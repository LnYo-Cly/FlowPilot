console.log('[MultiPage:grok-register-page] Content script loaded on', location.href);

const GROK_REGISTER_PAGE_LISTENER_SENTINEL = 'data-multipage-grok-register-page-listener';
const GROK_SIGNUP_URL = 'https://accounts.x.ai/sign-up?redirect=grok-com';
const GROK_EMAIL_SIGNUP_TEXT_PATTERN = /使用邮箱注册|sign\s*up\s*with\s*email|continue\s*with\s*email|email/i;
const GROK_CONTINUE_TEXT_PATTERN = /continue|next|sign\s*up|submit|verify|继续|下一步|注册|提交|验证/i;
const GROK_PROFILE_TEXT_PATTERN = /given\s*name|family\s*name|first\s*name|last\s*name|password|名字|姓氏|密码/i;
const GROK_EMAIL_VERIFICATION_READY_TIMEOUT_MS = 90 * 1000;
const GROK_HUMAN_VERIFICATION_SUCCESS_TIMEOUT_MS = 5 * 60 * 1000;
const GROK_HUMAN_VERIFICATION_SUCCESS_TEXT_PATTERN = /成功|success|verified|verification\s*(?:complete|successful)|challenge\s*(?:complete|passed)/i;

function isVisibleGrokElement(element) {
  if (!element || !(element instanceof Element)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getGrokElementText(element) {
  if (!element) return '';
  return String(
    element.innerText
    || element.textContent
    || element.getAttribute?.('aria-label')
    || element.getAttribute?.('title')
    || ''
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function queryVisibleGrokElement(selector) {
  return Array.from(document.querySelectorAll(selector)).find(isVisibleGrokElement) || null;
}

function findGrokClickableByText(pattern) {
  const selectors = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
  return Array.from(document.querySelectorAll(selectors)).find((element) => {
    if (!isVisibleGrokElement(element)) return false;
    const text = element instanceof HTMLInputElement ? element.value : getGrokElementText(element);
    return pattern.test(text);
  }) || null;
}

function simulateGrokClick(element) {
  throwIfStopped();
  if (!element) {
    throw new Error('无法点击空元素。');
  }
  const rect = element.getBoundingClientRect();
  const clientX = Math.max(0, Math.floor(rect.left + Math.min(rect.width - 1, Math.max(1, rect.width / 2))));
  const clientY = Math.max(0, Math.floor(rect.top + Math.min(rect.height - 1, Math.max(1, rect.height / 2))));
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
    screenX: window.screenX + clientX,
    screenY: window.screenY + clientY,
  };
  element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
  element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
  element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
  if (typeof element.click === 'function') {
    element.click();
    return;
  }
  element.dispatchEvent(new MouseEvent('click', eventOptions));
}

async function waitForGrok(predicate, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
  const intervalMs = Math.max(100, Number(options.intervalMs) || 250);
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() <= deadline) {
    throwIfStopped();
    lastValue = predicate();
    if (lastValue) return lastValue;
    await sleep(intervalMs);
  }
  return lastValue;
}

function findGrokEmailInput() {
  return queryVisibleGrokElement([
    'input[type="email"]',
    'input[name="email" i]',
    'input[autocomplete="email"]',
    'input[placeholder*="email" i]',
    'input[inputmode="email"]',
  ].join(', '));
}

function findGrokOtpInputs() {
  const inputs = Array.from(document.querySelectorAll([
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[name*="otp" i]',
    'input[name*="code" i]',
    'input[aria-label*="code" i]',
    'input[placeholder*="code" i]',
  ].join(', '))).filter(isVisibleGrokElement);
  if (inputs.length) return inputs;
  const oneCharInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])'))
    .filter((input) => isVisibleGrokElement(input) && Number(input.maxLength || 0) === 1);
  return oneCharInputs.length >= 4 ? oneCharInputs : [];
}

function findGrokProfileInput(names) {
  const selectors = names.flatMap((name) => [
    `input[name="${name}" i]`,
    `input[id="${name}" i]`,
    `input[autocomplete="${name}" i]`,
    `input[placeholder*="${name}" i]`,
    `input[aria-label*="${name}" i]`,
  ]).join(', ');
  return queryVisibleGrokElement(selectors);
}

