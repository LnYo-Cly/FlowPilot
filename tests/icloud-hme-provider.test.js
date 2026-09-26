const test = require('node:test');
const assert = require('node:assert/strict');

require('../icloud-hme-utils.js');
globalThis.IcloudUtils = require('../icloud-utils.js');
require('../background/icloud-hme-provider.js');

const U = globalThis.IcloudHmeUtils;

test('normalizeIcloudHmeBaseUrl normalizes inputs', () => {
  assert.equal(U.normalizeIcloudHmeBaseUrl(''), 'http://localhost:8081');
  assert.equal(U.normalizeIcloudHmeBaseUrl('  '), 'http://localhost:8081');
  assert.equal(U.normalizeIcloudHmeBaseUrl('localhost:8081'), 'http://localhost:8081');
  assert.equal(U.normalizeIcloudHmeBaseUrl('http://192.168.1.5:8081/'), 'http://192.168.1.5:8081');
  assert.equal(U.normalizeIcloudHmeBaseUrl('https://hme.example.com/api?x=1#y'), 'https://hme.example.com/api');
  assert.equal(U.normalizeIcloudHmeBaseUrl('ftp://x'), '');
  assert.equal(U.normalizeIcloudHmeBaseUrl('not a url'), '');
});

test('joinIcloudHmeUrl joins paths', () => {
  assert.equal(U.joinIcloudHmeUrl('http://localhost:8081', '/api/create'), 'http://localhost:8081/api/create');
  assert.equal(U.joinIcloudHmeUrl('http://localhost:8081/', 'api/inbox'), 'http://localhost:8081/api/inbox');
});

test('normalizeIcloudHmeMessages maps server shape to hotmail-like shape', () => {
  const messages = U.normalizeIcloudHmeMessages({
    success: true,
    data: {
      count: 1,
      messages: [{
        id: '42',
        from: 'OpenAI <noreply@tm.openai.com>',
        to: 'alias@icloud.com',
        subject: 'Your code',
        date: '2026-05-07T09:20:00Z',
        preview: 'code is 123456',
      }],
    },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, '42');
  assert.equal(messages[0].from.emailAddress.address, 'OpenAI <noreply@tm.openai.com>');
  assert.equal(messages[0].bodyPreview, 'code is 123456');
  assert.equal(messages[0].receivedAtMs, Date.parse('2026-05-07T09:20:00Z'));
});

test('normalizeIcloudHmeAccounts picks fields and default account', () => {
  const accounts = U.normalizeIcloudHmeAccounts({
    success: true,
    data: [
      { id: 'acc_1', name: '主号', icloud_email: 'a@icloud.com', status: 'pending', alias_total: 3 },
      { id: 'acc_2', name: '备用', status: 'active' },
    ],
  });
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, 'acc_1');
  assert.equal(accounts[0].icloudEmail, 'a@icloud.com');
  assert.equal(U.pickDefaultIcloudHmeAccountId(accounts), 'acc_2');
  assert.equal(U.pickDefaultIcloudHmeAccountId([]), '');
});

test('buildIcloudHmeApiRegexFilter escapes the origin', () => {
  assert.equal(
    U.buildIcloudHmeApiRegexFilter('http://localhost:8081'),
    '^http://localhost:8081/api/'
  );
});

