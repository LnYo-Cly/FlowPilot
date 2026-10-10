const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createContentHarness(fetchImpl, extras = {}) {
  const source = fs.readFileSync('flows/openai/content/chatgpt-session.js', 'utf8');
  const listeners = [];
  const logCalls = [];
  const context = {
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
        sendMessage: async () => ({}),
      },
    },
    console: { error() {}, info() {}, log() {}, warn() {} },
    fetch: fetchImpl,
    globalThis: null,
    self: null,
    window: null,
    log: (message, level) => {
      logCalls.push({ message, level });
    },
    ...extras,
  };
  context.globalThis = context;
  context.self = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.equal(listeners.length, 1);

  return {
    listener: listeners[0],
    logCalls,
    async send(message) {
      return await new Promise((resolve) => {
        const keepChannelOpen = listeners[0](message, {}, resolve);
        assert.equal(keepChannelOpen, true);
      });
    },
    sendSync(message) {
      let response;
      const keepChannelOpen = listeners[0](message, {}, (value) => {
        response = value;
      });
      return { keepChannelOpen, response };
    },
  };
}

function createFakeButton(text, overrides = {}) {
  return {
    nodeType: 1,
    tagName: 'BUTTON',
    innerText: text,
    textContent: text,
    disabled: false,
    form: null,
    getAttribute: () => null,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 96, height: 40 }),
    ...overrides,
  };
}

function createOnboardingDocument({ bodyText = '', buttons = [] } = {}) {
  return {
    body: {
      innerText: bodyText,
      textContent: bodyText,
    },
    querySelectorAll: (selector) => (selector === 'button, a, [role="button"]' ? buttons : []),
  };
}

test('ChatGPT session content script reads the current session through the generic protocol', async () => {
  const fetchCalls = [];
  const harness = createContentHarness(async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'session-access-token',
        user: { email: 'flow@example.com' },
      }),
    };
  });

  const result = await harness.send({
    type: 'OPENAI_SESSION_GET_CURRENT',
    source: 'background',
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/auth/session');
  assert.equal(fetchCalls[0].options.credentials, 'include');
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, 'session-access-token');
  assert.equal(result.session.user.email, 'flow@example.com');
});

test('ChatGPT session content script ignores unrelated messages and non-background callers', () => {
  let fetchCount = 0;
  const harness = createContentHarness(async () => {
    fetchCount += 1;
    throw new Error('unexpected fetch');
  });

  assert.equal(harness.listener({ type: 'PING', source: 'background' }, {}, () => {}), undefined);
  assert.equal(harness.listener({ type: 'OPENAI_SESSION_GET_CURRENT', source: 'sidepanel' }, {}, () => {}), undefined);
  assert.equal(fetchCount, 0);
});

test('ChatGPT session content script returns protocol errors without exposing response bodies', async () => {
  const harness = createContentHarness(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ accessToken: 'must-not-be-read' }),
  }));

  const result = await harness.send({
    type: 'OPENAI_SESSION_GET_CURRENT',
    source: 'background',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 503/);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'session'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'accessToken'), false);
});

test('ChatGPT session content script dismisses the ready onboarding page on demand', async () => {
  const button = createFakeButton('继续');
  let clicked = 0;
  const harness = createContentHarness(
    async () => {
      throw new Error('unexpected fetch');
    },
    {
      document: createOnboardingDocument({
        bodyText: '你已准备就绪\n继续\n继续操作即表示你同意我们的条款',
        buttons: [button],
      }),
      simulateClick(el) {
        clicked += 1;
        el.click?.();
      },
    }
  );

  const { keepChannelOpen, response } = harness.sendSync({
    type: 'OPENAI_SESSION_DISMISS_ONBOARDING',
    source: 'background',
  });

  assert.equal(keepChannelOpen, undefined);
  assert.equal(response.ok, true);
  assert.equal(response.clicked, true);
  assert.equal(response.found, true);
  assert.equal(response.label, '继续');
  assert.equal(clicked, 1);
  assert.ok(
    harness.logCalls.some(({ message }) => /你已准备就绪/.test(message) && /继续/.test(message)),
    'expected a log line describing the onboarding continue click',
  );
});

test('ChatGPT session content script reports not-found when the page is not onboarding', async () => {
  let clicked = 0;
  const harness = createContentHarness(
    async () => {
      throw new Error('unexpected fetch');
    },
    {
      document: createOnboardingDocument({
        bodyText: 'ChatGPT 主界面',
        buttons: [createFakeButton('发送')],
      }),
      simulateClick() {
        clicked += 1;
      },
    }
  );

  const { response } = harness.sendSync({
    type: 'OPENAI_SESSION_DISMISS_ONBOARDING',
    source: 'background',
  });

  assert.equal(response.ok, true);
  assert.equal(response.clicked, false);
  assert.equal(response.found, false);
  assert.equal(clicked, 0);
});

test('ChatGPT session content script reports found-without-click when continue is missing', async () => {
  let clicked = 0;
  const harness = createContentHarness(
    async () => {
      throw new Error('unexpected fetch');
    },
    {
      document: createOnboardingDocument({
        bodyText: '你已准备就绪',
        buttons: [createFakeButton('了解更多')],
      }),
      simulateClick() {
        clicked += 1;
      },
    }
  );

  const { response } = harness.sendSync({
    type: 'OPENAI_SESSION_DISMISS_ONBOARDING',
    source: 'background',
  });

  assert.equal(response.ok, true);
  assert.equal(response.clicked, false);
  assert.equal(response.found, true);
  assert.equal(clicked, 0);
});

test('ChatGPT session content script still reads session after dismissing onboarding', async () => {
  let clicked = 0;
  const harness = createContentHarness(
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'tok' }),
    }),
    {
      document: createOnboardingDocument({
        bodyText: '你已准备就绪',
        buttons: [createFakeButton('继续')],
      }),
      simulateClick() {
        clicked += 1;
      },
    }
  );

  const result = await harness.send({
    type: 'OPENAI_SESSION_GET_CURRENT',
    source: 'background',
  });

  assert.equal(result.ok, true);
  assert.equal(result.accessToken, 'tok');
  assert.equal(clicked, 1);
});
