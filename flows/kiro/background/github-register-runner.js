(function attachBackgroundKiroGithubRegisterRunner(root, factory) {
  root.MultiPageBackgroundKiroGithubRegisterRunner = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createKiroGithubRegisterRunnerModule(root) {
  const kiroStateApi = root.MultiPageBackgroundKiroState || null;
  const desktopClientApi = root.MultiPageBackgroundKiroDesktopClient || null;
  const desktopAuthorizeApi = root.MultiPageBackgroundKiroDesktopAuthorizeRunner || null;

  const DEFAULT_TARGET_ID = kiroStateApi?.DEFAULT_TARGET_ID || 'kiro-rs';
  const DEFAULT_REGION = kiroStateApi?.DEFAULT_REGION || 'us-east-1';
  const DEFAULT_KIRO_PAGE_LOAD_TIMEOUT_MS = 120000;
  const GITHUB_MANUAL_STEP_TIMEOUT_MS = 180000;
  const GITHUB_SIGNUP_URL = 'https://github.com/signup';
  const GITHUB_SIGNUP_SOURCE_ID = 'kiro-github-signup';
  const KIRO_REGISTER_PAGE_SOURCE_ID = 'kiro-register-page';
  const KIRO_PORTAL_URL = 'https://app.kiro.dev';
  const KIRO_AUTH_REGION = 'us-east-1';
  const KIRO_IDE_VERSION = '2.3.0';
  const GITHUB_USERNAME_MAX_ATTEMPTS = 5;
  const GITHUB_CAPTCHA_WAIT_TIMEOUT_MS = 180000;

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function getErrorMessage(error) {
    return error?.message || String(error || '未知错误');
  }

  function readKiroRuntime(state = {}) {
    if (typeof kiroStateApi?.ensureRuntimeState === 'function') {
      return kiroStateApi.ensureRuntimeState(state);
    }
    return state?.runtimeState?.flowState?.kiro || state?.flowState?.kiro || {};
  }

  function mergeRuntimePatch(currentState = {}, patch = {}) {
    if (typeof kiroStateApi?.buildRuntimeStatePatch === 'function') {
      return kiroStateApi.buildRuntimeStatePatch(currentState, patch);
    }
    if (typeof kiroStateApi?.buildRuntimeResetPatch === 'function') {
      return kiroStateApi.buildRuntimeResetPatch(currentState, patch);
    }
    return patch;
  }

  function isRetryableContentScriptTransportErrorCompat(error) {
    const message = getErrorMessage(error);
    return /Could not establish connection|Receiving end does not exist|message channel closed|Extension context invalidated|The message port closed/i.test(message);
  }

  function createKiroGithubRegisterRunner(deps = {}) {
    const {
      addLog = async () => {},
      chrome = (typeof globalThis !== 'undefined' ? globalThis.chrome : null),
      completeNodeFromBackground,
      ensureContentScriptReadyOnTab = null,
      fetchImpl = null,
      generatePassword = null,
      generateRandomName = null,
      getState = async () => ({}),
      getTabId = async () => null,
      isTabAlive = async () => false,
      KIRO_GITHUB_INJECT_FILES = null,
      KIRO_REGISTER_INJECT_FILES = null,
      pollFlowVerificationCode = null,
      registerTab = async () => {},
      resolveSignupEmailForFlow = null,
      reuseOrCreateTab = async () => null,
      sendToContentScriptResilient = null,
      setPasswordState = async () => {},
      setState = async () => {},
      sleepWithStop = async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      throwIfStopped = () => {},
      waitForTabStableComplete = null,
    } = deps;

    if (typeof completeNodeFromBackground !== 'function') {
      throw new Error('Kiro github register runner requires completeNodeFromBackground.');
    }
    if (typeof desktopClientApi?.generatePkcePair !== 'function'
      || typeof desktopClientApi?.buildRedirectUri !== 'function'
      || typeof desktopClientApi?.chooseRedirectPort !== 'function') {
      throw new Error('Kiro github register runner requires desktop client helpers (PKCE/redirect).');
    }
    if (typeof desktopAuthorizeApi?.createDesktopCallbackTracker !== 'function'
      || typeof desktopAuthorizeApi?.parseDesktopCallbackUrl !== 'function') {
      throw new Error('Kiro github register runner requires desktop callback tracker helpers.');
    }

    const githubCallbackTracker = desktopAuthorizeApi.createDesktopCallbackTracker(chrome);
    const parseGithubCallbackUrl = desktopAuthorizeApi.parseDesktopCallbackUrl;

    async function log(message, level = 'info', nodeId = '') {
      await addLog(message, level, nodeId ? { nodeId } : {});
    }

    async function getExecutionState(state = {}) {
      if (state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length) {
        return state;
      }
      return getState();
    }

    async function applyRuntimeState(currentState = {}, patch = {}, extraState = {}) {
      const runtimePatch = mergeRuntimePatch(currentState, patch);
      const nextPatch = {
        ...runtimePatch,
        ...extraState,
      };
      await setState(nextPatch);
      return nextPatch;
    }

    async function persistFailure(currentState = {}, message = '', extraPatch = {}) {
      const runtimeState = readKiroRuntime(currentState);
      const stage = runtimeState.session?.currentStage || 'github-signup';
      const patch = mergeRuntimePatch(currentState, {
        session: {
          currentStage: stage,
          lastError: message,
        },
        github: {
          status: runtimeState.github?.status || 'error',
        },
      });
      await setState({
        ...patch,
        ...extraPatch,
      });
    }

    async function activateTab(tabId) {
      if (!Number.isInteger(tabId) || !chrome?.tabs?.update) {
        return;
      }
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    }

    async function isSpecificTabAlive(tabId) {
      if (!Number.isInteger(tabId) || !chrome?.tabs?.get) {
        return false;
      }
      return Boolean(await chrome.tabs.get(tabId).catch(() => null));
    }

    function isGithubCandidateUrl(rawUrl = '') {
      let parsed = null;
      try {
        parsed = new URL(String(rawUrl || '').trim());
      } catch (_error) {
        return false;
      }
      const hostname = String(parsed.hostname || '').toLowerCase();
      return hostname === 'github.com' || hostname === 'www.github.com';
    }

    function isKiroPortalUrl(rawUrl = '') {
      let parsed = null;
      try {
        parsed = new URL(String(rawUrl || '').trim());
      } catch (_error) {
        return false;
      }
      return String(parsed.hostname || '').toLowerCase() === 'app.kiro.dev';
    }

    async function getActiveGithubTabId() {
      if (!chrome?.tabs?.query) {
        return null;
      }
      const queryAttempts = [
        { active: true, lastFocusedWindow: true },
        { active: true, currentWindow: true },
        { active: true },
      ];
      for (const queryInfo of queryAttempts) {
        const tabs = await chrome.tabs.query(queryInfo).catch(() => []);
        const matchedTab = (Array.isArray(tabs) ? tabs : []).find((tab) => (
          Number.isInteger(tab?.id) && isGithubCandidateUrl(tab?.url)
        ));
        if (Number.isInteger(matchedTab?.id)) {
          return matchedTab.id;
        }
      }
      return null;
    }

    async function ensureGithubTab(state = {}, options = {}) {
      const runtimeState = readKiroRuntime(state);
      let tabId = Number.isInteger(runtimeState.github?.tabId)
        ? runtimeState.github.tabId
        : await getTabId(GITHUB_SIGNUP_SOURCE_ID);

      if (Number.isInteger(tabId) && await isSpecificTabAlive(tabId)) {
        await registerTab(GITHUB_SIGNUP_SOURCE_ID, tabId);
        return tabId;
      }

      const activeTabId = await getActiveGithubTabId();
      if (Number.isInteger(activeTabId)) {
        await registerTab(GITHUB_SIGNUP_SOURCE_ID, activeTabId);
        return activeTabId;
      }

      tabId = await reuseOrCreateTab(GITHUB_SIGNUP_SOURCE_ID, GITHUB_SIGNUP_URL);
      if (!Number.isInteger(tabId)) {
        throw new Error(options.openFailedMessage || '无法打开 GitHub 注册页，请重试。');
      }
      await registerTab(GITHUB_SIGNUP_SOURCE_ID, tabId);
      return tabId;
    }

    async function sendGithubAction(tabId, action, payload = {}, options = {}) {
      if (typeof sendToContentScriptResilient !== 'function') {
        throw new Error('缺少 sendToContentScriptResilient 能力。');
      }
      return sendToContentScriptResilient(GITHUB_SIGNUP_SOURCE_ID, {
        type: 'EXECUTE_GITHUB_SIGNUP',
        step: options.step || 0,
        source: 'background',
        payload: {
          action,
          ...(payload || {}),
        },
      }, {
        timeoutMs: options.timeoutMs || 30000,
        retryDelayMs: options.retryDelayMs || 700,
        inject: Array.isArray(KIRO_GITHUB_INJECT_FILES) ? KIRO_GITHUB_INJECT_FILES : null,
        logMessage: options.logMessage || '',
        ...(options.extra || {}),
      });
    }

    async function getGithubPageState(tabId, options = {}) {
      if (typeof sendToContentScriptResilient !== 'function') {
        throw new Error('缺少 sendToContentScriptResilient 能力。');
      }
      return sendToContentScriptResilient(GITHUB_SIGNUP_SOURCE_ID, {
        type: 'GET_GITHUB_SIGNUP_STATE',
        step: options.step || 0,
        source: 'background',
        payload: {},
      }, {
        timeoutMs: options.timeoutMs || 30000,
        retryDelayMs: options.retryDelayMs || 700,
        inject: Array.isArray(KIRO_GITHUB_INJECT_FILES) ? KIRO_GITHUB_INJECT_FILES : null,
        logMessage: options.logMessage || '',
        ...(options.extra || {}),
      });
    }

    async function waitGithubPageState(tabId, targetStates = [], options = {}) {
      const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_KIRO_PAGE_LOAD_TIMEOUT_MS);
      const deadline = Date.now() + timeoutMs;
      let lastState = '';
      while (Date.now() < deadline) {
        throwIfStopped();
        const pageState = await getGithubPageState(tabId, {
          step: options.step || 0,
          timeoutMs: Math.min(15000, Math.max(2000, deadline - Date.now())),
        }).catch((error) => {
          if (isRetryableContentScriptTransportErrorCompat(error)) {
            return null;
          }
          throw error;
        });
        const state = cleanString(pageState?.state);
        if (state && targetStates.includes(state)) {
          return pageState;
        }
        if (state && state !== lastState) {
          lastState = state;
          await log(`GitHub 页面状态：${state}`, 'info', options.nodeId || '');
        }
        await sleepWithStop(Number(options.pollMs) || 800);
      }
      throw new Error(options.timeoutMessage || `等待 GitHub 页面进入 ${targetStates.join(' / ')} 超时。`);
    }

    function resolveGithubSignupEmail(currentState = {}, fallbackEmail = '') {
      const runtimeState = readKiroRuntime(currentState);
      return cleanString(
        fallbackEmail
        || currentState?.email
        || currentState?.registrationEmailState?.current
        || runtimeState?.github?.email
        || runtimeState?.register?.email
        || currentState?.registrationEmailState?.previous
      ).toLowerCase();
    }

    function resolveGithubPassword(state = {}) {
      const existing = String(state?.customPassword || state?.password || readKiroRuntime(state).github?.password || '');
      if (existing) {
        return existing;
      }
      if (typeof generatePassword !== 'function') {
        throw new Error('GitHub 密码步骤缺少公共密码生成能力。');
      }
      return String(generatePassword() || '');
    }

    function buildGithubUsernameCandidate(state = {}, attempt = 0) {
      let base = '';
      if (typeof generateRandomName === 'function') {
        const generated = generateRandomName();
        const first = cleanString(typeof generated === 'string' ? generated : generated?.firstName);
        const last = cleanString(typeof generated === 'object' ? generated?.lastName : '');
        base = `${first}${last ? `-${last}` : ''}`;
      }
      if (!base) {
        base = `fp${Math.random().toString(36).slice(2, 8)}`;
      }
      const suffix = Math.floor(1000 + Math.random() * 9000);
      const candidate = cleanString(`${base}${attempt ? `-${attempt}` : ''}-${suffix}`)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 39);
      return candidate || `fp-${Date.now().toString(36)}`;
    }

    async function pollGithubVerificationCode(step, state = {}, nodeId = '') {
      if (typeof pollFlowVerificationCode !== 'function') {
        throw new Error('GitHub 验证码步骤缺少共享邮件轮询能力。');
      }
      const runtimeState = readKiroRuntime(state);
      const requestedAt = Math.max(0, Number(runtimeState.github?.launchCodeRequestedAt) || Date.now());
      return pollFlowVerificationCode({
        actionLabel: 'GitHub 验证码',
        filterAfterTimestamp: Math.max(0, requestedAt - 15000),
        flowId: 'kiro',
        logStep: step,
        logStepKey: nodeId || 'kiro-github-submit-launch-code',
        missingCapabilityMessage: 'GitHub 验证码步骤缺少共享邮件轮询能力。',
        nodeId: nodeId || 'kiro-github-submit-launch-code',
        notFoundMessage: `步骤 ${step}：邮箱轮询结束，但未获取到 GitHub 验证码。`,
        state: {
          ...state,
          activeFlowId: 'kiro',
          flowId: 'kiro',
          visibleStep: step,
        },
        step,
      });
    }

    async function executeKiroGithubOpenSignup(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-github-open-signup').trim();
      const currentState = await getExecutionState(state);
      try {
        const tabId = await reuseOrCreateTab(GITHUB_SIGNUP_SOURCE_ID, GITHUB_SIGNUP_URL);
        if (!Number.isInteger(tabId)) {
          throw new Error('无法打开 GitHub 注册页，请重试。');
        }
        await registerTab(GITHUB_SIGNUP_SOURCE_ID, tabId);
        await activateTab(tabId);

        const landingState = await waitGithubPageState(tabId, ['email_entry', 'password_entry', 'username_entry', 'signup_page'], {
          step: 1,
          nodeId,
          timeoutMessage: 'GitHub 注册页未加载出可用表单，请检查网络或代理。',
        });

        const payload = await applyRuntimeState(currentState, {
          session: {
            currentStage: 'github-signup',
            pageState: landingState?.state || '',
            pageUrl: landingState?.url || GITHUB_SIGNUP_URL,
            lastError: '',
          },
          github: {
            tabId,
            status: 'waiting_email',
          },
          githubAuth: {
            region: DEFAULT_REGION,
            status: '',
          },
        });
        await log('GitHub 注册页已就绪，开始填写注册表单。', 'ok', nodeId);
        await completeNodeFromBackground(nodeId, payload);
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure(currentState, message);
        throw error;
      }
    }

    async function executeKiroGithubSubmitEmail(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-github-submit-email').trim();
      const currentState = await getExecutionState(state);
      try {
        const tabId = await ensureGithubTab(currentState);
        const resolvedEmail = typeof resolveSignupEmailForFlow === 'function'
          ? await resolveSignupEmailForFlow(currentState, { preserveAccountIdentity: true })
          : resolveGithubSignupEmail(currentState);
        if (!resolvedEmail) {
          throw new Error('缺少 GitHub 注册邮箱。');
        }
        await activateTab(tabId);
        const submitResult = await sendGithubAction(tabId, 'submit-email', { email: resolvedEmail }, {
          step: 2,
          logMessage: '正在向 GitHub 注册页提交邮箱...',
        });
        if (submitResult?.error) {
          throw new Error(submitResult.error);
        }
        await waitGithubPageState(tabId, ['password_entry', 'username_entry', 'captcha', 'signup_page'], {
          step: 2,
          nodeId,
          timeoutMessage: 'GitHub 邮箱提交后未进入下一步。',
        });
        const payload = await applyRuntimeState(currentState, {
          session: {
            currentStage: 'github-signup',
            pageUrl: submitResult?.url || '',
            lastError: '',
          },
          github: {
            email: resolvedEmail,
            status: 'waiting_password',
          },
        });
        await log(`GitHub 邮箱已提交：${resolvedEmail}`, 'ok', nodeId);
        await completeNodeFromBackground(nodeId, {
          ...payload,
          email: resolvedEmail,
          accountIdentifierType: 'email',
          accountIdentifier: resolvedEmail,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure(currentState, message);
        throw error;
      }
    }

    async function executeKiroGithubSubmitPassword(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-github-submit-password').trim();
      const currentState = await getExecutionState(state);
      try {
        const tabId = await ensureGithubTab(currentState);
        const password = resolveGithubPassword(currentState);
        if (!password) {
          throw new Error('缺少 GitHub 注册密码。');
        }
        await activateTab(tabId);
        const submitResult = await sendGithubAction(tabId, 'submit-password', { password }, {
          step: 3,
          logMessage: '正在向 GitHub 注册页提交密码...',
        });
        if (submitResult?.error) {
          throw new Error(submitResult.error);
        }
        const nextState = await waitGithubPageState(tabId, ['username_entry', 'email_prefs', 'captcha', 'signup_page'], {
          step: 3,
          nodeId,
          timeoutMessage: 'GitHub 密码提交后未进入用户名页。',
        });
        const payload = await applyRuntimeState(currentState, {
          session: {
            currentStage: 'github-signup',
            pageUrl: nextState?.url || '',
            lastError: '',
          },
          github: {
            password,
            status: 'waiting_username',
          },
        });
        await setPasswordState({ password });
        await log('GitHub 密码已提交。', 'ok', nodeId);
        await completeNodeFromBackground(nodeId, {
          ...payload,
          password,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure(currentState, message);
        throw error;
      }
    }

    async function executeKiroGithubSubmitUsername(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-github-submit-username').trim();
      const currentState = await getExecutionState(state);
      try {
        const tabId = await ensureGithubTab(currentState);
        await activateTab(tabId);
        let lastErrorMessage = '';
        for (let attempt = 0; attempt < GITHUB_USERNAME_MAX_ATTEMPTS; attempt += 1) {
          throwIfStopped();
          const username = buildGithubUsernameCandidate(currentState, attempt);
          const submitResult = await sendGithubAction(tabId, 'submit-username', { username }, {
            step: 4,
            logMessage: attempt === 0
              ? '正在向 GitHub 注册页提交用户名...'
              : `用户名被占用，重试第 ${attempt + 1} 次：${username}`,
          });
          if (submitResult?.error) {
            lastErrorMessage = submitResult.error;
            await sleepWithStop(600);
            continue;
          }
          const nextState = await waitGithubPageState(tabId, ['username_entry', 'email_prefs', 'captcha', 'signup_page'], {
            step: 4,
            nodeId,
            timeoutMessage: 'GitHub 用户名提交后未进入下一步。',
          }).catch(() => null);
          const stillTaken = cleanString(nextState?.state) === 'username_entry' && Boolean(nextState?.usernameTaken);
          if (stillTaken) {
            lastErrorMessage = `GitHub 用户名 ${username} 已被占用。`;
            await sleepWithStop(600);
            continue;
          }
          const payload = await applyRuntimeState(currentState, {
            session: {
              currentStage: 'github-signup',
              pageUrl: nextState?.url || '',
              lastError: '',
            },
            github: {
              username,
              status: 'waiting_email_prefs',
            },
          });
          await log(`GitHub 用户名已提交：${username}`, 'ok', nodeId);
          await completeNodeFromBackground(nodeId, {
            ...payload,
            username,
          });
          return;
        }
        throw new Error(lastErrorMessage || 'GitHub 用户名提交失败，请重试。');
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure(currentState, message);
        throw error;
      }
    }

    async function executeKiroGithubSubmitEmailPrefs(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-github-submit-email-prefs').trim();
      const currentState = await getExecutionState(state);
      try {
        const tabId = await ensureGithubTab(currentState);
        await activateTab(tabId);
        const currentPageState = await getGithubPageState(tabId, { step: 5 });
        if (currentPageState?.state === 'email_prefs') {
          const submitResult = await sendGithubAction(tabId, 'submit-email-prefs', { choice: 'n' }, {
            step: 5,
            logMessage: '正在提交 GitHub 邮件偏好（不订阅）...',
          });
          if (submitResult?.error) {
            throw new Error(submitResult.error);
          }
        } else if (currentPageState?.state !== 'captcha') {
          await waitGithubPageState(tabId, ['email_prefs', 'captcha'], {
            step: 5,
            nodeId,
            timeoutMs: 15000,
            timeoutMessage: 'GitHub 未进入邮件偏好或验证页。',
          });
        }
        const payload = await applyRuntimeState(currentState, {
          session: {
            currentStage: 'github-signup',
            lastError: '',
          },
          github: {
            status: 'waiting_captcha',
          },
        });
        await log('GitHub 邮件偏好已处理。', 'ok', nodeId);
        await completeNodeFromBackground(nodeId, payload);
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure(currentState, message);
        throw error;
      }
    }

    async function executeKiroGithubSubmitLaunchCode(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-github-submit-launch-code').trim();
      const currentState = await getExecutionState(state);
      try {
        const tabId = await ensureGithubTab(currentState);
        await activateTab(tabId);

        let pageState = await getGithubPageState(tabId, { step: 6 });
        let captchaWaitLogged = false;
        const captchaDeadline = Date.now() + GITHUB_CAPTCHA_WAIT_TIMEOUT_MS;
        while (pageState?.state === 'captcha' && Date.now() < captchaDeadline) {
          throwIfStopped();
          if (!captchaWaitLogged) {
            await log('GitHub 需要人机验证，请在自动化页中完成验证，完成后流程会自动继续。', 'warn', nodeId);
            captchaWaitLogged = true;
          }
          await sleepWithStop(1500);
          pageState = await getGithubPageState(tabId, { step: 6 }).catch(() => null);
        }
        if (pageState?.state === 'captcha') {
          throw new Error('GitHub 人机验证等待超时，请手动完成验证后重试。');
        }

        if (pageState?.state === 'create_account') {
          await log('人机验证已通过，正在点击 Create account...', 'info', nodeId);
          const createResult = await sendGithubAction(tabId, 'create-account', {}, {
            step: 6,
            logMessage: '正在点击 GitHub Create account...',
          });
          if (createResult?.error) {
            throw new Error(createResult.error);
          }
        }

        const launchState = await waitGithubPageState(tabId, ['launch_code'], {
          step: 6,
          nodeId,
          timeoutMessage: 'GitHub 未进入 launch code 验证页。',
        });
        const requestedAt = Date.now();
        const codeResult = await pollGithubVerificationCode(6, currentState, nodeId);
        const code = cleanString(codeResult?.code).replace(/\s+/g, '');
        if (!code) {
          throw new Error('未获取到 GitHub launch code。');
        }
        await log(`已获取 GitHub launch code：${code}，正在提交...`, 'info', nodeId);
        const submitResult = await sendGithubAction(tabId, 'submit-launch-code', { code }, {
          step: 6,
          logMessage: '正在提交 GitHub launch code...',
        });
        if (submitResult?.error) {
          throw new Error(submitResult.error);
        }

        const signedInState = await waitGithubPageState(tabId, ['signed_in', 'github_page', 'signup_page'], {
          step: 6,
          nodeId,
          timeoutMs: GITHUB_MANUAL_STEP_TIMEOUT_MS,
          timeoutMessage: 'GitHub launch code 提交后未确认登录成功。',
        });
        if (signedInState?.state !== 'signed_in' && signedInState?.state !== 'github_page') {
          throw new Error(`GitHub 注册后未进入已登录状态：${signedInState?.state || 'unknown'}。`);
        }

        const runtimeState = readKiroRuntime(currentState);
        const githubAccount = {
          email: cleanString(runtimeState.github?.email),
          username: cleanString(runtimeState.github?.username),
          password: cleanString(runtimeState.github?.password),
        };
        const payload = await applyRuntimeState(currentState, {
          session: {
            currentStage: 'github-auth',
            pageState: signedInState?.state || '',
            pageUrl: signedInState?.url || '',
            lastError: '',
          },
          github: {
            status: 'completed',
            completedAt: Date.now(),
            launchCodeRequestedAt: requestedAt,
          },
          githubAuth: {
            status: 'waiting_portal',
          },
        });
        await log(`GitHub 注册完成：${githubAccount.username || githubAccount.email}`, 'ok', nodeId);
        await completeNodeFromBackground(nodeId, payload);
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure(currentState, message);
        throw error;
      }
    }

    function buildKiroPortalUrl(stateToken = '', codeChallenge = '', redirectUri = '') {
      const search = new URLSearchParams();
      search.set('state', stateToken);
      search.set('code_challenge', codeChallenge);
      search.set('code_challenge_method', 'S256');
      search.set('redirect_uri', redirectUri);
      search.set('redirect_from', 'KiroIDE');
      return `${KIRO_PORTAL_URL}/signin?${search.toString()}`;
    }

    async function exchangeGithubSocialCode(params = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('缺少 fetch 能力，无法交换 Kiro social token。');
      }
      const region = cleanString(params.region) || KIRO_AUTH_REGION;
      const endpoint = `https://prod.${region}.auth.desktop.kiro.dev/oauth/token`;
      const body = {
        code: cleanString(params.code),
        code_verifier: cleanString(params.codeVerifier),
        redirect_uri: cleanString(params.redirectUri),
      };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `KiroIDE-${KIRO_IDE_VERSION}`,
          Accept: 'application/json, text/plain, */*',
        },
        body: JSON.stringify(body),
      });
      const text = await response.text().catch(() => '');
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_error) {
        json = null;
      }
      if (!response.ok) {
        const detail = cleanString(json?.error_description || json?.message || text || response.statusText);
        throw new Error(`Kiro social token 交换失败：HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
      }
      const accessToken = cleanString(json?.accessToken);
      const refreshToken = cleanString(json?.refreshToken);
      if (!accessToken || !refreshToken) {
        throw new Error('Kiro social token 响应缺少 accessToken 或 refreshToken。');
      }
      return {
        accessToken,
        refreshToken,
        expiresAt: cleanString(json?.expiresAt),
        expiresIn: Number(json?.expiresIn || 0) || 0,
        profileArn: cleanString(json?.profileArn),
      };
    }

    async function executeKiroOpenGithubAuth(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-open-github-auth').trim();
      const currentState = await getExecutionState(state);
      try {
        const runtimeState = readKiroRuntime(currentState);
        const githubAccount = runtimeState.github || {};
        if (githubAccount.status !== 'completed') {
          throw new Error('GitHub 注册尚未完成，请先执行 GitHub 注册步骤。');
        }
        const pkce = await desktopClientApi.generatePkcePair();
        const stateToken = cleanString(globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const redirectPort = desktopClientApi.chooseRedirectPort();
        const redirectUri = desktopClientApi.buildRedirectUri(redirectPort);
        const portalUrl = buildKiroPortalUrl(stateToken, pkce.codeChallenge, redirectUri);

        githubCallbackTracker.registerPending({
          expectedState: stateToken,
          redirectPort,
        });

        const tabId = await reuseOrCreateTab(GITHUB_SIGNUP_SOURCE_ID, portalUrl);
        if (!Number.isInteger(tabId)) {
          throw new Error('无法打开 Kiro GitHub 授权入口页，请重试。');
        }
        await registerTab(GITHUB_SIGNUP_SOURCE_ID, tabId);
        await registerTab(KIRO_REGISTER_PAGE_SOURCE_ID, tabId);
        githubCallbackTracker.registerPending({
          expectedState: stateToken,
          redirectPort,
          tabId,
        });
        await activateTab(tabId);

        const payload = await applyRuntimeState(currentState, {
          session: {
            currentStage: 'github-auth',
            pageState: '',
            pageUrl: portalUrl,
            lastError: '',
            lastWarning: '',
          },
          githubAuth: {
            region: KIRO_AUTH_REGION,
            state: stateToken,
            codeVerifier: pkce.codeVerifier,
            codeChallenge: pkce.codeChallenge,
            redirectUri,
            redirectPort,
            portalUrl,
            authorizationCode: '',
            accessToken: '',
            refreshToken: '',
            expiresAt: '',
            profileArn: '',
            status: 'waiting_provider_click',
            authorizedAt: 0,
          },
          upload: {
            status: 'waiting_desktop_authorize',
            error: '',
            credentialId: null,
            lastMessage: '',
            lastUploadedAt: 0,
          },
        });
        await log('Kiro GitHub 授权入口已打开，请在下一步中驱动 GitHub 授权页。', 'ok', nodeId);
        await completeNodeFromBackground(nodeId, payload);
      } catch (error) {
        const message = getErrorMessage(error);
        await persistFailure(currentState, message);
        throw error;
      }
    }

    async function executeKiroGithubCompleteOauth(state = {}) {
      const nodeId = String(state?.nodeId || 'kiro-github-complete-oauth').trim();
      let currentState = await getExecutionState(state);
      let runtimeState = readKiroRuntime(currentState);
      const githubState = cleanString(runtimeState.githubAuth?.state);
      try {
        if (!githubState) {
          throw new Error('缺少 GitHub 授权 state，请先执行 Kiro GitHub 授权入口步骤。');
        }
        if (!cleanString(runtimeState.githubAuth?.codeVerifier) || !cleanString(runtimeState.githubAuth?.redirectUri)) {
          throw new Error('缺少 GitHub 授权 PKCE 参数，请先执行 Kiro GitHub 授权入口步骤。');
        }
        const githubAccount = {
          email: cleanString(runtimeState.github?.email),
          username: cleanString(runtimeState.github?.username),
          password: cleanString(runtimeState.github?.password),
        };
        if (!githubAccount.password) {
          throw new Error('缺少 GitHub 账号密码，无法处理授权页登录回落。');
        }

        githubCallbackTracker.registerPending({
          expectedState: githubState,
          redirectPort: runtimeState.githubAuth?.redirectPort || 0,
          tabId: runtimeState.github?.tabId || null,
        });

        const deadline = Date.now() + DEFAULT_KIRO_PAGE_LOAD_TIMEOUT_MS + GITHUB_MANUAL_STEP_TIMEOUT_MS;
        let oauthActioned = false;
        let loginSubmitted = false;
        let deviceCodeSubmitted = false;
        let authorizeClicked = false;
        let githubClicked = false;

        while (Date.now() < deadline) {
          throwIfStopped();

          const resolvedCallback = githubCallbackTracker.consumeResolved(githubState);
          if (resolvedCallback?.error) {
            throw new Error(resolvedCallback.error);
          }
          if (resolvedCallback?.code) {
            const tokenResult = await exchangeGithubSocialCode({
              region: runtimeState.githubAuth?.region || KIRO_AUTH_REGION,
              code: resolvedCallback.code,
              codeVerifier: runtimeState.githubAuth?.codeVerifier,
              redirectUri: runtimeState.githubAuth?.redirectUri,
            });
            const payload = await applyRuntimeState(currentState, {
              session: {
                currentStage: 'github-auth',
                pageState: 'callback_received',
                pageUrl: resolvedCallback?.url || '',
                lastError: '',
              },
              githubAuth: {
                status: 'authorized',
                authorizationCode: resolvedCallback.code,
                accessToken: tokenResult.accessToken,
                refreshToken: tokenResult.refreshToken,
                expiresAt: tokenResult.expiresAt,
                profileArn: tokenResult.profileArn,
                authorizedAt: Date.now(),
              },
              upload: {
                status: 'waiting_upload',
                error: '',
              },
            });
            await log('GitHub 授权回调已捕获并完成 token 交换。', 'ok', nodeId);
            await completeNodeFromBackground(nodeId, payload);
            return;
          }

          const tabId = await getTabId(GITHUB_SIGNUP_SOURCE_ID).catch(() => null);
          if (!Number.isInteger(tabId) || !(await isSpecificTabAlive(tabId))) {
            await sleepWithStop(1000);
            continue;
          }

          let tab = null;
          try {
            tab = await chrome?.tabs?.get?.(tabId);
          } catch (_error) {
            tab = null;
          }
          const tabUrl = cleanString(tab?.url);
          const callbackCandidate = parseGithubCallbackUrl(
            tabUrl,
            githubState,
            runtimeState.githubAuth?.redirectPort || 0
          );
          if (callbackCandidate?.code) {
            githubCallbackTracker.registerPending({
              expectedState: githubState,
              redirectPort: runtimeState.githubAuth?.redirectPort || 0,
              tabId,
            });
            await sleepWithStop(300);
            continue;
          }

          if (isKiroPortalUrl(tabUrl)) {
            if (!githubClicked) {
              await log('正在 Kiro 登录页点击 GitHub 入口...', 'info', nodeId);
              const clickResult = await sendToContentScriptResilient(KIRO_REGISTER_PAGE_SOURCE_ID, {
                type: 'EXECUTE_NODE',
                nodeId: 'kiro-open-github-auth',
                step: 7,
                source: 'background',
                payload: {},
              }, {
                timeoutMs: 30000,
                retryDelayMs: 700,
                inject: Array.isArray(KIRO_REGISTER_INJECT_FILES) ? KIRO_REGISTER_INJECT_FILES : null,
                logMessage: '正在点击 Kiro 登录页的 GitHub 按钮...',
              });
              if (clickResult?.error) {
                throw new Error(clickResult.error);
              }
              githubClicked = true;
              await sleepWithStop(1200);
              continue;
            }
          } else if (isGithubCandidateUrl(tabUrl)) {
            const pageState = await getGithubPageState(tabId, { step: 7 }).catch(() => null);
            const stateName = cleanString(pageState?.state);
            if (stateName === 'oauth_authorize' && !authorizeClicked) {
              await log('正在 GitHub OAuth 授权页点击 Authorize...', 'info', nodeId);
              const authResult = await sendGithubAction(tabId, 'click-authorize', {}, {
                step: 7,
                logMessage: '正在点击 GitHub Authorize...',
              });
              if (authResult?.error) {
                throw new Error(authResult.error);
              }
              authorizeClicked = true;
              oauthActioned = true;
              await sleepWithStop(1000);
              continue;
            }
            if (stateName === 'oauth_login' && !loginSubmitted) {
              await log('GitHub OAuth 需要重新登录，正在回填 GitHub 账号密码...', 'info', nodeId);
              const loginResult = await sendGithubAction(tabId, 'submit-login', {
                login: githubAccount.username || githubAccount.email,
                password: githubAccount.password,
              }, {
                step: 7,
                logMessage: '正在提交 GitHub 登录表单...',
              });
              if (loginResult?.error) {
                throw new Error(loginResult.error);
              }
              loginSubmitted = true;
              oauthActioned = true;
              await sleepWithStop(1200);
              continue;
            }
            if (stateName === 'device_verify' && !deviceCodeSubmitted) {
              await log('GitHub 要求设备验证码，正在轮询邮箱...', 'info', nodeId);
              const codeResult = await pollGithubVerificationCode(7, currentState, 'kiro-github-submit-device-code');
              const deviceCode = cleanString(codeResult?.code).replace(/\s+/g, '');
              if (!deviceCode) {
                throw new Error('未获取到 GitHub 设备验证码。');
              }
              const deviceResult = await sendGithubAction(tabId, 'submit-device-code', { code: deviceCode }, {
                step: 7,
                logMessage: '正在提交 GitHub 设备验证码...',
              });
              if (deviceResult?.error) {
                throw new Error(deviceResult.error);
              }
              deviceCodeSubmitted = true;
              oauthActioned = true;
              await sleepWithStop(1200);
              continue;
            }
            if (stateName === 'signed_in' && oauthActioned) {
              await sleepWithStop(800);
              continue;
            }
          }

          await sleepWithStop(900);
        }

        throw new Error('等待 GitHub 授权回调超时。');
      } catch (error) {
        githubCallbackTracker.clear(githubState);
        const message = getErrorMessage(error);
        await persistFailure(currentState, message);
        throw error;
      }
    }

    return {
      executeKiroGithubCompleteOauth,
      executeKiroGithubOpenSignup,
      executeKiroGithubSubmitEmail,
      executeKiroGithubSubmitEmailPrefs,
      executeKiroGithubSubmitLaunchCode,
      executeKiroGithubSubmitPassword,
      executeKiroGithubSubmitUsername,
      executeKiroOpenGithubAuth,
    };
  }

  return {
    createKiroGithubRegisterRunner,
    GITHUB_SIGNUP_SOURCE_ID,
    GITHUB_SIGNUP_URL,
    KIRO_AUTH_REGION,
    KIRO_IDE_VERSION,
    KIRO_PORTAL_URL,
  };
});
