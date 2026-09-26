const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadModule(files) {
  const globalScope = {};
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n;\n');
  new Function('self', `${source}; return self;`)(globalScope);
  return globalScope;
}

function loadClient() {
  return loadModule(['flows/cline/background/cline-client.js']).MultiPageClineClient;
}

function loadRunner(extraScope = {}) {
  const scope = loadModule([
    'flows/cline/background/cline-client.js',
    'flows/cline/background/register-runner.js',
  ]);
  Object.assign(scope, extraScope);
  return scope.MultiPageBackgroundClineRegisterRunner;
}

function loadPublisher(extraScope = {}) {
  const scope = loadModule([
    'flows/cline/background/cline-client.js',
    'flows/cline/background/publisher-cline2api.js',
  ]);
  Object.assign(scope, extraScope);
  return scope.MultiPageBackgroundClinePublisher;
}

// ---------------- cline-client ----------------

test('cline client builds authorize URL with extension callback params', () => {
  const client = loadClient();
  const url = new URL(client.buildClineAuthorizeUrl({
    callbackUrl: 'http://127.0.0.1:48801/auth',
  }));
  assert.equal(url.origin, 'https://api.cline.bot');
  assert.equal(url.pathname, '/api/v1/auth/authorize');
  assert.equal(url.searchParams.get('client_type'), 'extension');
  assert.equal(url.searchParams.get('callback_url'), 'http://127.0.0.1:48801/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:48801/auth');
});

test('cline client extracts authorization code only from cline/loopback URLs', () => {
  const client = loadClient();
  const code = 'x'.repeat(20);
  assert.equal(client.pickClineCodeFromUrl(`http://127.0.0.1:48801/auth?code=${code}`), code);
  assert.equal(client.pickClineCodeFromUrl(`https://app.cline.bot/auth/callback?code=${code}`), code);
  assert.equal(client.pickClineCodeFromUrl(`https://evil.example/?code=${code}`), '');
  assert.equal(client.pickClineCodeFromUrl('not a url'), '');
  assert.equal(client.pickClineCodeFromUrl('http://127.0.0.1:48801/auth?code=short'), '');
});

test('cline client normalizes expiresAt seconds to milliseconds', () => {
  const client = loadClient();
  assert.equal(client.normalizeClineExpiresAt(1735689600), 1735689600000);
  assert.equal(client.normalizeClineExpiresAt('1735689600'), 1735689600000);
  assert.equal(client.normalizeClineExpiresAt(1735689600000), 1735689600000);
  assert.equal(client.normalizeClineExpiresAt('2025-01-01T00:00:00Z'), Date.parse('2025-01-01T00:00:00Z'));
  assert.equal(client.normalizeClineExpiresAt('junk'), 0);
  assert.equal(client.normalizeClineExpiresAt(null), 0);
});

test('cline client maps registration record to cline2api import shape', () => {
  const client = loadClient();
  const record = client.toCline2ApiImportRecord({
    email: 'User@Example.COM',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: 1735689600,
  });
  assert.deepEqual(record, {
    email: 'user@example.com',
    access: 'at-1',
    refresh: 'rt-1',
    expires: 1735689600000,
    tokenType: 'Bearer',
    provider: 'cline',
    label: null,
  });
  assert.equal(client.toCline2ApiImportRecord({ email: 'x@y.com' }), null);
  assert.equal(client.toCline2ApiImportRecord({ email: 'x@y.com', accessToken: 'a', refreshToken: 'r' }), null);
});

test('cline client resolveClineMicrosoftLoginUrl rewrites provider to MicrosoftOAuth', async () => {
  const client = loadClient();
  let capturedUrl = '';
  const loginUrl = await client.resolveClineMicrosoftLoginUrl({
    callbackUrl: 'http://127.0.0.1:48801/auth',
    fetchImpl: async (url) => {
      capturedUrl = url;
      return {
        status: 302,
        headers: { get: (name) => (name === 'location' ? 'https://api.workos.com/user_management/authorize?provider=Universal' : null) },
      };
    },
  });
  assert.match(capturedUrl, /^https:\/\/api\.cline\.bot\/api\/v1\/auth\/authorize\?/);
  const resolved = new URL(loginUrl);
  assert.equal(resolved.searchParams.get('provider'), 'MicrosoftOAuth');
});

