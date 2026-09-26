const test = require('node:test');
const assert = require('node:assert/strict');

require('../background/mailnest-provider.js');

const P = globalThis.MultiPageBackgroundMailnestProvider;

function createProvider(options = {}) {
  const {
    balance = { available_balance: 1.765 },
    projects = [],
    exclusiveProduct = { stock: 74, price: '0.038' },
    exclusiveEmails = [],
    buyTempResponse = [{ email: 'temp01@mail.test' }],
    buyExclusiveResponse = [{ email: 'excl01@mail.test' }],
    receiveRecords = [],
    failPaths = {},
    stateOverrides = {},
    webLoginResponse = { access_token: 'AT-1', refresh_token: 'RT-1' },
    webRefreshResponse = { access_token: 'AT-2', refresh_token: 'RT-2' },
    accountProducts = [],
    buyAccountResponse = { id: 'order-1', content: 'bought01@outlook.com----Pwd#123' },
  } = options;

  const calls = [];
  const stateUpdates = [];
  const secretStore = {};
  const logs = [];

  const respond = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
  const ok = (data) => respond(200, { code: '00000', msg: '成功', type: '', data });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const path = u.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || 'GET', body, headers: init.headers || {} });

    if (failPaths[path]) return failPaths[path](respond);
    if (path === '/api/v1/balance') return ok(balance);
    if (path === '/api/product/info') return ok({ temporary: projects, exclusive: exclusiveProduct });
    if (path === '/api/v1/email/temporary') return ok({ list: exclusiveEmails });
    if (path === '/api/v1/email/exclusive') return ok({ list: exclusiveEmails });
    if (path === '/api/v1/email/temporary/buy') return ok(buyTempResponse);
    if (path === '/api/v1/email/exclusive/buy') return ok(buyExclusiveResponse);
    if (path === '/api/v1/email/receive') return ok(receiveRecords);
    if (path === '/api/v1/email/release') return ok(null);
    if (path === '/api/users/login') return ok(webLoginResponse);
    if (path === '/api/users/refresh') return ok(webRefreshResponse);
    if (path === '/api/account/info') return ok(accountProducts);
    if (path === '/api/account/buy') return ok(buyAccountResponse);
    return respond(404, { code: '404', msg: 'no route' });
  };

  const provider = P.createMailnestProvider({
    addLog: async (msg) => { logs.push(msg); },
    chrome: {
      storage: {
        local: {
          get: async (key) => ({ [key]: secretStore[key] }),
          set: async (obj) => { Object.assign(secretStore, obj); },
          remove: async () => {},
        },
      },
    },
    fetchImpl,
    getState: async () => ({}),
    setState: async (updates) => { stateUpdates.push(updates); },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    pickVerificationMessageWithTimeFallback: options.pickVerificationMessageWithTimeFallback
      || (() => ({ match: { code: '654321', message: { id: 'x' }, receivedAt: 0 }, usedTimeFallback: false })),
    normalizeMessage: options.normalizeMessage || ((m) => ({ id: m.id || '', subject: m.subject || '', bodyPreview: m.bodyPreview || '', date: m.date || '' })),
    persistRegistrationEmailState: options.persistRegistrationEmailState || (async () => {}),
    normalizeMessage: undefined,
  });

  const state = {
    mailnestApiKey: 'sk-test-key',
    mailnestMode: 'temporary',
    mailnestProjectCode: 'chatgpt001',
    mailnestWebUsername: 'web-user',
    mailnestWebPassword: 'web-pass',
    ...stateOverrides,
  };

  return { provider, state, calls, stateUpdates, secretStore, logs };
}

test('normalizeMailnestBaseUrl normalizes inputs', () => {
  assert.equal(P.normalizeMailnestBaseUrl(''), 'https://mailnest.top');
  assert.equal(P.normalizeMailnestBaseUrl('  '), 'https://mailnest.top');
  assert.equal(P.normalizeMailnestBaseUrl('mailnest.example.com/'), 'https://mailnest.example.com');
  assert.equal(P.normalizeMailnestBaseUrl('http://192.168.1.5:9000/api?x=1#y'), 'http://192.168.1.5:9000/api');
  assert.equal(P.normalizeMailnestBaseUrl('ftp://x'), '');
});

test('listMailnestProducts parses temporary project list', async () => {
  const { provider, state } = createProvider({
    projects: [
      { code: 'chatgpt001', name: 'ChatGPT 官网', stock: 62, price: '0.018', original_price: 0.036, duration_seconds: 1200 },
      { code: 'aws001', name: 'aws builder id / kiro', stock: 10, price: 0.018 },
      { code: '', name: 'empty' },
    ],
  });
  const products = await provider.listMailnestProducts(state);
  assert.equal(products.temporary.length, 2);
  assert.equal(products.temporary[0].code, 'chatgpt001');
  assert.equal(products.temporary[0].price, '0.018');
  assert.equal(products.temporary[0].durationSeconds, 1200);
  assert.equal(products.exclusive.stock, 74);
});