function findGrokPasswordInputs() {
  return Array.from(document.querySelectorAll([
    'input[type="password"]',
    'input[name*="password" i]',
    'input[autocomplete="new-password"]',
    'input[placeholder*="password" i]',
    'input[aria-label*="password" i]',
  ].join(', '))).filter(isVisibleGrokElement);
}

function findGrokSubmitButton(contextPattern = GROK_CONTINUE_TEXT_PATTERN) {
  return findGrokClickableByText(contextPattern)
    || Array.from(document.querySelectorAll('button:not([disabled]), [role="button"]')).filter(isVisibleGrokElement).at(-1)
    || null;
}

// 深度查询：x.ai 页面用 Web Components，Turnstile 组件/隐藏 input 可能挂在
// open shadow root 或同域 iframe 里，普通 querySelectorAll 完全看不到。
function queryGrokDeep(selector, rootNode) {
  const results = [];
  const visited = new Set();
  const visit = (scope) => {
    if (!scope || visited.has(scope) || typeof scope.querySelectorAll !== 'function') return;
    visited.add(scope);
    let descendants = [];
    try {
      descendants = Array.from(scope.querySelectorAll('*'));
    } catch (_error) {}
    for (const el of descendants) {
      try {
        if (typeof el.matches === 'function' && el.matches(selector) && !results.includes(el)) {
          results.push(el);
        }
      } catch (_error) {}
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.tagName === 'IFRAME') {
        try {
          visit(el.contentDocument);
        } catch (_error) {}
      }
    }
  };
  visit(rootNode || document);
  return results;
}

function getGrokTurnstileInputElement() {
  return queryGrokDeep([
    'input[name="cf-turnstile-response"]',
    'textarea[name="cf-turnstile-response"]',
  ].join(', '))[0] || null;
}

function getGrokTurnstileApiToken() {
  try {
    if (typeof window !== 'undefined'
      && window.turnstile
      && typeof window.turnstile.getResponse === 'function') {
      return String(window.turnstile.getResponse() || '').trim();
    }
  } catch (_error) {}
  return '';
}

function getGrokTurnstileResponseValue() {
  const field = getGrokTurnstileInputElement();
  const value = String(field?.value || '').trim();
  if (value) return value;
  return getGrokTurnstileApiToken();
}

function backfillGrokTurnstileToken() {
  const input = getGrokTurnstileInputElement();
  if (!input) return '';
  const existing = String(input.value || '').trim();
  if (existing.length >= 80) return existing;
  const token = getGrokTurnstileApiToken();
  if (token.length < 80) return existing;
  const inputCtor = input.tagName === 'TEXTAREA'
    ? (typeof window !== 'undefined' ? window.HTMLTextAreaElement : undefined)
    : (typeof window !== 'undefined' ? window.HTMLInputElement : undefined);
  const setter = Object.getOwnPropertyDescriptor(inputCtor?.prototype || {}, 'value')?.set;
  try {
    if (setter) {
      setter.call(input, token);
    } else {
      input.value = token;
    }
    if (typeof Event === 'function') {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (_error) {}
  return String(input.value || '').trim();
}

function getGrokHumanVerificationContainers() {
  const selectors = [
    '.cf-turnstile',
    '[class*="turnstile" i]',
    '[id*="turnstile" i]',
    '[data-sitekey]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'iframe[title*="cloudflare" i]',
    'iframe[title*="challenge" i]',
    'input[name="cf-turnstile-response"]',
    'textarea[name="cf-turnstile-response"]',
  ].join(', ');
  const containers = new Set();
  for (const element of queryGrokDeep(selectors)) {
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (current instanceof Element) containers.add(current);
      current = current.parentElement;
    }
  }
  return Array.from(containers);
}

function getGrokHumanVerificationSuccessEvidence() {
  const token = getGrokTurnstileResponseValue();
  if (token) {
    return { type: 'turnstile_response' };
  }

  for (const container of getGrokHumanVerificationContainers()) {
    const text = getGrokElementText(container);
    if (text && GROK_HUMAN_VERIFICATION_SUCCESS_TEXT_PATTERN.test(text)) {
      return { type: 'visible_success_text', text };
    }
  }

  return null;
}

const GROK_TURNSTILE_CLICK_TARGET_SELECTOR = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]',
  'iframe[title*="cloudflare" i]',
  '.cf-turnstile',
  '[data-sitekey]',
].join(', ');
const GROK_TURNSTILE_CLICK_COOLDOWN_MS = 8000;
const GROK_TURNSTILE_MAX_AUTO_CLICKS = 5;
let grokTurnstileAutoClickCount = 0;
let grokTurnstileLastClickAt = 0;
let grokTurnstileManualHintLogged = false;