test('cline client rewriteClineProviderParam rewrites gateway urls only', () => {
  const client = loadClient();
  const rewritten = client.rewriteClineProviderParam(
    'https://api.workos.com/user_management/authorize?provider=authkit&client_id=c1', 'MicrosoftOAuth');
  assert.equal(new URL(rewritten).searchParams.get('provider'), 'MicrosoftOAuth');
  assert.equal(new URL(rewritten).searchParams.get('client_id'), 'c1');
  const authkit = client.rewriteClineProviderParam('https://authkit.cline.bot/authorize?provider=authkit', 'MicrosoftOAuth');
  assert.equal(new URL(authkit).searchParams.get('provider'), 'MicrosoftOAuth');
  assert.equal(client.rewriteClineProviderParam('https://evil.example.com/?provider=x', 'MicrosoftOAuth'), '');
  assert.equal(client.rewriteClineProviderParam('not a url'), '');
  assert.equal(client.isClineAuthGatewayUrl('https://api.workos.com/x'), true);
  assert.equal(client.isClineAuthGatewayUrl('https://login.microsoftonline.com/x'), false);
});

test('cline client import posts accounts to /admin/api/accounts/import with Bearer token', async () => {
  const client = loadClient();
  let request = null;
  const summary = await client.importCline2ApiAccounts({
    baseUrl: 'http://127.0.0.1:3000/',
    adminToken: 'adm-1',
    records: [{ email: 'a@b.com', accessToken: 'at', refreshToken: 'rt', expiresAt: 1735689600 }],
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ imported: 1, updated: 0, skipped: 0, total: 1, errors: [] }),
      };
    },
  });
  assert.equal(request.url, 'http://127.0.0.1:3000/admin/api/accounts/import');
  assert.equal(request.init.headers.Authorization, 'Bearer adm-1');
  const body = JSON.parse(request.init.body);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].access, 'at');
  assert.deepEqual(summary, { imported: 1, updated: 0, skipped: 0, total: 1, errors: [] });
});

// ---------------- register-runner ----------------

function makeRunnerDeps(overrides = {}) {
  const states = [];
  return {
    addLog: async () => {},
    completeNodeFromBackground: async (key, payload) => ({ ok: true, key, payload }),
    getState: async () => overrides.state || {},
    setState: async (patch) => { states.push(patch); },
    setEmailState: async () => {},
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    ...overrides.deps,
    __states: states,
  };
}

test('cline runner allocateClineAccounts picks unused login account plus aux account', () => {
  const api = loadRunner();
  const runner = api.createClineRegisterRunner({ completeNodeFromBackground: async () => ({}) });
  const { target, aux } = runner.allocateClineAccounts({
    hotmailAccounts: [
      { id: 'a1', email: 'used@h.com', password: 'pass-1111', used: true },
      { id: 'a2', email: 'free@h.com', password: 'pass-2222' },
      { id: 'a3', email: 'aux@h.com', password: 'pass-3333', clientId: 'cid', refreshToken: 'rt' },
    ],
  });
  assert.equal(target.email, 'free@h.com');
  assert.equal(aux.email, 'aux@h.com');
});

test('cline runner allocateClineAccounts throws without credentials', () => {
  const api = loadRunner();
  const runner = api.createClineRegisterRunner({ completeNodeFromBackground: async () => ({}) });
  assert.throws(
    () => runner.allocateClineAccounts({ hotmailAccounts: [{ email: 'x@h.com' }] }),
    /没有可用的微软账号/
  );
});

test('cline runner prepare account stores runtime patch and completes node', async () => {
  const api = loadRunner();
  const deps = makeRunnerDeps({
    state: {
      hotmailAccounts: [
        { id: 'a2', email: 'free@h.com', password: 'pass-2222' },
        { id: 'a3', email: 'aux@h.com', password: 'pass-3333', clientId: 'cid', refreshToken: 'rt' },
      ],
    },
  });
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClinePrepareAccount({});
  assert.equal(result.ok, true);
  assert.equal(result.key, 'cline-prepare-account');
  const clineState = deps.__states[0].runtimeState.flowState.cline;
  assert.equal(clineState.email, 'free@h.com');
  assert.equal(clineState.accountId, 'a2');
  assert.equal(clineState.auxAccountId, 'a3');
  assert.match(clineState.callbackUrl, /^http:\/\/127\.0\.0\.1:48\d{3}\/auth$/);
});