test('temporary buy sends project_code and persists registration email', async () => {
  const persisted = [];
  const { provider, state, calls } = createProvider({
    persistRegistrationEmailState: async (s, email) => { persisted.push(email); },
  });

  const email = await provider.fetchMailnestAddress(state);
  assert.equal(email, 'temp01@mail.test');

  const buyCall = calls.find((c) => c.path === '/api/v1/email/temporary/buy');
  assert.equal(buyCall.method, 'POST');
  assert.deepEqual(buyCall.body, { project_code: 'chatgpt001', count: 1 });
  assert.equal(buyCall.headers.Authorization, 'Bearer sk-test-key');
  assert.deepEqual(persisted, ['temp01@mail.test']);
});

test('temporary buy falls back to free-text project code when list empty', async () => {
  const { provider, state, calls } = createProvider({ projects: [] });
  await provider.fetchMailnestAddress({ ...state, mailnestProjectCode: 'aws001' });
  const buyCall = calls.find((c) => c.path === '/api/v1/email/temporary/buy');
  assert.equal(buyCall.body.project_code, 'aws001');
});

test('exclusive mode buys a fresh mailbox (unique per registration)', async () => {
  const { provider, state, calls } = createProvider({
    exclusiveEmails: [{ email: 'existing@mail.test' }],
  });
  const email = await provider.fetchMailnestAddress({ ...state, mailnestMode: 'exclusive' });
  assert.equal(email, 'excl01@mail.test');
  const buyCall = calls.find((c) => c.path === '/api/v1/email/exclusive/buy');
  assert.equal(buyCall.method, 'POST');
  assert.deepEqual(buyCall.body, { count: 1 });
});

test('exclusive mode buys when pool empty', async () => {
  const { provider, state, calls } = createProvider({ exclusiveEmails: [] });
  const email = await provider.fetchMailnestAddress({ ...state, mailnestMode: 'exclusive' });
  assert.equal(email, 'excl01@mail.test');
  const buyCall = calls.find((c) => c.path === '/api/v1/email/exclusive/buy');
  assert.deepEqual(buyCall.body, { count: 1 });
});

test('temporary buy without project code throws', async () => {
  const { provider, state } = createProvider();
  await assert.rejects(
    () => provider.fetchMailnestAddress({ ...state, mailnestProjectCode: '' }),
    /项目代码/
  );
});

test('missing API key throws config error', async () => {
  const { provider, state } = createProvider();
  await assert.rejects(
    () => provider.fetchMailnestAddress({ ...state, mailnestApiKey: '' }),
    /API Key/
  );
});

test('error envelope code is surfaced', async () => {
  const { provider, state } = createProvider({
    failPaths: { '/api/v1/balance': (respond) => respond(200, { code: '40001', msg: '密钥无效' }) },
  });
  await assert.rejects(() => provider.testMailnestConnection(state), /密钥无效/);
});

test('poll returns code_match directly from receive records', async () => {
  const pickCalls = [];
  const { provider, state } = createProvider({
    receiveRecords: [{ id: '1', subject: 'code', code_match: '998877', created_at: '2026-05-07 09:00:00' }],
    pickVerificationMessageWithTimeFallback: (...args) => { pickCalls.push(args); return null; },
  });
  const result = await provider.pollMailnestVerificationCode(4, { ...state, email: 'temp01@mail.test' }, {
    targetEmail: 'temp01@mail.test',
    maxAttempts: 3,
    intervalMs: 1,
  });
  assert.equal(result.code, '998877');
  // code_match fast path — shared picker not needed
  assert.equal(pickCalls.length, 0);
});

test('poll falls back to shared picker when no code_match', async () => {
  const { provider, state } = createProvider({
    receiveRecords: [{ id: '7', subject: 'Your ChatGPT code', bodyPreview: '654321' }],
  });
  const result = await provider.pollMailnestVerificationCode(4, { ...state, email: 'temp01@mail.test' }, {
    targetEmail: 'temp01@mail.test',
    maxAttempts: 3,
    intervalMs: 1,
  });
  assert.equal(result.code, '654321');
});

test('release calls /email/release', async () => {
  const { provider, state, calls } = createProvider();
  const result = await provider.releaseMailnestEmail({ email: 'temp01@mail.test' }, { state });
  assert.equal(result.ok, true);
  const releaseCall = calls.find((c) => c.path === '/api/v1/email/release');
  assert.equal(releaseCall.method, 'POST');
  assert.deepEqual(releaseCall.body, { email: 'temp01@mail.test' });
});

test('testMailnestConnection returns balance and project summary', async () => {
  const { provider, state } = createProvider({
    projects: [{ code: 'a', name: 'A', stock: 1 }, { code: 'b', name: 'B', stock: 2 }],
  });
  const result = await provider.testMailnestConnection(state);
  assert.equal(result.ok, true);
  assert.equal(result.balance.availableBalance, '1.765');
  assert.equal(result.temporaryProjectCount, 2);
});

