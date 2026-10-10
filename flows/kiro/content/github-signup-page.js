console.log('[MultiPage:kiro-github-signup-page] Content script loaded on', location.href);

const KIRO_GITHUB_LISTENER_SENTINEL = 'data-multipage-kiro-github-signup-listener';
const GITHUB_PAGE_WAIT_TIMEOUT_MS = 45000;
const GITHUB_PAGE_POLL_MS = 350;

const GITHUB_CONTINUE_TEXT_PATTERN = /continue|继续|next|下一步/i;
const GITHUB_CREATE_ACCOUNT_TEXT_PATTERN = /create\s*account|创建账户|注册/i;
const GITHUB_VERIFY_TEXT_PATTERN = /verify|验证/i;
const GITHUB_AUTHORIZE_TEXT_PATTERN = /authorize|授权|allow/i;
const GITHUB_SIGNIN_TEXT_PATTERN = /sign\s*in|登录/i;
const GITHUB_SKIP_TEXT_PATTERN = /skip|跳过|maybe later|以后再说/i;

const GITHUB_EMAIL_INPUT_SELECTOR = [
  'input#email',
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]',
].join(', ');

const GITHUB_PASSWORD_INPUT_SELECTOR = [
  'input#password',
  'input[type="password"][name="password"]',
  'input[autocomplete="new-password"]',
  'input[type="password"]',
].join(', ');

const GITHUB_USERNAME_INPUT_SELECTOR = [
  'input#login',
  'input[name="login"]',
  'input[autocomplete="username"]',
  'input[placeholder*="username" i]',
  'input[aria-label*="username" i]',
].join(', ');

const GITHUB_LAUNCH_CODE_INPUT_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[name*="code" i]',
  'input[inputmode="numeric"]',
  'input[placeholder*="code" i]',
  'input[aria-label*="code" i]',
].join(', ');

const GITHUB_OAUTH_AUTHORIZE_SELECTOR = [
  'button[name="authorize"]',
  'button.js-oauth-authorize-btn',
  'input[type="submit"][name="authorize"]',
].join(', ');

const GITHUB_LOGIN_FIELD_SELECTOR = [
  'input#login_field',
  'input[name="login"]',
  'input[autocomplete="username"]',
].join(', ');

const GITHUB_CAPTCHA_SELECTOR = [
  'iframe[src*="arkoselabs"]',
  'iframe[src*="funcaptcha"]',
  'iframe[id*="arkose" i]',
  'div[id*="captcha" i]',
  'div[class*="captcha" i]',
  '#funcaptcha',
  '[data-captcha]',
].join(', ');

function isVisibleGithubElement(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && rect.width > 0
    && rect.height > 0;
}

function collectVisibleGithubElements(selector) {
  try {
    return Array.from(document.querySelectorAll(selector))
      .filter((element) => isVisibleGithubElement(element));
  } catch (_error) {
    return [];
  }
}

function findFirstVisibleGithubElement(selector) {
  return collectVisibleGithubElements(selector)[0] || null;
}