test('cline runner exchange token rejects without authorization code', async () => {
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(makeRunnerDeps({
    state: { runtimeState: { flowState: { cline: {} } } },
  }));
  await assert.rejects(
    () => runner.executeClineExchangeToken({}),
    /缺少授权码/
  );
});

test('cline runner exchange token stores credentials on success', async () => {
  const api = loadRunner();
  const deps = makeRunnerDeps({
    state: {
      runtimeState: {
        flowState: {
          cline: { authorizationCode: 'code-123456789', callbackUrl: 'http://127.0.0.1:48801/auth' },
        },
      },
    },
    deps: {
      fetchImpl: async (url, init) => {
        assert.match(url, /api\.cline\.bot\/api\/v1\/auth\/token$/);
        const body = JSON.parse(init.body);
        assert.equal(body.code, 'code-123456789');
        assert.equal(body.grant_type, 'authorization_code');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            data: { accessToken: 'at-x', refreshToken: 'rt-x', expiresAt: 1735689600 },
          }),
        };
      },
    },
  });
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineExchangeToken({});
  assert.equal(result.ok, true);
  const patch = deps.__states[0].runtimeState.flowState.cline;
  assert.equal(patch.accessToken, 'at-x');
  assert.equal(patch.refreshToken, 'rt-x');
});

function makeDriveDeps({ state, onDriveStep } = {}) {
  let tabUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1';
  const sent = [];
  const messages = [];
  const deps = makeRunnerDeps({
    state,
    deps: {
      chrome: { tabs: { get: async (id) => ({ id, url: tabUrl }), update: async (id, { url }) => { tabUrl = url; } } },
      isTabAlive: async () => true,
      sendToContentScriptResilient: async (sourceId, message) => {
        sent.push(message.command);
        messages.push(message);
        if (message.command === 'cline-drive-step') {
          return onDriveStep?.(sent.filter((c) => c === 'cline-drive-step').length, {
            setTabUrl: (url) => { tabUrl = url; },
          }) || { action: 'wait' };
        }
        return { action: 'submitted' };
      },
    },
  });
  return { deps, sent, messages };
}

test('cline runner buys MailNest aux mailbox for security code when configured', async () => {
  const code = 'y'.repeat(24);
  const mailCalls = [];
  const { deps, sent } = makeDriveDeps({
    state: {
      mailnestApiKey: 'sk-x',
      hotmailAccounts: [{ id: 'a1', email: 't@h.com', password: 'pass-0000' }],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com',
        session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: (n, { setTabUrl }) => {
      if (n === 1) return { action: 'need-aux-email' };
      if (n === 2) return { action: 'need-security-code' };
      setTabUrl(`http://127.0.0.1:48801/auth?code=${code}`);
      return { action: 'done' };
    },
  });
  deps.mailnestProvider = {
    getMailnestConfig: (s) => ({ apiKey: s.mailnestApiKey }),
    requestMailnestJson: async (s, path, opts) => {
      mailCalls.push(path);
      assert.equal(opts.payload.project_code, 'microsoft001');
      return [{ email: 'aux-box@mailnest.io' }];
    },
    pollMailnestVerificationCode: async (step, s, payload) => {
      mailCalls.push(`receive:${payload.targetEmail}`);
      return { ok: true, code: '654321' };
    },
    releaseMailnestEmail: async (payload) => {
      mailCalls.push(`release:${payload.email}`);
      return { ok: true };
    },
  };
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineDriveLogin({});
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    'cline-drive-step', 'cline-submit-aux-email',
    'cline-drive-step', 'cline-submit-security-code',
    'cline-drive-step',
  ]);
  assert.deepEqual(mailCalls, [
    '/api/v1/email/temporary/buy',
    'receive:aux-box@mailnest.io',
    'release:aux-box@mailnest.io',
  ]);
  const patch = deps.__states.find((p) => p.runtimeState?.flowState?.cline?.auxEmailSource === 'mailnest');
  assert.equal(patch.runtimeState.flowState.cline.auxEmail, 'aux-box@mailnest.io');
});

