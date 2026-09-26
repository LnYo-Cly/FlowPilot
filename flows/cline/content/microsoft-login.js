console.log('[MultiPage:cline-microsoft-login] Content script loaded on', location.href);

const CLINE_MS_LOGIN_LISTENER_SENTINEL = 'data-multipage-cline-ms-login-listener';

const CLINE_MS_EMAIL_SELECTORS = [
  'input[name="loginfmt"]',
  'input[type="email"]',
  'input[name="Username"]',
  'input#i0116',
];
const CLINE_MS_SUBMIT_SELECTORS = [
  '#idSIButton9',
  'input[type="submit"]',
  'button[type="submit"]',
];
const CLINE_MS_AUX_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[type="text"]',
  '#EmailAddress',
];
const CLINE_MS_AUX_SUBMIT_SELECTORS = [
  'input[type="submit"]',
  'button[type="submit"]',
  '#iNext',
];
const CLINE_MS_FIDO_SKIP_SELECTORS = [
  '#idBtn_Back',
  'a[id*="Cancel"]',
  'button[id*="Cancel"]',
  'input[id*="Cancel"]',
];
const CLINE_MS_GENERIC_CONFIRM_TEXT = /^(是|接受|继续|下一步|添加电子邮件|Authorize|授权|接受并继续|Yes|Accept|Continue|Next|Add email|Keep me signed in|Stay signed in)$/i;
const CLINE_MS_USE_PASSWORD_TEXT = /使用密码|Use your password|Enter password|use password/i;
const CLINE_MS_ADD_EMAIL_TEXT = /添加电子邮件|添加电子邮件地址|Add email|Add an email/i;
const CLINE_MS_AUTHKIT_HOST_RE = /(^|\.)(authkit\.[a-z0-9.-]+|workos\.com)$/i;
const CLINE_MS_MICROSOFT_PROVIDER_TEXT = /microsoft|微软|继续使用\s*microsoft/i;
const CLINE_MS_KMSI_TEXT = /保持登录|保持登录状态|Stay signed in|减少.*登录/i;
const CLINE_MS_ACCOUNT_PICKER_TEXT = /选择一个帐户|选择账户|Pick an account|Choose an account/i;
const CLINE_MS_YES_TEXT = /^(是|是的|Yes|确定|OK|确认)$/i;
const CLINE_MS_PHONE_VERIFY_TEXT = /验证您的手机号码|验证你的手机号码|输入.*手机号|手机号码|Verify your phone|phone number|add.*phone/i;
const CLINE_MS_PHONE_URL_RE = /proofs|arbitration|addphone|phoneverify|phone\/add|radar-challenge/i;
const CLINE_MS_LOGIN_BLOCKED_TEXT = /无法使你登录|无法让你登录|无法使你登入|can'?t sign you in|unable to sign you in|稍后重试.*登录|try again later/i;

