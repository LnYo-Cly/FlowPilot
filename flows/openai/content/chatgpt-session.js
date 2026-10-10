// flows/openai/content/chatgpt-session.js - Read-only ChatGPT session bridge.

(function attachOpenAiChatGptSessionContentScript() {
  const rootScope = typeof window !== 'undefined' ? window : globalThis;
  const listenerSentinel = '__MULTIPAGE_OPENAI_SESSION_LISTENER_READY__';

  if (rootScope[listenerSentinel]) {
    return;
  }
  rootScope[listenerSentinel] = true;

  function normalizeString(value = '') {
    return String(value || '').trim();
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  async function readCurrentSession() {
    const response = await fetch('/api/auth/session', {
      credentials: 'include',
    });
    if (!response?.ok) {
      const status = Math.max(0, Number(response?.status) || 0);
      const error = new Error(`读取 ChatGPT 会话失败：HTTP ${status || 'unknown'}`);
      error.status = status;
      throw error;
    }

    let session = null;
    try {
      session = await response.json();
    } catch (_error) {
      throw new Error('读取 ChatGPT 会话失败：响应不是有效 JSON。');
    }
    if (!isPlainObject(session)) {
      throw new Error('读取 ChatGPT 会话失败：响应格式无效。');
    }

    return {
      session,
      accessToken: normalizeString(session.accessToken || session.access_token),
    };
  }

  const ONBOARDING_READY_TEXT_PATTERN = /你已准备就绪|一切就绪|准备就绪|you'?re\s+all\s+set|you\s+are\s+all\s+set/i;
  const ONBOARDING_CONTINUE_TEXT_PATTERN = /^\s*(?:继续|continue|get\s+started|start|开始|下一步|next)\s*$/i;
  const ONBOARDING_WATCH_INTERVAL_MS = 800;
  const ONBOARDING_WATCH_MAX_MS = 120000;
  const ONBOARDING_CLICK_COOLDOWN_MS = 4000;
  const ONBOARDING_MAX_CLICKS = 6;

  let onboardingWatcherTimer = null;
  let onboardingWatcherStartedAt = 0;
  let lastOnboardingClickAt = 0;
  let onboardingClickCount = 0;

  function isElementVisibleForClick(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    if (typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
    }
    const rect = el.getBoundingClientRect?.();
    return Boolean(rect) && rect.width > 0 && rect.height > 0;
  }

  function isElementEnabledForClick(el) {
    return Boolean(el)
      && !el.disabled
      && el.getAttribute?.('aria-disabled') !== 'true';
  }

  function isReadyOnboardingPage() {
    if (typeof document === 'undefined' || !document.body) {
      return false;
    }
    const bodyText = normalizeString(document.body.innerText || document.body.textContent || '');
    if (!bodyText) {
      return false;
    }
    return ONBOARDING_READY_TEXT_PATTERN.test(bodyText.slice(0, 4000));
  }

  function findOnboardingContinueTrigger() {
    if (!isReadyOnboardingPage()) {
      return null;
    }
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return candidates.find((candidate) => (
      isElementVisibleForClick(candidate)
      && isElementEnabledForClick(candidate)
      && ONBOARDING_CONTINUE_TEXT_PATTERN.test(normalizeString(candidate.innerText || candidate.textContent || ''))
    )) || null;
  }

  function dismissReadyOnboarding(reason = 'auto') {
    const trigger = findOnboardingContinueTrigger();
    if (!trigger) {
      return {
        ok: true,
        clicked: false,
        found: isReadyOnboardingPage(),
      };
    }
    lastOnboardingClickAt = Date.now();
    onboardingClickCount += 1;
    const label = normalizeString(trigger.innerText || trigger.textContent || '').slice(0, 40) || '继续';
    try {
      if (typeof log === 'function') {
        log(`检测到「你已准备就绪」注册引导页，自动点击「${label}」进入 ChatGPT（${reason}）。`, 'info');
      }
    } catch (_error) {}
    try {
      if (typeof simulateClick === 'function') {
        simulateClick(trigger);
      } else if (typeof trigger.click === 'function') {
        trigger.click();
      } else {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    } catch (error) {
      return {
        ok: false,
        clicked: false,
        found: true,
        error: normalizeString(error?.message || error) || '点击「继续」失败。',
      };
    }
    return {
      ok: true,
      clicked: true,
      found: true,
      label,
    };
  }

  function startOnboardingDismissWatcher() {
    if (onboardingWatcherTimer || typeof setInterval !== 'function') {
      return;
    }
    onboardingWatcherStartedAt = Date.now();
    onboardingWatcherTimer = setInterval(() => {
      try {
        if (
          Date.now() - onboardingWatcherStartedAt > ONBOARDING_WATCH_MAX_MS
          || onboardingClickCount >= ONBOARDING_MAX_CLICKS
        ) {
          clearInterval(onboardingWatcherTimer);
          onboardingWatcherTimer = null;
          return;
        }
        if (Date.now() - lastOnboardingClickAt < ONBOARDING_CLICK_COOLDOWN_MS) {
          return;
        }
        dismissReadyOnboarding('watcher');
      } catch (_error) {}
    }, ONBOARDING_WATCH_INTERVAL_MS);
  }

  startOnboardingDismissWatcher();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      message?.type === 'OPENAI_SESSION_DISMISS_ONBOARDING'
      && message?.source === 'background'
    ) {
      startOnboardingDismissWatcher();
      try {
        sendResponse(dismissReadyOnboarding('background'));
      } catch (error) {
        sendResponse({
          ok: false,
          clicked: false,
          error: error instanceof Error ? error.message : normalizeString(error) || '引导页处理失败。',
        });
      }
      return undefined;
    }

    if (
      message?.type !== 'OPENAI_SESSION_GET_CURRENT'
      || message?.source !== 'background'
    ) {
      return undefined;
    }

    startOnboardingDismissWatcher();
    try {
      dismissReadyOnboarding('session-read');
    } catch (_error) {}

    readCurrentSession()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : normalizeString(error) || '读取 ChatGPT 会话失败。',
          status: Math.max(0, Number(error?.status) || 0),
        });
      });
    return true;
  });
})();
