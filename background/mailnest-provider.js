(function mailnestProviderModule(root, factory) {
  root.MultiPageBackgroundMailnestProvider = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createMailnestProviderModule(root = globalThis) {
  const MAILNEST_DEFAULT_BASE_URL = 'https://mailnest.top';
  const MAILNEST_FETCH_TIMEOUT_MS = 20000;
  const MAILNEST_SUCCESS_CODE = '00000';
  const MAILNEST_MODE_TEMPORARY = 'temporary';
  const MAILNEST_MODE_EXCLUSIVE = 'exclusive';
  const MAILNEST_DEFAULT_ACCOUNT_PRODUCT = 'lweb_ocom_test';

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function normalizeMailnestBaseUrl(value = '') {
    const trimmed = cleanString(value) || MAILNEST_DEFAULT_BASE_URL;
    const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return '';
      }
      parsed.hash = '';
      parsed.search = '';
      const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
      return `${parsed.origin}${pathname}`;
    } catch {
      return '';
    }
  }

  function joinMailnestUrl(baseUrl, path = '') {
    const base = normalizeMailnestBaseUrl(baseUrl);
    const suffix = cleanString(path).replace(/^\/+/, '');
    return suffix ? `${base}/${suffix}` : base;
  }

  function normalizeMailnestMode(value = '') {
    return cleanString(value).toLowerCase() === MAILNEST_MODE_EXCLUSIVE
      ? MAILNEST_MODE_EXCLUSIVE
      : MAILNEST_MODE_TEMPORARY;
  }

  function getMailnestConfig(state = {}, overrides = {}) {
    return {
      baseUrl: normalizeMailnestBaseUrl(
        overrides.baseUrl !== undefined ? overrides.baseUrl : state.mailnestBaseUrl
      ),
      apiKey: cleanString(
        overrides.apiKey !== undefined ? overrides.apiKey : state.mailnestApiKey
      ),
      mode: normalizeMailnestMode(
        overrides.mode !== undefined ? overrides.mode : state.mailnestMode
      ),
      projectCode: cleanString(
        overrides.projectCode !== undefined ? overrides.projectCode : state.mailnestProjectCode
      ),
    };
  }

  function normalizeMailnestMessage(raw = {}) {
    const sender = cleanString(raw.from || raw.from_address || raw.sender);
    const subject = cleanString(raw.subject || raw.title);
    const text = cleanString(raw.text || raw.content || raw.body || '');
    const html = cleanString(raw.html || raw.html_content || '');
    const bodyContent = text || html.replace(/<[^>]+>/g, ' ');
    const rawTimestamp = raw.timestamp ?? raw.created_at ?? raw.create_time ?? raw.received_at ?? raw.date;
    let receivedDateTime = '';
    if (rawTimestamp !== undefined && rawTimestamp !== null && rawTimestamp !== '') {
      const numeric = Number(rawTimestamp);
      if (Number.isFinite(numeric) && numeric > 0) {
        receivedDateTime = new Date(numeric < 1e12 ? numeric * 1000 : numeric).toISOString();
      } else {
        const parsed = Date.parse(String(rawTimestamp).replace(' ', 'T') + (String(rawTimestamp).includes('Z') ? '' : 'Z'));
        receivedDateTime = Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
      }
    }
    return {
      id: cleanString(raw.id || raw.mail_id || raw.message_id),
      subject,
      bodyPreview: bodyContent.slice(0, 300),
      body: { content: bodyContent },
      from: { emailAddress: { address: sender, name: '' } },
      receivedDateTime,
      mailbox: 'INBOX',
      codeMatch: cleanString(raw.code_match),
    };
  }

  /**
   * 解析账号购买返回的 content 文本（每行一个账号）。
   * 兼容 email----password / email:password / 制表符或空格分隔；
   * 三段以上时按 fields[0]=密码、fields[1]=clientId、fields[2]=refreshToken 解释（graph 令牌号）。
   */
  function parseMailnestAccountContent(content = '') {
    const text = String(content ?? '');
    const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const accounts = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(emailRe);
      if (!match) continue;
      const rest = line.slice(match.index + match[0].length);
      const fields = rest
        .split(/----|\t|\s*[|:：]\s*|\s+/)
        .map(cleanString)
        .filter(Boolean);
      accounts.push({
        email: match[0].toLowerCase(),
        password: fields[0] || '',
        clientId: fields[1] || '',
        refreshToken: fields[2] || '',
        fields,
        raw: line,
      });
    }
    return accounts;
  }

  function createMailnestProvider(deps = {}) {
    const {
      addLog = async () => {},
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      getState = async () => ({}),
      persistRegistrationEmailState = null,
      pickVerificationMessageWithTimeFallback = null,
      setEmailState = async () => {},
      sleepWithStop = async () => {},
      throwIfStopped = () => {},
    } = deps;

    function ensureMailnestConfig(state = {}, overrides = {}, options = {}) {
      const config = getMailnestConfig(state, overrides);
      if (!config.baseUrl) {
        throw new Error('MailNest 服务地址为空或格式无效。');
      }
      if (options.requireApiKey !== false && !config.apiKey) {
        throw new Error('请先填写 MailNest API Key（在 mailnest.top 账号页获取）。');
      }
      if (options.requireProjectCode !== false
        && config.mode === MAILNEST_MODE_TEMPORARY
        && !config.projectCode) {
        throw new Error('MailNest 临时邮箱需要项目代码，请先在设置中拉取并选择项目。');
      }
      return config;
    }

    async function requestMailnestJson(state, path, options = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('当前环境不支持 fetch，无法连接 MailNest 服务。');
      }
      const config = ensureMailnestConfig(state, options.overrides || {}, {
        requireProjectCode: false,
        requireApiKey: options.requireApiKey !== false,
      });
      const method = cleanString(options.method || 'GET').toUpperCase() || 'GET';
      const url = new URL(joinMailnestUrl(config.baseUrl, path));
      const bearerToken = options.bearerToken !== undefined ? cleanString(options.bearerToken) : config.apiKey;
      const headers = { Accept: 'application/json' };
      if (bearerToken) {
        headers.Authorization = `Bearer ${bearerToken}`;
      }
      const init = { method, headers, cache: 'no-store' };
      if (options.payload !== undefined && method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.payload);
      }
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || MAILNEST_FETCH_TIMEOUT_MS));
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
          throw new Error(`MailNest 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
        }
        throw new Error(`无法连接 MailNest 服务：${err?.message || err}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (response.status === 401) {
        const error = new Error('MailNest 请求未授权或登录已失效（HTTP 401）。');
        error.mailnestUnauthorized = true;
        throw error;
      }
      if (!response.ok) {
        const msg = cleanString(payload?.msg || payload?.message || payload?.error) || `HTTP ${response.status}`;
        throw new Error(`MailNest 请求失败：${msg}`);
      }
      if (!payload || typeof payload !== 'object' || String(payload.code) !== MAILNEST_SUCCESS_CODE) {
        const msg = cleanString(payload?.msg || payload?.message) || '响应缺少成功标记';
        throw new Error(`MailNest 请求失败：${msg}`);
      }
      return payload.data;
    }

    async function buyMailnestTemporaryEmail(config, options = {}) {
      const data = await requestMailnestJson(options.state || {}, '/api/v1/email/temporary/buy', {
        method: 'POST',
        payload: { project_code: config.projectCode, count: 1 },
        overrides: options.overrides,
        timeoutMs: options.timeoutMs,
      });
      const email = cleanString((Array.isArray(data) ? data[0] : data?.[0] || data)?.email).toLowerCase();
      if (!email || !email.includes('@')) {
        throw new Error('MailNest 购买临时邮箱成功但响应中缺少邮箱地址。');
      }
      return { email, saleMode: MAILNEST_MODE_TEMPORARY, projectCode: config.projectCode };
    }

    async function buyMailnestExclusiveEmail(config, options = {}) {
      const data = await requestMailnestJson(options.state || {}, '/api/v1/email/exclusive/buy', {
        method: 'POST',
        payload: { count: 1 },
        overrides: options.overrides,
        timeoutMs: options.timeoutMs,
      });
      const email = cleanString((Array.isArray(data) ? data[0] : data?.[0] || data)?.email).toLowerCase();
      if (!email || !email.includes('@')) {
        throw new Error('MailNest 购买独占邮箱成功但响应中缺少邮箱地址。');
      }
      return { email, saleMode: MAILNEST_MODE_EXCLUSIVE, projectCode: '' };
    }

    async function persistResolvedEmailState(state = null, email, options = {}) {
      if (typeof persistRegistrationEmailState === 'function') {
        await persistRegistrationEmailState(state, email, options);
        return;
      }
      await setEmailState(email, options);
    }

    async function fetchMailnestAddress(state = {}, options = {}) {
      const mergedState = { ...(state || {}), ...(options?.state || {}) };
      const config = ensureMailnestConfig(mergedState, options.overrides || {});
      const modeLabel = config.mode === MAILNEST_MODE_EXCLUSIVE ? '独占' : '临时';
      await addLog(`MailNest：正在购买${modeLabel}邮箱${config.mode === MAILNEST_MODE_TEMPORARY ? `（项目 ${config.projectCode}）` : ''}...`, 'info');

      const bought = config.mode === MAILNEST_MODE_EXCLUSIVE
        ? await buyMailnestExclusiveEmail(config, { state: mergedState, overrides: options.overrides })
        : await buyMailnestTemporaryEmail(config, { state: mergedState, overrides: options.overrides });

      await persistResolvedEmailState(mergedState, bought.email, {
        preserveAccountIdentity: Boolean(options?.preserveAccountIdentity),
        source: 'generated:mailnest',
      });
      await addLog(`已通过 MailNest 获取${modeLabel}邮箱 ${bought.email}`, 'success');
      return bought.email;
    }

    async function listMailnestMessages(state, email, options = {}) {
      const data = await requestMailnestJson(state, '/api/v1/email/receive', {
        method: 'POST',
        payload: { email },
        overrides: options.overrides,
        timeoutMs: options.timeoutMs,
      });
      const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
      return items.map(normalizeMailnestMessage);
    }

    async function pollMailnestVerificationCode(step, state = {}, pollPayload = {}) {
      const targetEmail = cleanString(pollPayload?.targetEmail || state?.email).toLowerCase();
      if (!targetEmail) {
        throw new Error('MailNest 收码失败：当前没有可用的目标邮箱。');
      }
      ensureMailnestConfig(state, pollPayload?.overrides || {}, { requireProjectCode: false });

      const intervalMs = Math.max(2000, Math.floor(Number(pollPayload?.intervalMs) || 4000));
      const maxAttempts = Math.max(1, Math.floor(Number(pollPayload?.maxAttempts) || 1));
      const excludeCodes = new Set((pollPayload?.excludeCodes || []).map((value) => cleanString(value)).filter(Boolean));
      const afterTimestamp = Number(pollPayload?.filterAfterTimestamp) || 0;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfStopped();
        try {
          const messages = await listMailnestMessages(state, targetEmail, {
            overrides: pollPayload?.overrides,
          });
          // MailNest 返回的 code_match 是服务端按项目规则提取的验证码，优先使用；
          // 先按时间/排除码过滤，再回退到通用匹配逻辑覆盖 code_match 缺失的邮件。
          const sorted = messages
            .slice()
            .sort((a, b) => (Date.parse(b.receivedDateTime) || 0) - (Date.parse(a.receivedDateTime) || 0));
          for (const message of sorted) {
            const code = message.codeMatch;
            if (!code || excludeCodes.has(code)) continue;
            const receivedAt = Date.parse(message.receivedDateTime) || 0;
            if (afterTimestamp && receivedAt && receivedAt < afterTimestamp) continue;
            return {
              ok: true,
              code,
              emailTimestamp: receivedAt || Date.now(),
              mailId: message.id || '',
            };
          }

          if (typeof pickVerificationMessageWithTimeFallback === 'function') {
            const pick = pickVerificationMessageWithTimeFallback(messages, {
              afterTimestamp,
              excludeCodes: pollPayload?.excludeCodes || [],
              senderFilters: pollPayload?.senderFilters || [],
              subjectFilters: pollPayload?.subjectFilters || [],
              requiredKeywords: pollPayload?.requiredKeywords || [],
              codePatterns: pollPayload?.codePatterns,
            });
            if (pick?.match?.code) {
              return {
                ok: true,
                code: pick.match.code,
                emailTimestamp: pick.match.receivedAt || Date.now(),
                mailId: pick.match.message?.id || '',
                usedTimeFallback: Boolean(pick.usedTimeFallback),
              };
            }
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

    async function listMailnestProducts(overrides = {}) {
      const state = { ...(await getState()), ...overrides };
      const data = await requestMailnestJson(state, '/api/product/info', { overrides });
      const temporary = (Array.isArray(data?.temporary) ? data.temporary : [])
        .map((item) => ({
          code: cleanString(item?.code),
          name: cleanString(item?.name),
          query: cleanString(item?.query),
          icon: cleanString(item?.icon),
          stock: Number(item?.stock) || 0,
          price: cleanString(item?.price),
          originalPrice: cleanString(item?.original_price),
          senderDomains: cleanString(item?.sender_domains),
          mailKeywords: cleanString(item?.mail_keywords),
          durationSeconds: Number(item?.duration_seconds) || 0,
        }))
        .filter((item) => item.code);
      const exclusive = data?.exclusive && typeof data.exclusive === 'object'
        ? {
          stock: Number(data.exclusive.stock) || 0,
          price: cleanString(data.exclusive.price),
          originalPrice: cleanString(data.exclusive.original_price),
        }
        : null;
      return { temporary, exclusive };
    }

    async function getMailnestBalance(overrides = {}) {
      const state = { ...(await getState()), ...overrides };
      const data = await requestMailnestJson(state, '/api/v1/balance', { overrides });
      return {
        balance: cleanString(data?.balance),
        availableBalance: cleanString(data?.available_balance),
        frozenBalance: cleanString(data?.frozen_balance),
      };
    }

    async function testMailnestConnection(overrides = {}) {
      const balance = await getMailnestBalance(overrides);
      const products = await listMailnestProducts(overrides).catch(() => null);
      return {
        ok: true,
        balance,
        temporaryProjectCount: products?.temporary?.length ?? null,
        exclusiveStock: products?.exclusive?.stock ?? null,
      };
    }

    async function releaseMailnestEmail(payload = {}, options = {}) {
      const state = options.state || await getState();
      const email = cleanString(payload?.email).toLowerCase();
      if (!email) {
        throw new Error('MailNest 释放邮箱缺少 email 参数。');
      }
      await requestMailnestJson(state, '/api/v1/email/release', {
        method: 'POST',
        payload: { email },
        overrides: options.overrides,
      });
      return { ok: true, email };
    }

    // ---- 网站账号体系（账号购买走 /api/account/*，用网站登录态而非 API Key） ----
    const webAuthCache = { accessToken: '', refreshToken: '' };

    function getMailnestWebCredentials(state = {}, overrides = {}) {
      return {
        username: cleanString(overrides.username !== undefined ? overrides.username : state.mailnestWebUsername),
        password: cleanString(overrides.password !== undefined ? overrides.password : state.mailnestWebPassword),
      };
    }

    function isMailnestWebConfigured(state = {}, overrides = {}) {
      const { username, password } = getMailnestWebCredentials(state, overrides);
      return Boolean(username && password);
    }

    async function loginMailnestWebsite(state = {}, options = {}) {
      const creds = getMailnestWebCredentials(state, options.overrides || {});
      if (!creds.username || !creds.password) {
        throw new Error('缺少 MailNest 网站账号密码（购买微软账号用，与 API Key 不同）。');
      }
      const data = await requestMailnestJson(state, '/api/users/login', {
        method: 'POST',
        payload: { username: creds.username, password: creds.password },
        requireApiKey: false,
        bearerToken: '',
        overrides: options.overrides,
        timeoutMs: options.timeoutMs,
      });
      webAuthCache.accessToken = cleanString(data?.access_token || data?.accessToken);
      webAuthCache.refreshToken = cleanString(data?.refresh_token || data?.refreshToken);
      if (!webAuthCache.accessToken) {
        throw new Error('MailNest 网站登录成功但响应缺少 access_token。');
      }
      return webAuthCache.accessToken;
    }

    async function getMailnestWebAccessToken(state = {}, options = {}) {
      if (!options.forceFresh && webAuthCache.accessToken) {
        return webAuthCache.accessToken;
      }
      if (webAuthCache.refreshToken) {
        try {
          const data = await requestMailnestJson(state, '/api/users/refresh', {
            method: 'POST',
            payload: { refresh_token: webAuthCache.refreshToken },
            requireApiKey: false,
            bearerToken: '',
            timeoutMs: options.timeoutMs,
          });
          const accessToken = cleanString(data?.access_token || data?.accessToken);
          const refreshToken = cleanString(data?.refresh_token || data?.refreshToken);
          if (accessToken) {
            webAuthCache.accessToken = accessToken;
            if (refreshToken) webAuthCache.refreshToken = refreshToken;
            return accessToken;
          }
        } catch (_) {
          webAuthCache.accessToken = '';
          webAuthCache.refreshToken = '';
        }
      }
      return loginMailnestWebsite(state, options);
    }

    async function requestMailnestWebJson(state = {}, path, options = {}) {
      const token = await getMailnestWebAccessToken(state, options);
      try {
        return await requestMailnestJson(state, path, {
          ...options,
          bearerToken: token,
          requireApiKey: false,
        });
      } catch (err) {
        if (!err?.mailnestUnauthorized) {
          throw err;
        }
        webAuthCache.accessToken = '';
        const freshToken = await getMailnestWebAccessToken(state, { ...options, forceFresh: true });
        return requestMailnestJson(state, path, {
          ...options,
          bearerToken: freshToken,
          requireApiKey: false,
        });
      }
    }

    function normalizeMailnestAccountProduct(item = {}) {
      return {
        accountType: cleanString(item?.account_type),
        name: cleanString(item?.name),
        description: cleanString(item?.description),
        price: cleanString(item?.price),
        originalPrice: cleanString(item?.original_price),
        stock: Number(item?.stock) || 0,
        helpUrl: cleanString(item?.help_url),
      };
    }

    async function listMailnestAccountProducts(state = {}, options = {}) {
      const data = await requestMailnestWebJson(state, '/api/account/info', options);
      const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
      return items.map(normalizeMailnestAccountProduct).filter((item) => item.accountType);
    }

    async function buyMailnestAccounts(state = {}, options = {}) {
      const accountType = cleanString(options.accountType || state.mailnestAccountProductType)
        || MAILNEST_DEFAULT_ACCOUNT_PRODUCT;
      const count = Math.max(1, Math.floor(Number(options.count) || 1));
      const data = await requestMailnestWebJson(state, '/api/account/buy', {
        method: 'POST',
        payload: { account_type: accountType, count },
        timeoutMs: options.timeoutMs,
      });
      const content = cleanString(data?.content);
      return {
        id: cleanString(data?.id ?? data?.order_id),
        accountType,
        count,
        content,
        accounts: parseMailnestAccountContent(content),
      };
    }

    return {
      buyMailnestAccounts,
      ensureMailnestConfig,
      fetchMailnestAddress,
      getMailnestBalance,
      getMailnestConfig,
      isMailnestWebConfigured,
      listMailnestAccountProducts,
      listMailnestMessages,
      listMailnestProducts,
      loginMailnestWebsite,
      normalizeMailnestMode,
      pollMailnestVerificationCode,
      releaseMailnestEmail,
      requestMailnestJson,
      requestMailnestWebJson,
      testMailnestConnection,
    };
  }

  return {
    MAILNEST_DEFAULT_ACCOUNT_PRODUCT,
    MAILNEST_DEFAULT_BASE_URL,
    MAILNEST_MODE_EXCLUSIVE,
    MAILNEST_MODE_TEMPORARY,
    createMailnestProvider,
    normalizeMailnestBaseUrl,
    normalizeMailnestMessage,
    normalizeMailnestMode,
    parseMailnestAccountContent,
  };
});
