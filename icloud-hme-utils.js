/* eslint-disable no-var */
/* 通用 icloud-hme 自建服务（https://github.com/xiaozhou26/icloud-hme）API 工具。 */
(function icloudHmeUtilsModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.IcloudHmeUtils = api;
})(typeof self !== 'undefined' ? self : globalThis, function createIcloudHmeUtils() {
  const DEFAULT_ICLOUD_HME_BASE_URL = 'http://localhost:8081';
  const ICLOUD_HME_SESSION_COOKIE_NAME = 'hme_session';
  const ICLOUD_HME_CSRF_HEADER = 'X-CSRF-Token';
  const ICLOUD_HME_SESSION_DNR_RULE_ID = 910001;

  function normalizeIcloudHmeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return DEFAULT_ICLOUD_HME_BASE_URL;
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const url = new URL(withScheme);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return '';
      }
      url.hash = '';
      url.search = '';
      const normalized = url.toString().replace(/\/+$/, '');
      return normalized || '';
    } catch (_) {
      return '';
    }
  }

  function joinIcloudHmeUrl(baseUrl, path = '') {
    const normalizedBase = normalizeIcloudHmeBaseUrl(baseUrl);
    if (!normalizedBase) {
      return '';
    }
    const suffix = String(path || '').trim();
    if (!suffix) {
      return normalizedBase;
    }
    return `${normalizedBase}/${suffix.replace(/^\/+/, '')}`;
  }

  function normalizeIcloudHmeAccountId(value) {
    return String(value || '').trim();
  }

  function firstNonEmptyString(values = []) {
    for (const value of values) {
      if (value === undefined || value === null) continue;
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
    return '';
  }

  function normalizeIcloudHmeTimestamp(value) {
    if (value === undefined || value === null || value === '') {
      return 0;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function toArray(maybeArray) {
    return Array.isArray(maybeArray) ? maybeArray : [];
  }

  function getIcloudHmeDataRows(payload, keys = []) {
    const candidates = [];
    const data = payload && typeof payload === 'object' ? payload.data : null;
    for (const key of keys) {
      candidates.push(payload?.[key], data?.[key]);
    }
    candidates.push(data, payload);
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
    return [];
  }

  function normalizeIcloudHmeAccount(raw = {}) {
    const id = firstNonEmptyString([raw.id, raw.account_id, raw.accountId]);
    if (!id) {
      return null;
    }
    return {
      id,
      name: firstNonEmptyString([raw.name]),
      icloudEmail: firstNonEmptyString([raw.icloud_email, raw.icloudEmail, raw.email]),
      host: firstNonEmptyString([raw.host]),
      status: String(raw.status || '').trim().toLowerCase(),
      statusMessage: firstNonEmptyString([raw.status_message, raw.statusMessage]),
      aliasTotal: Math.max(0, Math.floor(Number(raw.alias_total ?? raw.aliasTotal) || 0)),
      aliasActive: Math.max(0, Math.floor(Number(raw.alias_active ?? raw.aliasActive) || 0)),
      hasCookies: Boolean(raw.has_cookies ?? raw.hasCookies),
      hasAppPassword: Boolean(raw.has_app_password ?? raw.hasAppPassword),
      mailboxEmail: firstNonEmptyString([raw.mailbox?.email]),
      lastValidated: firstNonEmptyString([raw.last_validated, raw.lastValidated]),
    };
  }

  function normalizeIcloudHmeAccounts(payload) {
    return getIcloudHmeDataRows(payload, ['accounts', 'items'])
      .map((item) => normalizeIcloudHmeAccount(item))
      .filter(Boolean);
  }

  function pickDefaultIcloudHmeAccountId(accounts = []) {
    const list = Array.isArray(accounts) ? accounts : [];
    const active = list.find((account) => account?.status === 'active' && account.id);
    if (active) {
      return active.id;
    }
    return String(list.find((account) => account?.id)?.id || '');
  }

  function getIcloudHmeAliasRows(payload) {
    return getIcloudHmeDataRows(payload, ['aliases', 'hmeEmails', 'items']);
  }

  function normalizeIcloudHmeMessage(raw = {}) {
    const id = firstNonEmptyString([raw.id, raw.uid, raw.message_id, raw.messageId]);
    const sender = firstNonEmptyString([
      raw.from?.emailAddress?.address,
      typeof raw.from === 'string' ? raw.from : '',
      raw.sender,
    ]);
    const preview = firstNonEmptyString([
      raw.preview,
      raw.bodyPreview,
      raw.snippet,
      raw.body,
      raw.text,
    ]);
    const receivedAt = firstNonEmptyString([
      raw.date,
      raw.receivedDateTime,
      raw.received_at,
      raw.created_at,
    ]);
    return {
      id,
      subject: firstNonEmptyString([raw.subject, raw.title]),
      from: { emailAddress: { address: sender } },
      bodyPreview: preview,
      receivedDateTime: receivedAt,
      receivedAtMs: normalizeIcloudHmeTimestamp(receivedAt),
      to: firstNonEmptyString([typeof raw.to === 'string' ? raw.to : raw.to?.emailAddress?.address]),
    };
  }

  function normalizeIcloudHmeMessages(payload) {
    return getIcloudHmeDataRows(payload, ['messages', 'items'])
      .map((item) => normalizeIcloudHmeMessage(item))
      .filter((item) => item.id || item.subject || item.bodyPreview);
  }

  function getIcloudHmeErrorMessage(payload, fallback = 'iCloud HME 请求失败') {
    return firstNonEmptyString([
      payload?.message,
      payload?.error,
      payload?.data?.message,
    ]) || fallback;
  }

  function getIcloudHmeErrorCode(payload) {
    return String(payload?.code || '').trim().toUpperCase();
  }

  function isIcloudHmeAuthError(status, payload) {
    if (Number(status) === 401) {
      return true;
    }
    const code = getIcloudHmeErrorCode(payload);
    return code === 'AUTH_REQUIRED' || code === 'INVALID_CREDENTIALS';
  }

  function isIcloudHmeCsrfError(status, payload) {
    if (Number(status) !== 403) {
      return false;
    }
    const code = getIcloudHmeErrorCode(payload);
    if (code === 'CSRF_INVALID' || code === 'CSRF_REQUIRED') {
      return true;
    }
    return /csrf/i.test(String(payload?.message || ''));
  }

  function isIcloudHmeRateLimited(status, payload) {
    return Number(status) === 429 || getIcloudHmeErrorCode(payload) === 'RATE_LIMITED';
  }

  function escapeIcloudHmeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildIcloudHmeApiRegexFilter(baseUrl) {
    const normalizedBase = normalizeIcloudHmeBaseUrl(baseUrl);
    if (!normalizedBase) {
      return '';
    }
    return `^${escapeIcloudHmeRegex(normalizedBase)}/api/`;
  }

  function normalizeIcloudHmeSession(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const sessionId = firstNonEmptyString([raw.sessionId, raw.session_id, raw.cookieValue]);
    const csrfToken = firstNonEmptyString([raw.csrfToken, raw.csrf_token]);
    const baseUrl = normalizeIcloudHmeBaseUrl(raw.baseUrl);
    if (!sessionId || !baseUrl) {
      return null;
    }
    const expiresAt = normalizeIcloudHmeTimestamp(raw.expiresAt || raw.expires_at);
    return {
      baseUrl,
      sessionId,
      csrfToken,
      expiresAt,
    };
  }

  return {
    DEFAULT_ICLOUD_HME_BASE_URL,
    ICLOUD_HME_CSRF_HEADER,
    ICLOUD_HME_SESSION_COOKIE_NAME,
    ICLOUD_HME_SESSION_DNR_RULE_ID,
    buildIcloudHmeApiRegexFilter,
    escapeIcloudHmeRegex,
    getIcloudHmeAliasRows,
    getIcloudHmeDataRows,
    getIcloudHmeErrorCode,
    getIcloudHmeErrorMessage,
    isIcloudHmeAuthError,
    isIcloudHmeCsrfError,
    isIcloudHmeRateLimited,
    joinIcloudHmeUrl,
    normalizeIcloudHmeAccount,
    normalizeIcloudHmeAccountId,
    normalizeIcloudHmeAccounts,
    normalizeIcloudHmeBaseUrl,
    normalizeIcloudHmeMessage,
    normalizeIcloudHmeMessages,
    normalizeIcloudHmeSession,
    normalizeIcloudHmeTimestamp,
    pickDefaultIcloudHmeAccountId,
  };
});
