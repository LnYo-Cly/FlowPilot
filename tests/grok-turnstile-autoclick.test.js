const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const routerSource = fs.readFileSync('background/message-router.js', 'utf8');
const grokSource = fs.readFileSync('flows/grok/content/register-page.js', 'utf8');

function loadRouterApi() {
  const globalScope = { console };
  return new Function('self', `${routerSource}; return self.MultiPageBackgroundMessageRouter;`)(globalScope);
}

function extractFunction(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return source.slice(start, end);
}

function buildGrokContentHarness({ hasIframe = true, evidenceJson = 'null', turnstileToken = '', hasCfInput = false, iframeInShadow = false } = {}) {
  return new Function(`
    const sentMessages = [];
    const logs = [];
    let grokTurnstileAutoClickCount = 0;
    let grokTurnstileLastClickAt = 0;
    let grokTurnstileManualHintLogged = false;
    const GROK_TURNSTILE_CLICK_TARGET_SELECTOR = 'iframe';
    const GROK_TURNSTILE_CLICK_COOLDOWN_MS = 8000;
    const GROK_TURNSTILE_MAX_AUTO_CLICKS = 5;
    const GROK_HUMAN_VERIFICATION_SUCCESS_TIMEOUT_MS = 300;
    const iframeEl = ${hasIframe ? `{ tagName: 'IFRAME', matches: (s) => String(s).includes('iframe'), shadowRoot: null, getBoundingClientRect: () => ({ left: 100, top: 200, width: 300, height: 65 }) }` : 'null'};
    const cfInputEl = ${hasCfInput ? `{ tagName: 'INPUT', matches: (s) => String(s).includes('cf-turnstile-response'), shadowRoot: null, value: '', dispatchEvent: () => true }` : 'null'};
    const shadowHostEl = ${iframeInShadow ? `{ tagName: 'DIV', matches: () => false, shadowRoot: null }` : 'null'};
    if (shadowHostEl) {
      shadowHostEl.shadowRoot = {
        querySelectorAll: (selector) => (selector === '*' && iframeEl ? [iframeEl] : []),
      };
    }
    const document = {
      querySelectorAll: (selector) => {
        if (selector === '*') {
          return [
            shadowHostEl,
            (iframeEl && !${iframeInShadow}) ? iframeEl : null,
            cfInputEl,
          ].filter(Boolean);
        }
        return [];
      },
      body: { innerText: '' },
      cookie: '',
    };
    const window = {
      turnstile: ${turnstileToken ? `{ getResponse: () => '${turnstileToken}' }` : 'undefined'},
      HTMLInputElement: undefined,
    };
    const location = { hostname: 'accounts.x.ai', href: 'https://accounts.x.ai/sign-up' };
    const chrome = {
      runtime: {
        sendMessage: async (message) => {
          sentMessages.push(message);
          return { ok: true };
        },
      },
    };
    function isVisibleGrokElement(el) { return Boolean(el); }
    function getGrokHumanVerificationSuccessEvidence() { return ${evidenceJson}; }
    function getGrokHumanVerificationContainers() { return []; }
    ${extractFunction(grokSource, 'getGrokElementText')}
    ${extractFunction(grokSource, 'queryGrokDeep')}
    ${extractFunction(grokSource, 'getGrokTurnstileInputElement')}
    ${extractFunction(grokSource, 'getGrokTurnstileApiToken')}
    ${extractFunction(grokSource, 'getGrokTurnstileResponseValue')}
    ${extractFunction(grokSource, 'backfillGrokTurnstileToken')}
    async function waitForGrok(predicate, options = {}) {
      const deadline = Date.now() + (Number(options.timeoutMs) || 100);
      let value = null;
      while (Date.now() <= deadline) {
        value = predicate();
        if (value) return value;
        await sleep(Number(options.intervalMs) || 50);
      }
      return value;
    }
    function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
    function throwIfStopped() {}
    function log(message, level = 'info') { logs.push({ message, level }); }
    ${extractFunction(grokSource, 'getGrokTurnstileClickPoint')}
    ${extractFunction(grokSource, 'hasGrokHumanVerificationHint')}
    ${extractFunction(grokSource, 'requestGrokTurnstileTrustedClick')}
    ${extractFunction(grokSource, 'waitForGrokHumanVerificationSuccess')}
    return {
      logs,
      sentMessages,
      backfillGrokTurnstileToken,
      getGrokTurnstileClickPoint,
      requestGrokTurnstileTrustedClick,
      waitForGrokHumanVerificationSuccess,
      getGrokTurnstileResponseValue,
      cfInputEl,
    };
  `)();
}