function clineMsIsVisible(element) {
  if (!element || !(element instanceof Element)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function clineMsQueryVisible(selector) {
  try {
    return Array.from(document.querySelectorAll(selector)).find(clineMsIsVisible) || null;
  } catch (_) {
    return null;
  }
}

function clineMsQueryVisibleFirst(selectors = []) {
  for (const selector of selectors) {
    const element = clineMsQueryVisible(selector);
    if (element) return element;
  }
  return null;
}

function clineMsClick(element) {
  if (!element) return false;
  try {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    if (typeof element.click === 'function') {
      element.click();
      return true;
    }
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  } catch (_) {
    return false;
  }
}

function clineMsFill(element, value) {
  if (!element) return false;
  try {
    element.focus();
    element.value = String(value ?? '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch (_) {
    return false;
  }
}

function clineMsFindClickableByText(pattern) {
  const candidates = document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
  return Array.from(candidates).find((element) => {
    if (!clineMsIsVisible(element)) return false;
    const text = element instanceof HTMLInputElement
      ? element.value
      : String(element.innerText || element.textContent || element.getAttribute?.('aria-label') || '');
    return pattern.test(text.replace(/\s+/g, ' ').trim());
  }) || null;
}

function clineMsBodyText() {
  try {
    return String(document.body?.innerText || '').replace(/\s+/g, ' ');
  } catch (_) {
    return '';
  }
}

function cleanProviderError(value = '') {
  return String(value || '').trim().slice(0, 120);
}

function clineMsPageSnippet() {
  try {
    return String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch (_) {
    return '';
  }
}

function clineMsDetectPage() {
  const url = String(location.href || '');
  const title = String(document.title || '');
  const text = clineMsBodyText();

  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) {
    return { state: 'local-callback', url };
  }
  if (/policy_denied|radar-challenge/i.test(url)) {
    return { state: url.includes('radar-challenge') ? 'radar-challenge' : 'policy-denied', url };
  }
  // 手机号验证页：没有接码渠道，直接失败弃号（与原版 cline-register 一致）。
  if (CLINE_MS_PHONE_URL_RE.test(url) || (CLINE_MS_PHONE_VERIFY_TEXT.test(title) && CLINE_MS_PHONE_VERIFY_TEXT.test(text))) {
    return { state: 'phone-verify', url, title };
  }
  // 微软限流/风控页「目前无法使你登录」：重试无用，快速失败换号。
  if (CLINE_MS_LOGIN_BLOCKED_TEXT.test(title) || CLINE_MS_LOGIN_BLOCKED_TEXT.test(text)) {
    return { state: 'login-blocked', url, title };
  }
  if (url.includes('app.cline.bot/auth/callback') || url.includes('/auth/callback')) {
    return { state: 'cline-authorize', url };
  }
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = ''; }
  if (CLINE_MS_AUTHKIT_HOST_RE.test(host)) {
    let providerError = '';
    try { providerError = new URL(url).searchParams.get('error') || ''; } catch { providerError = ''; }
    if (providerError) {
      return { state: 'authkit-provider-select', url, error: providerError };
    }
    // WorkOS 设备码确认页（verification_uri_complete 已带用户码）：点 submit 确认。
    const deviceSubmit = clineMsQueryVisible('button[type="submit"], input[type="submit"]');
    const looksLikeDevicePage = /api\.workos\.com|login\.workos\.com/i.test(host)
      || /device|用户码|user.?code|verification/i.test(text);
    if (deviceSubmit && looksLikeDevicePage) {
      return { state: 'workos-device-confirm', url };
    }
    return { state: 'authkit-provider-select', url, error: providerError };
  }
  if (url.includes('credentialaction') || title.includes('保护你的帐户') || title.includes('输入你的代码') || text.includes('输入我们发送到')) {
    return { state: 'security-challenge', url, title };
  }
  if (url.includes('tou/accrue') || title.includes('更新条款')) {
    return { state: 'tou-accrue', url };
  }
  // 微软 OAuth 同意页：底部「拒绝/接受」同为 submit，通用确认会误点「拒绝」。
  if (/\/Consent\//i.test(url) || /是否允许此应用访问|需要得到你的许可|Let this app access/i.test(text)) {
    return { state: 'consent-update', url };
  }
  // fido 只认 URL：新版 KMSI/插页常内嵌「创建通行密钥」推广文案，
  // 单凭正文文案会把 KMSI 误判成 fido-create（该分支只找跳过按钮 → 永远 waiting）。
  if (url.includes('fido/create') || url.includes('fido2')) {
    return { state: 'fido-create', url };
  }
  if (clineMsQueryVisible('input[type="password"]')) {
    return { state: 'password', url };
  }
  const usePasswordLink = clineMsFindClickableByText(CLINE_MS_USE_PASSWORD_TEXT);
  if (usePasswordLink) {
    return { state: 'choose-password-signin', url };
  }
  if (clineMsQueryVisibleFirst(CLINE_MS_EMAIL_SELECTORS)) {
    return { state: 'email', url };
  }
  const addEmail = clineMsFindClickableByText(CLINE_MS_ADD_EMAIL_TEXT) || clineMsQueryVisible('#iLandingViewAction');
  if (addEmail) {
    return { state: 'add-security-email', url };
  }
  // KMSI 双信号：文案或「主按钮 idSIButton9 + 次级按钮 idBtn_Back」按钮对。
  // （idSIButton9 单独不足为凭——登录页下一步也是它；配上「否」类次级按钮才是 KMSI。）
  const kmsiButtonPair = Boolean(clineMsQueryVisible('#idSIButton9'))
    && Boolean(
      clineMsQueryVisible('#idBtn_Back')
      || clineMsFindClickableByText(/^(否|不|No|Don'?t)$/i)
    );
  if (CLINE_MS_KMSI_TEXT.test(title) || CLINE_MS_KMSI_TEXT.test(text) || kmsiButtonPair) {
    return { state: 'kmsi', url, title };
  }
  if (CLINE_MS_ACCOUNT_PICKER_TEXT.test(title) || CLINE_MS_ACCOUNT_PICKER_TEXT.test(text)) {
    return { state: 'account-picker', url, title };
  }
  // fido 文案兜底检测移到 KMSI/帐户选择之后：独立的通行密钥页才会走到这里。
  if (/通行密钥|passkey/i.test(text) || /通行密钥|passkey/i.test(title)) {
    return { state: 'fido-create', url };
  }
  const confirmBtn = clineMsQueryVisibleFirst(CLINE_MS_SUBMIT_SELECTORS) || clineMsFindClickableByText(CLINE_MS_GENERIC_CONFIRM_TEXT);
  if (confirmBtn) {
    return { state: 'generic-confirm', url };
  }
  return { state: 'unknown', url, title };
}

async function clineMsWaitFor(predicate, timeoutMs = 8000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function executeClineMsCommand(command, payload = {}) {
  switch (command) {
    case 'cline-get-login-state':
      return clineMsDetectPage();

    case 'cline-drive-step': {
      const page = clineMsDetectPage();
      switch (page.state) {
        case 'local-callback':
          return { ...page, action: 'done' };
        case 'policy-denied':
          return { ...page, action: 'failed', failReason: 'Cline 拒绝授权（policy_denied）。' };
        case 'radar-challenge':
          return { ...page, action: 'failed', failReason: '被要求手机号验证（Radar）。' };
        case 'phone-verify':
          return { ...page, action: 'failed', failReason: '微软要求验证手机号码，该账号本轮无法继续（没有接手机号渠道）。' };
        case 'login-blocked':
          return { ...page, action: 'failed', failReason: '微软提示「目前无法使你登录，请稍后重试」——账号或 IP 被限流/风控，换号重试。' };
        case 'cline-authorize': {
          const button = clineMsFindClickableByText(/Authorize|授权/i) || clineMsQueryVisible('button[type="submit"]');
          if (button && clineMsClick(button)) {
            return { ...page, action: 'clicked-authorize' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'workos-device-confirm': {
          const submit = clineMsQueryVisible('button[type="submit"], input[type="submit"]');
          if (submit) clineMsClick(submit);
          return { ...page, action: 'clicked-device-confirm' };
        }
        case 'authkit-provider-select': {
          // WorkOS AuthKit 登录方式选择页（Google/Microsoft/GitHub）：直接点 Microsoft。
          // URL 带 ?error= 说明上一轮微软 OAuth 报错了，上报错误同时重试。
          const msButton = clineMsFindClickableByText(CLINE_MS_MICROSOFT_PROVIDER_TEXT);
          const clicked = msButton ? clineMsClick(msButton) : false;
          if (page.error) {
            // 注意：不能占用 `error` 字段——协议层的 error 会被后台当作驱动失败。
            return { ...page, action: 'provider-error', providerError: cleanProviderError(page.error), retried: clicked };
          }
          if (clicked) {
            return { ...page, action: 'clicked-microsoft-provider' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'kmsi': {
          // 「保持登录状态？」页：点是。#idSIButton9 是微软主按钮固定 id，最可靠；
          // 新版 React 化 KMSI 可能没有该 id，退化为按文案找「是/Yes」，再退化为
          // 任意可见 submit 按钮；都找不到时直接 requestSubmit 提交表单推进流程
          // （无 submitter 参数的提交等价于未勾选保持登录，只是不落持久 Cookie）。
          const yes = clineMsQueryVisible('#idSIButton9')
            || clineMsFindClickableByText(CLINE_MS_YES_TEXT)
            || clineMsQueryVisibleFirst(CLINE_MS_SUBMIT_SELECTORS);
          if (yes) {
            clineMsClick(yes);
            try {
              const form = yes instanceof Element ? yes.closest('form') : null;
              if (form && typeof form.requestSubmit === 'function') {
                form.requestSubmit(yes.type === 'submit' ? yes : undefined);
              }
            } catch (_) { /* click 已触发过提交时这里静默失败即可 */ }
            return { ...page, action: 'confirmed-kmsi' };
          }
          const loneForm = document.querySelector('form');
          if (loneForm && typeof loneForm.requestSubmit === 'function') {
            try {
              loneForm.requestSubmit();
              return { ...page, action: 'confirmed-kmsi' };
            } catch (_) { /* fallthrough */ }
          }
          return { ...page, action: 'waiting', pageText: clineMsPageSnippet() };
        }
        case 'account-picker': {
          // 「选择一个帐户」页：点含目标邮箱的帐户块，否则点「使用其他帐户」。
          const tile = payload.email ? clineMsFindClickableByText(
            new RegExp(payload.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
          ) : null;
          if (tile && clineMsClick(tile)) {
            return { ...page, action: 'picked-account' };
          }
          const other = clineMsFindClickableByText(/使用其他帐户|使用另一个帐户|Use another account|其它帐户/i);
          if (other && clineMsClick(other)) {
            return { ...page, action: 'clicked-other-account' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'security-challenge': {
          // 已到达"输入代码"页 → 让 background 去 Graph 拉码。
          const isCodeInput = page.title.includes('输入你的代码') || clineMsBodyText().includes('输入我们发送到')
            || Boolean(clineMsQueryVisible('input[autocomplete="one-time-code"], input[name="otc"], input[type="tel"]'));
          if (isCodeInput) {
            return { ...page, action: 'need-security-code' };
          }
          const addButton = clineMsFindClickableByText(CLINE_MS_ADD_EMAIL_TEXT) || clineMsQueryVisible('#iLandingViewAction');
          if (addButton) {
            clineMsClick(addButton);
            return { ...page, action: 'clicked-add-email' };
          }
          if (clineMsQueryVisibleFirst(CLINE_MS_AUX_EMAIL_SELECTORS)) {
            return { ...page, action: 'need-aux-email' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'consent-update': {
          // 只点「接受」：#idBtn_Accept 是微软同意页的固定 id；退化为按文案找，
          // 显式排除拒绝/取消按钮，避免 generic-confirm 误点。
          const accept = clineMsQueryVisible('#idBtn_Accept')
            || clineMsFindClickableByText(/^(接受|接受并继续|Accept|Yes|是)$/i);
          if (accept && clineMsClick(accept)) {
            return { ...page, action: 'accepted-consent' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'tou-accrue': {
          const next = clineMsQueryVisible('#iNext') || clineMsQueryVisibleFirst(CLINE_MS_SUBMIT_SELECTORS);
          if (next && clineMsClick(next)) {
            return { ...page, action: 'accepted-terms' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'fido-create': {
          const skip = clineMsQueryVisibleFirst(CLINE_MS_FIDO_SKIP_SELECTORS)
            || clineMsFindClickableByText(/跳过|skip|暂时跳过|not now|以后再说|取消|cancel/i);
          if (skip && clineMsClick(skip)) {
            return { ...page, action: 'skipped-fido' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'password': {
          if (!payload.password) {
            return { ...page, action: 'failed', failReason: '缺少微软账号密码。' };
          }
          const input = clineMsQueryVisible('input[type="password"]');
          if (input && clineMsFill(input, payload.password)) {
            const submit = clineMsQueryVisibleFirst(CLINE_MS_SUBMIT_SELECTORS);
            if (submit) clineMsClick(submit);
            return { ...page, action: 'submitted-password' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'choose-password-signin': {
          const link = clineMsFindClickableByText(CLINE_MS_USE_PASSWORD_TEXT);
          if (link && clineMsClick(link)) {
            return { ...page, action: 'clicked-use-password' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'email': {
          if (!payload.email) {
            return { ...page, action: 'failed', failReason: '缺少微软账号邮箱。' };
          }
          const input = clineMsQueryVisibleFirst(CLINE_MS_EMAIL_SELECTORS);
          if (input && clineMsFill(input, payload.email)) {
            const submit = clineMsQueryVisibleFirst(CLINE_MS_SUBMIT_SELECTORS);
            if (submit) clineMsClick(submit);
            return { ...page, action: 'submitted-email' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'add-security-email': {
          const addButton = clineMsFindClickableByText(CLINE_MS_ADD_EMAIL_TEXT) || clineMsQueryVisible('#iLandingViewAction');
          if (addButton) {
            clineMsClick(addButton);
            return { ...page, action: 'clicked-add-email' };
          }
          return { ...page, action: 'waiting' };
        }
        case 'generic-confirm': {
          const button = clineMsQueryVisibleFirst(CLINE_MS_SUBMIT_SELECTORS) || clineMsFindClickableByText(CLINE_MS_GENERIC_CONFIRM_TEXT);
          if (button && clineMsClick(button)) {
            return { ...page, action: 'clicked-confirm' };
          }
          return { ...page, action: 'waiting' };
        }
        default:
          // 未知页面上报页面文本摘要，便于后台日志定位卡点。
          return { ...page, action: 'waiting', pageText: clineMsPageSnippet() };
      }
    }

    case 'cline-submit-security-code': {
      const input = await clineMsWaitFor(() => clineMsQueryVisible(
        'input[autocomplete="one-time-code"], input[name="otc"], input[type="tel"], input[type="text"], input'
      ), 8000);
      if (!input) {
        return { state: 'security-challenge', url: location.href, action: 'failed', error: '等待验证码输入框超时。' };
      }
      clineMsClick(input);
      input.value = '';
      clineMsFill(input, payload.code);
      const submit = clineMsQueryVisibleFirst(CLINE_MS_AUX_SUBMIT_SELECTORS)
        || clineMsFindClickableByText(/验证|提交|下一步|verify|submit|next/i);
      if (submit) clineMsClick(submit);
      return { state: 'security-challenge', url: location.href, action: 'submitted-security-code' };
    }

    case 'cline-submit-aux-email': {
      const input = await clineMsWaitFor(() => clineMsQueryVisibleFirst(CLINE_MS_AUX_EMAIL_SELECTORS), 8000);
      if (!input) {
        return { state: 'security-challenge', url: location.href, action: 'failed', error: '等待辅助邮箱输入框超时。' };
      }
      clineMsFill(input, payload.email);
      const submit = clineMsQueryVisibleFirst(CLINE_MS_AUX_SUBMIT_SELECTORS)
        || clineMsFindClickableByText(/下一步|继续|next|continue|submit/i);
      if (submit) clineMsClick(submit);
      return { state: 'security-challenge', url: location.href, action: 'submitted-aux-email' };
    }

    default:
      throw new Error(`未知 Cline 登录命令：${command}`);
  }
}

if (!document.documentElement.hasAttribute(CLINE_MS_LOGIN_LISTENER_SENTINEL)) {
  document.documentElement.setAttribute(CLINE_MS_LOGIN_LISTENER_SENTINEL, '1');
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'EXECUTE_NODE' && message?.type !== 'GET_PAGE_STATE') return false;
    const command = message.command || message.nodeId || message.type;
    Promise.resolve()
      .then(() => executeClineMsCommand(command === 'GET_PAGE_STATE' ? 'cline-get-login-state' : command, message.payload || {}))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  });
}

window.__MULTIPAGE_CLINE_MS_LOGIN__ = {
  executeClineMsCommand,
  clineMsDetectPage,
};
