(function attachBackgroundGrokSsoDeviceFlow(root, factory) {
  root.MultiPageBackgroundGrokSsoDeviceFlow = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundGrokSsoDeviceFlowModule(_root) {
  const OIDC_ISSUER = 'https://auth.x.ai';
  const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
  // 与 CPA internal/auth/xai 严格一致；不可加 conversations:* —— 未授权 scope
  // 会导致 token 端点 invalid_grant "Access denied"。
  const DEVICE_SCOPES = 'openid profile email offline_access grok-cli:access api:access';
  const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
  const DEFAULT_HTTP_TIMEOUT_MS = 30000;
  const DEFAULT_POLL_TIMEOUT_MS = 120000;
  const DEFAULT_POLL_INTERVAL_MS = 1500;
  // grok2api 约定：有 refresh_token 时把 expires_at 写成过去时间，服务端立即用
  // refresh_token 续期（对齐 openai-cpa _grok2api_import_expires_at）。
  const EXPIRED_SKEW_MS = 60 * 1000;

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : cleanString(error) || '未知错误';
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

  async function fetchJsonWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_error) {
        json = null;
      }
      return { response, text, json };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function postForm(fetchImpl, url, fields = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
    const body = new URLSearchParams();
    Object.entries(fields).forEach(([key, value]) => {
      body.append(key, String(value ?? ''));
    });
    return fetchJsonWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    }, timeoutMs);
  }

  async function requestDeviceCode(fetchImpl, options = {}) {
    const timeoutMs = Math.max(1, Number(options?.timeoutMs) || DEFAULT_HTTP_TIMEOUT_MS);
    const issuer = cleanString(options?.issuer) || OIDC_ISSUER;
    const { response, json } = await postForm(fetchImpl, `${issuer}/oauth2/device/code`, {
      client_id: cleanString(options?.clientId) || CLIENT_ID,
      scope: cleanString(options?.scope) || DEVICE_SCOPES,
    }, timeoutMs);
    if (!response.ok) {
      const detail = cleanString(json?.error_description || json?.error || response.statusText || `HTTP ${response.status}`);
      throw new Error(`Grok device/code 请求失败：${detail}`);
    }
    const deviceCode = cleanString(json?.device_code);
    const userCode = cleanString(json?.user_code);
    if (!deviceCode || !userCode) {
      throw new Error('Grok device/code 响应缺少 device_code/user_code。');
    }
    let verificationUrl = cleanString(json?.verification_uri_complete || json?.verification_uri);
    if (verificationUrl && !/user_code=/i.test(verificationUrl)) {
      verificationUrl += `${verificationUrl.includes('?') ? '&' : '?'}user_code=${encodeURIComponent(userCode)}`;
    }
    if (!verificationUrl) {
      verificationUrl = `${issuer}/oauth2/device/verify?user_code=${encodeURIComponent(userCode)}`;
    }
    return {
      deviceCode,
      userCode,
      verificationUrl,
      intervalSeconds: Math.max(1, Number(json?.interval) || 5),
      expiresInSeconds: Math.max(1, Number(json?.expires_in) || 1800),
    };
  }

  async function pollDeviceToken(fetchImpl, options = {}) {
    const issuer = cleanString(options?.issuer) || OIDC_ISSUER;
    const deviceCode = cleanString(options?.deviceCode);
    if (!deviceCode) {
      throw new Error('缺少 device_code，无法轮询授权结果。');
    }
    const timeoutMs = Math.max(1, Number(options?.timeoutMs) || DEFAULT_POLL_TIMEOUT_MS);
    const httpTimeoutMs = Math.max(1, Number(options?.httpTimeoutMs) || DEFAULT_HTTP_TIMEOUT_MS);
    const isStopped = typeof options?.isStopped === 'function' ? options.isStopped : () => false;
    let intervalMs = Math.max(200, Number(options?.intervalMs) || DEFAULT_POLL_INTERVAL_MS);
    const deadline = Date.now() + timeoutMs;
    let lastError = '';

    while (Date.now() < deadline) {
      if (isStopped()) {
        throw new Error('Grok 授权轮询已停止。');
      }
      let result = null;
      try {
        result = await postForm(fetchImpl, `${issuer}/oauth2/token`, {
          grant_type: DEVICE_CODE_GRANT_TYPE,
          client_id: cleanString(options?.clientId) || CLIENT_ID,
          device_code: deviceCode,
        }, httpTimeoutMs);
      } catch (error) {
        lastError = getErrorMessage(error);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      const { response, json } = result;
      if (response.ok && json?.access_token) {
        return json;
      }
      const error = cleanString(json?.error);
      if (error === 'invalid_grant' || error === 'access_denied') {
        throw new Error(`Grok 授权被拒绝：${cleanString(json?.error_description) || error}`);
      }
      if (error === 'authorization_pending') {
        lastError = 'authorization_pending';
      } else if (error === 'slow_down') {
        intervalMs = Math.min(10000, intervalMs + 1000);
        lastError = 'slow_down';
      } else if (!response.ok && error) {
        throw new Error(`Grok token 轮询失败：${cleanString(json?.error_description) || error}`);
      } else {
        lastError = `HTTP ${response.status}`;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`等待 Grok 设备授权超时${lastError ? `（最后状态：${lastError}）` : ''}。`);
  }

  async function fetchUserInfo(fetchImpl, accessToken, options = {}) {
    const issuer = cleanString(options?.issuer) || OIDC_ISSUER;
    const { response, json } = await fetchJsonWithTimeout(fetchImpl, `${issuer}/oauth2/userinfo`, {
      headers: {
        Authorization: `Bearer ${cleanString(accessToken)}`,
        Accept: 'application/json',
      },
    }, Math.max(1, Number(options?.timeoutMs) || DEFAULT_HTTP_TIMEOUT_MS));
    if (!response.ok) return {};
    return json && typeof json === 'object' ? json : {};
  }

  function resolvePrincipalIdFromSso(ssoCookie = '') {
    const payload = decodeJwtPayload(ssoCookie);
    for (const key of ['sub', 'principal_id', 'principalId', 'user_id', 'userId', 'uid']) {
      const value = cleanString(payload[key]);
      if (value) return value;
    }
    for (const nestKey of ['user', 'account', 'identity', 'profile']) {
      const nested = payload[nestKey];
      if (!nested || typeof nested !== 'object') continue;
      for (const key of ['sub', 'principal_id', 'user_id', 'userId', 'uid']) {
        const value = cleanString(nested[key]);
        if (value) return value;
      }
    }
    return '';
  }

  function normalizeTokenRecord(token = {}, options = {}) {
    const accessPayload = decodeJwtPayload(token.access_token);
    const idPayload = decodeJwtPayload(token.id_token);
    const email = cleanString(
      accessPayload.email
      || idPayload.email
      || token.email
      || token._email
      || options?.email
    );
    const userId = cleanString(
      accessPayload.sub
      || accessPayload.principal_id
      || idPayload.sub
      || idPayload.principal_id
      || token.user_id
      || token.principal_id
      || resolvePrincipalIdFromSso(options?.ssoCookie)
    );
    return {
      client_id: cleanString(token.client_id) || cleanString(options?.clientId) || CLIENT_ID,
      access_token: cleanString(token.access_token),
      refresh_token: cleanString(token.refresh_token),
      id_token: cleanString(token.id_token),
      token_type: cleanString(token.token_type) || 'Bearer',
      expires_in: Number(token.expires_in) || 0,
      email,
      user_id: userId,
      team_id: cleanString(accessPayload.team_id || idPayload.team_id || token.team_id),
    };
  }

  function resolveImportExpiresAt(record = {}) {
    if (cleanString(record.refresh_token)) {
      return new Date(Date.now() - EXPIRED_SKEW_MS).toISOString();
    }
    const payload = decodeJwtPayload(record.access_token);
    if (Number.isFinite(Number(payload.exp))) {
      return new Date(Number(payload.exp) * 1000).toISOString();
    }
    if (Number.isFinite(Number(record.expires_in)) && Number(record.expires_in) > 0) {
      return new Date(Date.now() + Number(record.expires_in) * 1000).toISOString();
    }
    return '';
  }

  function buildGrok2ApiBuildImportDocument(record = {}) {
    if (!cleanString(record.access_token) && !cleanString(record.refresh_token)) {
      throw new Error('缺少 access_token/refresh_token，无法生成 grok_build 鉴权文件。');
    }
    const email = cleanString(record.email);
    const userId = cleanString(record.user_id || record.principal_id);
    return {
      provider: 'grok_build',
      name: email || 'Grok Build account',
      client_id: cleanString(record.client_id) || CLIENT_ID,
      access_token: cleanString(record.access_token),
      refresh_token: cleanString(record.refresh_token),
      id_token: cleanString(record.id_token),
      token_type: cleanString(record.token_type) || 'Bearer',
      email,
      user_id: userId,
      team_id: cleanString(record.team_id),
      expires_at: resolveImportExpiresAt(record),
    };
  }

  return {
    CLIENT_ID,
    DEVICE_SCOPES,
    OIDC_ISSUER,
    buildGrok2ApiBuildImportDocument,
    decodeJwtPayload,
    fetchUserInfo,
    normalizeTokenRecord,
    pollDeviceToken,
    requestDeviceCode,
    resolveImportExpiresAt,
    resolvePrincipalIdFromSso,
  };
});