function createProvider(options = {}) {
  const {
    loginResponses = null,
    sessionIdInBody = 'sess-abc',
    cookieValue = '',
    accounts = [{ id: 'acc_1', name: '主号', status: 'active', icloud_email: 'a@icloud.com' }],
    aliases = [],
    inboxMessages = [],
    createResult = { email: 'new-alias@icloud.com', label: 'FlowPilot', created_at: '2026-01-01T00:00:00Z' },
    failOnceWith = null,
    stateOverrides = {},
  } = options;

  const calls = [];
  let loginCount = 0;
  let inboxCalls = 0;
  const sessionUpdates = [];
  const dnrRules = [];

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const path = u.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || 'GET', body, headers: init.headers || {}, query: Object.fromEntries(u.searchParams) });

    const respond = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

    if (path === '/api/auth/login') {
      loginCount += 1;
      if (Array.isArray(loginResponses) && loginResponses.length) {
        return loginResponses.shift()(respond);
      }
      return respond(200, {
        success: true,
        data: {
          csrf_token: `csrf-${loginCount}`,
          expires_at: new Date(Date.now() + 3600e3).toISOString(),
          ...(sessionIdInBody ? { session_id: sessionIdInBody } : {}),
        },
      });
    }
    if (path === '/api/auth/session') {
      return respond(200, {
        success: true,
        data: { csrf_token: 'csrf-cached', expires_at: new Date(Date.now() + 3600e3).toISOString() },
      });
    }
    if (path === '/api/accounts') {
      return respond(200, { success: true, data: accounts });
    }
    if (path === '/api/aliases') {
      return respond(200, { success: true, data: { account_id: u.searchParams.get('account_id'), count: aliases.length, aliases } });
    }
    if (path === '/api/create') {
      return respond(200, { success: true, data: createResult });
    }
    if (path === '/api/inbox') {
      inboxCalls += 1;
      if (failOnceWith && inboxCalls === 1) {
        return failOnceWith(respond);
      }
      return respond(200, { success: true, data: { count: inboxMessages.length, messages: inboxMessages, method: 'imap' } });
    }
    return respond(404, { success: false, code: 'NOT_FOUND', message: 'no route' });
  };

  const provider = globalThis.MultiPageBackgroundIcloudHmeProvider.createIcloudHmeProvider({
    addLog: async () => {},
    chrome: {
      cookies: { get: async () => (cookieValue ? { value: cookieValue } : null) },
      declarativeNetRequest: {
        updateSessionRules: async (opts) => { dnrRules.push(opts); },
      },
    },
    fetchImpl,
    getState: async () => ({}),
    setState: async (updates) => { sessionUpdates.push(updates); },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    pickVerificationMessageWithTimeFallback: options.pickVerificationMessageWithTimeFallback,
    persistRegistrationEmailState: options.persistRegistrationEmailState || (async () => {}),
  });

  const state = {
    icloudHmeBaseUrl: 'http://localhost:8081',
    icloudHmeAdminPassword: 'pw',
    icloudHmeAccountId: '',
    ...stateOverrides,
  };

  return { provider, state, calls, sessionUpdates, dnrRules, getLoginCount: () => loginCount };
}