// ---- 网站账号体系（/api/account/* 走登录态，不走 API Key）----

test('parseMailnestAccountContent handles ----, colon, and multi-line formats', () => {
  const parsed = P.parseMailnestAccountContent(
    'a1@outlook.com----Pwd#123\n'
    + 'a2@outlook.com:pw:abc\n'
    + 'a3@outlook.com----pw3----client-id-9----rt-token\n'
    + 'noise line without email\n'
  );
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].email, 'a1@outlook.com');
  assert.equal(parsed[0].password, 'Pwd#123');
  assert.equal(parsed[1].password, 'pw');
  assert.equal(parsed[2].password, 'pw3');
  assert.equal(parsed[2].clientId, 'client-id-9');
  assert.equal(parsed[2].refreshToken, 'rt-token');
});

test('isMailnestWebConfigured reflects username+password presence', () => {
  const { provider, state } = createProvider();
  assert.equal(provider.isMailnestWebConfigured(state), true);
  assert.equal(provider.isMailnestWebConfigured({ ...state, mailnestWebPassword: '' }), false);
});

test('buyMailnestAccounts logs in once then buys with web token', async () => {
  const { provider, state, calls } = createProvider();

  const bought = await provider.buyMailnestAccounts(state, { accountType: 'lweb_ocom_test', count: 1 });
  assert.equal(bought.id, 'order-1');
  assert.equal(bought.accounts.length, 1);
  assert.equal(bought.accounts[0].email, 'bought01@outlook.com');
  assert.equal(bought.accounts[0].password, 'Pwd#123');

  const loginCall = calls.find((c) => c.path === '/api/users/login');
  assert.deepEqual(loginCall.body, { username: 'web-user', password: 'web-pass' });
  const buyCall = calls.find((c) => c.path === '/api/account/buy');
  assert.equal(buyCall.method, 'POST');
  assert.deepEqual(buyCall.body, { account_type: 'lweb_ocom_test', count: 1 });
  assert.equal(buyCall.headers.Authorization, 'Bearer AT-1');

  // 第二次购买复用缓存 token，不再重复登录
  await provider.buyMailnestAccounts(state, { accountType: 'lweb_ocom_test', count: 1 });
  assert.equal(calls.filter((c) => c.path === '/api/users/login').length, 1);
});

test('buyMailnestAccounts retries via refresh token on 401', async () => {
  let accountCalls = 0;
  const { provider, state, calls } = createProvider({
    failPaths: {
      '/api/account/buy': (respond) => {
        accountCalls += 1;
        return accountCalls === 1
          ? respond(401, { detail: 'Unauthorized' })
          : respond(200, { code: '00000', msg: '成功', data: { id: 'order-2', content: 'r@outlook.com----pw' } });
      },
    },
  });

  const bought = await provider.buyMailnestAccounts(state, { count: 1 });
  assert.equal(bought.id, 'order-2');
  const refreshCall = calls.find((c) => c.path === '/api/users/refresh');
  assert.deepEqual(refreshCall.body, { refresh_token: 'RT-1' });
  const secondBuy = calls.filter((c) => c.path === '/api/account/buy')[1];
  assert.equal(secondBuy.headers.Authorization, 'Bearer AT-2');
});

test('buyMailnestAccounts re-logins when refresh fails', async () => {
  let accountCalls = 0;
  const { provider, state, calls } = createProvider({
    failPaths: {
      '/api/account/buy': (respond) => {
        accountCalls += 1;
        return accountCalls === 1
          ? respond(401, { detail: 'Unauthorized' })
          : respond(200, { code: '00000', msg: '成功', data: { id: 'order-3', content: 'x@outlook.com----pw' } });
      },
      '/api/users/refresh': (respond) => respond(200, { code: 'A0401', msg: 'refresh_token 无效' }),
    },
  });

  const bought = await provider.buyMailnestAccounts(state, { count: 1 });
  assert.equal(bought.id, 'order-3');
  assert.equal(calls.filter((c) => c.path === '/api/users/login').length, 2);
});

test('buyMailnestAccounts without web credentials throws', async () => {
  const { provider, state } = createProvider({
    stateOverrides: { mailnestWebUsername: '', mailnestWebPassword: '' },
  });
  await assert.rejects(() => provider.buyMailnestAccounts(state, { count: 1 }), /网站账号密码/);
});

test('listMailnestAccountProducts normalizes product fields', async () => {
  const { provider, state } = createProvider({
    accountProducts: [
      { name: '长效网页号', account_type: 'lweb_ocom_test', description: 'd', price: '0.029', original_price: '0.040', stock: 22, help_url: 'https://x' },
      { name: '', account_type: '' },
    ],
  });
  const products = await provider.listMailnestAccountProducts(state);
  assert.equal(products.length, 1);
  assert.equal(products[0].accountType, 'lweb_ocom_test');
  assert.equal(products[0].stock, 22);
  assert.equal(products[0].price, '0.029');
});
