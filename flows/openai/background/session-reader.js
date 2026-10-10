(function attachBackgroundOpenAiSessionReader(root, factory) {
  root.MultiPageBackgroundOpenAiSessionReader = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundOpenAiSessionReaderModule() {
  const OPENAI_SESSION_SOURCE = 'openai-session';
  const OPENAI_SESSION_INJECT_FILES = [
    'content/utils.js',
    'flows/openai/content/chatgpt-session.js',
  ];
  const OPENAI_SESSION_MESSAGE = Object.freeze({
    type: 'OPENAI_SESSION_GET_CURRENT',
    source: 'background',
  });
  const SESSION_INITIAL_DELAY_MS = 1000;
  const SESSION_RETRY_DELAY_MS = 2000;
  const SESSION_READ_MAX_ATTEMPTS = 11;
  const SUPPORTED_REQUIRED_FIELDS = Object.freeze(['session', 'accessToken']);

  function normalizeString(value = '') {
    return String(value || '').trim();
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isSupportedChatGptSessionUrl(url = '') {
    try {
      const parsed = new URL(String(url || ''));
      if (!/^https?:$/i.test(parsed.protocol)) {
        return false;
      }
      const hostname = normalizeString(parsed.hostname).toLowerCase();
      return hostname === 'chatgpt.com'
        || hostname === 'www.chatgpt.com'
        || hostname === 'chat.openai.com';
    } catch {
      return false;
    }
  }

  function getSessionTabHostPriority(url = '') {
    try {
      const hostname = normalizeString(new URL(String(url || '')).hostname).toLowerCase();
      if (hostname === 'chatgpt.com' || hostname === 'www.chatgpt.com') {
        return 0;
      }
      if (hostname === 'chat.openai.com') {
        return 1;
      }
    } catch {
      return Number.POSITIVE_INFINITY;
    }
    return Number.POSITIVE_INFINITY;
  }

  function getSessionTabActivityPriority(tab = {}) {
    if (tab?.active && tab?.currentWindow) {
      return 0;
    }
    if (tab?.active) {
      return 1;
    }
    return 2;
  }

  function pickPreferredSessionTab(tabs = []) {
    const candidates = (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => Number.isInteger(tab?.id) && isSupportedChatGptSessionUrl(tab.url));
    if (!candidates.length) {
      return null;
    }

    return candidates.reduce((best, candidate) => {
      if (!best) {
        return candidate;
      }

      const candidateHostPriority = getSessionTabHostPriority(candidate.url);
      const bestHostPriority = getSessionTabHostPriority(best.url);
      if (candidateHostPriority !== bestHostPriority) {
        return candidateHostPriority < bestHostPriority ? candidate : best;
      }

      const candidateActivityPriority = getSessionTabActivityPriority(candidate);
      const bestActivityPriority = getSessionTabActivityPriority(best);
      if (candidateActivityPriority !== bestActivityPriority) {
        return candidateActivityPriority < bestActivityPriority ? candidate : best;
      }

      const candidateLastAccessed = Number(candidate?.lastAccessed) || 0;
      const bestLastAccessed = Number(best?.lastAccessed) || 0;
      if (candidateLastAccessed !== bestLastAccessed) {
        return candidateLastAccessed > bestLastAccessed ? candidate : best;
      }

      return Number(candidate.id) < Number(best.id) ? candidate : best;
    }, null);
  }

  function normalizeAutomationWindowId(state = {}) {
    const windowId = Number(state?.automationWindowId);
    return Number.isInteger(windowId) && windowId > 0 ? windowId : 0;
  }

  function normalizeRequiredFields(requiredFields) {
    if (requiredFields === undefined) {
      return ['session'];
    }
    if (!Array.isArray(requiredFields) || !requiredFields.length) {
      throw new Error('OpenAI session reader 的 requiredFields 必须是非空数组。');
    }

    const normalized = Array.from(new Set(requiredFields.map((field) => normalizeString(field))));
    const unsupportedFields = normalized.filter((field) => !SUPPORTED_REQUIRED_FIELDS.includes(field));
    if (unsupportedFields.length) {
      throw new Error(`OpenAI session reader 的 requiredFields 包含不支持的字段：${unsupportedFields.join(', ')}`);
    }
    return normalized;
  }

  function normalizeSessionResult(result, visibleStep) {
    if (!isPlainObject(result)) {
      throw new Error(`步骤 ${visibleStep}：ChatGPT 会话消息协议返回格式无效。`);
    }
    if (result.stopped) {
      throw new Error(normalizeString(result.error) || '流程已被用户停止。');
    }
    if (result.ok !== true) {
      throw new Error(normalizeString(result.error) || `步骤 ${visibleStep}：ChatGPT 会话消息协议执行失败。`);
    }

    const session = isPlainObject(result.session) ? result.session : null;
    return {
      session,
      accessToken: normalizeString(
        result.accessToken
        || session?.accessToken
        || session?.access_token
      ),
    };
  }

  function getMissingRequiredFields(sessionState = {}, requiredFields = []) {
    return requiredFields.filter((field) => {
      if (field === 'session') {
        return !isPlainObject(sessionState.session) || !Object.keys(sessionState.session).length;
      }
      if (field === 'accessToken') {
        return !normalizeString(sessionState.accessToken);
      }
      return true;
    });
  }

  function createOpenAiSessionReader(deps = {}) {
    const {
      addLog = null,
      chrome,
      ensureContentScriptReadyOnTabUntilStopped,
      getTabId,
      getStepIdByKeyForState = null,
      isTabAlive,
      registerTab,
      sendTabMessageUntilStopped,
      sleepWithStop = async () => {},
      waitForTabCompleteUntilStopped = async () => {},
    } = deps;

    function resolveVisibleStep(state = {}, options = {}) {
      const visibleStep = Math.floor(Number(options?.visibleStep ?? state?.visibleStep) || 0);
      if (visibleStep > 0) {
        return visibleStep;
      }
      const stepKey = normalizeString(options?.stepKey || state?.nodeId);
      const resolvedStep = typeof getStepIdByKeyForState === 'function'
        ? Math.floor(Number(getStepIdByKeyForState(stepKey, state)) || 0)
        : 0;
      if (resolvedStep > 0) {
        return resolvedStep;
      }
      throw new Error(`无法解析 ${stepKey || 'OpenAI Session 读取节点'} 的当前步骤，请检查 workflow 装配。`);
    }

    async function readSupportedSessionTab(tabId, automationWindowId = 0) {
      const numericTabId = Number(tabId) || 0;
      if (!numericTabId || !chrome?.tabs?.get) {
        return null;
      }

      const tab = await chrome.tabs.get(numericTabId).catch(() => null);
      if (!tab?.id || !isSupportedChatGptSessionUrl(tab.url)) {
        return null;
      }
      if (automationWindowId && Number(tab.windowId) !== automationWindowId) {
        return null;
      }
      return tab;
    }

    async function findFallbackSessionTab(automationWindowId = 0) {
      if (!chrome?.tabs?.query) {
        return null;
      }

      if (automationWindowId) {
        const windowTabs = await chrome.tabs.query({ windowId: automationWindowId }).catch(() => []);
        return pickPreferredSessionTab(windowTabs);
      }

      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const activeMatch = pickPreferredSessionTab(activeTabs);
      const allTabs = await chrome.tabs.query({}).catch(() => []);
      const globalMatch = pickPreferredSessionTab(allTabs);
      return pickPreferredSessionTab([activeMatch, globalMatch]);
    }

    async function resolveSessionTabId(state = {}) {
      const automationWindowId = normalizeAutomationWindowId(state);
      const registeredTabId = typeof getTabId === 'function'
        ? await getTabId(OPENAI_SESSION_SOURCE)
        : null;
      const registeredTabAlive = registeredTabId
        && (typeof isTabAlive !== 'function' || await isTabAlive(OPENAI_SESSION_SOURCE));
      if (registeredTabAlive) {
        const registeredTab = await readSupportedSessionTab(registeredTabId, automationWindowId);
        if (registeredTab?.id) {
          return registeredTab.id;
        }
      }

      const fallbackTab = await findFallbackSessionTab(automationWindowId);
      if (fallbackTab?.id) {
        if (typeof registerTab === 'function') {
          await registerTab(OPENAI_SESSION_SOURCE, fallbackTab.id);
        }
        return fallbackTab.id;
      }

      const windowHint = automationWindowId ? '当前自动化窗口内' : '';
      throw new Error(`未找到可读取 ChatGPT 会话的标签页，请先在${windowHint || '浏览器中'}打开一个已登录的 ChatGPT 页面。`);
    }

    async function getResolvedSessionTab(tabId, visibleStep, targetLabel = '', automationWindowId = 0) {
      const tab = await chrome?.tabs?.get?.(tabId).catch(() => null);
      const targetSuffix = targetLabel ? `，无法继续交付到 ${targetLabel}` : '';
      if (!tab?.id || (automationWindowId && Number(tab.windowId) !== automationWindowId)) {
        throw new Error(`步骤 ${visibleStep}：ChatGPT 会话标签页不存在、已关闭或已离开当前自动化窗口${targetSuffix}。`);
      }
      if (!isSupportedChatGptSessionUrl(tab.url)) {
        throw new Error(`步骤 ${visibleStep}：当前标签页不在可读取 ChatGPT 会话的页面${targetSuffix}。`);
      }
      return tab;
    }

    async function readCurrentChatGptSession(tabId, visibleStep, options = {}) {
      const requiredFields = normalizeRequiredFields(options.requiredFields);
      const targetLabel = normalizeString(options.targetLabel);
      const automationWindowId = Math.max(0, Number(options.automationWindowId) || 0);

      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(SESSION_INITIAL_DELAY_MS);
      await ensureContentScriptReadyOnTabUntilStopped(OPENAI_SESSION_SOURCE, tabId, {
        inject: OPENAI_SESSION_INJECT_FILES,
        injectSource: OPENAI_SESSION_SOURCE,
        logMessage: `步骤 ${visibleStep}：正在等待 ChatGPT 会话页面完成加载，再继续读取当前登录会话...`,
      });

      let missingFields = requiredFields;
      let reloadedAfterForbidden = false;
      for (let attempt = 1; attempt <= SESSION_READ_MAX_ATTEMPTS; attempt += 1) {
        await getResolvedSessionTab(tabId, visibleStep, targetLabel, automationWindowId);
        const rawResult = await sendTabMessageUntilStopped(
          tabId,
          OPENAI_SESSION_SOURCE,
          OPENAI_SESSION_MESSAGE
        );
        if (
          rawResult?.ok !== true
          && Number(rawResult?.status) === 403
          && !reloadedAfterForbidden
          && typeof chrome?.tabs?.reload === 'function'
        ) {
          reloadedAfterForbidden = true;
          await addLog?.(
            `步骤 ${visibleStep}：ChatGPT 会话接口返回 403，刷新 chatgpt.com 标签页后重试...`,
            'info',
            { step: visibleStep }
          );
          await chrome.tabs.reload(tabId).catch(() => {});
          await waitForTabCompleteUntilStopped(tabId);
          await ensureContentScriptReadyOnTabUntilStopped(OPENAI_SESSION_SOURCE, tabId, {
            inject: OPENAI_SESSION_INJECT_FILES,
            injectSource: OPENAI_SESSION_SOURCE,
            logMessage: `步骤 ${visibleStep}：chatgpt.com 刷新完成，重新加载会话读取驱动...`,
          });
          continue;
        }
        const sessionState = normalizeSessionResult(rawResult, visibleStep);
        missingFields = getMissingRequiredFields(sessionState, requiredFields);
        if (!missingFields.length) {
          return sessionState;
        }
        if (attempt < SESSION_READ_MAX_ATTEMPTS) {
          await sleepWithStop(SESSION_RETRY_DELAY_MS);
        }
      }

      throw new Error(
        `步骤 ${visibleStep}：连续读取 ${SESSION_READ_MAX_ATTEMPTS} 次仍未获取必需字段 ${missingFields.join(', ')}，请确认 ChatGPT 已登录。`
      );
    }

    async function readCurrentSessionFromState(state = {}, options = {}) {
      const requiredFields = normalizeRequiredFields(options.requiredFields);
      const visibleStep = resolveVisibleStep(state, options);
      const targetLabel = normalizeString(options.targetLabel);
      const automationWindowId = normalizeAutomationWindowId(state);
      const tabId = await resolveSessionTabId(state);
      const tab = await getResolvedSessionTab(tabId, visibleStep, targetLabel, automationWindowId);
      if (chrome?.tabs?.update && options?.activateTab !== false) {
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      }
      const sessionState = await readCurrentChatGptSession(tab.id, visibleStep, {
        automationWindowId,
        requiredFields,
        targetLabel,
      });
      return {
        ...sessionState,
        tab,
        tabId: tab.id,
      };
    }

    return {
      getResolvedSessionTab,
      readCurrentChatGptSession,
      readCurrentSessionFromState,
      resolveSessionTabId,
    };
  }

  return {
    OPENAI_SESSION_INJECT_FILES,
    OPENAI_SESSION_SOURCE,
    SESSION_INITIAL_DELAY_MS,
    SESSION_READ_MAX_ATTEMPTS,
    SESSION_RETRY_DELAY_MS,
    createOpenAiSessionReader,
    isSupportedChatGptSessionUrl,
    pickPreferredSessionTab,
  };
});
