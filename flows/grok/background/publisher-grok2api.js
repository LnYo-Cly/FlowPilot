(function attachBackgroundGrokPublisherGrok2Api(root, factory) {
  root.MultiPageBackgroundGrokPublisherGrok2Api = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundGrokPublisherGrok2ApiModule(root) {
  const grokStateApi = root?.MultiPageBackgroundGrokState || null;
  const GROK2API_LOGIN_PATH = '/api/admin/v1/auth/login';
  const GROK2API_WEB_IMPORT_PATH = '/api/admin/v1/accounts/web/import';
  const GROK2API_CONSOLE_IMPORT_PATH = '/api/admin/v1/accounts/console/import';
  const DEFAULT_GROK2API_USERNAME = 'admin';
  const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
  const GROK2API_TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
  // 与 chenyme/grok2api account.CurrentWebToSVersion 对齐（当前 = 5）。
  // 注册页已通过 tos_gate 自动确认，导入时如实上报当前版本号。
  const GROK_WEB_TOS_VERSION = 5;
  const adminTokenCache = new Map();

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function cloneValue(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => cloneValue(entry));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => [key, cloneValue(entryValue)])
      );
    }
    return value;
  }

  function deepMerge(baseValue, patchValue) {
    if (Array.isArray(patchValue)) {
      return patchValue.map((entry) => cloneValue(entry));
    }
    if (!isPlainObject(patchValue)) {
      return patchValue === undefined ? cloneValue(baseValue) : patchValue;
    }

    const baseObject = isPlainObject(baseValue) ? baseValue : {};
    const next = {
      ...cloneValue(baseObject),
    };
    Object.entries(patchValue).forEach(([key, value]) => {
      next[key] = deepMerge(baseObject[key], value);
    });
    return next;
  }

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : cleanString(error) || '未知错误';
  }

  function sanitizeSensitiveMessage(value = '', sensitiveValues = []) {
    let message = cleanString(value).slice(0, 500);
    const secrets = Array.from(new Set(
      (Array.isArray(sensitiveValues) ? sensitiveValues : [])
        .map((entry) => cleanString(entry))
        .filter(Boolean)
        .sort((left, right) => right.length - left.length)
    ));
    secrets.forEach((secret) => {
      message = message.split(secret).join('[REDACTED]');
    });
    return message;
  }

  function formatErrorValue(value) {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => formatErrorValue(entry)).filter(Boolean).join('; ');
    }
    if (isPlainObject(value)) {
      const nestedMessage = value.message || value.msg || value.error || value.detail;
      if (nestedMessage !== undefined) {
        return formatErrorValue(nestedMessage);
      }
      try {
        return JSON.stringify(value);
      } catch (_error) {
        return '';
      }
    }
    return cleanString(value);
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

  function readGrok2ApiErrorMessage(body = {}, fallback = '', sensitiveValues = []) {
    const rawMessage = body?.json?.error?.message
      ?? body?.json?.error
      ?? body?.json?.detail
      ?? body?.json?.message
      ?? body?.json?.msg
      ?? body?.text
      ?? fallback;
    return sanitizeSensitiveMessage(formatErrorValue(rawMessage) || fallback, sensitiveValues);
  }

  function normalizeGrok2ApiBaseUrl(value = '') {
    const rawUrl = cleanString(value);
    if (!rawUrl) {
      throw new Error('缺少 grok2api 地址。');
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) && !/^https?:\/\//i.test(rawUrl)) {
      throw new Error('grok2api 地址只支持 http 或 https。');
    }
    const withProtocol = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
    let parsed = null;
    try {
      parsed = new URL(withProtocol);
    } catch (_error) {
      throw new Error('grok2api 地址格式无效，请检查配置。');
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error('grok2api 地址只支持 http 或 https。');
    }
    return parsed.origin;
  }

  function buildGrok2ApiLoginUrl(value = '') {
    return `${normalizeGrok2ApiBaseUrl(value)}${GROK2API_LOGIN_PATH}`;
  }

  function buildGrok2ApiWebImportUrl(value = '') {
    return `${normalizeGrok2ApiBaseUrl(value)}${GROK2API_WEB_IMPORT_PATH}`;
  }

  function buildGrok2ApiConsoleImportUrl(value = '') {
    return `${normalizeGrok2ApiBaseUrl(value)}${GROK2API_CONSOLE_IMPORT_PATH}`;
  }

  function normalizeGrok2ApiCredentials(value = {}) {
    if (typeof value === 'string') {
      return {
        username: DEFAULT_GROK2API_USERNAME,
        password: cleanString(value),
      };
    }
    return {
      username: cleanString(value?.username) || DEFAULT_GROK2API_USERNAME,
      password: cleanString(value?.password ?? value?.apiKey),
    };
  }

  function decodeJwtPayload(token = '') {
    const parts = cleanString(token).split('.');
    if (parts.length < 2) return {};
    try {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const json = typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf8');
      return JSON.parse(json) || {};
    } catch (_error) {
      return {};
    }
  }

  function resolveSsoUserId(ssoCookie = '') {
    const payload = decodeJwtPayload(ssoCookie);
    return cleanString(payload.sub || payload.principal_id || payload.user_id || '');
  }

  function buildGrok2ApiWebImportDocument(options = {}) {
    const ssoToken = cleanString(options.ssoToken);
    if (!ssoToken) {
      throw new Error('缺少 Grok SSO Cookie，请先完成 SSO 提取步骤。');
    }
    const email = cleanString(options.email);
    const userId = cleanString(options.userId) || email || 'grok-web';
    const name = cleanString(options.name) || email || userId;
    const account = {
      name,
      email,
      user_id: userId,
      sso_token: ssoToken,
      token: '',
      tier: cleanString(options.tier) || 'auto',
      cloudflare_cookies: cleanString(options.cloudflareCookies),
    };
    // 注册流程已自动通过 tos_gate，导入时如实上报已接受与版本号；
    // 缺此项时服务端会把账号视为未接受条款。
    if (options.tosAccepted) {
      account.tos_accepted_at = new Date().toISOString();
      account.tos_version = GROK_WEB_TOS_VERSION;
    }
    return {
      provider: 'grok_web',
      accounts: [account],
    };
  }

  function buildGrok2ApiConsoleImportDocument(options = {}) {
    const ssoToken = cleanString(options.ssoToken);
    if (!ssoToken) {
      throw new Error('缺少 Grok SSO Cookie，请先完成 SSO 提取步骤。');
    }
    const email = cleanString(options.email);
    const userId = cleanString(options.userId) || email || 'grok-console';
    const localPart = email ? email.split('@', 1)[0] : userId;
    const name = cleanString(options.name) || `Grok Console ${localPart}`.trim();
    return {
      provider: 'grok_console',
      accounts: [{
        name,
        email,
        user_id: userId,
        sso_token: ssoToken,
        token: '',
        cloudflare_cookies: cleanString(options.cloudflareCookies),
      }],
    };
  }

  function parseSseEventStream(text = '') {
    const events = [];
    let eventName = 'message';
    let dataLines = [];
    const flush = () => {
      if (!dataLines.length) return;
      let data = null;
      const raw = dataLines.join('\n');
      try {
        data = JSON.parse(raw);
      } catch (_error) {
        data = raw;
      }
      events.push({ event: eventName, data });
      eventName = 'message';
      dataLines = [];
    };
    String(text || '').split(/\r?\n/).forEach((line) => {
      if (!line) {
        flush();
        return;
      }
      if (line.startsWith(':')) return;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || 'message';
        return;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^\s/, ''));
      }
    });
    flush();
    return events;
  }

  function resolveImportOutcome(events = []) {
    const errorEvent = events.find((entry) => entry.event === 'error');
    if (errorEvent) {
      return {
        ok: false,
        message: formatErrorValue(errorEvent.data) || '导入账号失败',
      };
    }
    const completeEvent = [...events].reverse().find((entry) => entry.event === 'complete');
    if (!completeEvent || !isPlainObject(completeEvent.data)) {
      return { ok: false, message: '导入结果缺失 complete 事件' };
    }
    const data = completeEvent.data;
    const created = Math.max(0, Number(data.created) || 0);
    const updated = Math.max(0, Number(data.updated) || 0);
    const skipped = Math.max(0, Number(data.skipped) || 0);
    const failed = Math.max(0, Number(data.failed) || 0);
    const synced = Math.max(0, Number(data.synced) || 0);
    const syncFailed = Math.max(0, Number(data.syncFailed) || 0);
    return {
      ok: created + updated + skipped > 0,
      created,
      updated,
      skipped,
      failed,
      synced,
      syncFailed,
      message: `新增 ${created} 个，更新 ${updated} 个，跳过 ${skipped} 个${failed ? `，失败 ${failed} 个` : ''}`,
    };
  }

  function readGrokRuntime(state = {}) {
    return grokStateApi?.ensureRuntimeState
      ? grokStateApi.ensureRuntimeState(state)
      : (isPlainObject(state?.runtimeState?.flowState?.grok)
        ? state.runtimeState.flowState.grok
        : (isPlainObject(state?.flowState?.grok) ? state.flowState.grok : {}));
  }

  function buildCanonicalRuntimePatch(currentState = {}, nextRuntimeState = {}) {
    if (typeof grokStateApi?.buildRuntimeStatePatch === 'function') {
      return grokStateApi.buildRuntimeStatePatch(currentState, nextRuntimeState);
    }
    const baseRuntimeState = isPlainObject(currentState?.runtimeState)
      ? cloneValue(currentState.runtimeState)
      : {};
    const baseFlowState = isPlainObject(baseRuntimeState.flowState)
      ? cloneValue(baseRuntimeState.flowState)
      : {};
    return {
      runtimeState: {
        ...baseRuntimeState,
        flowState: {
          ...baseFlowState,
          grok: deepMerge(readGrokRuntime(currentState), nextRuntimeState),
        },
      },
    };
  }

  function mergeRuntimePatch(currentState = {}, patch = {}) {
    return buildCanonicalRuntimePatch(
      currentState,
      deepMerge(readGrokRuntime(currentState), patch)
    );
  }

  function resolveGrok2ApiConfig(state = {}) {
    const nestedConfig = state?.settingsState?.flows?.grok?.targets?.grok2api || {};
    return {
      baseUrl: cleanString(nestedConfig.baseUrl || state?.grok2ApiUrl),
      username: cleanString(nestedConfig.username || state?.grok2ApiUsername) || DEFAULT_GROK2API_USERNAME,
      password: cleanString(
        nestedConfig.password
        ?? nestedConfig.apiKey
        ?? state?.grok2ApiPassword
        ?? state?.grok2ApiAdminKey
        ?? ''
      ),
    };
  }

  function resolveGrokSsoCookie(state = {}) {
    const runtimeState = readGrokRuntime(state);
    return cleanString(runtimeState?.sso?.currentCookie || state?.grokSsoCookie);
  }

  function resolveGrokAccountEmail(state = {}) {
    return cleanString(
      state?.grokEmail
      || state?.email
      || state?.accountIdentifier
      || readGrokRuntime(state)?.register?.email
      || ''
    ).toLowerCase();
  }

  async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function loginGrok2ApiAdmin(baseUrl, credentials, fetchImpl, options = {}) {
    const endpointUrl = buildGrok2ApiLoginUrl(baseUrl);
    const timeoutMs = Math.max(1, Number(options?.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
    const sensitiveValues = [credentials.password];
    let response = null;
    try {
      response = await fetchWithTimeout(fetchImpl, endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          username: credentials.username,
          password: credentials.password,
        }),
      }, timeoutMs);
    } catch (error) {
      const message = sanitizeSensitiveMessage(getErrorMessage(error), sensitiveValues);
      throw new Error(`grok2api 管理员登录失败：${message}`);
    }
    const body = await readResponse(response);
    if (!response.ok) {
      const message = readGrok2ApiErrorMessage(body, response.statusText || `HTTP ${response.status}`, sensitiveValues);
      throw new Error(`grok2api 管理员登录失败：${message}`);
    }
    const accessToken = cleanString(
      body?.json?.data?.tokens?.accessToken
      || body?.json?.data?.accessToken
      || body?.json?.accessToken
      || ''
    );
    if (!accessToken) {
      throw new Error('grok2api 管理员登录失败：响应缺少 accessToken。');
    }
    return accessToken;
  }

  const GROK2API_BUILD_IMPORT_PATH = '/api/admin/v1/accounts/import';

  function buildGrok2ApiBuildImportUrl(value = '') {
    return `${normalizeGrok2ApiBaseUrl(value)}${GROK2API_BUILD_IMPORT_PATH}`;
  }

  async function uploadGrokSsoToGrok2Api(baseUrl, credentialsInput, ssoCookie, fetchImpl, options = {}) {
    const credentials = normalizeGrok2ApiCredentials(credentialsInput);
    if (!credentials.password) {
      throw new Error('缺少 grok2api 管理员密码。');
    }
    const normalizedSsoCookie = cleanString(ssoCookie);
    if (!normalizedSsoCookie) {
      throw new Error('缺少 Grok SSO Cookie，请先完成 SSO 提取步骤。');
    }
    const email = cleanString(options?.email);
    // user_id 优先用 OAuth access_token 的 principal（sso JWT 通常只有
    // session_id，解不出用户 ID——对齐可用平台导出里的 UUID 形态）。
    const userId = cleanString(options?.userId)
      || cleanString(options?.tokenRecord?.user_id)
      || resolveSsoUserId(normalizedSsoCookie)
      || email;
    const timeoutMs = Math.max(1, Number(options?.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
    const cacheKey = `${normalizeGrok2ApiBaseUrl(baseUrl)}|${credentials.username}`;
    let accessToken = '';
    const sensitiveValues = () => [
      credentials.password,
      accessToken,
      normalizedSsoCookie,
      cleanString(options?.tokenRecord?.access_token),
      cleanString(options?.tokenRecord?.refresh_token),
      cleanString(options?.tokenRecord?.id_token),
      cleanString(options?.cloudflareCookies),
      cleanString(options?.consoleCloudflareCookies),
    ];

    // 对齐可用平台导出的 grok_web 账号契约（实测可用 JSON）：
    // - web: {provider:'grok_web', accounts:[{name:'Grok Web x', email,
    //   user_id:<OAuth principal>, sso_token, token:'', tier:'basic',
    //   cloudflare_cookies:''}]}（files 字段）
    // - console: {provider:'grok_console', accounts:[...]} JSON（files 字段）
    // - build: grok_build 单对象 JSON（file 字段，auth.json，需 OAuth token）
    // 账号级 cf cookie 一律传空——跨 IP 的 cf cookie 只会被 CF 标记。
    const uploads = [
      {
        label: 'web',
        url: buildGrok2ApiWebImportUrl(baseUrl),
        field: 'files',
        fileName: `g2a-web-${(email || userId || 'account').replace(/[^a-z0-9@._-]/gi, '_')}.json`,
        content: JSON.stringify(buildGrok2ApiWebImportDocument({
          ssoToken: normalizedSsoCookie,
          email,
          userId,
          name: `Grok Web ${email ? email.split('@', 1)[0] : userId}`.trim(),
          tier: 'basic',
        })),
        contentType: 'application/json',
        required: true,
      },
      {
        label: 'console',
        url: buildGrok2ApiConsoleImportUrl(baseUrl),
        field: 'files',
        fileName: `g2a-console-${(email || userId || 'account').replace(/[^a-z0-9@._-]/gi, '_')}.json`,
        content: JSON.stringify(buildGrok2ApiConsoleImportDocument({
          ssoToken: normalizedSsoCookie,
          email,
          userId,
          cloudflareCookies: '',
        })),
        contentType: 'application/json',
        required: true,
      },
    ];
    const tokenRecord = options?.tokenRecord;
    const hasOAuthCredentials = Boolean(
      tokenRecord && (cleanString(tokenRecord.access_token) || cleanString(tokenRecord.refresh_token))
    );
    if (hasOAuthCredentials) {
      const deviceFlowModule = root?.MultiPageBackgroundGrokSsoDeviceFlow || null;
      if (typeof deviceFlowModule?.buildGrok2ApiBuildImportDocument !== 'function') {
        throw new Error('SSO→OAuth 凭据转换模块未加载。');
      }
      uploads.push({
        label: 'build',
        url: buildGrok2ApiBuildImportUrl(baseUrl),
        field: 'file',
        fileName: 'auth.json',
        content: JSON.stringify(deviceFlowModule.buildGrok2ApiBuildImportDocument(tokenRecord)),
        contentType: 'application/json',
        required: true,
      });
    }

    const submitImport = async (upload) => {
      const formData = new FormData();
      formData.append(
        upload.field,
        new Blob([upload.content], { type: upload.contentType }),
        upload.fileName
      );
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchImpl(upload.url, {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${accessToken}`,
          },
          body: formData,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const obtainToken = async (force = false) => {
      const cached = adminTokenCache.get(cacheKey);
      if (!force && cached && cached.expiresAt > Date.now() + GROK2API_TOKEN_REFRESH_MARGIN_MS) {
        accessToken = cached.token;
        return accessToken;
      }
      accessToken = await loginGrok2ApiAdmin(baseUrl, credentials, fetchImpl, { timeoutMs });
      adminTokenCache.set(cacheKey, {
        token: accessToken,
        expiresAt: Date.now() + 14 * 60 * 1000,
      });
      return accessToken;
    };

    const runUpload = async (upload) => {
      let response = null;
      try {
        await obtainToken();
        response = await submitImport(upload);
        if (response.status === 401 || response.status === 403) {
          await obtainToken(true);
          response = await submitImport(upload);
        }
      } catch (error) {
        const message = sanitizeSensitiveMessage(getErrorMessage(error), sensitiveValues());
        throw new Error(`${upload.label} 上传失败：${message}`);
      }
      const body = await readResponse(response);
      if (!response.ok) {
        const message = readGrok2ApiErrorMessage(body, response.statusText || `HTTP ${response.status}`, sensitiveValues());
        throw new Error(`${upload.label} 上传失败：${message}`);
      }
      const outcome = resolveImportOutcome(parseSseEventStream(body.text));
      if (!outcome.ok) {
        const message = sanitizeSensitiveMessage(outcome.message || '服务端未导入任何账号。', sensitiveValues());
        throw new Error(`${upload.label} 上传失败：${message}`);
      }
      return { label: upload.label, url: upload.url, ...outcome };
    };

    const results = [];
    for (const upload of uploads) {
      results.push(await runUpload(upload));
    }

    const primary = results.find((entry) => entry.label === 'web') || results[0] || {};
    return {
      endpointUrl: primary.url || buildGrok2ApiWebImportUrl(baseUrl),
      results,
      created: results.reduce((sum, entry) => sum + (Number(entry.created) || 0), 0),
      updated: results.reduce((sum, entry) => sum + (Number(entry.updated) || 0), 0),
      skipped: results.reduce((sum, entry) => sum + (Number(entry.skipped) || 0), 0),
      count: primary.created || 0,
      message: results.map((entry) => `${entry.label}：${entry.message}`).join('；'),
    };
  }

  function createGrok2ApiPublisher(deps = {}) {
    const {
      addLog = async () => {},
      completeNodeFromBackground,
      exchangeSsoToken = null,
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      getState = async () => ({}),
      setState = async () => {},
    } = deps;

    if (typeof completeNodeFromBackground !== 'function') {
      throw new Error('Grok2API publisher requires completeNodeFromBackground.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('Grok2API publisher requires fetch support.');
    }

    async function log(message, level = 'info', nodeId = '') {
      await addLog(message, level, nodeId ? { nodeId } : {});
    }

    async function applyRuntimeState(currentState = {}, patch = {}) {
      const nextPatch = mergeRuntimePatch(currentState, patch);
      await setState(nextPatch);
      return nextPatch;
    }

    async function persistFailure(currentState = {}, message = '', targetUrl = '') {
      const uploadPatch = {
        targetId: 'grok2api',
        status: 'error',
        uploadedAt: 0,
        message,
      };
      const normalizedTargetUrl = cleanString(targetUrl);
      if (normalizedTargetUrl) {
        uploadPatch.targetUrl = normalizedTargetUrl;
      }
      await setState(mergeRuntimePatch(currentState, {
        session: {
          lastError: message,
        },
        upload: uploadPatch,
      }));
    }

    async function executeGrokUploadSsoToGrok2Api(state = {}) {
      const nodeId = cleanString(state?.nodeId) || 'grok-upload-sso-to-grok2api';
      const currentState = await getState();
      let failureTargetUrl = '';
      const targetConfig = resolveGrok2ApiConfig(currentState);
      const ssoCookie = resolveGrokSsoCookie(currentState);
      try {
        const endpointUrl = buildGrok2ApiWebImportUrl(targetConfig.baseUrl);
        failureTargetUrl = endpointUrl;
        if (!targetConfig.password) {
          throw new Error('缺少 grok2api 管理员密码。');
        }
        if (!ssoCookie) {
          throw new Error('缺少 Grok SSO Cookie，请先完成 SSO 提取步骤。');
        }

        await applyRuntimeState(currentState, {
          session: {
            lastError: '',
          },
          upload: {
            targetId: 'grok2api',
            status: 'uploading',
            uploadedAt: 0,
            message: '',
            targetUrl: endpointUrl,
          },
        });

        let tokenRecord = null;
        if (typeof exchangeSsoToken === 'function') {
          await log('正在通过设备授权把 SSO 换取 OAuth 凭据（grok_build）...', 'info', nodeId);
          try {
            tokenRecord = await exchangeSsoToken(currentState);
          } catch (error) {
            tokenRecord = null;
            const reason = sanitizeSensitiveMessage(getErrorMessage(error), [
              targetConfig.password,
              ssoCookie,
            ]);
            await log(`SSO 设备授权换取 OAuth 凭据失败，将跳过 grok_build 导入：${reason}`, 'warn', nodeId);
          }
          if (tokenRecord && !(tokenRecord.access_token || tokenRecord.refresh_token)) {
            tokenRecord = null;
            await log('SSO 设备授权未返回 OAuth 凭据，将跳过 grok_build 导入。', 'warn', nodeId);
          }
        } else {
          await log('未配置 SSO→OAuth 转换，跳过 grok_build 导入。', 'warn', nodeId);
        }

        // 不再上传账号级 Cloudflare Cookie：cf_clearance/__cf_bm 绑定签发时的
        // IP+UA，从注册浏览器采集的 cookie 拿到 grok2api 服务器上用只会被 CF
        // 标记为异常。服务器端出口由 egress 节点（代理+cookie+UA）负责，
        // 与 openai-cpa 的"只传 sso"行为一致。
        await log('正在上传 Grok SSO 到 grok2api...', 'info', nodeId);
        const uploadResult = await uploadGrokSsoToGrok2Api(
          targetConfig.baseUrl,
          { username: targetConfig.username, password: targetConfig.password },
          ssoCookie,
          fetchImpl,
          {
            email: resolveGrokAccountEmail(currentState),
            tokenRecord,
          }
        );
        const payload = await applyRuntimeState(currentState, {
          session: {
            lastError: '',
          },
          upload: {
            targetId: 'grok2api',
            status: 'uploaded',
            uploadedAt: Date.now(),
            message: uploadResult.message,
            targetUrl: uploadResult.endpointUrl,
          },
        });
        await log(`Grok SSO 已上传到 grok2api，${uploadResult.message}。`, 'ok', nodeId);
        await completeNodeFromBackground(nodeId, payload);
      } catch (error) {
        const message = sanitizeSensitiveMessage(getErrorMessage(error), [
          targetConfig.password,
          ssoCookie,
        ]);
        await persistFailure(currentState, message, failureTargetUrl);
        await log(message, 'error', nodeId);
        throw new Error(message);
      }
    }

    return {
      executeGrokUploadSsoToGrok2Api,
    };
  }

  return {
    buildGrok2ApiBuildImportUrl,
    buildGrok2ApiConsoleImportDocument,
    buildGrok2ApiConsoleImportUrl,
    buildGrok2ApiLoginUrl,
    buildGrok2ApiWebImportUrl,
    buildGrok2ApiWebImportDocument,
    createGrok2ApiPublisher,
    decodeJwtPayload,
    normalizeGrok2ApiBaseUrl,
    normalizeGrok2ApiCredentials,
    parseSseEventStream,
    resolveGrok2ApiConfig,
    resolveImportOutcome,
    sanitizeSensitiveMessage,
    uploadGrokSsoToGrok2Api,
  };
});
