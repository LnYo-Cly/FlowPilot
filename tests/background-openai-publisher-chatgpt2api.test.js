const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadPublisherApi() {
  const source = fs.readFileSync('flows/openai/background/publisher-chatgpt2api.js', 'utf8');
  const globalScope = {};
  new Function('self', `${source}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundOpenAiPublisherChatgpt2Api;
}

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: async () => JSON.stringify(payload),
  };
}

test('OpenAI ChatGPT2API publisher exposes helpers and normalizes to accounts endpoint', () => {
  const api = loadPublisherApi();

  assert.equal(typeof api?.createOpenAiChatgpt2ApiPublisher, 'function');
  assert.equal(
    api.buildChatgpt2ApiAccountsUrl('https://remote.example.com/admin/deep/path'),
    'https://remote.example.com/api/accounts'
  );
  assert.equal(
    api.buildChatgpt2ApiAccountsUrl('remote.example.com/admin'),
    'http://remote.example.com/api/accounts'
  );
});

test('OpenAI ChatGPT2API publisher builds token import payload', () => {
  const api = loadPublisherApi();

  assert.deepEqual(api.buildOpenAiSessionImportPayload(
    {
      accessToken: 'session-token',
      user: { email: 'flow@example.com' },
    },
    ''
  ), {
    tokens: ['session-token'],
  });

  assert.throws(
    () => api.buildOpenAiSessionImportPayload(null, ''),
    /缺少 ChatGPT 会话 accessToken/
  );
});

test('OpenAI ChatGPT2API publisher builds accounts payload with registration credentials', () => {
  const api = loadPublisherApi();

  assert.deepEqual(api.buildOpenAiSessionImportPayload(
    { accessToken: 'session-token' },
    '',
    { email: 'reg@example.com', password: 'reg-password' }
  ), {
    accounts: [{
      access_token: 'session-token',
      email: 'reg@example.com',
      password: 'reg-password',
    }],
  });

  // 缺邮箱或密码时回退 tokens 形态
  assert.deepEqual(api.buildOpenAiSessionImportPayload(
    { accessToken: 'session-token' },
    '',
    { email: 'reg@example.com', password: '' }
  ), { tokens: ['session-token'] });
  assert.deepEqual(api.buildOpenAiSessionImportPayload(
    { accessToken: 'session-token' },
    '',
    { email: '', password: 'reg-password' }
  ), { tokens: ['session-token'] });

  assert.deepEqual(api.resolveOpenAiRegistrationCredentials({
    email: ' reg@example.com ',
    password: 'reg-password',
    customPassword: 'ignored',
  }), { email: 'reg@example.com', password: 'reg-password' });
  assert.deepEqual(api.resolveOpenAiRegistrationCredentials({
    email: 'reg@example.com',
    password: '',
    customPassword: 'custom-password',
  }), { email: 'reg@example.com', password: 'custom-password' });
});

test('OpenAI ChatGPT2API publisher posts account credentials with bearer admin key', async () => {
  const api = loadPublisherApi();
  const requests = [];

  await api.uploadOpenAiSessionToChatgpt2Api(
    'https://remote.example.com/admin/deep/path',
    ' admin-secret ',
    {
      session: { accessToken: 'session-token' },
      accessToken: 'session-token',
    },
    async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return createJsonResponse({ added: 1, skipped: 0, errors: [] });
    },
    { email: 'reg@example.com', password: 'reg-password' }
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, {
    accounts: [{
      access_token: 'session-token',
      email: 'reg@example.com',
      password: 'reg-password',
    }],
  });
});

test('OpenAI ChatGPT2API publisher posts tokens with bearer admin key', async () => {
  const api = loadPublisherApi();
  const requests = [];

  const result = await api.uploadOpenAiSessionToChatgpt2Api(
    'https://remote.example.com/admin/deep/path',
    ' admin-secret ',
    {
      session: {
        accessToken: 'session-token',
        user: { email: 'flow@example.com' },
      },
      accessToken: 'session-token',
    },
    async (url, options = {}) => {
      requests.push({
        url,
        method: options.method,
        authorization: options.headers?.Authorization,
        contentType: options.headers?.['Content-Type'],
        body: JSON.parse(options.body),
      });
      return createJsonResponse({ added: 1, skipped: 0, refreshed: 1, errors: [] });
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://remote.example.com/api/accounts');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].authorization, 'Bearer admin-secret');
  assert.equal(requests[0].contentType, 'application/json');
  assert.deepEqual(requests[0].body, { tokens: ['session-token'] });
  assert.equal(result.endpointUrl, 'https://remote.example.com/api/accounts');
  assert.equal(result.message, '新增 1 个，跳过 0 个，刷新 1 个');
});

test('OpenAI ChatGPT2API publisher surfaces validation detail on upload failure', async () => {
  const api = loadPublisherApi();

  await assert.rejects(
    () => api.uploadOpenAiSessionToChatgpt2Api(
      'https://remote.example.com/admin',
      'admin-secret',
      { accessToken: 'session-token' },
      async () => createJsonResponse({
        detail: [{
          loc: ['body', 'tokens'],
          msg: 'tokens is required',
          type: 'value_error',
        }],
      }, 422)
    ),
    /tokens: tokens is required/
  );
});

test('OpenAI ChatGPT2API executor reads latest state and writes upload status without leaking secrets', async () => {
  const api = loadPublisherApi();
  const requests = [];
  const logs = [];
  const broadcasts = [];
  const completed = [];
  const sessionReadCalls = [];
  const stepResolutionCalls = [];
  let liveState = {
    openaiChatgpt2ApiUrl: '',
    openaiChatgpt2ApiAdminKey: '',
    email: 'registered@example.com',
    password: 'registered-password',
    settingsState: {
      flows: {
        openai: {
          targets: {
            chatgpt2api: {
              baseUrl: 'https://remote.example.com/admin',
              apiKey: 'live-admin-key',
            },
          },
        },
      },
    },
  };
  const publisher = api.createOpenAiChatgpt2ApiPublisher({
    addLog: async (message, level) => logs.push({ message, level }),
    broadcastDataUpdate: (updates) => broadcasts.push(updates),
    completeNodeFromBackground: async (nodeId, payload) => completed.push({ nodeId, payload }),
    createOpenAiSessionReader: () => ({
      readCurrentSessionFromState: async (state, options) => {
        sessionReadCalls.push({ state, options });
        return {
          session: {
            accessToken: 'live-session-token',
            user: { email: 'flow@example.com' },
          },
          accessToken: 'live-session-token',
          tabId: 91,
        };
      },
    }),
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        authorization: options.headers?.Authorization,
        body: JSON.parse(options.body),
      });
      return createJsonResponse({ added: 1, skipped: 0, refreshed: 1, errors: [] });
    },
    getStepIdByKeyForState: (stepKey, state) => {
      stepResolutionCalls.push({ stepKey, state });
      return 7;
    },
    getState: async () => ({ ...liveState }),
    setState: async (updates = {}) => {
      liveState = { ...liveState, ...updates };
    },
  });

  const executionState = {
    nodeId: 'openai-upload-session-to-chatgpt2api',
    openaiChatgpt2ApiAdminKey: 'stale-key',
  };
  await publisher.executeOpenAiUploadSessionToChatgpt2Api(executionState);

  assert.deepEqual(stepResolutionCalls, [{
    stepKey: 'openai-upload-session-to-chatgpt2api',
    state: executionState,
  }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://remote.example.com/api/accounts');
  assert.equal(requests[0].authorization, 'Bearer live-admin-key');
  assert.deepEqual(requests[0].body, {
    accounts: [{
      access_token: 'live-session-token',
      email: 'registered@example.com',
      password: 'registered-password',
    }],
  });
  assert.equal(sessionReadCalls.length, 1);
  assert.deepEqual(sessionReadCalls[0].options, {
    visibleStep: 7,
    targetLabel: 'ChatGPT2API',
    requiredFields: ['accessToken'],
  });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].nodeId, 'openai-upload-session-to-chatgpt2api');
  assert.equal(completed[0].payload.openaiChatgpt2ApiUploadStatus, 'uploaded');
  assert.equal(completed[0].payload.openaiChatgpt2ApiUploadMessage, '新增 1 个，跳过 0 个，刷新 1 个');
  assert.equal(completed[0].payload.openaiChatgpt2ApiTargetUrl, 'https://remote.example.com/api/accounts');
  assert.equal(typeof completed[0].payload.openaiChatgpt2ApiUploadedAt, 'number');
  assert.equal(broadcasts.some((entry) => entry.openaiChatgpt2ApiUploadStatus === 'uploaded'), true);
  assert.equal(
    logs.some(({ message }) => message.includes('live-session-token')
      || message.includes('live-admin-key')
      || message.includes('registered-password')),
    false
  );
  assert.equal(
    logs.some(({ message }) => message.includes('ChatGPT 会话已上传到 ChatGPT2API，状态：新增 1 个，跳过 0 个，刷新 1 个。')),
    true
  );
});

test('OpenAI ChatGPT2API executor persists failure state without completing or leaking secrets', async () => {
  const api = loadPublisherApi();
  const logs = [];
  const completed = [];
  let liveState = {
    settingsState: {
      flows: {
        openai: {
          targets: {
            chatgpt2api: {
              baseUrl: 'https://remote.example.com/admin',
              apiKey: 'secret-admin-key',
            },
          },
        },
      },
    },
  };
  const publisher = api.createOpenAiChatgpt2ApiPublisher({
    addLog: async (message, level) => logs.push({ message, level }),
    completeNodeFromBackground: async (nodeId, payload) => completed.push({ nodeId, payload }),
    createOpenAiSessionReader: () => ({
      readCurrentSessionFromState: async () => ({
        session: { accessToken: 'secret-session-token' },
        accessToken: 'secret-session-token',
      }),
    }),
    fetchImpl: async () => createJsonResponse({ error: 'invalid admin key' }, 403),
    getState: async () => ({ ...liveState }),
    setState: async (updates = {}) => {
      liveState = { ...liveState, ...updates };
    },
  });

  await assert.rejects(
    () => publisher.executeOpenAiUploadSessionToChatgpt2Api({
      nodeId: 'openai-upload-session-to-chatgpt2api',
      visibleStep: 7,
    }),
    /ChatGPT2API 会话上传失败：invalid admin key/
  );

  assert.equal(completed.length, 0);
  assert.equal(liveState.openaiChatgpt2ApiUploadStatus, 'error');
  assert.equal(liveState.openaiChatgpt2ApiUploadedAt, 0);
  assert.equal(liveState.openaiChatgpt2ApiUploadMessage, 'ChatGPT2API 会话上传失败：invalid admin key');
  assert.equal(liveState.openaiChatgpt2ApiTargetUrl, 'https://remote.example.com/api/accounts');
  assert.equal(logs.some(({ message }) => message.includes('secret-session-token') || message.includes('secret-admin-key')), false);
});
