(function attachBackgroundClineRegisterRunner(root, factory) {
  root.MultiPageBackgroundClineRegisterRunner = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundClineRegisterRunnerModule(root = globalThis) {
  const CLINE_REGISTER_SOURCE_ID = 'cline-microsoft-login';
  const CLINE_REGISTER_PAGE_LABEL = 'Cline 微软登录页';
  const CLINE_CALLBACK_PORT_BASE = 48801;
  const CLINE_CALLBACK_PORT_SPAN = 200;
  const CLINE_OPEN_PAGE_TIMEOUT_MS = 90 * 1000;
  const CLINE_DRIVE_TIMEOUT_MS = 180 * 1000;
  const CLINE_DRIVE_POLL_INTERVAL_MS = 1500;
  const CLINE_AUX_CODE_TIMEOUT_MS = 60 * 1000;
  const CLINE_AUX_CODE_LOOKBACK_MS = 45 * 1000;
  const CLINE_AUX_MAILNEST_DEFAULT_PROJECT = 'microsoft001';
  const CLINE_MAILNEST_DEFAULT_ACCOUNT_PRODUCT = 'lweb_ocom_test';
  const CLINE_WEBAUTHN_STUB_SCRIPT_ID = 'cline-webauthn-stub';
  const CLINE_MS_HOST_MATCHES = Object.freeze([
    'https://login.microsoft.com/*',
    'https://login.microsoftonline.com/*',
    'https://login.live.com/*',
    'https://account.live.com/*',
    'https://login.windows.net/*',
  ]);
  const CLINE_SECURITY_CODE_SUBJECT_FILTERS = Object.freeze(['安全代码', 'security code']);

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : cleanString(error) || '未知错误';
  }

  function getClineClient(scope = root) {
    return scope?.MultiPageClineClient || null;
  }

  function getMicrosoftEmailHelpers(scope = root) {
    return scope?.MultiPageMicrosoftEmail || null;
  }

  function createClineRegisterRunner(deps = {}) {
    const {
      addLog = async () => {},
      chrome = (typeof globalThis !== 'undefined' ? globalThis.chrome : null),
      completeNodeFromBackground,
      ensureContentScriptReadyOnTab = null,
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      getState = async () => ({}),
      getTabId = async () => null,
      isTabAlive = async () => false,
      mailnestProvider = null,
      normalizeHotmailAccounts = (list) => (Array.isArray(list) ? list : []),
      pickHotmailAccountForRun = null,
      registerTab = async () => {},
      reuseOrCreateTab = async () => null,
      sendToContentScriptResilient = null,
      setCurrentHotmailAccount = null,
      setEmailState = async () => {},
      setState = async () => {},
      sleepWithStop = async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      throwIfStopped = () => {},
      upsertHotmailAccount = null,
      waitForTabStableComplete = null,
      CLINE_MS_LOGIN_INJECT_FILES = null,
    } = deps;

    if (typeof completeNodeFromBackground !== 'function') {
      throw new Error('Cline register runner requires completeNodeFromBackground.');
    }

    async function log(message, level = 'info') {
      await addLog(`Cline：${message}`, level);
    }

    function buildClineRuntimePatch(patch = {}) {
      return {
        runtimeState: {
          flowState: {
            cline: patch,
          },
        },
      };
    }

    function readClineRuntime(state = {}) {
      return state?.runtimeState?.flowState?.cline || {};
    }

    async function getExecutionState(state = {}) {
      if (state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length) {
        return state;
      }
      return getState();
    }

    async function isSpecificTabAlive(tabId) {
      if (!Number.isInteger(tabId)) {
        return false;
      }
      if (typeof isTabAlive === 'function' && await isTabAlive(CLINE_REGISTER_SOURCE_ID)) {
        return true;
      }
      if (chrome?.tabs?.get) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        return Boolean(tab?.id === tabId);
      }
      return true;
    }

    async function getTabUrl(tabId) {
      if (!Number.isInteger(tabId) || !chrome?.tabs?.get) {
        return '';
      }
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return cleanString(tab?.url || tab?.pendingUrl);
    }

    function pickClineCallbackUrl() {
      const port = CLINE_CALLBACK_PORT_BASE + Math.floor(Math.random() * CLINE_CALLBACK_PORT_SPAN);
      return `http://127.0.0.1:${port}/auth`;
    }

    // document_start+MAIN world 注册式注入：在页面 JS 之前禁用 WebAuthn，
    // 比循环里 executeScript 更早，能拦住 fido/create 的首次 credentials.create()。
    async function registerWebauthnStub() {
      if (!chrome?.scripting?.registerContentScripts) return;
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [CLINE_WEBAUTHN_STUB_SCRIPT_ID] }).catch(() => {});
        await chrome.scripting.registerContentScripts([{
          id: CLINE_WEBAUTHN_STUB_SCRIPT_ID,
          js: ['flows/cline/content/webauthn-stub.js'],
          matches: [...CLINE_MS_HOST_MATCHES],
          runAt: 'document_start',
          world: 'MAIN',
          persistAcrossSessions: false,
        }]);
      } catch (err) {
        await log(`WebAuthn 拦截脚本注册失败（${getErrorMessage(err)}），通行密钥弹窗可能需要手动点「取消」。`, 'warn');
      }
    }

    async function unregisterWebauthnStub() {
      if (!chrome?.scripting?.unregisterContentScripts) return;
      await chrome.scripting.unregisterContentScripts({ ids: [CLINE_WEBAUTHN_STUB_SCRIPT_ID] }).catch(() => {});
    }

    /**
     * 优先在无痕窗口打开登录页：微软 OAuth 会话与用户浏览器 Cookie 完全隔离
     * （等价原版的 browser.newContext），跑完关窗即销毁会话。
     * 无痕权限需用户在 chrome://extensions 手动开启，未开启则降级普通窗口。
     */
    async function openClineLoginTab(url) {
      try {
        if (chrome?.extension?.isAllowedIncognitoAccess && chrome?.windows?.create) {
          const allowed = await chrome.extension.isAllowedIncognitoAccess();
          if (allowed) {
            const win = await chrome.windows.create({ url, incognito: true, focused: true });
            const tabId = Array.isArray(win?.tabs) ? win.tabs[0]?.id : null;
            if (Number.isInteger(tabId)) {
              return { tabId, windowId: win.id, incognito: true };
            }
          } else {
            await log('未授予「无痕模式」权限，将在普通窗口运行（微软会话不隔离）。如需账号隔离：chrome://extensions → FlowPilot → 详细信息 → 开启「在无痕模式下启用」。', 'warn');
          }
        }
      } catch (err) {
        await log(`无痕窗口创建失败（${getErrorMessage(err)}），回退普通窗口。`, 'warn');
      }
      const tabId = await reuseOrCreateTab(CLINE_REGISTER_SOURCE_ID, url);
      return { tabId, windowId: null, incognito: false };
    }

    function accountHasLoginCredentials(account = {}) {
      // 微软密码最短 8 位：令牌号（g_ocom）密码位是 'x' 之类占位符，不能当登录目标。
      return Boolean(account)
        && Boolean(cleanString(account.email))
        && cleanString(account.password).length >= 8
        && account.enabled !== false;
    }

    function accountHasAuxCapability(account = {}) {
      return Boolean(account)
        && Boolean(cleanString(account.clientId))
        && Boolean(cleanString(account.refreshToken))
        && account.enabled !== false;
    }

    /**
     * 从 Hotmail 号池选目标微软账号（email+password）与辅助接码账号（clientId+refreshToken）。
     * 目标是尚未注册过 Cline 的号；辅助号只用于微软安全代码，优先选已就绪且非目标的号。
     */
    function allocateClineAccounts(state = {}, preferredAccountId = '') {
      const accounts = normalizeHotmailAccounts(state.hotmailAccounts);
      const loginCandidates = accounts.filter(accountHasLoginCredentials);
      if (!loginCandidates.length) {
        throw new Error('没有可用的微软账号。请先在 Hotmail 号池添加至少一个带「邮箱+密码」的账号（Cline 注册走微软 OAuth 登录）。');
      }
      let target = preferredAccountId
        ? loginCandidates.find((account) => account.id === preferredAccountId) || null
        : null;
      if (!target) {
        const unused = loginCandidates.filter((account) => !account.used);
        target = typeof pickHotmailAccountForRun === 'function'
          ? pickHotmailAccountForRun(unused.length ? unused : loginCandidates, {})
          : (unused.length ? unused : loginCandidates)
            .slice()
            .sort((a, b) => (Number(a.lastUsedAt) || 0) - (Number(b.lastUsedAt) || 0))[0];
      }
      if (!target) {
        throw new Error('无法从 Hotmail 号池分配微软账号。');
      }

      const auxCandidates = accounts.filter((account) => accountHasAuxCapability(account) && account.id !== target.id);
      const aux = auxCandidates.length
        ? auxCandidates.slice().sort((a, b) => (Number(a.lastAuthAt) || 0) - (Number(b.lastAuthAt) || 0))[0]
        : null;

      return { target, aux };
    }

    async function executeClinePrepareAccount(state = {}) {
      const currentState = await getExecutionState(state);
      let target = null;
      let aux = null;
      let purchased = null;
      try {
        ({ target, aux } = allocateClineAccounts(currentState, currentState.clineAccountId || ''));
      } catch (allocationError) {
        if (!isMailnestWebConfigured(currentState)) {
          throw allocationError;
        }
        purchased = await buyMailnestMicrosoftAccount(currentState);
      }
      const callbackUrl = pickClineCallbackUrl();
      const msEmail = cleanString(purchased?.email || target?.email);
      const msPassword = cleanString(purchased?.password || target?.password);
      const msAccountSource = purchased ? 'mailnest' : 'hotmail-pool';
      if (target && typeof setCurrentHotmailAccount === 'function') {
        try {
          await setCurrentHotmailAccount(target.id, { markUsed: false, syncEmail: true });
        } catch (_) {
          await setEmailState(msEmail);
        }
      } else {
        await setEmailState(msEmail);
      }
      await setState(buildClineRuntimePatch({
        accountId: target?.id || '',
        email: msEmail,
        msAccountEmail: msEmail,
        msAccountPassword: msPassword,
        msAccountSource,
        auxAccountId: aux?.id || '',
        auxEmail: cleanString(aux?.email),
        auxEmailSource: '',
        callbackUrl,
        authorizationCode: '',
        accessToken: '',
        refreshToken: '',
        expiresAt: '',
        preparedAt: Date.now(),
      }));
      const auxHint = aux
        ? `，辅助接码邮箱 ${aux.email}`
        : (isMailnestAuxAvailable(currentState)
          ? '（无 Graph 辅助号，若遇安全验证将自动购买 MailNest 辅助邮箱）'
          : '（无辅助接码邮箱，若遇安全验证将失败）');
      const sourceHint = purchased ? `（MailNest 购买${purchased.orderId ? `，订单 ${purchased.orderId}` : ''}）` : '';
      await log(`已分配微软账号 ${msEmail}${sourceHint}${auxHint}`, 'ok');
      return completeNodeFromBackground('cline-prepare-account', {
        email: msEmail,
      });
    }

    async function executeClineOpenAuthorize(state = {}) {
      const currentState = await getExecutionState(state);
      const runtime = readClineRuntime(currentState);
      const callbackUrl = cleanString(runtime.callbackUrl) || pickClineCallbackUrl();
      const clineApiBase = cleanString(currentState.clineApiBase) || undefined;
      const client = getClineClient();
      if (!client?.buildClineAuthorizeUrl || !client?.rewriteClineProviderParam) {
        throw new Error('Cline 客户端模块未加载。');
      }
      const authorizeUrl = client.buildClineAuthorizeUrl({ apiBase: clineApiBase, callbackUrl });

      // 扩展里 fetch redirect:manual 拿到的是 opaqueredirect（读不到 Location），
      // 改为让标签页自己跟 302，再从 tab.url 截获 WorkOS/AuthKit 落地地址改写 provider。
      await log('正在打开 Cline 授权入口（等待跳转到 WorkOS）...');
      await registerWebauthnStub();
      const opened = await openClineLoginTab(authorizeUrl);
      const tabId = opened.tabId;
      if (!Number.isInteger(tabId)) {
        throw new Error('无法打开 Cline 授权页标签页。');
      }
      await registerTab(CLINE_REGISTER_SOURCE_ID, tabId);
      await setState(buildClineRuntimePatch({
        callbackUrl,
        authorizeUrl,
        session: { loginTabId: tabId, loginWindowId: opened.windowId, incognito: opened.incognito },
      }));
      if (opened.incognito) {
        await log('已在无痕窗口中打开登录页（微软会话与浏览器隔离）。');
      }

      const deadline = Date.now() + CLINE_OPEN_PAGE_TIMEOUT_MS;
      let landingUrl = '';
      try {
        while (Date.now() < deadline) {
          throwIfStopped();
          const tabUrl = await getTabUrl(tabId);
          if (/(^|\.)login\.microsoftonline\.com$/i.test(getUrlHost(tabUrl))) {
            landingUrl = tabUrl;
            break;
          }
          if (client.isClineAuthGatewayUrl?.(tabUrl)) {
            landingUrl = tabUrl;
            break;
          }
          await sleepWithStop(300);
        }
        if (!landingUrl) {
          throw new Error('授权页未跳转到 WorkOS/微软登录入口（超时）。请检查网络或代理。');
        }
      } catch (err) {
        // 开页失败即回收无痕窗口，避免残留会话窗口堆积。
        if (opened.incognito && Number.isInteger(opened.windowId) && chrome?.windows?.remove) {
          await chrome.windows.remove(opened.windowId).catch(() => {});
        }
        await unregisterWebauthnStub();
        throw err;
      }

      const rewritten = client.rewriteClineProviderParam(landingUrl, 'MicrosoftOAuth');
      if (rewritten && rewritten !== landingUrl && chrome?.tabs?.update) {
        await chrome.tabs.update(tabId, { url: rewritten }).catch(() => {});
      }
      await setState(buildClineRuntimePatch({ loginUrl: rewritten || landingUrl }));
      if (typeof waitForTabStableComplete === 'function') {
        await waitForTabStableComplete(tabId, { timeoutMs: CLINE_OPEN_PAGE_TIMEOUT_MS, stableMs: 800 }).catch(() => {});
      }
      await log('已打开微软登录页。', 'ok');
      return completeNodeFromBackground('cline-open-authorize', {
        session: { loginTabId: tabId },
      });
    }

    function getUrlHost(rawUrl = '') {
      try {
        return new URL(String(rawUrl || '')).hostname.toLowerCase();
      } catch (_) {
        return '';
      }
    }

    // 无痕标签页不在 tabRegistry/automationWindow 管辖内（registerTab 会拒绝
    // 非自动化窗口的 tab，resilient 路径会把命令丢进队列空转），直接走裸消息。
    async function sendClineDriverMessageIncognito(tabId, message, options = {}) {
      const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 15000);
      const start = Date.now();
      let lastError = null;
      while (Date.now() - start < timeoutMs) {
        try {
          const result = await Promise.race([
            chrome.tabs.sendMessage(tabId, message),
            new Promise((_, reject) => setTimeout(() => reject(new Error('响应超时')), 10000)),
          ]);
          if (result?.error) throw new Error(result.error);
          return result;
        } catch (err) {
          lastError = err;
          if (chrome?.scripting?.executeScript
            && Array.isArray(CLINE_MS_LOGIN_INJECT_FILES)
            && CLINE_MS_LOGIN_INJECT_FILES.length) {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: CLINE_MS_LOGIN_INJECT_FILES,
            }).catch(() => {});
          }
          await sleepWithStop(600);
        }
      }
      throw lastError || new Error('无痕标签页内容脚本未响应。');
    }

    async function sendClineDriverMessage(tabId, message, options = {}) {
      if (options.incognito) {
        return sendClineDriverMessageIncognito(tabId, message, options);
      }
      if (typeof sendToContentScriptResilient !== 'function') {
        throw new Error('缺少 sendToContentScriptResilient 依赖。');
      }
      const result = await sendToContentScriptResilient(CLINE_REGISTER_SOURCE_ID, message, {
        timeoutMs: Math.max(3000, Number(options.timeoutMs) || 15000),
        retryDelayMs: 600,
        onRetryableError: async () => {
          if (typeof ensureContentScriptReadyOnTab === 'function'
            && Array.isArray(CLINE_MS_LOGIN_INJECT_FILES)
            && CLINE_MS_LOGIN_INJECT_FILES.length) {
            await ensureContentScriptReadyOnTab(CLINE_REGISTER_SOURCE_ID, tabId, {
              inject: CLINE_MS_LOGIN_INJECT_FILES,
            }).catch(() => {});
          }
        },
        logMessage: options.logMessage || '正在等待微软登录页响应...',
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result;
    }

    function resolveAuxMailnestProjectCode(state = {}) {
      return cleanString(state.clineAuxMailnestProjectCode) || CLINE_AUX_MAILNEST_DEFAULT_PROJECT;
    }

    function isMailnestWebConfigured(state = {}) {
      try {
        return Boolean(mailnestProvider?.isMailnestWebConfigured?.(state));
      } catch (_) {
        return false;
      }
    }

    /**
     * Hotmail 号池无可用微软账号时，通过 MailNest 网站账号体系购买一个
     * 「长效网页号」（默认 lweb_ocom_test），交付 content 文本解析出邮箱+密码。
     */
    async function buyMailnestMicrosoftAccount(state = {}) {
      if (typeof mailnestProvider?.buyMailnestAccounts !== 'function') {
        throw new Error('MailNest 账号购买模块未加载。');
      }
      const productType = cleanString(state.mailnestAccountProductType) || CLINE_MAILNEST_DEFAULT_ACCOUNT_PRODUCT;
      await log(`Hotmail 号池无可用微软账号，正在通过 MailNest 购买（${productType}）...`);
      const bought = await mailnestProvider.buyMailnestAccounts(state, { accountType: productType, count: 1 });
      const account = Array.isArray(bought?.accounts) ? bought.accounts[0] : null;
      const email = cleanString(account?.email).toLowerCase();
      const password = cleanString(account?.password);
      if (!email || !password) {
        throw new Error('MailNest 账号购买成功但未能从交付内容解析账号密码（格式可能已变化）。');
      }
      return { email, password, productType, orderId: cleanString(bought?.id) };
    }

    function isMailnestAuxAvailable(state = {}) {
      if (typeof mailnestProvider?.requestMailnestJson !== 'function'
        || typeof mailnestProvider?.pollMailnestVerificationCode !== 'function') {
        return false;
      }
      try {
        return Boolean(mailnestProvider.getMailnestConfig?.(state)?.apiKey);
      } catch (_) {
        return false;
      }
    }

    async function buyAuxMailnestEmail(state = {}) {
      const projectCode = resolveAuxMailnestProjectCode(state);
      const data = await mailnestProvider.requestMailnestJson(state, '/api/v1/email/temporary/buy', {
        method: 'POST',
        payload: { project_code: projectCode, count: 1 },
      });
      const email = cleanString((Array.isArray(data) ? data[0] : data)?.email).toLowerCase();
      if (!email.includes('@')) {
        throw new Error('MailNest 辅助邮箱购买响应缺少邮箱地址。');
      }
      return email;
    }

    async function pollAuxMailnestCode(state, email, { filterAfterTimestamp = 0, excludeCodes = [] } = {}) {
      const intervalMs = 4000;
      return mailnestProvider.pollMailnestVerificationCode(null, state, {
        targetEmail: email,
        filterAfterTimestamp,
        excludeCodes,
        intervalMs,
        maxAttempts: Math.max(1, Math.ceil(CLINE_AUX_CODE_TIMEOUT_MS / intervalMs)),
        subjectFilters: [...CLINE_SECURITY_CODE_SUBJECT_FILTERS],
      });
    }

    async function releaseAuxMailnestEmail(state, email) {
      if (!email || typeof mailnestProvider?.releaseMailnestEmail !== 'function') {
        return;
      }
      await mailnestProvider.releaseMailnestEmail({ email }, { state })
        .then(() => log(`已释放 MailNest 辅助邮箱 ${email}。`, 'info'))
        .catch(() => {});
    }

    async function pollAuxSecurityCode(auxAccount, { filterAfterTimestamp = 0 } = {}) {
      const helpers = getMicrosoftEmailHelpers();
      if (!helpers?.fetchMicrosoftVerificationCode) {
        throw new Error('Microsoft 邮件辅助模块（microsoft-email.js）未加载。');
      }
      return helpers.fetchMicrosoftVerificationCode({
        clientId: auxAccount.clientId,
        refreshToken: auxAccount.refreshToken,
        fetchImpl,
        maxRetries: Math.max(1, Math.ceil(CLINE_AUX_CODE_TIMEOUT_MS / 8000)),
        retryDelayMs: 4000,
        filterAfterTimestamp,
        subjectFilters: [...CLINE_SECURITY_CODE_SUBJECT_FILTERS],
        mailboxes: ['INBOX', 'Junk'],
      });
    }

    async function executeClineDriveLogin(state = {}) {
      const currentState = await getExecutionState(state);
      const runtime = readClineRuntime(currentState);
      const client = getClineClient();
      if (!client?.pickClineCodeFromUrl) {
        throw new Error('Cline 客户端模块未加载。');
      }

      const accounts = normalizeHotmailAccounts(currentState.hotmailAccounts);
      const poolTarget = accounts.find((account) => account.id === runtime.accountId)
        || accounts.find((account) => cleanString(account.email).toLowerCase() === cleanString(runtime.email).toLowerCase());
      // 购买号不在号池里：运行时凭据（prepare 阶段写入）兜底。
      const runtimeEmail = cleanString(runtime.msAccountEmail);
      const runtimePassword = cleanString(runtime.msAccountPassword);
      let target = accountHasLoginCredentials(poolTarget) ? poolTarget : null;
      if (!target && runtimeEmail && runtimePassword) {
        target = { id: '', email: runtimeEmail, password: runtimePassword };
      }
      if (!target) {
        throw new Error('缺少本轮微软账号的邮箱或密码，请重新执行「分配账号」步骤。');
      }
      const aux = runtime.auxAccountId
        ? accounts.find((account) => account.id === runtime.auxAccountId)
        : null;

      const loginIncognito = Boolean(runtime.session?.incognito);
      let tabId = Number.isInteger(runtime.session?.loginTabId) ? runtime.session.loginTabId : null;
      if (!Number.isInteger(tabId)) {
        tabId = await getTabId(CLINE_REGISTER_SOURCE_ID);
      }
      if (!Number.isInteger(tabId) || !(await isSpecificTabAlive(tabId))) {
        throw new Error('Cline 登录标签页已关闭，请重新执行「打开授权页」。');
      }

      const startedAt = Date.now();
      const challengeStartRef = { at: 0 };
      let lastAction = '';
      let lastState = '';
      let sameActionCount = 0;
      let lastAuxSubmitAt = 0;
      const submittedCodes = new Set();
      let providerErrorCount = 0;
      let deviceFlow = null;
      // 双向切换各限一次：回调被拦→设备码；设备码撞 Radar→回切回调（原版 README 经验）。
      let usedDeviceFallback = false;
      let usedCallbackFallback = false;
      let auxEmail = cleanString(runtime.auxEmail) || cleanString(aux?.email);
      let auxSource = cleanString(runtime.auxEmailSource) || (auxEmail ? 'hotmail-graph' : '');

      // WorkOS 设备码降级路径（对应原版 --device）：绕过 authkit 授权页与本地回调，
      // 由 WorkOS 轮询直接发令牌。仅对 WorkOS/AuthKit 侧错误兜底；
      // 微软账号侧的手机号验证换路径也救不了，直接抛。
      async function enterDeviceMode(reason = '') {
        if (deviceFlow || usedDeviceFallback || !client.startClineDeviceAuthorization) return false;
        usedDeviceFallback = true;
        const device = await client.startClineDeviceAuthorization({ fetchImpl });
        deviceFlow = {
          device,
          intervalMs: Math.max(2000, Number(device.interval || 5) * 1000),
          nextPollAt: Date.now() + 2000,
          expiresAt: Date.now() + Math.min(Number(device.expires_in || 300) * 1000, CLINE_DRIVE_TIMEOUT_MS),
        };
        const targetUrl = cleanString(device.verification_uri_complete) || cleanString(device.verification_uri);
        if (!targetUrl) throw new Error('WorkOS 设备码未返回验证地址。');
        await log(`授权链被 WorkOS 拦截（${reason}），切换设备码路径（用户码 ${device.user_code || '?'}）...`, 'warn');
        await chrome.tabs.update(tabId, { url: targetUrl });
        await sleepWithStop(2500);
        return true;
      }

      // Radar 是 Cline/WorkOS 风控、主要拦设备码链路（原版 README：换默认回调通常可绕过）。
      // 设备码在途中被拦时把标签页导航回已改写 provider 的微软授权 URL，继续走回调状态机。
      async function exitDeviceMode(reason = '') {
        if (usedCallbackFallback) return false;
        usedCallbackFallback = true;
        deviceFlow = null;
        const targetUrl = cleanString(runtime.loginUrl) || cleanString(runtime.authorizeUrl)
          || client.buildClineAuthorizeUrl({
            apiBase: cleanString(currentState.clineApiBase) || undefined,
            callbackUrl: cleanString(runtime.callbackUrl) || pickClineCallbackUrl(),
          });
        if (!targetUrl) return false;
        await log(`设备码链路触发风控（${reason}），切回默认回调流程重试...`, 'warn');
        await chrome.tabs.update(tabId, { url: targetUrl });
        await sleepWithStop(2500);
        return true;
      }

      async function pollDeviceOnce() {
        if (!deviceFlow || Date.now() < deviceFlow.nextPollAt) return;
        deviceFlow.nextPollAt = Date.now() + deviceFlow.intervalMs;
        const poll = await client.pollClineDeviceTokenOnce({ device: deviceFlow.device, fetchImpl });
        if (poll.status === 'slow_down') {
          deviceFlow.intervalMs += 2000;
          return;
        }
        if (poll.status === 'failed') {
          // 设备码授权被 WorkOS 拒（典型即 Radar）：回切默认回调路径再试一次。
          if (await exitDeviceMode(poll.error || 'device-token-failed')) return;
          throw new Error(poll.error || 'WorkOS 设备码登录失败。');
        }
        if (poll.status === 'success') {
          await log('设备码已授权，正在注册 Cline 会话...');
          const session = await client.registerClineSessionFromWorkos({
            apiBase: cleanString(currentState.clineApiBase) || undefined,
            workos: poll.tokens,
            fetchImpl,
          });
          await setState(buildClineRuntimePatch({
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresAt: session.expiresAt,
            loginMode: 'device',
          }));
          await log('已通过设备码路径取得 Cline 令牌。', 'ok');
          return completeNodeFromBackground('cline-drive-login', {
            session: { loginTabId: tabId },
            loginMode: 'device',
          });
        }
      }

      try {
      while (Date.now() - startedAt < CLINE_DRIVE_TIMEOUT_MS) {
        throwIfStopped();
        if (deviceFlow && Date.now() > deviceFlow.expiresAt) {
          throw new Error('WorkOS 设备码已过期，未完成授权。');
        }

        const tabUrl = await getTabUrl(tabId);
        const inlineCode = client.pickClineCodeFromUrl(tabUrl);
        if (inlineCode) {
          await log('已从回调地址取得授权码。', 'ok');
          await setState(buildClineRuntimePatch({ authorizationCode: inlineCode }));
          return completeNodeFromBackground('cline-drive-login', {
            session: { loginTabId: tabId },
            authorizationCode: inlineCode,
          });
        }
        if (/policy_denied|radar-challenge/i.test(tabUrl)) {
          const reason = tabUrl.includes('radar-challenge') ? 'radar-challenge' : 'policy_denied';
          const baseReason = tabUrl.includes('radar-challenge')
            ? 'Cline/WorkOS 风控拦截（Radar）。'
            : 'Cline 拒绝授权（policy_denied）。';
          // 已在设备码链路：Radar 专门拦设备码（原版 README），回切默认回调通常可绕过。
          if (deviceFlow) {
            try {
              if (await exitDeviceMode(reason)) continue;
            } catch (cbErr) {
              throw new Error(`${baseReason}（切回回调路径也失败：${getErrorMessage(cbErr)}）`);
            }
            throw new Error(baseReason);
          }
          try {
            if (await enterDeviceMode(reason)) continue;
          } catch (deviceErr) {
            throw new Error(`${baseReason}（设备码备用路径也失败：${getErrorMessage(deviceErr)}）`);
          }
          throw new Error(baseReason);
        }
        // 本地回环回调：连接会被拒绝，但 URL 已携带 code。
        if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(tabUrl)) {
          const code = client.pickClineCodeFromUrl(tabUrl);
          if (code) {
            await setState(buildClineRuntimePatch({ authorizationCode: code }));
            return completeNodeFromBackground('cline-drive-login', { authorizationCode: code });
          }
        }

        if (typeof ensureContentScriptReadyOnTab === 'function'
          && Array.isArray(CLINE_MS_LOGIN_INJECT_FILES)
          && CLINE_MS_LOGIN_INJECT_FILES.length) {
          await ensureContentScriptReadyOnTab(CLINE_REGISTER_SOURCE_ID, tabId, {
            inject: CLINE_MS_LOGIN_INJECT_FILES,
          }).catch(() => {});
        }

        // 页面上下文废掉 WebAuthn 已由 registerWebauthnStub（document_start 注册式
        // 脚本）覆盖——比逐轮 executeScript 更早，能拦住 fido/create 首次调用。

        let stepResult = null;
        try {
          stepResult = await sendClineDriverMessage(tabId, {
            type: 'EXECUTE_NODE',
            command: 'cline-drive-step',
            payload: { email: target.email, password: target.password },
          }, { timeoutMs: 20000, incognito: loginIncognito });
        } catch (err) {
          await log(`页面驱动暂不可用：${getErrorMessage(err)}（等待页面导航完成后继续）`, 'warn');
          await sleepWithStop(CLINE_DRIVE_POLL_INTERVAL_MS);
          continue;
        }

        const action = cleanString(stepResult?.action);
        const state = cleanString(stepResult?.state);
        if (action && action !== lastAction) {
          const pageDetail = state || cleanString(stepResult?.title) || '';
          const snippet = action === 'waiting' ? cleanString(stepResult?.pageText).slice(0, 120) : '';
          await log(`登录流转：${action}${pageDetail ? `[${pageDetail}]` : ''}${stepResult?.url ? `（${stepResult.url.slice(0, 90)}）` : ''}${snippet ? `｜${snippet}` : ''}`, 'info');
          lastAction = action;
          lastState = state;
          sameActionCount = 0;
        } else {
          sameActionCount += 1;
          // 同一动作卡住时节流重打（约每 12 秒一次）：waiting 附上页面摘要定位误检，
          // confirmed-* 附上摘要便于确认点击后页面是否真的没走。
          if (sameActionCount > 0 && sameActionCount % 8 === 0) {
            const snippet = cleanString(stepResult?.pageText).slice(0, 120);
            const tag = action || 'no-response';
            await log(`仍停留在 ${tag}${state ? `[${state}]` : lastState ? `[${lastState}]` : ''}（第 ${sameActionCount} 次）${snippet ? `｜${snippet}` : ''}${stepResult?.url ? `（${stepResult.url.slice(0, 90)}）` : ''}`, 'warn');
          }
        }

        if (action === 'provider-error') {
          providerErrorCount += 1;
          const errText = cleanString(stepResult?.providerError) || 'unknown';
          if (providerErrorCount >= 2) {
            try {
              if (await enterDeviceMode(errText)) continue;
            } catch (deviceErr) {
              throw new Error(`微软 OAuth 登录失败（${errText}）（设备码备用路径也失败：${getErrorMessage(deviceErr)}）。该账号可能被风控，换一个微软账号重试。`);
            }
            throw new Error(`微软 OAuth 登录失败（${errText}）。该账号可能被风控，换一个微软账号重试。`);
          }
          await log(`微软 OAuth 返回错误（${errText}），正在自动重试一次...`, 'warn');
          await sleepWithStop(CLINE_DRIVE_POLL_INTERVAL_MS);
          continue;
        }

        if (action === 'failed') {
          throw new Error(stepResult?.failReason || stepResult?.error || '微软登录流程失败。');
        }
        if (action === 'done') {
          const urlAfter = await getTabUrl(tabId);
          const code = client.pickClineCodeFromUrl(urlAfter);
          if (code) {
            await setState(buildClineRuntimePatch({ authorizationCode: code }));
            return completeNodeFromBackground('cline-drive-login', { authorizationCode: code });
          }
        }
        if (action === 'need-aux-email') {
          const fixedAuxEmail = cleanString(currentState.clineAuxMailnestEmail).toLowerCase();
          if (!auxEmail && fixedAuxEmail && isMailnestAuxAvailable(currentState)) {
            auxEmail = fixedAuxEmail;
            auxSource = 'mailnest-fixed';
            await setState(buildClineRuntimePatch({ auxEmail, auxEmailSource: auxSource }));
            await log(`使用固定 MailNest 辅助邮箱 ${auxEmail}。`, 'ok');
          } else if (!auxEmail && auxSource !== 'mailnest' && isMailnestAuxAvailable(currentState)) {
            auxEmail = await buyAuxMailnestEmail(currentState);
            auxSource = 'mailnest';
            await setState(buildClineRuntimePatch({ auxEmail, auxEmailSource: auxSource }));
            await log(`已通过 MailNest 购买辅助接码邮箱 ${auxEmail}（项目 ${resolveAuxMailnestProjectCode(currentState)}）。`, 'ok');
          }
          if (!auxEmail) {
            throw new Error('微软要求绑定安全备用邮箱：配置 MailNest API Key 可自动购买辅助邮箱，或在 Hotmail 号池准备带 clientId+refreshToken 的辅助账号。');
          }
          // 节流：页面跳转期间输入框仍可见，避免每轮循环重复提交。
          if (Date.now() - lastAuxSubmitAt >= 4000) {
            lastAuxSubmitAt = Date.now();
            await log(`向安全备用邮箱字段填入 ${auxEmail}...`);
            await sendClineDriverMessage(tabId, {
              type: 'EXECUTE_NODE',
              command: 'cline-submit-aux-email',
              payload: { email: auxEmail },
            }, { timeoutMs: 20000, incognito: loginIncognito });
            challengeStartRef.at = Date.now();
          }
          continue;
        }
        if (action === 'need-security-code') {
          const filterAfterTimestamp = challengeStartRef.at || (Date.now() - CLINE_AUX_CODE_LOOKBACK_MS);
          let code = '';
          if (auxSource === 'mailnest' || auxSource === 'mailnest-fixed') {
            await log(`正在通过 MailNest 从辅助邮箱 ${auxEmail} 拉取安全代码...`);
            const result = await pollAuxMailnestCode(currentState, auxEmail, {
              filterAfterTimestamp,
              excludeCodes: [...submittedCodes],
            });
            code = cleanString(result?.code);
          } else {
            if (!aux || !accountHasAuxCapability(aux)) {
              throw new Error('微软要求输入安全代码，但辅助接码账号缺少 clientId/refreshToken。');
            }
            await log(`正在通过 Graph API 从辅助邮箱 ${aux.email} 拉取安全代码...`);
            const match = await pollAuxSecurityCode(aux, { filterAfterTimestamp });
            code = cleanString(match?.code);
          }
          if (!code) {
            if (submittedCodes.size) {
              // 已提交过码但页面未前进——微软还在处理中，多等一拍而不是重复提交旧码。
              await log('安全代码已提交，等待页面响应...', 'info');
              await sleepWithStop(3000);
              continue;
            }
            throw new Error('未能从辅助邮箱获取安全代码。');
          }
          await log('已取得安全代码，正在提交。');
          await sendClineDriverMessage(tabId, {
            type: 'EXECUTE_NODE',
            command: 'cline-submit-security-code',
            payload: { code },
          }, { timeoutMs: 20000, incognito: loginIncognito });
          submittedCodes.add(code);
          continue;
        }

        const deviceResult = await pollDeviceOnce();
        if (deviceResult) return deviceResult;

        await sleepWithStop(CLINE_DRIVE_POLL_INTERVAL_MS);
      }
      } finally {
        if (auxSource === 'mailnest' && auxEmail) {
          await releaseAuxMailnestEmail(currentState, auxEmail);
        }
        // 无痕窗口跑完即关：销毁本轮微软登录会话，轮间不串号。
        const loginWindowId = runtime.session?.loginWindowId;
        if (runtime.session?.incognito && Number.isInteger(loginWindowId) && chrome?.windows?.remove) {
          await chrome.windows.remove(loginWindowId).catch(() => {});
        }
        await unregisterWebauthnStub();
      }

      throw new Error(`微软登录驱动超时（${Math.round(CLINE_DRIVE_TIMEOUT_MS / 1000)} 秒未到达回调）。`);
    }

    async function executeClineExchangeToken(state = {}) {
      const currentState = await getExecutionState(state);
      const runtime = readClineRuntime(currentState);
      const client = getClineClient();
      // 设备码路径已在驱动阶段直接拿到 Cline 会话令牌，无需换码。
      if (runtime.loginMode === 'device' && cleanString(runtime.accessToken)) {
        await log(`已取得 Cline 令牌（设备码路径，${runtime.email || ''}）。`, 'ok');
        if (typeof setCurrentHotmailAccount === 'function' && runtime.accountId) {
          await setCurrentHotmailAccount(runtime.accountId, { markUsed: true, syncEmail: false }).catch(() => {});
        }
        return completeNodeFromBackground('cline-exchange-token', {});
      }
      const code = cleanString(runtime.authorizationCode);
      if (!code) {
        throw new Error('缺少授权码，请先完成「驱动微软登录」步骤。');
      }
      const result = await client.exchangeClineAuthorizationCode({
        apiBase: cleanString(currentState.clineApiBase) || undefined,
        code,
        callbackUrl: cleanString(runtime.callbackUrl),
        fetchImpl,
      });
      await setState(buildClineRuntimePatch({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      }));
      await log(`已取得 Cline 令牌（${runtime.email || ''}）。`, 'ok');
      if (typeof setCurrentHotmailAccount === 'function' && runtime.accountId) {
        await setCurrentHotmailAccount(runtime.accountId, { markUsed: true, syncEmail: false }).catch(() => {});
      }
      return completeNodeFromBackground('cline-exchange-token', {});
    }

    return {
      executeClinePrepareAccount,
      executeClineOpenAuthorize,
      executeClineDriveLogin,
      executeClineExchangeToken,
      // 供测试与外部编排复用
      allocateClineAccounts,
      pickClineCallbackUrl,
    };
  }

  return {
    CLINE_REGISTER_SOURCE_ID,
    CLINE_SECURITY_CODE_SUBJECT_FILTERS,
    createClineRegisterRunner,
  };
});
