(function attachBackgroundOpenAiPublisherChatgpt2Api(root, factory) {
  root.MultiPageBackgroundOpenAiPublisherChatgpt2Api = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundOpenAiPublisherChatgpt2ApiModule() {
  const CHATGPT2API_ACCOUNTS_PATH = '/api/accounts';

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : cleanString(error) || '未知错误';
  }

  async function readResponse(response) {
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_error) {
      json = null;
    }
    return { text, json };
  }

  function readChatgpt2ApiDetailMessage(detail) {
    if (Array.isArray(detail)) {
      return cleanString(detail.map((item) => {
        if (isPlainObject(item)) {
          const loc = Array.isArray(item.loc)
            ? item.loc.map((part) => cleanString(part)).filter((part) => part && part !== 'body').join('.')
            : cleanString(item.loc);
          const message = cleanString(item.msg || item.message || item.error || item.type);
          return [loc, message].filter(Boolean).join(': ');
        }
        return cleanString(item);
      }).filter(Boolean).join('; '));
    }
    if (isPlainObject(detail)) {
      const error = detail.error;
      return cleanString(
        (isPlainObject(error) ? error.message : error)
        || detail.message
        || detail.msg
      );
    }
    return cleanString(detail);
  }

  function buildChatgpt2ApiSuccessMessage(payload = {}) {
    if (!isPlainObject(payload)) {
      return '';
    }
    const hasCounts = ['added', 'skipped', 'refreshed'].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
    if (!hasCounts) {
      return cleanString(payload.message || '');
    }
    const added = Math.max(0, Number(payload.added) || 0);
    const skipped = Math.max(0, Number(payload.skipped) || 0);
    const refreshed = Math.max(0, Number(payload.refreshed) || 0);
    const errors = Array.isArray(payload.errors) ? payload.errors.length : 0;
    return `新增 ${added} 个，跳过 ${skipped} 个，刷新 ${refreshed} 个${errors ? `，失败 ${errors} 个` : ''}`;
  }

  function readChatgpt2ApiResponseMessage(body = {}, fallback = '') {
    const error = body?.json?.error;
    return cleanString(
      (isPlainObject(error) ? error.message : error)
      || body?.json?.message
      || readChatgpt2ApiDetailMessage(body?.json?.detail)
      || buildChatgpt2ApiSuccessMessage(body?.json)
      || fallback
    );
  }

  function normalizeChatgpt2ApiBaseUrl(value = '') {
    const rawUrl = cleanString(value);
    if (!rawUrl) {
      throw new Error('缺少 ChatGPT2API 地址。');
    }
    const withProtocol = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
    let parsed = null;
    try {
      parsed = new URL(withProtocol);
    } catch (_error) {
      throw new Error('ChatGPT2API 地址格式无效，请检查配置。');
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error('ChatGPT2API 地址只支持 http 或 https。');
    }
    return parsed.origin;
  }

  function buildChatgpt2ApiAccountsUrl(value = '') {
    return `${normalizeChatgpt2ApiBaseUrl(value)}${CHATGPT2API_ACCOUNTS_PATH}`;
  }

  function normalizeChatgpt2ApiAdminKey(value = '') {
    return cleanString(value);
  }

  function resolveOpenAiChatgpt2ApiConfig(state = {}) {
    const nestedConfig = state?.settingsState?.flows?.openai?.targets?.chatgpt2api || {};
    return {
      baseUrl: cleanString(nestedConfig.baseUrl || state?.openaiChatgpt2ApiUrl),
      apiKey: normalizeChatgpt2ApiAdminKey(nestedConfig.apiKey ?? state?.openaiChatgpt2ApiAdminKey ?? ''),
    };
  }

  function buildOpenAiSessionImportPayload(session = null, accessToken = '', credentials = null) {
    const token = cleanString(accessToken || session?.access_token || session?.accessToken);
    if (!token) {
      throw new Error('缺少 ChatGPT 会话 accessToken。');
    }
    const email = cleanString(credentials?.email);
    const password = cleanString(credentials?.password);
    if (email && password) {
      return {
        accounts: [{
          access_token: token,
          email,
          password,
        }],
      };
    }
    return {
      tokens: [token],
    };
  }

  function resolveOpenAiRegistrationCredentials(state = {}) {
    return {
      email: cleanString(state?.email),
      password: cleanString(state?.password || state?.customPassword),
    };
  }

  async function uploadOpenAiSessionToChatgpt2Api(baseUrl, apiKey, sessionState = {}, fetchImpl, credentials = null) {
    const endpointUrl = buildChatgpt2ApiAccountsUrl(baseUrl);
    const normalizedApiKey = normalizeChatgpt2ApiAdminKey(apiKey);
    if (!normalizedApiKey) {
      throw new Error('缺少 ChatGPT2API Admin Key。');
    }

    const response = await fetchImpl(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${normalizedApiKey}`,
      },
      body: JSON.stringify(buildOpenAiSessionImportPayload(
        isPlainObject(sessionState?.session) ? sessionState.session : null,
        sessionState?.accessToken,
        credentials
      )),
    });
    const body = await readResponse(response);
    if (!response.ok) {
      const message = readChatgpt2ApiResponseMessage(body, response.statusText) || `HTTP ${response.status}`;
      throw new Error(`ChatGPT2API 会话上传失败：${message}`);
    }
    return {
      endpointUrl,
      message: readChatgpt2ApiResponseMessage(body, '') || '上传成功',
      raw: body.json,
    };
  }

  function createOpenAiChatgpt2ApiPublisher(deps = {}) {
    const {
      addLog = async () => {},
      broadcastDataUpdate = null,
      completeNodeFromBackground,
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      getStepIdByKeyForState = null,
      getState = async () => ({}),
      setState = async () => {},
    } = deps;

    if (typeof completeNodeFromBackground !== 'function') {
      throw new Error('OpenAI ChatGPT2API 上传器缺少 completeNodeFromBackground。');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('OpenAI ChatGPT2API 上传器缺少 fetch 支持。');
    }

    let sessionReader = null;

    function getSessionReader() {
      if (sessionReader) {
        return sessionReader;
      }
      const factory = deps.createOpenAiSessionReader
        || self.MultiPageBackgroundOpenAiSessionReader?.createOpenAiSessionReader;
      if (typeof factory !== 'function') {
        throw new Error('OpenAI 会话读取模块未加载。');
      }
      sessionReader = factory(deps);
      return sessionReader;
    }

    async function log(message, level = 'info', nodeId = '') {
      await addLog(message, level, nodeId ? { nodeId } : {});
    }

    async function setUploadState(patch = {}) {
      const updates = {
        openaiChatgpt2ApiUploadStatus: cleanString(patch.status),
        openaiChatgpt2ApiUploadedAt: Math.max(0, Number(patch.uploadedAt) || 0),
        openaiChatgpt2ApiUploadMessage: cleanString(patch.message),
        openaiChatgpt2ApiTargetUrl: cleanString(patch.targetUrl),
      };
      await setState(updates);
      if (typeof broadcastDataUpdate === 'function') {
        broadcastDataUpdate(updates);
      }
      return updates;
    }

    function resolveVisibleStep(state = {}, stepKey = '') {
      const visibleStep = Math.floor(Number(state?.visibleStep) || 0);
      if (visibleStep > 0) {
        return visibleStep;
      }
      const resolvedStep = typeof getStepIdByKeyForState === 'function'
        ? Math.floor(Number(getStepIdByKeyForState(stepKey, state)) || 0)
        : 0;
      if (resolvedStep > 0) {
        return resolvedStep;
      }
      throw new Error(`无法解析 ${stepKey || 'OpenAI ChatGPT2API 交付节点'} 的当前步骤，请检查 workflow 装配。`);
    }

    async function executeOpenAiUploadSessionToChatgpt2Api(state = {}) {
      const nodeId = cleanString(state?.nodeId) || 'openai-upload-session-to-chatgpt2api';
      const visibleStep = resolveVisibleStep(state, nodeId);
      const currentState = await getState();
      let failureTargetUrl = '';
      try {
        const targetConfig = resolveOpenAiChatgpt2ApiConfig(currentState);
        const endpointUrl = buildChatgpt2ApiAccountsUrl(targetConfig.baseUrl);
        failureTargetUrl = endpointUrl;
        const apiKey = normalizeChatgpt2ApiAdminKey(targetConfig.apiKey);
        if (!apiKey) {
          throw new Error('缺少 ChatGPT2API Admin Key。');
        }

        await setUploadState({
          status: 'reading_session',
          uploadedAt: 0,
          message: '',
          targetUrl: endpointUrl,
        });
        await log(`步骤 ${visibleStep}：正在读取当前 ChatGPT 会话，准备上传到 ChatGPT2API...`, 'info', nodeId);
        const sessionState = await getSessionReader().readCurrentSessionFromState(currentState, {
          visibleStep,
          targetLabel: 'ChatGPT2API',
          requiredFields: ['accessToken'],
        });

        await setUploadState({
          status: 'uploading',
          uploadedAt: 0,
          message: '',
          targetUrl: endpointUrl,
        });
        await log(`步骤 ${visibleStep}：正在上传 ChatGPT 会话到 ChatGPT2API...`, 'info', nodeId);
        const uploadResult = await uploadOpenAiSessionToChatgpt2Api(
          targetConfig.baseUrl,
          apiKey,
          sessionState,
          fetchImpl,
          resolveOpenAiRegistrationCredentials(currentState)
        );
        const payload = await setUploadState({
          status: 'uploaded',
          uploadedAt: Date.now(),
          message: uploadResult.message || '上传成功',
          targetUrl: uploadResult.endpointUrl,
        });
        await log(`步骤 ${visibleStep}：ChatGPT 会话已上传到 ChatGPT2API，状态：${uploadResult.message || '上传成功'}。`, 'ok', nodeId);
        await completeNodeFromBackground(nodeId, payload);
      } catch (error) {
        const message = getErrorMessage(error);
        await setUploadState({
          status: 'error',
          uploadedAt: 0,
          message,
          targetUrl: failureTargetUrl,
        });
        await log(`步骤 ${visibleStep}：${message}`, 'error', nodeId);
        throw error;
      }
    }

    return {
      executeOpenAiUploadSessionToChatgpt2Api,
    };
  }

  return {
    buildChatgpt2ApiAccountsUrl,
    buildOpenAiSessionImportPayload,
    createOpenAiChatgpt2ApiPublisher,
    normalizeChatgpt2ApiBaseUrl,
    resolveOpenAiRegistrationCredentials,
    uploadOpenAiSessionToChatgpt2Api,
  };
});