test('router forwards turnstile click requests to the debugger clicker', async () => {
  const api = loadRouterApi();
  const clicks = [];
  const router = api.createMessageRouter({
    addLog: async () => {},
    clickWithDebugger: async (tabId, rect) => {
      clicks.push({ tabId, rect });
    },
  });

  const response = await router.handleMessage(
    {
      type: 'GROK_TURNSTILE_CLICK_REQUEST',
      source: 'grok-register-page',
      payload: { centerX: 130, centerY: 232 },
    },
    { tab: { id: 55 } }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(clicks, [{ tabId: 55, rect: { centerX: 130, centerY: 232 } }]);
});

test('router rejects malformed turnstile click payloads', async () => {
  const api = loadRouterApi();
  const router = api.createMessageRouter({
    addLog: async () => {},
    clickWithDebugger: async () => {},
  });

  const badRect = await router.handleMessage(
    { type: 'GROK_TURNSTILE_CLICK_REQUEST', payload: { centerX: 'x' } },
    { tab: { id: 55 } }
  );
  assert.equal(badRect.ok, false);

  const noTab = await router.handleMessage(
    { type: 'GROK_TURNSTILE_CLICK_REQUEST', payload: { centerX: 1, centerY: 2 } },
    {}
  );
  assert.equal(noTab.ok, false);
});

test('router returns a soft failure when the debugger clicker is not wired', async () => {
  const api = loadRouterApi();
  const router = api.createMessageRouter({ addLog: async () => {} });

  const response = await router.handleMessage(
    { type: 'GROK_TURNSTILE_CLICK_REQUEST', payload: { centerX: 10, centerY: 20 } },
    { tab: { id: 55 } }
  );

  assert.equal(response.ok, false);
});

test('grok turnstile click point targets the checkbox area on the widget left edge', async () => {
  const harness = buildGrokContentHarness({ hasIframe: true });

  const point = harness.getGrokTurnstileClickPoint();
  assert.equal(point.centerX, 124);
  assert.equal(point.centerY, 233);

  const result = await harness.requestGrokTurnstileTrustedClick();
  assert.equal(result.ok, true);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].type, 'GROK_TURNSTILE_CLICK_REQUEST');
  assert.deepEqual(harness.sentMessages[0].payload, { centerX: 124, centerY: 233 });
});

test('grok turnstile click point pierces open shadow roots to reach the widget iframe', async () => {
  const harness = buildGrokContentHarness({ hasIframe: true, iframeInShadow: true });

  const point = harness.getGrokTurnstileClickPoint();
  assert.ok(point);
  assert.equal(point.centerX, 124);
  assert.equal(point.centerY, 233);

  const result = await harness.requestGrokTurnstileTrustedClick();
  assert.equal(result.ok, true);
  assert.equal(harness.sentMessages.length, 1);
});

test('grok turnstile request is a no-op without a visible widget', async () => {
  const harness = buildGrokContentHarness({ hasIframe: false });

  assert.equal(harness.getGrokTurnstileClickPoint(), null);
  const result = await harness.requestGrokTurnstileTrustedClick();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-found');
  assert.equal(harness.sentMessages.length, 0);
});

test('grok turnstile request probes the background when the widget hides in a closed root', async () => {
  // 本地检测不到组件（closed shadow root），但页面有验证迹象（验证容器存在）
  // → 发送 {probe:true}，由后台 CDP DOM 穿透定位。
  const harness = new Function(`
    const sentMessages = [];
    let grokTurnstileAutoClickCount = 0;
    let grokTurnstileLastClickAt = 0;
    let grokTurnstileManualHintLogged = false;
    const GROK_TURNSTILE_CLICK_TARGET_SELECTOR = 'iframe';
    const GROK_TURNSTILE_CLICK_COOLDOWN_MS = 8000;
    const GROK_TURNSTILE_MAX_AUTO_CLICKS = 5;
    const document = { querySelectorAll: () => [], body: { innerText: '' }, cookie: '' };
    const chrome = { runtime: { sendMessage: async (m) => { sentMessages.push(m); return { ok: true }; } } };
    function isVisibleGrokElement(el) { return Boolean(el); }
    function getGrokHumanVerificationSuccessEvidence() { return null; }
    function getGrokHumanVerificationContainers() { return [{}]; }
    ${extractFunction(grokSource, 'getGrokElementText')}
    ${extractFunction(grokSource, 'queryGrokDeep')}
    ${extractFunction(grokSource, 'getGrokTurnstileClickPoint')}
    ${extractFunction(grokSource, 'hasGrokHumanVerificationHint')}
    ${extractFunction(grokSource, 'requestGrokTurnstileTrustedClick')}
    function log() {}
    return { sentMessages, requestGrokTurnstileTrustedClick, getGrokTurnstileClickPoint };
  `)();

  assert.equal(harness.getGrokTurnstileClickPoint(), null);
  const result = await harness.requestGrokTurnstileTrustedClick();
  assert.equal(result.ok, true);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0].payload, { probe: true });
});

test('grok turnstile request skips when verification already succeeded', async () => {
  const harness = buildGrokContentHarness({
    hasIframe: true,
    evidenceJson: '{ type: \'turnstile_response\' }',
  });

  const result = await harness.requestGrokTurnstileTrustedClick();
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(harness.sentMessages.length, 0);
});

test('grok human verification wait auto-clicks the widget then succeeds on evidence', async () => {
  const harness = buildGrokContentHarness({
    hasIframe: true,
    evidenceJson: '{ type: \'turnstile_response\' }',
  });

  const result = await harness.waitForGrokHumanVerificationSuccess();
  assert.equal(result.type, 'turnstile_response');
  // Evidence already present → the initial request short-circuits as skipped (no click sent).
  assert.equal(harness.sentMessages.length, 0);
});

test('grok turnstile response falls back to the turnstile api token', () => {
  const token = 'x'.repeat(90);
  const harness = buildGrokContentHarness({
    hasIframe: false,
    turnstileToken: token,
    hasCfInput: false,
  });

  assert.equal(harness.getGrokTurnstileResponseValue(), token);
});

test('grok turnstile backfill writes an api-side token into the hidden input', () => {
  const token = 'y'.repeat(96);
  const harness = buildGrokContentHarness({
    hasIframe: false,
    turnstileToken: token,
    hasCfInput: true,
  });

  const synced = harness.backfillGrokTurnstileToken();
  assert.equal(synced, token);
  assert.equal(harness.cfInputEl.value, token);
});