test('login then create alias sends CSRF header and account_id', async () => {
  const { provider, state, calls, sessionUpdates, dnrRules } = createProvider();

  const created = await provider.createIcloudHmeAlias(state);

  assert.equal(created.email, 'new-alias@icloud.com');
  const loginCall = calls.find((c) => c.path === '/api/auth/login');
  assert.deepEqual(loginCall.body, { password: 'pw' });
  const createCall = calls.find((c) => c.path === '/api/create');
  assert.equal(createCall.method, 'POST');
  assert.equal(createCall.body.account_id, 'acc_1');
  assert.equal(createCall.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(dnrRules.length, 1);
  assert.match(dnrRules[0].addRules[0].action.requestHeaders[0].value, /^hme_session=sess-abc$/);
  assert.equal(sessionUpdates.at(-1).icloudHmeSession.sessionId, 'sess-abc');
});

test('login falls back to chrome.cookies when session_id missing in body', async () => {
  const { provider, state, sessionUpdates } = createProvider({ sessionIdInBody: '', cookieValue: 'cookie-sess' });
  await provider.listIcloudHmeAccounts(state);
  assert.equal(sessionUpdates.at(-1).icloudHmeSession.sessionId, 'cookie-sess');
});

test('401 on inbox triggers re-login and retries once', async () => {
  const pick = () => ({ match: { code: '123456', message: { id: '1' }, receivedAt: 1 }, usedTimeFallback: false });
  const { provider, state, calls, getLoginCount } = createProvider({
    pickVerificationMessageWithTimeFallback: pick,
    inboxMessages: [{ id: '1', subject: 'code', preview: '123456' }],
    failOnceWith: (respond) => respond(401, { success: false, code: 'AUTH_REQUIRED', message: '会话已失效' }),
  });

  const result = await provider.pollIcloudHmeVerificationCode(4, { ...state, email: 'alias@icloud.com' }, {
    targetEmail: 'alias@icloud.com',
    maxAttempts: 2,
    intervalMs: 1,
  });

  assert.equal(result.code, '123456');
  assert.equal(getLoginCount(), 2);
  assert.equal(calls.filter((c) => c.path === '/api/inbox').length, 2);
});

test('pollIcloudHmeVerificationCode passes alias and account_id query params', async () => {
  const { provider, state, calls } = createProvider({
    pickVerificationMessageWithTimeFallback: () => ({ match: null }),
    inboxMessages: [],
  });

  const result = await provider.pollIcloudHmeVerificationCode(4, { ...state, email: 'alias@icloud.com' }, {
    targetEmail: 'alias@icloud.com',
    maxAttempts: 1,
    intervalMs: 1,
  });

  assert.equal(result.ok, false);
  const inboxCall = calls.find((c) => c.path === '/api/inbox');
  assert.equal(inboxCall.query.alias, 'alias@icloud.com');
  assert.equal(inboxCall.query.account_id, 'acc_1');
});

test('fetchIcloudHmeAddress reuses unused alias when reuse_existing', async () => {
  const persistCalls = [];
  const { provider, state, calls } = createProvider({
    aliases: [
      { email: 'used@icloud.com', anonymousId: 'anon1', active: true },
      { email: 'fresh@icloud.com', anonymousId: 'anon2', active: true },
    ],
    persistRegistrationEmailState: async (s, email, opts) => persistCalls.push({ email, opts }),
  });

  const email = await provider.fetchIcloudHmeAddress({
    ...state,
    icloudFetchMode: 'reuse_existing',
    manualAliasUsage: { 'used@icloud.com': true },
  });

  assert.equal(email, 'fresh@icloud.com');
  assert.equal(persistCalls[0].email, 'fresh@icloud.com');
  assert.equal(persistCalls[0].opts.source, 'generated:icloud-hme');
  assert.equal(calls.some((c) => c.path === '/api/create'), false);
});

test('fetchIcloudHmeAddress creates alias when always_new', async () => {
  const persistCalls = [];
  const { provider, state, calls } = createProvider({
    aliases: [{ email: 'fresh@icloud.com', anonymousId: 'anon2', active: true }],
    persistRegistrationEmailState: async (s, email, opts) => persistCalls.push({ email, opts }),
  });

  const email = await provider.fetchIcloudHmeAddress({ ...state, icloudFetchMode: 'always_new' });

  assert.equal(email, 'new-alias@icloud.com');
  assert.equal(persistCalls[0].email, 'new-alias@icloud.com');
  assert.equal(calls.some((c) => c.path === '/api/create'), true);
});

test('ensureIcloudHmeConfig rejects missing password', async () => {
  const { provider } = createProvider();
  assert.throws(
    () => provider.ensureIcloudHmeConfig({ icloudHmeBaseUrl: 'http://localhost:8081', icloudHmeAdminPassword: '' }),
    /管理员密码/
  );
});

test('invalid credentials surfaces as auth error without retry loop', async () => {
  const { provider, state, getLoginCount } = createProvider({
    loginResponses: [
      (respond) => respond(401, { success: false, code: 'INVALID_CREDENTIALS', message: '管理员密码错误' }),
    ],
  });
  await assert.rejects(
    () => provider.listIcloudHmeAccounts(state),
    /管理员密码错误/
  );
  assert.equal(getLoginCount(), 1);
});
