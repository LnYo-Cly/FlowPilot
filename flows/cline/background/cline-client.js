(function attachClineClientModule(root, factory) {
  root.MultiPageClineClient = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createClineClientModule(root = globalThis) {
  const CLINE_API_BASE = 'https://api.cline.bot';
  const CLINE_WORKOS_API_BASE = 'https://api.workos.com';
  const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR';
  const CLINE_CALLBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);
  const CLINE_FETCH_TIMEOUT_MS = 30000;
  const CLINE_DEFAULT_CALLBACK_PORT = 48801;
  const CLINE2API_IMPORT_PATH = '/admin/api/accounts/import';
  const CLINE2API_STATUS_PATH = '/admin/api/status';
  const CLINE2API_MAX_BATCH = 500;

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function normalizeClineApiBase(value = '') {
    const trimmed = cleanString(value) || CLINE_API_BASE;
    const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      parsed.hash = '';
      parsed.search = '';
      const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
      return `${parsed.origin}${pathname}`;
    } catch {
      return '';
    }
  }

  function normalizeCline2ApiBaseUrl(value = '') {
    return normalizeClineApiBase(value);
  }

  function normalizeClineExpiresAt(value) {
    if (typeof value === 'string') {
      const numeric = Number(value);
      value = Number.isFinite(numeric) ? numeric : Date.parse(value);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    // 秒级时间戳统一换算成毫秒，与 cline2api 网关内部表示保持一致。
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }

  function buildClineAuthorizeUrl({ apiBase = '', callbackUrl = '' } = {}) {
    const base = normalizeClineApiBase(apiBase);
    if (!base) throw new Error('Cline API 地址无效。');
    const cb = cleanString(callbackUrl);
    if (!cb) throw new Error('缺少 Cline 回调地址。');
    const url = new URL('/api/v1/auth/authorize', `${base}/`);
    url.searchParams.set('client_type', 'extension');
    url.searchParams.set('callback_url', cb);
    url.searchParams.set('redirect_uri', cb);
    return url.toString();
  }

  /**
   * 请求 Cline 授权入口并改写为 MicrosoftOAuth 直达链接。
   * authorize 端点 302 到 WorkOS，把 provider 参数换成 MicrosoftOAuth 后微软登录页直接出现。
   */
  async function resolveClineMicrosoftLoginUrl({ apiBase = '', callbackUrl = '', fetchImpl, timeoutMs } = {}) {
    const fetcher = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error('当前环境不支持 fetch，无法请求 Cline 授权入口。');
    const url = buildClineAuthorizeUrl({ apiBase, callbackUrl });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = Math.max(5000, Math.floor(Number(timeoutMs) || CLINE_FETCH_TIMEOUT_MS));
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    let response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('请求 Cline 授权入口超时。');
      throw new Error(`无法连接 Cline 授权入口：${err?.message || err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const location = cleanString(response?.headers?.get?.('location'));
    if (!location) {
      throw new Error(`Cline 授权入口未返回跳转地址（HTTP ${response?.status || '?'}）。`);
    }
    const resolved = new URL(location, url);
    resolved.searchParams.set('provider', 'MicrosoftOAuth');
    return resolved.toString();
  }

  /** WorkOS/AuthKit 授权网关地址（authorize 302 的落地页）。 */
  const CLINE_AUTH_GATEWAY_HOSTS = Object.freeze(['api.workos.com', 'authkit.cline.bot', 'login.workos.com']);

  function isClineAuthGatewayUrl(rawUrl = '') {
    try {
      const host = new URL(String(rawUrl || '')).hostname.toLowerCase();
      return CLINE_AUTH_GATEWAY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  /**
   * 把授权网关地址上的 provider 参数改写为指定值（如 MicrosoftOAuth 直达微软登录）。
   * 扩展内 fetch redirect:manual 拿不到 Location，因此跳转链由标签页导航产生、再就地改写。
   */
  function rewriteClineProviderParam(rawUrl = '', provider = 'MicrosoftOAuth') {
    try {
      const url = new URL(String(rawUrl || ''));
      if (!isClineAuthGatewayUrl(url.toString())) return '';
      url.searchParams.set('provider', cleanString(provider) || 'MicrosoftOAuth');
      return url.toString();
    } catch {
      return '';
    }
  }

  /**
   * 从页面 URL 中抠授权码。仅限 cline 回调端点与本地回环地址，避免误伤其它带 code 参数的页面。
   */
  function pickClineCodeFromUrl(rawUrl = '') {
    try {
      const url = new URL(String(rawUrl || ''));
      const host = String(url.hostname || '').toLowerCase();
      const hostOk = /(^|\.)cline\.bot$/.test(host) || CLINE_CALLBACK_HOSTS.includes(host);
      if (!hostOk) return '';
      const code = cleanString(url.searchParams.get('code'));
      return code.length > 8 ? code : '';
    } catch {
      return '';
    }
  }

  function isClineCallbackUrl(rawUrl = '') {
    try {
      const url = new URL(String(rawUrl || ''));
      const host = String(url.hostname || '').toLowerCase();
      return CLINE_CALLBACK_HOSTS.includes(host) || /(^|\.)cline\.bot$/.test(host);
    } catch {
      return false;
    }
  }

  async function postClineJson(fetchImpl, url, body, { timeoutMs, headers } = {}) {
    const fetcher = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error('当前环境不支持 fetch。');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = Math.max(5000, Math.floor(Number(timeoutMs) || CLINE_FETCH_TIMEOUT_MS));
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(headers || {}) },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('Cline 接口请求超时。');
      throw new Error(`无法连接 Cline 接口：${err?.message || err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    return { response, payload, text };
  }

  /** 授权码换 Cline 正式令牌（extension 链路拿到的即最终凭据）。 */
  async function exchangeClineAuthorizationCode({ apiBase = '', code = '', callbackUrl = '', fetchImpl, timeoutMs } = {}) {
    const base = normalizeClineApiBase(apiBase);
    if (!base) throw new Error('Cline API 地址无效。');
    const authCode = cleanString(code);
    if (!authCode) throw new Error('缺少 Cline 授权码。');
    const { response, payload, text } = await postClineJson(fetchImpl, `${base}/api/v1/auth/token`, {
      grant_type: 'authorization_code',
      code: authCode,
      client_type: 'extension',
      redirect_uri: cleanString(callbackUrl),
    }, { timeoutMs });
    if (!response.ok || typeof payload?.data?.accessToken !== 'string') {
      throw new Error(`授权码换令牌失败 HTTP ${response.status}：${text.slice(0, 200)}`);
    }
    return {
      accessToken: payload.data.accessToken,
      refreshToken: cleanString(payload.data.refreshToken),
      expiresAt: payload.data.expiresAt,
    };
  }

  /**
   * WorkOS 设备码路径（原版 cline-register 的 --device 备用路线）。
   * 不走 authkit.cline.bot 授权页与本地回调：WorkOS 轮询直接发令牌，
   * 可绕过 AuthKit 侧风控（oauth_provider_generic_error / radar-challenge）。
   */
  async function startClineDeviceAuthorization({ fetchImpl, timeoutMs } = {}) {
    // 官方 SDK 用 urlencoded 提交 client_id（cline/cline sdk auth/cline.ts 同款契约）。
    const fetcher = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error('当前环境不支持 fetch。');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = Math.max(5000, Math.floor(Number(timeoutMs) || CLINE_FETCH_TIMEOUT_MS));
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    let response;
    try {
      response = await fetcher(`${CLINE_WORKOS_API_BASE}/user_management/authorize/device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }),
        signal: controller?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('WorkOS 设备码申请超时。');
      throw new Error(`无法连接 WorkOS：${err?.message || err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!response.ok || typeof payload?.device_code !== 'string') {
      throw new Error(`WorkOS 设备码申请失败 HTTP ${response.status}：${text.slice(0, 200)}`);
    }
    return payload;
  }

  /**
   * 单次轮询设备码授权状态（由调用方按 interval 控制节奏）。
   * 返回 { status: 'pending'|'slow_down'|'success'|'failed', tokens?, error? }
   */
  async function pollClineDeviceTokenOnce({ device, fetchImpl, timeoutMs } = {}) {
    const deviceCode = cleanString(device?.device_code);
    if (!deviceCode) throw new Error('缺少 WorkOS device_code。');
    const fetcher = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error('当前环境不支持 fetch。');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = Math.max(5000, Math.floor(Number(timeoutMs) || CLINE_FETCH_TIMEOUT_MS));
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    let response;
    try {
      response = await fetcher(`${CLINE_WORKOS_API_BASE}/user_management/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: CLINE_WORKOS_CLIENT_ID,
        }),
        signal: controller?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') return { status: 'failed', error: 'WorkOS 设备码轮询超时' };
      return { status: 'failed', error: `无法连接 WorkOS：${err?.message || err}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (response.ok && typeof payload?.access_token === 'string') {
      return {
        status: 'success',
        tokens: { accessToken: payload.access_token, refreshToken: cleanString(payload.refresh_token) },
      };
    }
    if (payload?.error === 'authorization_pending') return { status: 'pending' };
    if (payload?.error === 'slow_down') return { status: 'slow_down' };
    if (['access_denied', 'expired_token', 'invalid_grant'].includes(payload?.error)) {
      return { status: 'failed', error: `设备码登录失败：${cleanString(payload.error_description) || payload.error}` };
    }
    if (!response.ok && response.status >= 500) return { status: 'pending' };
    return { status: 'failed', error: `设备码轮询失败 HTTP ${response.status}` };
  }

  /** 设备码路径拿到的 WorkOS 令牌 → 注册成 Cline 会话凭据（跳过授权码交换）。 */
  async function registerClineSessionFromWorkos({ apiBase = '', workos = {}, fetchImpl, timeoutMs } = {}) {
    const base = normalizeClineApiBase(apiBase);
    if (!base) throw new Error('Cline API 地址无效。');
    const accessToken = cleanString(workos.accessToken);
    if (!accessToken) throw new Error('缺少 WorkOS accessToken。');
    const { response, payload, text } = await postClineJson(fetchImpl, `${base}/api/v1/auth/register`, {
      accessToken,
      refreshToken: cleanString(workos.refreshToken),
    }, { timeoutMs });
    if (!response.ok || typeof payload?.data?.accessToken !== 'string') {
      throw new Error(`Cline 会话注册失败 HTTP ${response.status}：${text.slice(0, 200)}`);
    }
    return {
      accessToken: payload.data.accessToken,
      refreshToken: cleanString(payload.data.refreshToken) || cleanString(workos.refreshToken),
      expiresAt: payload.data.expiresAt,
    };
  }

  /**
   * 注册机记录 → cline2api 网关导入形状。
   * { email, accessToken, refreshToken, expiresAt } → { email, access, refresh, expires, ... }
   */
  function toCline2ApiImportRecord(record = {}) {
    const email = cleanString(record.email).toLowerCase();
    const access = cleanString(record.accessToken || record.access);
    const refresh = cleanString(record.refreshToken || record.refresh);
    const expires = normalizeClineExpiresAt(record.expiresAt ?? record.expires);
    if (!email || !email.includes('@') || !access || !refresh || !expires) return null;
    return {
      email,
      access,
      refresh,
      expires,
      tokenType: 'Bearer',
      provider: 'cline',
      label: null,
    };
  }

  async function importCline2ApiAccounts({
    baseUrl = '',
    adminToken = '',
    records = [],
    importPath = CLINE2API_IMPORT_PATH,
    fetchImpl,
    timeoutMs,
  } = {}) {
    const base = normalizeCline2ApiBaseUrl(baseUrl);
    if (!base) throw new Error('cline2api 网关地址为空或无效。');
    if (!cleanString(adminToken)) throw new Error('cline2api 管理令牌（ADMIN_TOKEN）为空。');
    const accounts = (Array.isArray(records) ? records : [])
      .map(toCline2ApiImportRecord)
      .filter(Boolean)
      .slice(0, CLINE2API_MAX_BATCH);
    if (!accounts.length) throw new Error('没有可导入的 Cline 凭据（字段缺失）。');
    const path = cleanString(importPath) || CLINE2API_IMPORT_PATH;
    const { response, payload, text } = await postClineJson(
      fetchImpl,
      `${base}${path.startsWith('/') ? path : `/${path}`}`,
      { accounts },
      { timeoutMs, headers: { Authorization: `Bearer ${cleanString(adminToken)}` } }
    );
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.error || text.slice(0, 300);
      throw new Error(`cline2api 导入失败 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    return {
      imported: Number(payload?.imported ?? 0) || 0,
      updated: Number(payload?.updated ?? 0) || 0,
      skipped: Number(payload?.skipped ?? 0) || 0,
      total: Number(payload?.total ?? accounts.length) || accounts.length,
      errors: Array.isArray(payload?.errors) ? payload.errors : [],
    };
  }

  async function probeCline2Api({ baseUrl = '', adminToken = '', fetchImpl, timeoutMs } = {}) {
    const base = normalizeCline2ApiBaseUrl(baseUrl);
    if (!base) throw new Error('cline2api 网关地址为空或无效。');
    if (!cleanString(adminToken)) throw new Error('cline2api 管理令牌为空。');
    const fetcher = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error('当前环境不支持 fetch。');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = Math.max(5000, Math.floor(Number(timeoutMs) || CLINE_FETCH_TIMEOUT_MS));
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    let response;
    try {
      response = await fetcher(`${base}${CLINE2API_STATUS_PATH}`, {
        headers: { Authorization: `Bearer ${cleanString(adminToken)}`, Accept: 'application/json' },
        signal: controller?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('连接 cline2api 超时。');
      throw new Error(`无法连接 cline2api：${err?.message || err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.error || text.slice(0, 200);
      throw new Error(`cline2api 探测失败 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    return { ok: true, status: response.status, payload };
  }

  return {
    CLINE_API_BASE,
    CLINE_CALLBACK_HOSTS,
    CLINE_DEFAULT_CALLBACK_PORT,
    CLINE2API_IMPORT_PATH,
    buildClineAuthorizeUrl,
    exchangeClineAuthorizationCode,
    importCline2ApiAccounts,
    isClineAuthGatewayUrl,
    isClineCallbackUrl,
    normalizeCline2ApiBaseUrl,
    normalizeClineApiBase,
    normalizeClineExpiresAt,
    pickClineCodeFromUrl,
    pollClineDeviceTokenOnce,
    probeCline2Api,
    registerClineSessionFromWorkos,
    startClineDeviceAuthorization,
    resolveClineMicrosoftLoginUrl,
    rewriteClineProviderParam,
    toCline2ApiImportRecord,
  };
});