test('cline runner falls back to Graph aux account when MailNest not configured', async () => {
  const code = 'z'.repeat(24);
  const scope = {
    MultiPageMicrosoftEmail: {
      fetchMicrosoftVerificationCode: async ({ clientId, refreshToken }) => {
        assert.equal(clientId, 'cid');
        assert.equal(refreshToken, 'rt');
        return { code: '111222' };
      },
    },
  };
  const { deps, sent } = makeDriveDeps({
    state: {
      hotmailAccounts: [
        { id: 'a1', email: 't@h.com', password: 'pass-0000' },
        { id: 'a3', email: 'aux@h.com', password: 'pass-3333', clientId: 'cid', refreshToken: 'rt' },
      ],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com', auxAccountId: 'a3', auxEmail: 'aux@h.com',
        session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: (n, { setTabUrl }) => {
      if (n === 1) return { action: 'need-aux-email' };
      if (n === 2) return { action: 'need-security-code' };
      setTabUrl(`http://127.0.0.1:48801/auth?code=${code}`);
      return { action: 'done' };
    },
  });
  const api = loadRunner(scope);
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineDriveLogin({});
  assert.equal(result.ok, true);
  assert.equal(sent[1], 'cline-submit-aux-email');
});

test('cline runner open-authorize lands on workos url and rewrites provider', async () => {
  const api = loadRunner();
  const updates = [];
  // 模拟浏览器跟 302：创建标签页后 tab.url 已经落到 workos
  let tabUrl = '';
  const deps = makeRunnerDeps({
    state: { runtimeState: { flowState: { cline: { callbackUrl: 'http://127.0.0.1:48810/auth' } } } },
    deps: {
      reuseOrCreateTab: async (source, url) => {
        tabUrl = 'https://api.workos.com/user_management/authorize?provider=authkit&client_id=c1';
        return 42;
      },
      registerTab: async () => {},
      waitForTabStableComplete: async () => {},
      chrome: {
        tabs: {
          get: async (id) => ({ id, url: tabUrl }),
          update: async (id, props) => { updates.push(props); tabUrl = props.url; return { id, url: props.url }; },
        },
      },
    },
  });
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineOpenAuthorize({});
  assert.equal(result.ok, true);
  assert.equal(result.key, 'cline-open-authorize');
  assert.equal(updates.length, 1);
  const nav = new URL(updates[0].url);
  assert.equal(nav.searchParams.get('provider'), 'MicrosoftOAuth');
});

test('cline runner open-authorize skips rewrite when already on microsoft', async () => {
  const api = loadRunner();
  const updates = [];
  let tabUrl = '';
  const deps = makeRunnerDeps({
    state: { runtimeState: { flowState: { cline: { callbackUrl: 'http://127.0.0.1:48810/auth' } } } },
    deps: {
      reuseOrCreateTab: async () => {
        tabUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1';
        return 42;
      },
      registerTab: async () => {},
      waitForTabStableComplete: async () => {},
      chrome: { tabs: { get: async (id) => ({ id, url: tabUrl }), update: async (id, p) => { updates.push(p); } } },
    },
  });
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineOpenAuthorize({});
  assert.equal(result.ok, true);
  assert.equal(updates.length, 0);
});

test('cline runner buys MailNest Microsoft account when pool empty', async () => {
  const api = loadRunner();
  const deps = makeRunnerDeps({
    state: {
      hotmailAccounts: [],
      mailnestWebUsername: 'web-user',
      mailnestWebPassword: 'web-pass',
      mailnestAccountProductType: 'lweb_ocom_test',
    },
    deps: {
      mailnestProvider: {
        isMailnestWebConfigured: (s) => Boolean(s.mailnestWebUsername && s.mailnestWebPassword),
        buyMailnestAccounts: async (s, opts) => {
          assert.equal(opts.accountType, 'lweb_ocom_test');
          return {
            id: 'order-9',
            accounts: [{ email: 'bought@outlook.com', password: 'Bought#1' }],
          };
        },
      },
    },
  });
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClinePrepareAccount({});
  assert.equal(result.ok, true);
  const clineState = deps.__states[0].runtimeState.flowState.cline;
  assert.equal(clineState.msAccountSource, 'mailnest');
  assert.equal(clineState.msAccountEmail, 'bought@outlook.com');
  assert.equal(clineState.msAccountPassword, 'Bought#1');
  assert.equal(clineState.accountId, '');
});

test('cline runner still throws when pool empty and MailNest web not configured', async () => {
  const api = loadRunner();
  const deps = makeRunnerDeps({ state: { hotmailAccounts: [] } });
  const runner = api.createClineRegisterRunner(deps);
  await assert.rejects(() => runner.executeClinePrepareAccount({}), /没有可用的微软账号/);
});

test('cline runner drive-login uses purchased runtime credentials', async () => {
  const code = 'w'.repeat(24);
  const { deps, messages } = makeDriveDeps({
    state: {
      hotmailAccounts: [],
      runtimeState: { flowState: { cline: {
        msAccountSource: 'mailnest',
        msAccountEmail: 'bought@outlook.com',
        msAccountPassword: 'Bought#1',
        session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: (n, { setTabUrl }) => {
      setTabUrl(`http://127.0.0.1:48801/auth?code=${code}`);
      return { action: 'done' };
    },
  });
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineDriveLogin({});
  assert.equal(result.ok, true);
  const driveStep = messages.find((m) => m.command === 'cline-drive-step');
  assert.equal(driveStep.payload.email, 'bought@outlook.com');
  assert.equal(driveStep.payload.password, 'Bought#1');
});

test('cline runner uses fixed MailNest aux email without buying or releasing', async () => {
  const code = 'q'.repeat(24);
  const mailCalls = [];
  const { deps, sent } = makeDriveDeps({
    state: {
      mailnestApiKey: 'sk-x',
      clineAuxMailnestEmail: 'mybox@exclusive.test',
      hotmailAccounts: [{ id: 'a1', email: 't@h.com', password: 'pass-0000' }],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com', session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: (n, { setTabUrl }) => {
      if (n === 1) return { action: 'need-aux-email' };
      if (n === 2) return { action: 'need-security-code' };
      setTabUrl(`http://127.0.0.1:48801/auth?code=${code}`);
      return { action: 'done' };
    },
  });
  deps.mailnestProvider = {
    getMailnestConfig: (s) => ({ apiKey: s.mailnestApiKey }),
    requestMailnestJson: async (s, path) => { mailCalls.push(path); return [{ email: 'should-not-buy@x' }]; },
    pollMailnestVerificationCode: async (step, s, payload) => {
      mailCalls.push(`receive:${payload.targetEmail}`);
      assert.deepEqual(payload.excludeCodes, []);
      return { ok: true, code: '112233' };
    },
    releaseMailnestEmail: async (payload) => { mailCalls.push(`release:${payload.email}`); return { ok: true }; },
  };
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineDriveLogin({});
  assert.equal(result.ok, true);
  assert.deepEqual(mailCalls, ['receive:mybox@exclusive.test']);
  assert.ok(sent.includes('cline-submit-aux-email'));
  const patch = deps.__states.find((p) => p.runtimeState?.flowState?.cline?.auxEmailSource === 'mailnest-fixed');
  assert.equal(patch.runtimeState.flowState.cline.auxEmail, 'mybox@exclusive.test');
});

test('cline runner excludes already-submitted codes on repeated need-security-code', async () => {
  const code = 'r'.repeat(24);
  const pollPayloads = [];
  const { deps } = makeDriveDeps({
    state: {
      mailnestApiKey: 'sk-x',
      clineAuxMailnestEmail: 'mybox@exclusive.test',
      hotmailAccounts: [{ id: 'a1', email: 't@h.com', password: 'pass-0000' }],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com', session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: (n, { setTabUrl }) => {
      if (n === 1) return { action: 'need-aux-email' };
      if (n <= 3) return { action: 'need-security-code' };
      setTabUrl(`http://127.0.0.1:48801/auth?code=${code}`);
      return { action: 'done' };
    },
  });
  deps.mailnestProvider = {
    getMailnestConfig: (s) => ({ apiKey: s.mailnestApiKey }),
    requestMailnestJson: async () => [],
    pollMailnestVerificationCode: async (step, s, payload) => {
      pollPayloads.push(payload);
      return { ok: true, code: pollPayloads.length === 1 ? '556677' : '' };
    },
    releaseMailnestEmail: async () => ({ ok: true }),
  };
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineDriveLogin({});
  assert.equal(result.ok, true);
  assert.deepEqual(pollPayloads[0].excludeCodes, []);
  assert.deepEqual(pollPayloads[1].excludeCodes, ['556677']);
});

test('cline runner fails after repeated provider-error', async () => {
  const { deps } = makeDriveDeps({
    state: {
      hotmailAccounts: [{ id: 'a1', email: 't@h.com', password: 'pass-0000' }],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com', session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: () => ({ action: 'provider-error', providerError: 'oauth_provider_generic_error', retried: true }),
  });
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  await assert.rejects(() => runner.executeClineDriveLogin({}), /oauth_provider_generic_error/);
});

test('cline runner falls back to WorkOS device flow after repeated provider-error', async () => {
  const fetches = [];
  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  let authCalls = 0;
  const { deps } = makeDriveDeps({
    state: {
      hotmailAccounts: [{ id: 'a1', email: 't@h.com', password: 'pass-0000' }],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com', session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: (n) => (n <= 2
      ? { action: 'provider-error', providerError: 'oauth_provider_generic_error' }
      : { action: 'waiting' }),
  });
  deps.fetchImpl = async (url) => {
    fetches.push(String(url));
    if (String(url).includes('/user_management/authorize/device')) {
      return jsonResponse({
        device_code: 'dc-1', user_code: 'UC-1', interval: 0, expires_in: 300,
        verification_uri_complete: 'https://api.workos.com/activate?user_code=UC-1',
      });
    }
    if (String(url).includes('/user_management/authenticate')) {
      authCalls += 1;
      return authCalls === 1
        ? jsonResponse({ error: 'authorization_pending' }, 400)
        : jsonResponse({ access_token: 'wat-1', refresh_token: 'wrt-1' });
    }
    if (String(url).includes('/api/v1/auth/register')) {
      return jsonResponse({ data: { accessToken: 'cat-1', refreshToken: 'crt-1', expiresAt: 1735689600 } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineDriveLogin({});
  assert.equal(result.ok, true);
  assert.ok(fetches.some((u) => u.includes('/authorize/device')));
  assert.ok(fetches.some((u) => u.includes('/api/v1/auth/register')));
  const clineState = deps.__states.at(-1).runtimeState.flowState.cline;
  assert.equal(clineState.accessToken, 'cat-1');
  assert.equal(clineState.loginMode, 'device');
  // 设备码模式已持有令牌：换码步直接跳过
  const exchangeResult = await runner.executeClineExchangeToken({
    runtimeState: deps.__states.at(-1).runtimeState,
  });
  assert.equal(exchangeResult.ok, true);
  assert.ok(!fetches.some((u) => u.includes('/api/v1/auth/token')));
});

test('cline runner reports original error when device fallback also fails', async () => {
  const { deps } = makeDriveDeps({
    state: {
      hotmailAccounts: [{ id: 'a1', email: 't@h.com', password: 'pass-0000' }],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com', session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: () => ({ action: 'provider-error', providerError: 'oauth_provider_generic_error' }),
  });
  deps.fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'down' });
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  await assert.rejects(
    () => runner.executeClineDriveLogin({}),
    /oauth_provider_generic_error.*设备码备用路径也失败/
  );
});

test('cline runner switches device flow back to callback when device auth fails (Radar)', async () => {
  const code = 'd'.repeat(24);
  const tabUpdates = [];
  let switchedBack = false;
  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  const { deps } = makeDriveDeps({
    state: {
      hotmailAccounts: [{ id: 'a1', email: 't@h.com', password: 'pass-0000' }],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com',
        loginUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1',
        callbackUrl: 'http://127.0.0.1:48801/auth',
        session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: (n, { setTabUrl }) => {
      if (n <= 2) return { action: 'provider-error', providerError: 'oauth_provider_generic_error' };
      // 回切发生前保持 waiting，让设备码轮询有机会失败；回切后放行回调授权码。
      if (!switchedBack) return { action: 'waiting' };
      setTabUrl(`http://127.0.0.1:48801/auth?code=${code}`);
      return { action: 'done' };
    },
  });
  const origUpdate = deps.chrome.tabs.update;
  deps.chrome.tabs.update = async (id, opts) => {
    tabUpdates.push(opts.url);
    if (String(opts.url).includes('login.microsoftonline.com')) switchedBack = true;
    return origUpdate(id, opts);
  };
  deps.fetchImpl = async (url) => {
    if (String(url).includes('/user_management/authorize/device')) {
      return jsonResponse({
        device_code: 'dc-1', user_code: 'UC-1', interval: 0, expires_in: 300,
        verification_uri_complete: 'https://api.workos.com/activate?user_code=UC-1',
      });
    }
    if (String(url).includes('/user_management/authenticate')) {
      return jsonResponse({ error: 'access_denied', error_description: 'radar flagged' }, 400);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  const result = await runner.executeClineDriveLogin({});
  assert.equal(result.ok, true);
  assert.equal(result.payload.authorizationCode, code);
  // 先进设备码确认页，撞 Radar 后回切 loginUrl，最后在回调里拿到授权码。
  assert.ok(tabUpdates[0]?.includes('workos.com'));
  assert.ok(tabUpdates[1]?.includes('login.microsoftonline.com'));
});

test('cline runner rejects aux step when neither MailNest nor Graph aux available', async () => {
  const { deps } = makeDriveDeps({
    state: {
      hotmailAccounts: [{ id: 'a1', email: 't@h.com', password: 'pass-0000' }],
      runtimeState: { flowState: { cline: {
        accountId: 'a1', email: 't@h.com', session: { loginTabId: 7 },
      } } },
    },
    onDriveStep: () => ({ action: 'need-aux-email' }),
  });
  const api = loadRunner();
  const runner = api.createClineRegisterRunner(deps);
  await assert.rejects(() => runner.executeClineDriveLogin({}), /MailNest API Key/);
});

// ---------------- publisher ----------------

test('cline publisher uploads runtime credential to cline2api', async () => {
  const api = loadPublisher();
  const states = [];
  let request = null;
  const publisher = api.createCline2ApiPublisher({
    completeNodeFromBackground: async (key, payload) => ({ ok: true, key, payload }),
    getState: async () => ({
      cline2apiBaseUrl: 'http://127.0.0.1:3000',
      cline2apiAdminToken: 'adm',
      runtimeState: {
        flowState: {
          cline: { email: 'u@h.com', accessToken: 'at', refreshToken: 'rt', expiresAt: 1735689600 },
        },
      },
    }),
    setState: async (patch) => { states.push(patch); },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ imported: 1, updated: 0, skipped: 0, total: 1 }),
      };
    },
  });
  const result = await publisher.executeClineUploadCredential();
  assert.equal(result.key, 'cline-upload-credential');
  assert.equal(request.url, 'http://127.0.0.1:3000/admin/api/accounts/import');
  assert.equal(JSON.parse(request.init.body).accounts[0].email, 'u@h.com');
  assert.equal(states[0].runtimeState.flowState.cline.uploadSummary.imported, 1);
});

test('cline publisher fails without base url', async () => {
  const api = loadPublisher();
  const publisher = api.createCline2ApiPublisher({
    completeNodeFromBackground: async () => ({}),
    getState: async () => ({
      runtimeState: {
        flowState: {
          cline: { email: 'u@h.com', accessToken: 'at', refreshToken: 'rt', expiresAt: 1 },
        },
      },
    }),
  });
  await assert.rejects(() => publisher.executeClineUploadCredential(), /cline2api 网关地址/);
});

test('cline publisher test connection probes /admin/api/status', async () => {
  const api = loadPublisher();
  let capturedUrl = '';
  const publisher = api.createCline2ApiPublisher({
    completeNodeFromBackground: async () => ({}),
    getState: async () => ({ cline2apiBaseUrl: 'http://x.local', cline2apiAdminToken: 'tok' }),
    fetchImpl: async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  const result = await publisher.testCline2ApiConnection();
  assert.equal(capturedUrl, 'http://x.local/admin/api/status');
  assert.equal(result.ok, true);
});