function getGithubPageText() {
  return String(document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getGithubActionText(element) {
  return [
    element?.textContent,
    element?.value,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('data-testid'),
    element?.getAttribute?.('placeholder'),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findGithubActionButton(options = {}) {
  const {
    preferredSelectors = [],
    textPattern = null,
  } = options;

  for (const selector of preferredSelectors) {
    const preferred = findFirstVisibleGithubElement(selector);
    if (preferred && !preferred.disabled && preferred.getAttribute('aria-disabled') !== 'true') {
      return preferred;
    }
  }

  const candidates = collectVisibleGithubElements(
    'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]'
  ).filter((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true');

  if (textPattern instanceof RegExp) {
    return candidates.find((element) => textPattern.test(getGithubActionText(element))) || null;
  }
  return null;
}

function isGithubHost(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'github.com' || normalized === 'www.github.com';
}

function isGithubSignupPath() {
  return isGithubHost(location.hostname) && /^\/signup/i.test(location.pathname || '');
}

function isGithubOauthAuthorizePath() {
  return isGithubHost(location.hostname)
    && /\/login\/oauth\/authorize/i.test(location.pathname || '');
}

function isGithubDeviceVerifyPath() {
  return isGithubHost(location.hostname)
    && /\/(sessions\/verified-device|login\/device|device-verification)/i.test(location.pathname || '');
}

function isGithubLoginPath() {
  return isGithubHost(location.hostname) && /^\/login\b/i.test(location.pathname || '');
}

function hasGithubSession() {
  if (!isGithubHost(location.hostname)) return false;
  return Boolean(
    document.querySelector('meta[name="user-login"][content]')
    || document.querySelector('button[aria-label*="account" i]')
    || document.querySelector('[data-testid="avatar"]')
    || /\/dashboard|\/account|\/settings/i.test(location.pathname || '')
  );
}

function isGithubSignedIn() {
  if (isGithubLoginPath() || isGithubSignupPath() || isGithubOauthAuthorizePath()) {
    return false;
  }
  return hasGithubSession();
}

function findGithubCaptchaContainer() {
  for (const iframe of collectVisibleGithubElements(GITHUB_CAPTCHA_SELECTOR)) {
    return iframe;
  }
  const allIframes = Array.from(document.querySelectorAll('iframe')).filter(isVisibleGithubElement);
  return allIframes.find((iframe) => /arkoselabs|funcaptcha|captcha|arkose/i.test(String(iframe.src || iframe.id || ''))) || null;
}

function detectGithubPageState() {
  const currentUrl = location.href;
  const pageText = getGithubPageText();

  if (!isGithubHost(location.hostname)) {
    return { state: 'non_github', url: currentUrl };
  }

  if (isGithubOauthAuthorizePath()) {
    const authorizeButton = findFirstVisibleGithubElement(GITHUB_OAUTH_AUTHORIZE_SELECTOR)
      || findGithubActionButton({ textPattern: GITHUB_AUTHORIZE_TEXT_PATTERN });
    const reauthorizeLoginInput = findFirstVisibleGithubElement(GITHUB_LOGIN_FIELD_SELECTOR);
    return {
      state: authorizeButton ? 'oauth_authorize' : (reauthorizeLoginInput ? 'oauth_login' : 'oauth_page'),
      url: currentUrl,
      actionButton: authorizeButton,
      actionText: getGithubActionText(authorizeButton),
    };
  }

  if (isGithubDeviceVerifyPath()) {
    const codeInput = findFirstVisibleGithubElement(GITHUB_LAUNCH_CODE_INPUT_SELECTOR);
    const continueButton = findGithubActionButton({ textPattern: GITHUB_VERIFY_TEXT_PATTERN })
      || findGithubActionButton({ textPattern: GITHUB_CONTINUE_TEXT_PATTERN });
    return {
      state: 'device_verify',
      url: currentUrl,
      codeInput,
      continueButton,
      actionText: getGithubActionText(continueButton),
    };
  }

  if (isGithubLoginPath()) {
    const loginInput = findFirstVisibleGithubElement(GITHUB_LOGIN_FIELD_SELECTOR);
    const passwordInput = findFirstVisibleGithubElement(GITHUB_PASSWORD_INPUT_SELECTOR);
    const signInButton = findGithubActionButton({ textPattern: GITHUB_SIGNIN_TEXT_PATTERN })
      || findFirstVisibleGithubElement('input[type="submit"], button[type="submit"]');
    return {
      state: 'oauth_login',
      url: currentUrl,
      loginInput,
      passwordInput,
      actionButton: signInButton,
      actionText: getGithubActionText(signInButton),
    };
  }

  if (isGithubSignupPath()) {
    const captcha = findGithubCaptchaContainer();
    if (captcha) {
      return {
        state: 'captcha',
        url: currentUrl,
        fatalMessage: '',
      };
    }

    const launchCodeInput = findFirstVisibleGithubElement(GITHUB_LAUNCH_CODE_INPUT_SELECTOR);
    const emailInput = findFirstVisibleGithubElement(GITHUB_EMAIL_INPUT_SELECTOR);
    const passwordInput = findFirstVisibleGithubElement(GITHUB_PASSWORD_INPUT_SELECTOR);
    const usernameInput = findFirstVisibleGithubElement(GITHUB_USERNAME_INPUT_SELECTOR);

    const continueButton = findGithubActionButton({ textPattern: GITHUB_CONTINUE_TEXT_PATTERN });
    const createButton = findGithubActionButton({ textPattern: GITHUB_CREATE_ACCOUNT_TEXT_PATTERN });
    const verifyButton = findGithubActionButton({ textPattern: GITHUB_VERIFY_TEXT_PATTERN });

    const hasLaunchCodeText = /launch\s*code|verification\s*code|verify\s*your\s*email|确认.*邮箱|验证码/i.test(pageText);
    if (launchCodeInput && (hasLaunchCodeText || (!emailInput && !usernameInput))) {
      return {
        state: 'launch_code',
        url: currentUrl,
        codeInput: launchCodeInput,
        actionButton: verifyButton || continueButton || createButton,
        actionText: getGithubActionText(verifyButton || continueButton || createButton),
      };
    }

    const emailPrefsRadio = collectVisibleGithubElements('input[type="radio"]');
    const hasPrefsText = /product\s*updates|announcements|via\s*email|邮件.*更新|产品.*更新/i.test(pageText);
    if (emailPrefsRadio.length && hasPrefsText && continueButton) {
      return {
        state: 'email_prefs',
        url: currentUrl,
        radios: emailPrefsRadio,
        continueButton,
      };
    }

    if (createButton && !emailInput && !passwordInput && !usernameInput) {
      return {
        state: 'create_account',
        url: currentUrl,
        actionButton: createButton,
        actionText: getGithubActionText(createButton),
      };
    }

    if (usernameInput && continueButton) {
      const usernameTaken = /already\s*taken|username.*not\s*available|已被使用|不可用/i.test(pageText)
        || Boolean(document.querySelector('[class*="error" i], [data-validation], .flash-error'));
      return {
        state: 'username_entry',
        url: currentUrl,
        usernameInput,
        continueButton,
        usernameTaken,
      };
    }

    if (passwordInput && continueButton) {
      return {
        state: 'password_entry',
        url: currentUrl,
        passwordInput,
        continueButton,
      };
    }

    if (emailInput) {
      return {
        state: 'email_entry',
        url: currentUrl,
        emailInput,
        continueButton: continueButton || findFirstVisibleGithubElement('button[type="submit"], input[type="submit"]'),
      };
    }

    return { state: 'signup_page', url: currentUrl };
  }

  if (isGithubSignedIn()) {
    return { state: 'signed_in', url: currentUrl };
  }

  return { state: 'github_page', url: currentUrl };
}

async function waitForGithubState(predicate, options = {}) {
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || GITHUB_PAGE_WAIT_TIMEOUT_MS));
  const retryDelayMs = Math.max(100, Math.floor(Number(options.retryDelayMs) || GITHUB_PAGE_POLL_MS));
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const detected = detectGithubPageState();
    if (predicate(detected)) {
      return detected;
    }
    await sleep(retryDelayMs);
  }

  const finalState = detectGithubPageState();
  throw new Error(options.timeoutMessage || `等待 GitHub 页面状态超时：${finalState.state}`);
}

async function ensureGithubPageState(options = {}) {
  const targetStates = Array.isArray(options.targetStates)
    ? options.targetStates.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (!targetStates.length) {
    return detectGithubPageState();
  }
  return waitForGithubState(
    (detected) => targetStates.includes(detected.state),
    {
      ...options,
      timeoutMessage: options.timeoutMessage || `等待 GitHub 页面进入 ${targetStates.join(' / ')} 超时，当前页面：${location.href}`,
    }
  );
}

async function githubSubmitField(input, value, button, options = {}) {
  if (!input) {
    throw new Error(options.missingInputMessage || 'GitHub 页面未找到输入框。');
  }
  fillInput(input, value);
  await sleep(200);
  if (button) {
    simulateClick(button);
  } else {
    throw new Error(options.missingButtonMessage || 'GitHub 页面未找到继续按钮。');
  }
  return {
    submitted: true,
    url: location.href,
  };
}

async function githubSubmitEmail(payload = {}) {
  const email = String(payload?.email || '').trim();
  if (!email) throw new Error('缺少 GitHub 注册邮箱。');
  const readyState = await ensureGithubPageState({ targetStates: ['email_entry'] });
  return githubSubmitField(readyState.emailInput, email, readyState.continueButton, {
    missingInputMessage: 'GitHub 注册页未找到邮箱输入框。',
    missingButtonMessage: 'GitHub 注册页未找到继续按钮。',
  });
}

async function githubSubmitPassword(payload = {}) {
  const password = String(payload?.password || '');
  if (!password) throw new Error('缺少 GitHub 密码。');
  const readyState = await ensureGithubPageState({ targetStates: ['password_entry'] });
  return githubSubmitField(readyState.passwordInput, password, readyState.continueButton, {
    missingInputMessage: 'GitHub 注册页未找到密码输入框。',
    missingButtonMessage: 'GitHub 注册页未找到继续按钮。',
  });
}

async function githubSubmitUsername(payload = {}) {
  const username = String(payload?.username || '').trim();
  if (!username) throw new Error('缺少 GitHub 用户名。');
  const readyState = await ensureGithubPageState({ targetStates: ['username_entry'] });
  return githubSubmitField(readyState.usernameInput, username, readyState.continueButton, {
    missingInputMessage: 'GitHub 注册页未找到用户名输入框。',
    missingButtonMessage: 'GitHub 注册页未找到继续按钮。',
  });
}

async function githubSubmitEmailPrefs(payload = {}) {
  const choice = String(payload?.choice || 'n').trim().toLowerCase();
  const readyState = await ensureGithubPageState({ targetStates: ['email_prefs'] });
  const radios = Array.isArray(readyState.radios) ? readyState.radios : [];
  const targetRadio = radios.find((radio) => {
    const label = getGithubActionText(radio) || getGithubActionText(radio.closest?.('label')) || '';
    return choice === 'y'
      ? /^(y|yes|是)$/i.test(label) || /yes/i.test(label)
      : /^(n|no|否)$/i.test(label) || /no/i.test(label);
  }) || radios.find((radio) => /^(n|no|否)$/i.test(String(radio.value || '')) || /no/i.test(getGithubActionText(radio)));
  if (targetRadio) {
    simulateClick(targetRadio);
    await sleep(150);
  }
  if (readyState.continueButton) {
    simulateClick(readyState.continueButton);
  }
  return { submitted: true, url: location.href };
}

async function githubSubmitLaunchCode(payload = {}) {
  const code = String(payload?.code || '').trim().replace(/\s+/g, '');
  if (!code) throw new Error('缺少 GitHub launch code。');
  const readyState = await ensureGithubPageState({ targetStates: ['launch_code'] });
  return githubSubmitField(readyState.codeInput, code, readyState.actionButton, {
    missingInputMessage: 'GitHub launch code 页未找到验证码输入框。',
    missingButtonMessage: 'GitHub launch code 页未找到提交按钮。',
  });
}

async function githubSubmitLogin(payload = {}) {
  const login = String(payload?.login || payload?.email || '').trim();
  const password = String(payload?.password || '');
  if (!login || !password) throw new Error('缺少 GitHub 登录账号或密码。');
  const readyState = await ensureGithubPageState({ targetStates: ['oauth_login'] });
  if (readyState.loginInput) fillInput(readyState.loginInput, login);
  if (readyState.passwordInput) fillInput(readyState.passwordInput, password);
  await sleep(200);
  if (readyState.actionButton) {
    simulateClick(readyState.actionButton);
    return { submitted: true, url: location.href };
  }
  const form = readyState.loginInput?.form || readyState.passwordInput?.form || null;
  if (form) {
    form.requestSubmit ? form.requestSubmit() : form.submit();
    return { submitted: true, url: location.href };
  }
  throw new Error('GitHub 登录页未找到提交按钮。');
}

async function githubSubmitDeviceCode(payload = {}) {
  const code = String(payload?.code || '').trim().replace(/\s+/g, '');
  if (!code) throw new Error('缺少 GitHub 设备验证码。');
  const readyState = await ensureGithubPageState({ targetStates: ['device_verify'] });
  return githubSubmitField(readyState.codeInput, code, readyState.continueButton, {
    missingInputMessage: 'GitHub 设备验证页未找到验证码输入框。',
    missingButtonMessage: 'GitHub 设备验证页未找到继续按钮。',
  });
}

async function githubClickCreateAccount() {
  const readyState = await ensureGithubPageState({ targetStates: ['create_account'] });
  if (!readyState.actionButton) {
    throw new Error('GitHub 注册页未找到 Create account 按钮。');
  }
  simulateClick(readyState.actionButton);
  return { submitted: true, url: location.href, actionText: readyState.actionText || '' };
}

async function githubClickAuthorize() {
  const readyState = await ensureGithubPageState({ targetStates: ['oauth_authorize'] });
  if (!readyState.actionButton) {
    throw new Error('GitHub OAuth 页未找到 Authorize 按钮。');
  }
  simulateClick(readyState.actionButton);
  return { submitted: true, url: location.href, actionText: readyState.actionText || '' };
}

async function githubClickContinueOnboarding() {
  const current = detectGithubPageState();
  if (current.state !== 'github_page' && current.state !== 'signed_in') {
    return { skipped: true, state: current.state };
  }
  const skipButton = findGithubActionButton({ textPattern: GITHUB_SKIP_TEXT_PATTERN });
  if (skipButton) {
    simulateClick(skipButton);
    return { submitted: true, url: location.href };
  }
  return { skipped: true, state: current.state };
}

async function handleGithubSignupCommand(message) {
  switch (message.type) {
    case 'GET_GITHUB_SIGNUP_STATE': {
      const detected = detectGithubPageState();
      return {
        state: detected?.state || '',
        url: detected?.url || location.href,
        usernameTaken: Boolean(detected?.usernameTaken),
        fatalMessage: detected?.fatalMessage || '',
        actionText: detected?.actionText || '',
      };
    }
    case 'ENSURE_GITHUB_STATE':
      return ensureGithubPageState(message.payload || {});
    case 'EXECUTE_GITHUB_SIGNUP': {
      const action = String(message.payload?.action || '').trim();
      if (action === 'submit-email') return githubSubmitEmail(message.payload || {});
      if (action === 'submit-password') return githubSubmitPassword(message.payload || {});
      if (action === 'submit-username') return githubSubmitUsername(message.payload || {});
      if (action === 'submit-email-prefs') return githubSubmitEmailPrefs(message.payload || {});
      if (action === 'submit-launch-code') return githubSubmitLaunchCode(message.payload || {});
      if (action === 'submit-login') return githubSubmitLogin(message.payload || {});
      if (action === 'submit-device-code') return githubSubmitDeviceCode(message.payload || {});
      if (action === 'create-account') return githubClickCreateAccount(message.payload || {});
      if (action === 'click-authorize') return githubClickAuthorize(message.payload || {});
      if (action === 'finish-onboarding') return githubClickContinueOnboarding(message.payload || {});
      throw new Error(`github-signup-page.js 不处理动作：${action}`);
    }
    default:
      return null;
  }
}

if (document.documentElement.getAttribute(KIRO_GITHUB_LISTENER_SENTINEL) !== '1') {
  document.documentElement.setAttribute(KIRO_GITHUB_LISTENER_SENTINEL, '1');
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      message.type === 'GET_GITHUB_SIGNUP_STATE'
      || message.type === 'ENSURE_GITHUB_STATE'
      || message.type === 'EXECUTE_GITHUB_SIGNUP'
    ) {
      resetStopState();
      handleGithubSignupCommand(message)
        .then((result) => {
          sendResponse({ ok: true, ...(result || {}) });
        })
        .catch((error) => {
          if (isStopError(error)) {
            sendResponse({ stopped: true, error: error.message });
            return;
          }
          sendResponse({ error: error?.message || String(error || '未知错误') });
        });
      return true;
    }
    return false;
  });
}
