(function icloudHmeProviderModule(root, factory) {
  root.MultiPageBackgroundIcloudHmeProvider = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createIcloudHmeProviderModule(root = globalThis) {
  const DEFAULT_ICLOUD_HME_FETCH_TIMEOUT_MS = 20000;
  const ICLOUD_HME_SESSION_EXPIRY_SKEW_MS = 60000;
  const ICLOUD_HME_INBOX_LIMIT = 20;
  const ICLOUD_HME_INBOX_DAYS = 3;
  const ICLOUD_HME_ALIAS_LABEL = 'FlowPilot';

  function getIcloudHmeUtils() {
    return root.IcloudHmeUtils || {};
  }

  function getIcloudUtils() {
    return root.IcloudUtils || {};
  }

  function createIcloudHmeProvider(deps = {}) {
    const {
      addLog = async () => {},
      chrome = root.chrome,
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      getEffectiveUsedEmails = async () => ({}),
      getPreservedAliasMap = async () => ({}),
      getState = async () => ({}),
      ICLOUD_HME_GENERATOR = 'icloud-hme',
      ICLOUD_HME_PROVIDER = 'icloud-hme',
      normalizeIcloudFetchMode = (value) => (String(value || '').trim().toLowerCase() === 'always_new' ? 'always_new' : 'reuse_existing'),
      persistRegistrationEmailState = null,
      pickVerificationMessageWithTimeFallback = null,
      setEmailState = async () => {},
      setState = async () => {},
      sleepWithStop = async () => {},
      throwIfStopped = () => {},
    } = deps;

    let runtimeSessionCache = null;

    function normalizeIcloudHmeBaseUrl(value) {
      return getIcloudHmeUtils().normalizeIcloudHmeBaseUrl?.(value)
        || String(value || '').trim().replace(/\/+$/, '');
    }

    function joinIcloudHmeUrl(baseUrl, path = '') {
      const joined = getIcloudHmeUtils().joinIcloudHmeUrl?.(baseUrl, path);
      if (joined) {
        return joined;
      }
      const normalizedBase = normalizeIcloudHmeBaseUrl(baseUrl);
      const suffix = String(path || '').trim().replace(/^\/+/, '');
      return suffix ? `${normalizedBase}/${suffix}` : normalizedBase;
    }

    function normalizeIcloudHmeAccountId(value) {
      return getIcloudHmeUtils().normalizeIcloudHmeAccountId?.(value)
        || String(value || '').trim();
    }

    function getIcloudHmeConfig(state = {}, overrides = {}) {
      const baseUrl = normalizeIcloudHmeBaseUrl(
        overrides.baseUrl !== undefined ? overrides.baseUrl : state.icloudHmeBaseUrl
      );
      const adminPassword = overrides.adminPassword !== undefined
        ? String(overrides.adminPassword || '')
        : String(state.icloudHmeAdminPassword || '');
      const accountId = normalizeIcloudHmeAccountId(
        overrides.accountId !== undefined ? overrides.accountId : state.icloudHmeAccountId
      );
      return { baseUrl, adminPassword, accountId };
    }

    function ensureIcloudHmeConfig(state = {}, overrides = {}) {
      const config = getIcloudHmeConfig(state, overrides);
      if (!config.baseUrl) {
        throw new Error('iCloud HME 服务地址为空或格式无效。');
      }
      if (!config.adminPassword) {
        throw new Error('请先填写 iCloud HME 管理员密码（服务端 ICLOUD_HME_ADMIN_PASSWORD）。');
      }
      return config;
    }

    function normalizeIcloudHmeSessionState(raw) {
      return getIcloudHmeUtils().normalizeIcloudHmeSession?.(raw) || null;
    }

    function isIcloudHmeSessionFresh(session) {
      if (!session?.sessionId) {
        return false;
      }
      if (!session.expiresAt) {
        return true;
      }
      return session.expiresAt - ICLOUD_HME_SESSION_EXPIRY_SKEW_MS > Date.now();
    }

    async function syncIcloudHmeSessionCookieRule(config, session) {
      const dnr = chrome?.declarativeNetRequest;
      const ruleId = getIcloudHmeUtils().ICLOUD_HME_SESSION_DNR_RULE_ID || 910001;
      if (!dnr?.updateSessionRules) {
        await addLog('iCloud HME：当前浏览器不支持动态请求规则，登录会话可能无法携带。', 'warn');
        return false;
      }
      const cookieName = getIcloudHmeUtils().ICLOUD_HME_SESSION_COOKIE_NAME || 'hme_session';
      const regexFilter = getIcloudHmeUtils().buildIcloudHmeApiRegexFilter?.(config.baseUrl)
        || `^${String(config.baseUrl || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/`;
      if (!regexFilter || !session?.sessionId) {
        return false;
      }
      await dnr.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{
              header: 'cookie',
              operation: 'set',
              value: `${cookieName}=${session.sessionId}`,
            }],
          },
          condition: {
            regexFilter,
            resourceTypes: ['xmlhttprequest'],
          },
        }],
      });
      return true;
    }

    async function clearIcloudHmeSessionCookieRule() {
      const ruleId = getIcloudHmeUtils().ICLOUD_HME_SESSION_DNR_RULE_ID || 910001;
      await chrome?.declarativeNetRequest?.updateSessionRules?.({
        removeRuleIds: [ruleId],
      }).catch(() => {});
    }

    async function readIcloudHmeSessionCookie(config) {
      try {
        const cookieName = getIcloudHmeUtils().ICLOUD_HME_SESSION_COOKIE_NAME || 'hme_session';
        const cookie = await chrome?.cookies?.get({ url: config.baseUrl, name: cookieName });
        return String(cookie?.value || '').trim();
      } catch (_) {
        return '';
      }
    }

    function buildIcloudHmeSession(config, payload = {}, extras = {}) {
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const sessionId = String(
        extras.sessionId
          || data?.session_id
          || data?.sessionId
          || ''
      ).trim();
      const csrfToken = String(data?.csrf_token || data?.csrfToken || extras.csrfToken || '').trim();
      const expiresAtRaw = data?.expires_at || data?.expiresAt || extras.expiresAt || '';
      const expiresAt = getIcloudHmeUtils().normalizeIcloudHmeTimestamp?.(expiresAtRaw)
        || Date.parse(expiresAtRaw)
        || 0;
      if (!sessionId) {
        return null;
      }
      return {
        baseUrl: config.baseUrl,
        sessionId,
        csrfToken,
        expiresAt,
      };
    }

    async function cacheIcloudHmeSession(config, session, options = {}) {
      if (!session?.sessionId) {
        return null;
      }
      runtimeSessionCache = {
        ...session,
        baseUrl: config.baseUrl,
        validatedAt: options.validatedAt ?? Date.now(),
      };
      await setState({
        icloudHmeSession: {
          baseUrl: config.baseUrl,
          sessionId: session.sessionId,
          csrfToken: session.csrfToken || '',
          expiresAt: session.expiresAt || 0,
        },
      }).catch(() => {});
      await syncIcloudHmeSessionCookieRule(config, session).catch(() => {});
      return session;
    }

    async function requestIcloudHmeRaw(config, path, options = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('当前环境不支持 fetch，无法连接 iCloud HME 服务。');
      }
      const method = String(options.method || 'GET').trim().toUpperCase() || 'GET';
      const url = new URL(joinIcloudHmeUrl(config.baseUrl, path));
      const searchParams = options.searchParams && typeof options.searchParams === 'object'
        ? options.searchParams
        : {};
      for (const [key, value] of Object.entries(searchParams)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
      const headers = {
        Accept: 'application/json',
        ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
      };
      const init = {
        method,
        headers,
        credentials: 'include',
        cache: 'no-store',
      };
      if (options.payload !== undefined && method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.payload);
      }
      const session = options.session;
      const csrfHeader = getIcloudHmeUtils().ICLOUD_HME_CSRF_HEADER || 'X-CSRF-Token';
      if (method !== 'GET' && method !== 'HEAD' && session?.csrfToken) {
        headers[csrfHeader] = session.csrfToken;
      }
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || DEFAULT_ICLOUD_HME_FETCH_TIMEOUT_MS));
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (controller) {
        init.signal = controller.signal;
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      let response;
      try {
        response = await fetchImpl(url.toString(), init);
      } catch (err) {
        if (err?.name === 'AbortError') {
          throw new Error(`iCloud HME 请求超时（${Math.round(timeoutMs / 1000)} 秒）：${url.origin}`);
        }
        throw new Error(`无法连接 iCloud HME 服务（${url.origin}）：${err?.message || err}`);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (_) {
        payload = null;
      }
      return { response, payload };
    }

    async function assertIcloudHmeOk(result, config) {
      const { response, payload } = result;
      const utils = getIcloudHmeUtils();
      if (response.ok && payload && payload.success !== false) {
        return payload;
      }
      const message = utils.getIcloudHmeErrorMessage?.(payload)
        || `HTTP ${response.status}`;
      const error = new Error(`iCloud HME 请求失败：${message}`);
      error.status = response.status;
      error.code = utils.getIcloudHmeErrorCode?.(payload) || '';
      error.payload = payload || null;
      if (utils.isIcloudHmeAuthError?.(response.status, payload)) {
        error.icloudHmeAuthError = true;
      }
      if (utils.isIcloudHmeCsrfError?.(response.status, payload)) {
        error.icloudHmeCsrfError = true;
      }
      throw error;
    }

    async function loginIcloudHme(state = {}, overrides = {}) {
      const config = ensureIcloudHmeConfig(state, overrides);
      const result = await requestIcloudHmeRaw(config, '/api/auth/login', {
        method: 'POST',
        payload: { password: config.adminPassword },
        timeoutMs: overrides.timeoutMs,
      });
      const payload = await assertIcloudHmeOk(result, config);
      const cookieSessionId = await readIcloudHmeSessionCookie(config);
      const session = buildIcloudHmeSession(config, payload, { sessionId: cookieSessionId });
      if (!session) {
        throw new Error('iCloud HME 登录成功但未获取到会话 Cookie，请检查服务版本或浏览器 Cookie 设置。');
      }
      await cacheIcloudHmeSession(config, session);
      await addLog(`iCloud HME：已登录 ${config.baseUrl}。`, 'info');
      return session;
    }

    async function validateIcloudHmeSession(config, session) {
      if (!session?.sessionId) {
        return null;
      }
      // 本会话刚校验过（60 秒内）时直接复用，避免每次 API 调用都多一次 /session 请求。
      if (session.validatedAt && Date.now() - session.validatedAt < 60000) {
        return session;
      }
      await syncIcloudHmeSessionCookieRule(config, session).catch(() => {});
      try {
        const result = await requestIcloudHmeRaw(config, '/api/auth/session', {
          method: 'GET',
          session,
        });
        const payload = await assertIcloudHmeOk(result, config);
        const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
        const refreshed = {
          ...session,
          csrfToken: String(data.csrf_token || session.csrfToken || '').trim(),
          expiresAt: getIcloudHmeUtils().normalizeIcloudHmeTimestamp?.(data.expires_at)
            || session.expiresAt
            || 0,
        };
        await cacheIcloudHmeSession(config, refreshed);
        return refreshed;
      } catch (err) {
        if (err?.icloudHmeAuthError || err?.icloudHmeCsrfError || err?.status === 401) {
          return null;
        }
        throw err;
      }
    }

    async function ensureIcloudHmeSession(state = {}, options = {}) {
      const config = ensureIcloudHmeConfig(state, options);
      if (!options.forceLogin) {
        const candidates = [];
        if (runtimeSessionCache?.baseUrl === config.baseUrl) {
          candidates.push(runtimeSessionCache);
        }
        const persisted = normalizeIcloudHmeSessionState(
          options.session !== undefined ? options.session : state?.icloudHmeSession
        );
        if (persisted?.baseUrl === config.baseUrl) {
          candidates.push(persisted);
        }
        for (const candidate of candidates) {
          if (!isIcloudHmeSessionFresh(candidate)) {
            continue;
          }
          const validated = await validateIcloudHmeSession(config, candidate);
          if (validated) {
            return { config, session: validated };
          }
        }
      }
      const session = await loginIcloudHme(state, options);
      return { config, session };
    }

    async function requestIcloudHmeJson(state, path, options = {}) {
      const { config, session } = await ensureIcloudHmeSession(state, options);
      try {
        const result = await requestIcloudHmeRaw(config, path, { ...options, session });
        return await assertIcloudHmeOk(result, config);
      } catch (err) {
        if (!err?.icloudHmeAuthError && !err?.icloudHmeCsrfError) {
          throw err;
        }
        const { session: refreshed } = await ensureIcloudHmeSession(state, { ...options, forceLogin: true });
        const retry = await requestIcloudHmeRaw(config, path, { ...options, session: refreshed });
        return assertIcloudHmeOk(retry, config);
      }
    }

    async function listIcloudHmeAccounts(state = {}, options = {}) {
      const payload = await requestIcloudHmeJson(state, '/api/accounts', options);
      const accounts = getIcloudHmeUtils().normalizeIcloudHmeAccounts?.(payload) || [];
      const config = getIcloudHmeConfig(state, options);
      return {
        accounts,
        resolvedAccountId: config.accountId
          || getIcloudHmeUtils().pickDefaultIcloudHmeAccountId?.(accounts)
          || '',
      };
    }

    async function resolveIcloudHmeAccountId(state = {}, options = {}) {
      const config = getIcloudHmeConfig(state, options);
      if (config.accountId) {
        return config.accountId;
      }
      const { accounts } = await listIcloudHmeAccounts(state, options);
      const resolved = getIcloudHmeUtils().pickDefaultIcloudHmeAccountId?.(accounts) || '';
      if (!resolved) {
        throw new Error('iCloud HME 服务中没有可用账号，请先在 icloud-hme 管理界面添加 iCloud 账号。');
      }
      return resolved;
    }

    async function listIcloudHmeAliases(state = {}, options = {}) {
      const accountId = await resolveIcloudHmeAccountId(state, options);
      const payload = await requestIcloudHmeJson(state, '/api/aliases', {
        ...options,
        searchParams: { account_id: accountId },
      });
      const rows = getIcloudHmeUtils().getIcloudHmeAliasRows?.(payload) || [];
      let usedEmails = {};
      let preservedEmails = {};
      try {
        if (typeof getEffectiveUsedEmails === 'function') {
          usedEmails = await getEffectiveUsedEmails(state);
        }
        if (typeof getPreservedAliasMap === 'function') {
          preservedEmails = await getPreservedAliasMap(state);
        }
      } catch (_) {}
      const aliases = getIcloudUtils().normalizeIcloudAliasList?.(rows, { usedEmails, preservedEmails })
        || rows;
      return { accountId, aliases };
    }

    async function createIcloudHmeAlias(state = {}, options = {}) {
      const accountId = await resolveIcloudHmeAccountId(state, options);
      const payload = await requestIcloudHmeJson(state, '/api/create', {
        ...options,
        method: 'POST',
        payload: {
          account_id: accountId,
          label: options.label || ICLOUD_HME_ALIAS_LABEL,
        },
      });
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
      const email = String(data.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        throw new Error('iCloud HME 创建别名成功但响应中缺少邮箱地址。');
      }
      return { accountId, email, label: String(data.label || '').trim(), createdAt: data.created_at || '' };
    }

    async function persistResolvedEmailState(state = null, email, options = {}) {
      if (typeof persistRegistrationEmailState === 'function') {
        await persistRegistrationEmailState(state, email, options);
        return;
      }
      await setEmailState(email, options);
    }

    async function fetchIcloudHmeAddress(state = {}, options = {}) {
      const mergedState = { ...(state || {}), ...(options?.state || {}) };
      const fetchMode = normalizeIcloudFetchMode(mergedState.icloudFetchMode);
      const generateNew = Boolean(options?.generateNew) || fetchMode === 'always_new';

      if (!generateNew) {
        try {
          const { aliases } = await listIcloudHmeAliases(mergedState, options);
          const reusable = getIcloudUtils().pickReusableIcloudAlias?.(aliases) || null;
          if (reusable?.email) {
            await persistResolvedEmailState(mergedState, reusable.email, {
              preserveAccountIdentity: Boolean(options?.preserveAccountIdentity),
              source: 'generated:icloud-hme',
            });
            await addLog(`已复用 iCloud HME 别名 ${reusable.email}`, 'info');
            return reusable.email;
          }
        } catch (err) {
          if (typeof throwIfStopped === 'function') {
            throwIfStopped();
          }
          await addLog(`iCloud HME 别名复用失败（${err?.message || err}），改为新建别名。`, 'warn');
        }
      }

      const created = await createIcloudHmeAlias(mergedState, options);
      await persistResolvedEmailState(mergedState, created.email, {
        preserveAccountIdentity: Boolean(options?.preserveAccountIdentity),
        source: 'generated:icloud-hme',
      });
      await addLog(`已通过 iCloud HME 生成别名 ${created.email}`, 'success');
      return created.email;
    }

    function normalizePollLimit(value, fallback = ICLOUD_HME_INBOX_LIMIT) {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
      }
      return Math.min(100, parsed);
    }

    async function pollIcloudHmeVerificationCode(step, state = {}, pollPayload = {}) {
      const targetEmail = String(pollPayload?.targetEmail || state?.email || '').trim().toLowerCase();
      if (!targetEmail) {
        throw new Error('iCloud HME 收码失败：当前没有可用的目标邮箱。');
      }
      const accountId = await resolveIcloudHmeAccountId(state, { session: state?.icloudHmeSession });
      const intervalMs = Math.max(1000, Math.floor(Number(pollPayload?.intervalMs) || 4000));
      const maxAttempts = Math.max(1, Math.floor(Number(pollPayload?.maxAttempts) || 1));
      const limit = normalizePollLimit(pollPayload?.limit);
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfStopped();
        try {
          const payload = await requestIcloudHmeJson(state, '/api/inbox', {
            searchParams: {
              account_id: accountId,
              alias: targetEmail,
              limit,
              days: ICLOUD_HME_INBOX_DAYS,
            },
          });
          const messages = getIcloudHmeUtils().normalizeIcloudHmeMessages?.(payload) || [];
          const pick = typeof pickVerificationMessageWithTimeFallback === 'function'
            ? pickVerificationMessageWithTimeFallback(messages, {
              afterTimestamp: pollPayload?.filterAfterTimestamp || 0,
              excludeCodes: pollPayload?.excludeCodes || [],
              senderFilters: pollPayload?.senderFilters || [],
              subjectFilters: pollPayload?.subjectFilters || [],
              requiredKeywords: pollPayload?.requiredKeywords || [],
              codePatterns: pollPayload?.codePatterns,
            })
            : null;
          if (pick?.match?.code) {
            return {
              ok: true,
              code: pick.match.code,
              emailTimestamp: pick.match.receivedAt || Date.now(),
              mailId: pick.match.message?.id || '',
              usedTimeFallback: Boolean(pick.usedTimeFallback),
            };
          }
          lastError = null;
        } catch (err) {
          if (typeof throwIfStopped === 'function') {
            throwIfStopped();
          }
          lastError = err;
        }
        if (attempt < maxAttempts) {
          await sleepWithStop(intervalMs);
        }
      }

      if (lastError) {
        throw lastError;
      }
      return { ok: false, reason: 'not_found' };
    }

    async function findIcloudHmeAliasAnonymousId(state = {}, email = '', options = {}) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) {
        return '';
      }
      const { aliases } = await listIcloudHmeAliases(state, options);
      const match = getIcloudUtils().findIcloudAliasByEmail?.(aliases, normalizedEmail)
        || aliases.find((alias) => String(alias?.email || '').trim().toLowerCase() === normalizedEmail);
      return String(match?.anonymousId || match?.id || '').trim();
    }

    async function deleteIcloudHmeAlias(payload = {}, options = {}) {
      const state = options.state || await getState();
      const email = String(payload?.email || '').trim().toLowerCase();
      let anonymousId = String(payload?.anonymousId || payload?.anonymousID || '').trim();
      if (!anonymousId && email) {
        anonymousId = await findIcloudHmeAliasAnonymousId(state, email, options);
      }
      if (!anonymousId) {
        throw new Error(email
          ? `iCloud HME 未找到别名 ${email}，无法删除。`
          : 'iCloud HME 删除别名缺少 anonymousId。');
      }
      const accountId = await resolveIcloudHmeAccountId(state, options);
      await requestIcloudHmeJson(state, `/api/aliases/${encodeURIComponent(anonymousId)}`, {
        method: 'DELETE',
        payload: { account_id: accountId },
      });
      return { ok: true, email, anonymousId };
    }

    async function testIcloudHmeConnection(overrides = {}) {
      const state = { ...(await getState()), ...overrides };
      const { accounts, resolvedAccountId } = await listIcloudHmeAccounts(state, {
        ...overrides,
        forceLogin: true,
      });
      return { ok: true, accounts, resolvedAccountId };
    }

    async function clearIcloudHmeSession() {
      runtimeSessionCache = null;
      await clearIcloudHmeSessionCookieRule();
      await setState({ icloudHmeSession: null }).catch(() => {});
    }

    return {
      clearIcloudHmeSession,
      createIcloudHmeAlias,
      deleteIcloudHmeAlias,
      ensureIcloudHmeConfig,
      ensureIcloudHmeSession,
      fetchIcloudHmeAddress,
      findIcloudHmeAliasAnonymousId,
      getIcloudHmeConfig,
      listIcloudHmeAccounts,
      listIcloudHmeAliases,
      loginIcloudHme,
      pollIcloudHmeVerificationCode,
      requestIcloudHmeJson,
      resolveIcloudHmeAccountId,
      testIcloudHmeConnection,
    };
  }

  return { createIcloudHmeProvider };
});