function getGrokTurnstileClickPoint() {
  const elements = queryGrokDeep(GROK_TURNSTILE_CLICK_TARGET_SELECTOR)
    .filter(isVisibleGrokElement);
  if (!elements.length) return null;
  // 优先打 iframe（勾选框在 iframe 内部左侧），容器类兜底同样取左缘。
  const element = elements.find((candidate) => candidate.tagName === 'IFRAME') || elements[0];
  // 组件可能在视口外：CDP 用的是视口坐标，先滚动到可见再量取，否则点击会落在屏幕外。
  try {
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
  } catch (_error) {}
  const rect = element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  // Turnstile 的勾选框在组件左侧约 24px 处。
  const offsetX = Math.min(24, Math.max(10, rect.width * 0.08));
  const centerX = Math.round(rect.left + offsetX);
  const centerY = Math.round(rect.top + rect.height / 2);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || centerX < 0 || centerY < 0) return null;
  return { centerX, centerY };
}

// 页面本地找不到组件（closed shadow root / 嵌套 iframe）时仍可能正处在人机验证页：
// 用「验证迹象」决定是否发探测请求，坐标交给后台 CDP DOM 穿透定位。
function hasGrokHumanVerificationHint() {
  if (getGrokTurnstileClickPoint()) return true;
  if (getGrokHumanVerificationContainers().length) return true;
  const text = getGrokElementText(typeof document !== 'undefined' ? document.body : null) || '';
  return /真人|验证您是|verify you are human|human verification|checking your|just a moment|cloudflare|验证码/i.test(text);
}

async function requestGrokTurnstileTrustedClick() {
  if (getGrokHumanVerificationSuccessEvidence()) return { ok: true, skipped: true };
  const point = getGrokTurnstileClickPoint();
  if (!point && !hasGrokHumanVerificationHint()) return { ok: false, reason: 'not-found' };
  if (Date.now() - grokTurnstileLastClickAt < GROK_TURNSTILE_CLICK_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' };
  }
  if (grokTurnstileAutoClickCount >= GROK_TURNSTILE_MAX_AUTO_CLICKS) {
    if (!grokTurnstileManualHintLogged && typeof log === 'function') {
      grokTurnstileManualHintLogged = true;
      log('Cloudflare 自动验证已达重试上限，请在自动化窗口中手动勾选「请验证您是真人」。', 'warn');
    }
    return { ok: false, reason: 'max-attempts' };
  }
  grokTurnstileLastClickAt = Date.now();
  grokTurnstileAutoClickCount += 1;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GROK_TURNSTILE_CLICK_REQUEST',
      source: 'grok-register-page',
      payload: point || { probe: true },
    });
    if (!response?.ok && typeof log === 'function') {
      log(`Cloudflare 可信点击未成功（第 ${grokTurnstileAutoClickCount}/${GROK_TURNSTILE_MAX_AUTO_CLICKS} 次）：${String(response?.error || '未知响应')}。`, 'warn');
    }
    return response || { ok: false, error: 'empty-response' };
  } catch (error) {
    if (typeof log === 'function') {
      log(`Cloudflare 可信点击请求失败：${String(error?.message || error)}。`, 'warn');
    }
    return { ok: false, error: String(error?.message || error) };
  }
}

async function waitForGrokHumanVerificationSuccess() {
  let widgetDetected = hasGrokHumanVerificationHint();
  if (widgetDetected) {
    if (typeof log === 'function') {
      log('检测到 Cloudflare 人机验证迹象，尝试通过调试器自动勾选真人验证...', 'info');
    }
    await requestGrokTurnstileTrustedClick().catch(() => {});
  }
  const result = await waitForGrok(
    () => {
      backfillGrokTurnstileToken();
      const evidence = getGrokHumanVerificationSuccessEvidence();
      if (evidence) return evidence;
      if (!widgetDetected && hasGrokHumanVerificationHint()) {
        widgetDetected = true;
        if (typeof log === 'function') {
          log('检测到 Cloudflare 人机验证迹象，尝试通过调试器自动勾选真人验证...', 'info');
        }
      }
      if (
        grokTurnstileAutoClickCount < GROK_TURNSTILE_MAX_AUTO_CLICKS
        && Date.now() - grokTurnstileLastClickAt >= GROK_TURNSTILE_CLICK_COOLDOWN_MS
      ) {
        void requestGrokTurnstileTrustedClick();
      }
      return null;
    },
    {
      timeoutMs: GROK_HUMAN_VERIFICATION_SUCCESS_TIMEOUT_MS,
      intervalMs: 500,
    }
  );
  if (result) return result;
  throw new Error('x.ai 人机验证等待已达到 5 分钟，仍未显示成功，暂不点击完成注册。');
}

