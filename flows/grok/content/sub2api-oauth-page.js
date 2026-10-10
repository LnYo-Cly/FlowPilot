(function attachGrokSub2ApiOAuthPage(root, factory) {
  const api = factory();
  root.MultiPageGrokSub2ApiOAuthPage = api;
  api.installListener();
})(typeof self !== 'undefined' ? self : globalThis, function createGrokSub2ApiOAuthPage() {
  const LISTENER_SENTINEL = 'data-flowpilot-grok-sub2api-oauth-listener';
  const CONSENT_PAGE_PATTERN = /授权\s*Grok Build|Authorize\s+Grok Build|Grok Build\s+(?:wants|requests)|请求访问|wants to access/i;
  const ALLOW_ACTION_PATTERN = /^(?:允许|Allow|Authorize|Continue)$/i;
  // 设备授权页的中间步骤（确认代码/确认账号等）只有「继续」类前进按钮；
  // 不在这张名单上的拒绝/返回类动作永不点击。
  const FORWARD_ACTION_PATTERN = /继续|Continue|Next|Proceed|Confirm|确认|Verify|验证|Submit|提交|允许|Allow|Authorize|授权|Grant/i;
  const DENY_ACTION_PATTERN = /拒绝|Deny|Decline|Cancel|取消|Back|返回|Not now|稍后/i;
  const TURNSTILE_HINT_PATTERN = /challenges\.cloudflare\.com|turnstile|cf-chl|cloudflare/i;
  const CODE_PAGE_PATTERN = /输入此代码以完成登录|Enter this code to (?:complete|finish) sign(?:ing)?[ -]?in|Enter this code to (?:complete|finish) login|copy (?:the )?code(?: below)? (?:into|to) Grok Build|将下面的代码复制到\s*Grok Build/i;
  const ERROR_PAGE_PATTERN = /授权失败|拒绝授权|authorization (?:failed|denied)|access denied|something went wrong/i;
  const DEVICE_DONE_PATTERN = /设备已授权|device (?:is )?authorized|you have authorized|authorization complete/i;
  const DEVICE_DONE_PATH_PATTERN = /\/oauth2\/device\/done|\/device\/done|device_authorized/i;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function cleanText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getPathname(url = '', fallback = '') {
    const raw = cleanText(fallback);
    if (raw.startsWith('/')) return raw;
    try {
      if (url) return new URL(String(url), 'https://accounts.x.ai').pathname || '';
    } catch {}
    if (typeof location !== 'undefined' && location?.pathname) {
      return String(location.pathname || '');
    }
    return '';
  }

  function isSignInPath(pathname = '') {
    return /\/sign-?in(?:\/|$)/i.test(String(pathname || ''));
  }

  function normalizeAuthorizationCode(value = '') {
    const code = cleanText(value);
    if (code.length < 20 || code.length > 256 || /\s/.test(code) || !/^[A-Za-z0-9._~-]+$/.test(code)) {
      return '';
    }
    if (UUID_PATTERN.test(code)) return '';
    return code;
  }

  function extractAuthorizationCodeFromText(pageText = '') {
    const tokens = String(pageText || '').match(/[A-Za-z0-9._~-]{24,128}/g) || [];
    const codes = tokens
      .map(normalizeAuthorizationCode)
      .filter(Boolean)
      .filter((code) => /[-_]/.test(code) || /[A-Z]/.test(code) && /[a-z]/.test(code))
      .sort((left, right) => right.length - left.length);
    return codes[0] || '';
  }

  function classifyPageSnapshot(snapshot = {}) {
    const pageText = cleanText(snapshot.pageText);
    const pathname = getPathname(snapshot.url, snapshot.pathname);
    const actionIndex = (Array.isArray(snapshot.actionTexts) ? snapshot.actionTexts : [])
      .findIndex((text) => ALLOW_ACTION_PATTERN.test(cleanText(text)));
    const isConsentPage = CONSENT_PAGE_PATTERN.test(pageText);
    const hasCodeUi = CODE_PAGE_PATTERN.test(pageText);
    const onSignIn = isSignInPath(pathname);
    const withPath = (result) => pathname ? { ...result, pathname } : result;

    if (DEVICE_DONE_PATH_PATTERN.test(pathname) || DEVICE_DONE_PATH_PATTERN.test(snapshot.url || '') || DEVICE_DONE_PATTERN.test(pageText)) {
      return withPath({ state: 'device_done' });
    }

    if (isConsentPage && actionIndex >= 0) {
      return withPath({ state: 'consent_page', actionIndex });
    }

    if (onSignIn && !isConsentPage) {
      return withPath({ state: 'sign_in' });
    }

    if (hasCodeUi && !onSignIn) {
      const candidateCode = (Array.isArray(snapshot.codeCandidates) ? snapshot.codeCandidates : [])
        .map(normalizeAuthorizationCode)
        .find(Boolean);
      const code = candidateCode || extractAuthorizationCodeFromText(pageText);
      return code
        ? withPath({ state: 'code_page', code })
        : withPath({ state: 'code_waiting' });
    }

    if (isConsentPage) {
      return withPath({ state: 'consent_waiting' });
    }

    if (snapshot.hasCodeEntryInput && !onSignIn) {
      return withPath({ state: 'device_code_form' });
    }

    if (ERROR_PAGE_PATTERN.test(pageText)) {
      return withPath({
        state: 'error_page',
        error: 'Grok OAuth 授权页面显示失败。',
      });
    }

    return withPath({ state: 'loading' });
  }

  function isVisible(element) {
    if (!element || typeof window === 'undefined') return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  }

  function getElementTextValues(element) {
    return [
      element?.textContent,
      element?.value,
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'),
    ].map(cleanText).filter(Boolean);
  }

  function getActionText(element) {
    const values = getElementTextValues(element);
    return values.find((value) => ALLOW_ACTION_PATTERN.test(value)) || values[0] || '';
  }

  function getForwardActionText(element) {
    const values = getElementTextValues(element);
    const forwardHit = values.find((value) => FORWARD_ACTION_PATTERN.test(value));
    if (!forwardHit) return '';
    if (values.some((value) => DENY_ACTION_PATTERN.test(value))) return '';
    return forwardHit;
  }

  function getCodeCandidate(element) {
    const value = cleanText(element?.value);
    return value || cleanText(element?.textContent);
  }

  function collectVisible(selector) {
    if (typeof document === 'undefined') return [];
    return Array.from(document.querySelectorAll(selector)).filter(isVisible);
  }

  function inspectPage() {
    const actions = collectVisible('button, [role="button"], input[type="button"], input[type="submit"], a[href]')
      .filter((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    const codeElements = collectVisible([
      'input[readonly]',
      'textarea[readonly]',
      'code',
      'pre',
      '[data-testid*="code" i]',
      '[aria-label*="code" i]',
      '[class*="code" i]',
    ].join(', '));
    const codeEntryInputs = collectVisible('input:not([readonly]):not([type="hidden"]):not([type="checkbox"]):not([type="button"]):not([type="submit"])');
    const url = typeof location !== 'undefined' ? location.href : '';
    const pathname = typeof location !== 'undefined' ? location.pathname : '';
    const classified = classifyPageSnapshot({
      // 用 innerText 而非 textContent：SPA 内嵌的脚本/语言包 JSON 含有
      // "device is authorized"「授权 Grok Build」等字符串，textContent 会
      // 把它们算进页面文本导致误分类（把输码页判成 device_done）。
      pageText: cleanText(`${document.title || ''} ${document.body?.innerText ?? document.body?.textContent ?? ''}`),
      actionTexts: actions.map(getActionText),
      codeCandidates: codeElements.map(getCodeCandidate),
      hasCodeEntryInput: codeEntryInputs.length > 0,
      url,
      pathname,
    });
    const forwardActionElement = actions.find((element) => getForwardActionText(element)) || null;
    return {
      ...classified,
      url,
      pathname: classified.pathname || pathname,
      actionElement: Number.isInteger(classified.actionIndex) ? actions[classified.actionIndex] : null,
      forwardActionElement,
      forwardActionText: forwardActionElement ? getForwardActionText(forwardActionElement) : '',
      codeEntryInput: codeEntryInputs[0] || null,
      codeEntryInputs,
    };
  }

  function getPublicPageState() {
    const state = inspectPage();
    if (state.state === 'error_page') {
      throw new Error(state.error || 'Grok OAuth 授权失败。');
    }
    return {
      state: state.state,
      url: state.url,
      pathname: state.pathname || '',
      ...(state.code ? { code: state.code } : {}),
    };
  }

  function confirmConsent() {
    const state = inspectPage();
    if (state.state !== 'consent_page' || !state.actionElement) {
      throw new Error(`当前页面不是 Grok OAuth 授权确认页：${state.state}`);
    }
    if (typeof simulateClick === 'function') {
      simulateClick(state.actionElement);
    } else {
      state.actionElement.click();
    }
    return { submitted: true, state: 'consent_submitted', url: location.href };
  }

  const DEVICE_APPROVE_TIMEOUT_MS = 90000;
  const DEVICE_APPROVE_POLL_MS = 700;
  const DEVICE_FORWARD_CLICK_THROTTLE_MS = 1800;
  const DEVICE_TURNSTILE_COOLDOWN_MS = 8000;
  const DEVICE_TURNSTILE_MAX_CLICKS = 6;

  // 提示级检测：只决定要不要发点击请求；真正的组件定位由后台 CDP
  // （pierce 穿透 closed shadow root）完成。
  function hasTurnstileHint() {
    if (typeof document === 'undefined') return false;
    const iframes = Array.from(document.querySelectorAll('iframe'));
    if (iframes.some((frame) => TURNSTILE_HINT_PATTERN.test(`${frame.src || ''} ${frame.title || ''} ${frame.className || ''}`))) {
      return true;
    }
    return Boolean(document.querySelector('.cf-turnstile, [data-sitekey], [class*="turnstile" i], [id*="turnstile" i]'));
  }

  function fillCodeEntryInput(input, userCode) {
    if (!input || !userCode) return false;
    const nativeSetter = typeof HTMLInputElement !== 'undefined'
      ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      : null;
    try {
      if (nativeSetter) {
        nativeSetter.call(input, userCode);
      } else {
        input.value = userCode;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return cleanText(input.value) === cleanText(userCode);
    } catch (_error) {
      return false;
    }
  }

  function normalizeDeviceCode(value = '') {
    return cleanText(value).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  // 输码框已含目标码时视为已填（?user_code= 会预填到分格输入框）；
  // 只看输入框实际值，避免把预填码改写坏。
  function codeEntryInputsHaveCode(inputs, userCode) {
    const want = normalizeDeviceCode(userCode);
    if (!want || !Array.isArray(inputs) || !inputs.length) return false;
    const have = inputs.map((input) => cleanText(input?.value)).join('');
    return normalizeDeviceCode(have) === want;
  }

  // 多格 OTP 框按各框 maxlength 分配填入；单框直接填整码。
  function fillCodeEntryInputs(inputs, userCode) {
    const list = Array.isArray(inputs) ? inputs.filter(Boolean) : [];
    if (!list.length || !userCode) return false;
    if (list.length === 1) return fillCodeEntryInput(list[0], userCode);
    const digits = normalizeDeviceCode(userCode);
    if (!digits) return false;
    let cursor = 0;
    for (const input of list) {
      if (cursor >= digits.length) break;
      const maxLength = Number(input?.maxLength);
      const capacity = Number.isFinite(maxLength) && maxLength > 0
        ? Math.min(maxLength, digits.length - cursor)
        : Math.min(1, digits.length - cursor);
      const chunk = digits.slice(cursor, cursor + capacity);
      if (!chunk) break;
      if (!fillCodeEntryInput(input, chunk)) return false;
      cursor += chunk.length;
    }
    return cursor >= digits.length;
  }

  function clickActionElement(element) {
    if (!element) return false;
    if (typeof simulateClick === 'function') {
      simulateClick(element);
    } else {
      element.click();
    }
    return true;
  }

  const HTTP_APPROVE_TIMEOUT_MS = 45000;

  // 协议级设备授权（对齐 openai-cpa sso_to_token_device_flow）：
  // 同域表单 POST /oauth2/device/verify + /oauth2/device/approve，
  // 页面上下文 fetch 自动携带本标签所在 cookie store 的 sso/sso-rw
  // （无痕自动化窗口即无痕 store），完全不依赖按钮/DOM 结构。
  async function approveDeviceHttp(payload = {}) {
    const userCode = cleanText(payload.userCode || payload.user_code);
    if (!userCode) throw new Error('缺少 user_code，无法提交设备授权。');
    const principalId = cleanText(payload.principalId || payload.principal_id);
    const referrer = cleanText(payload.referrer) || 'grok-build';
    const plan = cleanText(payload.plan) || 'generic';
    const deadline = Date.now() + Math.max(5000, Number(payload.timeoutMs) || HTTP_APPROVE_TIMEOUT_MS);

    const SIGN_IN_URL = /sign-?in|sign-?up/i;
    // 只认重定向后的 URL：SPA 所有路由返回同一份外壳 HTML，
    // 内嵌 i18n 里有 "authorization complete" 等字符串，body 文本判定必然误报。
    const isDoneUrl = (url) => /\/device\/done|device_authorized/i.test(url || '');
    // accounts.x.ai 的 SPA catch-all 会把不存在的 POST 路由 302 到
    // /account 之类的页面——落到非 device 路径说明端点根本不接受表单，
    // 重试同一批变体没意义，立即回退到页面点击。
    const isDeviceishUrl = (url) => /\/oauth2\/device|\/device\/|consent|authorize|sign-?in|done/i.test(url || '');

    // 每个请求硬超时：协议路径失败要快速回退到页面点击，
    // 不能让挂起的 fetch 把整个回退链堵死。
    const requestSignal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(10000)
      : undefined);
    const postForm = async (path, fields) => {
      const body = new URLSearchParams();
      Object.entries(fields || {}).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        const text = String(value).trim();
        if (text) body.set(key, text);
      });
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        body: body.toString(),
        credentials: 'include',
        redirect: 'follow',
        signal: requestSignal(),
      });
      return { status: response.status, url: response.url || '', redirected: response.redirected };
    };
    // 复核授权结果：重新 GET consent 入口——user_code 一旦被消费，
    // 服务端会把它 302 到 /device/done；未授权则仍停在 consent。
    const probeConsent = async (ref) => {
      try {
        const response = await fetch(ref, { credentials: 'include', redirect: 'follow', signal: requestSignal() });
        return { status: response.status, url: response.url || '' };
      } catch (_error) {
        return null;
      }
    };

    // 1) verify：提交 user_code，正常应 302 到 consent 页。
    let consentRef = `/oauth2/device/consent?user_code=${encodeURIComponent(userCode)}`;
    if (typeof log === 'function') log('[Grok 设备授权] 协议路径：POST /oauth2/device/verify...', 'info');
    const verify = await postForm('/oauth2/device/verify', { user_code: userCode });
    if (typeof log === 'function') log(`[Grok 设备授权] verify 响应 ${verify.status} ${verify.url}`, 'info');
    if (SIGN_IN_URL.test(verify.url)) {
      throw new Error('设备授权 verify 跳转登录页，SSO 会话不可用。');
    }
    if (isDoneUrl(verify.url)) {
      return { submitted: true, state: 'device_authorized', via: 'http_verify', url: verify.url };
    }
    if (!isDeviceishUrl(verify.url)) {
      throw new Error(`设备授权 verify 落点非授权路径（${verify.url || '无 URL'}），端点不接受表单提交。`);
    }
    if (verify.url && /consent/i.test(verify.url)) {
      consentRef = verify.url;
    }

    // 2) 抓 consent 页隐藏表单字段（SPA 多半没有，拿不到就用最小表单兜底）。
    const overlay = { user_code: userCode, action: 'allow', principal_type: 'User', referrer, plan };
    if (principalId) overlay.principal_id = principalId;
    try {
      const consentHtml = await fetch(consentRef, { credentials: 'include', redirect: 'follow' })
        .then((response) => (response.ok || response.redirected ? response.text() : ''));
      const doc = new DOMParser().parseFromString(consentHtml, 'text/html');
      doc.querySelectorAll('input[name]').forEach((input) => {
        const name = cleanText(input.getAttribute('name') || '');
        if (!name || name.toLowerCase() === 'submit') return;
        const value = input.getAttribute('value') || '';
        if (value) overlay[name] = value;
      });
      overlay.action = 'allow';
      overlay.user_code = userCode;
      overlay.referrer = referrer;
      overlay.plan = plan;
      if (principalId && !cleanText(overlay.principal_id)) overlay.principal_id = principalId;
    } catch (_error) {}

    const formVariants = [
      { user_code: userCode, action: 'allow', referrer, plan, principal_type: 'User', ...(principalId ? { principal_id: principalId } : {}) },
      overlay,
      { user_code: userCode, action: 'allow' },
    ];

    // 3) approve：表单变体过一遍即可——302 落到 /device/done 即成功；
    // 200/XHR 风格响应再复核 consent 入口。全部落空立即抛，
    // 不在死路上空转（回退点击路径更可靠）。
    let lastError = '';
    let pass = 0;
    while (pass < 2 && Date.now() < deadline) {
      pass += 1;
      for (const form of formVariants) {
        let res = null;
        try {
          res = await postForm('/oauth2/device/approve', form);
        } catch (error) {
          lastError = String(error?.message || error);
          continue;
        }
        if (SIGN_IN_URL.test(res.url)) {
          throw new Error('设备授权 approve 跳转登录页，SSO 会话不可用。');
        }
        if (isDoneUrl(res.url)) {
          return { submitted: true, state: 'device_authorized', via: 'http', url: res.url };
        }
        if (!isDeviceishUrl(res.url)) {
          throw new Error(`设备授权 approve 落点非授权路径（${res.url || '无 URL'}），端点不接受表单提交。`);
        }
        const probe = await probeConsent(consentRef);
        if (probe && isDoneUrl(probe.url)) {
          return { submitted: true, state: 'device_authorized', via: 'http_probe', url: probe.url };
        }
        if (probe && SIGN_IN_URL.test(probe.url)) {
          throw new Error('设备授权复核跳转登录页，SSO 会话不可用。');
        }
        lastError = `HTTP ${res.status} ${res.url || ''}`.trim();
        if (typeof log === 'function') log(`[Grok 设备授权] approve 未确认：${lastError}`, 'info');
      }
      if (lastError && Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw new Error(`设备授权协议提交未确认完成（${lastError || '无响应'}）。`);
  }

  // 设备授权流程：CF 验证（可能）→ verify 页（可能带 user_code 输入框）
  // → 「继续」类中间页 → 「允许」同意页 → device/done。
  // 页面形态以 inspectPage 每次循环的现场状态为准：任何前进动作
  // （继续/允许/Authorize/Verify…）都会点击，拒绝类动作永不点击；
  // CF 组件交给后台 CDP 穿透定位后可信点击。
  async function approveDevice(payload = {}) {
    const userCode = cleanText(payload.userCode || payload.user_code);
    const deadline = Date.now() + DEVICE_APPROVE_TIMEOUT_MS;
    let codeSubmitted = false;
    let codeFillFailures = 0;
    let lastForwardClickAt = 0;
    let lastTurnstileClickAt = 0;
    let turnstileClicks = 0;
    let stuckClickCount = 0;
    let lastState = '';
    const stateTrail = [];

    const noteState = (name) => {
      if (name === lastState) return;
      lastState = name;
      stuckClickCount = 0;
      stateTrail.push(name);
      if (typeof log === 'function') {
        log(`[Grok 设备授权] 页面状态：${name}`, 'info');
      }
    };

    while (Date.now() < deadline) {
      const state = inspectPage();
      noteState(state.state);
      if (state.state === 'device_done') {
        return { submitted: true, state: 'device_authorized', url: state.url, stateTrail };
      }
      if (state.state === 'error_page') {
        throw new Error(`${state.error || 'Grok 设备授权页显示失败。'}（轨迹：${stateTrail.join('→')}）`);
      }
      if (state.state === 'sign_in') {
        throw new Error(`设备授权页跳转到登录页，SSO 会话已失效。（轨迹：${stateTrail.join('→')}）`);
      }

      // 1) 输码页：先把码填好（预填则直接通过），再交下面统一点前进；
      //    连续填不进（自定义组件拿不到真 input）时放行前进点击兜底。
      if (state.state === 'device_code_form' && !codeSubmitted) {
        const alreadyFilled = codeEntryInputsHaveCode(state.codeEntryInputs || [state.codeEntryInput], userCode);
        if (alreadyFilled || (userCode && fillCodeEntryInputs(state.codeEntryInputs || [state.codeEntryInput], userCode))) {
          codeSubmitted = true;
        } else {
          codeFillFailures += 1;
          if (codeFillFailures < 8) {
            await new Promise((resolve) => setTimeout(resolve, DEVICE_APPROVE_POLL_MS));
            continue;
          }
          codeSubmitted = true;
        }
      }

      // 2) 有前进按钮就点——「继续」类中间页 / consent 的「允许」都走这里，
      //    不被 Turnstile 探测挡住。
      const forwardElement = state.forwardActionElement || (state.state === 'consent_page' ? state.actionElement : null);
      if (forwardElement && Date.now() - lastForwardClickAt >= DEVICE_FORWARD_CLICK_THROTTLE_MS) {
        lastForwardClickAt = Date.now();
        stuckClickCount += 1;
        // 合成点击连续无效（页面可能校验 isTrusted）→ 升级后台 CDP 可信点击。
        if (stuckClickCount >= 3 && typeof chrome?.runtime?.sendMessage === 'function') {
          const rect = forwardElement.getBoundingClientRect?.();
          if (rect && rect.width > 0 && rect.height > 0) {
            if (typeof log === 'function') {
              log(`[Grok 设备授权] 合成点击无效，改用可信点击「${state.forwardActionText || 'allow'}」。`, 'info');
            }
            try {
              await chrome.runtime.sendMessage({
                type: 'GROK_TRUSTED_CLICK_REQUEST',
                source: 'grok-sub2api-oauth-page',
                payload: { centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 },
              });
            } catch (_error) {}
            await new Promise((resolve) => setTimeout(resolve, 1200));
            continue;
          }
        }
        if (typeof log === 'function') {
          log(`[Grok 设备授权] 点击前进按钮「${state.forwardActionText || 'allow'}」。`, 'info');
        }
        clickActionElement(forwardElement);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        continue;
      }

      // 3) 无按钮可点时才是 CF 真人验证的时间窗：本地只做提示级检测，
      //    坐标由后台 CDP 穿透定位。
      if ((hasTurnstileHint() || state.state === 'loading')
        && turnstileClicks < DEVICE_TURNSTILE_MAX_CLICKS
        && Date.now() - lastTurnstileClickAt >= DEVICE_TURNSTILE_COOLDOWN_MS) {
        lastTurnstileClickAt = Date.now();
        turnstileClicks += 1;
        noteState('turnstile');
        if (typeof log === 'function') {
          log('[Grok 设备授权] 检测到 Cloudflare 验证迹象，请求后台可信点击...', 'info');
        }
        try {
          await chrome.runtime.sendMessage({
            type: 'GROK_TURNSTILE_CLICK_REQUEST',
            source: 'grok-sub2api-oauth-page',
            payload: { probe: true },
          });
        } catch (_error) {}
        await new Promise((resolve) => setTimeout(resolve, DEVICE_APPROVE_POLL_MS));
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, DEVICE_APPROVE_POLL_MS));
    }
    throw new Error(`Grok 设备授权超时（最后状态：${lastState || 'unknown'}；轨迹：${stateTrail.join('→') || 'none'}）。`);
  }

  async function handleMessage(message = {}) {
    if (message.type === 'GET_GROK_SUB2API_OAUTH_STATE') {
      return getPublicPageState();
    }
    if (message.type === 'EXECUTE_GROK_SUB2API_OAUTH_ACTION') {
      const action = String(message.payload?.action || '').trim();
      if (action === 'confirm-consent') {
        return confirmConsent();
      }
      if (action === 'approve-device') {
        return approveDevice(message.payload || {});
      }
      if (action === 'approve-device-http') {
        return approveDeviceHttp(message.payload || {});
      }
      throw new Error(`未知 Grok SUB2API OAuth 动作：${message.payload?.action || ''}`);
    }
    return null;
  }

  function installListener() {
    if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
      return;
    }
    if (document.documentElement.getAttribute(LISTENER_SENTINEL) === '1') {
      return;
    }
    document.documentElement.setAttribute(LISTENER_SENTINEL, '1');
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!['GET_GROK_SUB2API_OAUTH_STATE', 'EXECUTE_GROK_SUB2API_OAUTH_ACTION'].includes(message?.type)) {
        return false;
      }
      handleMessage(message)
        .then((result) => sendResponse({ ok: true, ...(result || {}) }))
        .catch((error) => sendResponse({ error: error?.message || String(error || '未知错误') }));
      return true;
    });
  }

  return {
    approveDevice,
    approveDeviceHttp,
    classifyPageSnapshot,
    codeEntryInputsHaveCode,
    extractAuthorizationCodeFromText,
    fillCodeEntryInput,
    fillCodeEntryInputs,
    getActionText,
    getCodeCandidate,
    getPathname,
    getPublicPageState,
    handleMessage,
    installListener,
    isSignInPath,
    normalizeAuthorizationCode,
  };
});