const GROK_TOS_GATE_PATH_PATTERN = /tos[_-]?gate|\/terms|\/legal/i;
const GROK_TOS_GATE_TEXT_PATTERN = /服务条款|可接受使用政策|条款.*更新|terms\s+of\s+service|acceptable\s+use\s+policy|terms.{0,20}updat/i;
const GROK_TOS_GATE_CONFIRM_PATTERN = /^\s*(?:知道了|好的|确定|确认|同意|接受|明白|got\s*it|okay?|understood|i\s*understand|agree|accept|continue|继续)\s*[。.!！]?$/i;
const GROK_COOKIE_ACCEPT_PATTERN = /接受所有\s*cookie|接受全部|全部接受|accept\s*all\s*cookies?|allow\s*all\s*cookies?/i;

function isGrokTosGatePage(pageText = '') {
  // 排除仍在表单阶段的页面（注册页本身也带 Terms of Service 文案和「继续」按钮）。
  const hasForm = Boolean(findGrokProfileInput(['givenName', 'firstName']))
    || findGrokOtpInputs().length > 0
    || Boolean(findGrokEmailInput());
  if (hasForm) return false;
  if (GROK_TOS_GATE_PATH_PATTERN.test(String(location.pathname || ''))) return true;
  if (/accounts\.x\.ai$/i.test(String(location.hostname || ''))) return false;
  const text = String(pageText || document.body?.innerText || '');
  // 必须同时具备条款文案和一个明确确认按钮，避免正常 Grok 页的 Cookie 横幅误判。
  return GROK_TOS_GATE_TEXT_PATTERN.test(text) && Boolean(findGrokClickableByText(GROK_TOS_GATE_CONFIRM_PATTERN));
}

async function dismissGrokTosGate() {
  const clicked = [];
  const confirmButton = findGrokClickableByText(GROK_TOS_GATE_CONFIRM_PATTERN);
  if (confirmButton) {
    clicked.push(getGrokElementText(confirmButton) || '知道了');
    simulateGrokClick(confirmButton);
    await sleep(400);
  }
  const cookieButton = findGrokClickableByText(GROK_COOKIE_ACCEPT_PATTERN);
  if (cookieButton) {
    clicked.push(getGrokElementText(cookieButton) || '接受所有 Cookie');
    simulateGrokClick(cookieButton);
    await sleep(300);
  }
  return {
    submitted: true,
    dismissed: clicked.length > 0,
    clicked,
    state: getGrokPageState(),
    url: location.href,
  };
}

function getGrokPageState() {
  const pageText = document.body?.innerText || '';
  let state = 'unknown';
  if (/grok|xai|x\.ai/i.test(location.hostname) && /(?:^|;\s*)sso=/.test(document.cookie || '')) {
    state = 'signed_in';
  } else if (isGrokTosGatePage(pageText)) {
    state = 'tos_gate';
  } else if (findGrokProfileInput(['givenName', 'firstName']) || findGrokPasswordInputs().length || GROK_PROFILE_TEXT_PATTERN.test(pageText)) {
    state = 'profile_entry';
  } else if (findGrokOtpInputs().length) {
    state = 'verification_code_entry';
  } else if (findGrokEmailInput()) {
    state = 'email_entry';
  }
  // CF 兜底：后台每次轮询页面状态时顺带做一次自节流自动点击（内部有成功证据门禁+
  // 冷却+次数上限）。只认结构性迹象（iframe/容器，含 shadow 穿透），unknown 态下才
  // 放宽到文案迹象——避免验证码输入页因「验证码」文案误触发调试器探针。这覆盖了
  // 「完成注册」点击之后才弹出人机验证的等待窗口。
  if (hasGrokTurnstileStructuralHint() || (state === 'unknown' && hasGrokHumanVerificationHint())) {
    void requestGrokTurnstileTrustedClick().catch(() => {});
  }
  return state;
}

function hasGrokTurnstileStructuralHint() {
  return Boolean(getGrokTurnstileClickPoint()) || getGrokHumanVerificationContainers().length > 0;
}

async function openGrokSignupPage() {
  if (!/accounts\.x\.ai$/i.test(location.hostname) || !/\/sign-up/i.test(location.pathname)) {
    location.href = GROK_SIGNUP_URL;
    return { submitted: true, state: 'navigating', url: location.href };
  }
  const emailButton = await waitForGrok(() => (
    findGrokClickableByText(GROK_EMAIL_SIGNUP_TEXT_PATTERN) || findGrokEmailInput()
  ), { timeoutMs: 30000 });
  if (!emailButton) throw new Error('未找到 x.ai 邮箱注册入口。');
  if (!(emailButton instanceof HTMLInputElement)) {
    simulateGrokClick(emailButton);
    await sleep(500);
  }
  return { submitted: true, state: getGrokPageState(), url: location.href };
}

function getGrokEmailErrorText() {
  const text = String(document.body?.innerText || '').trim();
  const patterns = [
    /Your email domain[^\n]+has been rejected[^\n]*/i,
    /Please use a different email address[^\n]*/i,
    /邮箱域名[^\n]*(?:被拒绝|不可用|不支持)[^\n]*/i,
    /请使用其他邮箱[^\n]*/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0].trim();
  }
  return '';
}

async function waitForGrokVerificationPageAfterEmailSubmit() {
  const settledState = await waitForGrok(() => {
    const errorText = getGrokEmailErrorText();
    if (errorText) return { state: 'email_error', error: errorText, url: location.href };
    const state = getGrokPageState();
    return state === 'verification_code_entry' ? { state, url: location.href } : null;
  }, { timeoutMs: GROK_EMAIL_VERIFICATION_READY_TIMEOUT_MS, intervalMs: 500 });

  if (settledState?.error) {
    throw new Error(settledState.error);
  }
  if (settledState?.state === 'verification_code_entry') {
    return settledState;
  }

  const errorText = getGrokEmailErrorText();
  if (errorText) {
    throw new Error(errorText);
  }
  const finalState = getGrokPageState();
  throw new Error(`提交 Grok 注册邮箱后未进入验证码页面，当前页面状态：${finalState || 'unknown'}。请确认页面已跳转到“验证您的邮箱”后再继续。`);
}

async function submitGrokEmail(payload = {}) {
  const email = String(payload.email || '').trim();
  if (!email) throw new Error('缺少 Grok 注册邮箱。');
  const input = await waitForGrok(findGrokEmailInput, { timeoutMs: 45000 });
  if (!input) throw new Error('未找到 x.ai 邮箱输入框。');
  fillInput(input, email);
  await sleep(200);
  const button = findGrokSubmitButton();
  if (!button) throw new Error('未找到 x.ai 邮箱提交按钮。');
  simulateGrokClick(button);
  await sleep(1200);
  const errorText = getGrokEmailErrorText();
  if (errorText) {
    throw new Error(errorText);
  }
  const readyState = await waitForGrokVerificationPageAfterEmailSubmit();
  return { submitted: true, state: readyState.state, url: readyState.url || location.href };
}

function getGrokVerificationErrorText() {
  const text = String(document.body?.innerText || '').trim();
  const patterns = [
    /(?:verification|confirmation)?\s*code\s*(?:is\s*)?(?:invalid|incorrect|expired)[^\n]*/i,
    /invalid\s*(?:verification|confirmation)?\s*code[^\n]*/i,
    /验证码[^\n]*(?:错误|无效|过期)[^\n]*/i,
    /代码[^\n]*(?:错误|无效|过期)[^\n]*/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0].trim();
  }
  return '';
}

async function submitGrokVerificationCode(payload = {}) {
  const normalizedCode = String(payload.code || '').replace(/[^A-Za-z0-9]/g, '').trim();
  if (!normalizedCode) throw new Error('缺少 xAI 验证码。');
  const inputs = await waitForGrok(() => findGrokOtpInputs(), { timeoutMs: 45000 });
  if (!inputs?.length) throw new Error('未找到 xAI 验证码输入框。');
  if (inputs.length === 1) {
    fillInput(inputs[0], normalizedCode);
  } else {
    normalizedCode.split('').forEach((char, index) => {
      if (inputs[index]) fillInput(inputs[index], char);
    });
  }
  await sleep(200);
  const settledState = await waitForGrok(() => {
    const errorText = getGrokVerificationErrorText();
    if (errorText) return { state: 'verification_error', error: errorText };
    const state = getGrokPageState();
    return state && state !== 'verification_code_entry' ? { state } : null;
  }, { timeoutMs: 20000, intervalMs: 500 });
  const finalState = settledState?.state || getGrokPageState();
  if (settledState?.error) {
    throw new Error(settledState.error);
  }
  if (finalState === 'email_entry') {
    throw new Error('x.ai 验证码提交后回到邮箱注册页，可能是验证码无效、会话过期或注册风控重置。');
  }
  if (!['profile_entry', 'signed_in'].includes(finalState)) {
    throw new Error(`x.ai 验证码提交后进入未知页面状态：${finalState || 'unknown'}。`);
  }
  return { submitted: true, state: finalState, url: location.href };
}

async function submitGrokProfile(payload = {}) {
  const firstName = String(payload.firstName || '').trim();
  const lastName = String(payload.lastName || '').trim();
  const password = String(payload.password || '');
  if (!firstName || !lastName || !password) throw new Error('缺少 Grok 注册资料。');
  const ready = await waitForGrok(() => {
    const firstInput = findGrokProfileInput(['givenName', 'firstName', 'given-name']);
    const lastInput = findGrokProfileInput(['familyName', 'lastName', 'family-name']);
    const passwordInputs = findGrokPasswordInputs();
    return firstInput && lastInput && passwordInputs.length ? { firstInput, lastInput, passwordInputs } : null;
  }, { timeoutMs: 45000 });
  if (!ready) throw new Error('未找到 x.ai 资料或密码表单。');
  fillInput(ready.firstInput, firstName);
  fillInput(ready.lastInput, lastName);
  ready.passwordInputs.forEach((input) => fillInput(input, password));
  const humanVerification = await waitForGrokHumanVerificationSuccess();
  const button = findGrokSubmitButton();
  if (!button) throw new Error('未找到 x.ai 资料提交按钮。');
  simulateGrokClick(button);
  return {
    submitted: true,
    state: 'profile_submitted',
    url: location.href,
    humanVerification: humanVerification?.type || '',
  };
}

async function extractGrokSsoCookie() {
  const match = String(document.cookie || '').match(/(?:^|;\s*)sso=([^;]+)/);
  return {
    submitted: true,
    state: match ? 'sso_cookie_found' : getGrokPageState(),
    ssoCookie: match ? decodeURIComponent(match[1]) : '',
    url: location.href,
  };
}

async function executeGrokCommand(command, payload = {}) {
  switch (command) {
    case 'grok-open-signup-page':
      return openGrokSignupPage(payload);
    case 'grok-submit-email':
      return submitGrokEmail(payload);
    case 'grok-submit-verification-code':
      return submitGrokVerificationCode(payload);
    case 'grok-submit-profile':
      return submitGrokProfile(payload);
    case 'grok-extract-sso-cookie':
      return extractGrokSsoCookie(payload);
    case 'grok-dismiss-tos-gate':
      return dismissGrokTosGate(payload);
    case 'GET_PAGE_STATE':
      return { state: getGrokPageState(), url: location.href };
    default:
      throw new Error(`未知 Grok 注册命令：${command}`);
  }
}

if (!document.documentElement.hasAttribute(GROK_REGISTER_PAGE_LISTENER_SENTINEL)) {
  document.documentElement.setAttribute(GROK_REGISTER_PAGE_LISTENER_SENTINEL, '1');
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'EXECUTE_NODE' && message?.type !== 'GET_PAGE_STATE') return false;
    resetStopState();
    const command = message.command || message.nodeId || message.type;
    executeGrokCommand(command, message.payload || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        if (isStopError(error)) {
          sendResponse({ stopped: true, error: error.message });
          return;
        }
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  });
}

window.__MULTIPAGE_GROK_REGISTER_PAGE__ = {
  executeGrokCommand,
  getGrokPageState,
};
