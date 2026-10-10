const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadDeviceFlowApi() {
  const source = fs.readFileSync('flows/grok/background/sso-device-flow.js', 'utf8');
  const globalScope = {};
  new Function('self', `${source}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundGrokSsoDeviceFlow;
}

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: async () => JSON.stringify(payload),
  };
}

function makeJwt(payload = {}) {
  const segment = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${segment({ alg: 'none' })}.${segment(payload)}.sig`;
}

test('requestDeviceCode posts form fields and normalizes the verification url', async () => {
  const api = loadDeviceFlowApi();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return createJsonResponse({
      device_code: 'dev-1',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://auth.x.ai/oauth2/device/verify',
      interval: 5,
      expires_in: 1800,
    });
  };

  const result = await api.requestDeviceCode(fetchImpl);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://auth.x.ai/oauth2/device/code');
  assert.match(requests[0].options.body, /client_id=b1a00492-073a-47ea-816f-4c329264a828/);
  assert.match(requests[0].options.body, /scope=openid/);
  assert.match(requests[0].options.body, /grok-cli%3Aaccess/);
  assert.equal(result.deviceCode, 'dev-1');
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(
    result.verificationUrl,
    'https://auth.x.ai/oauth2/device/verify?user_code=ABCD-EFGH'
  );
});

test('pollDeviceToken waits through authorization_pending then returns the token', async () => {
  const api = loadDeviceFlowApi();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) {
      return createJsonResponse({ error: 'authorization_pending' }, 400);
    }
    return createJsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', id_token: 'idt-1', expires_in: 3600 });
  };

  const token = await api.pollDeviceToken(fetchImpl, { deviceCode: 'dev-1', intervalMs: 5, timeoutMs: 5000 });
  assert.equal(token.access_token, 'at-1');
  assert.equal(calls, 3);
});

test('pollDeviceToken rejects invalid_grant and times out on pending', async () => {
  const api = loadDeviceFlowApi();
  await assert.rejects(
    () => api.pollDeviceToken(async () => createJsonResponse({ error: 'invalid_grant', error_description: 'Access denied' }, 400), { deviceCode: 'd', timeoutMs: 1000 }),
    /Access denied|拒绝/
  );
  await assert.rejects(
    () => api.pollDeviceToken(async () => createJsonResponse({ error: 'authorization_pending' }, 400), { deviceCode: 'd', intervalMs: 5, timeoutMs: 50 }),
    /超时/
  );
});

test('normalizeTokenRecord resolves email/user_id from jwt payloads and sso fallback', () => {
  const api = loadDeviceFlowApi();
  const access = makeJwt({ sub: 'principal-1', email: 'acct@x.com', team_id: 'team-9' });
  const record = api.normalizeTokenRecord(
    { access_token: access, refresh_token: 'rt', id_token: '', expires_in: 100 },
    { ssoCookie: makeJwt({ principal_id: 'sso-principal' }), email: 'fallback@x.com' }
  );
  assert.equal(record.email, 'acct@x.com');
  assert.equal(record.user_id, 'principal-1');
  assert.equal(record.team_id, 'team-9');

  const ssoOnly = api.resolvePrincipalIdFromSso(makeJwt({ principal_id: 'sso-principal' }));
  assert.equal(ssoOnly, 'sso-principal');
});

test('buildGrok2ApiBuildImportDocument expires immediately when refresh_token exists', () => {
  const api = loadDeviceFlowApi();
  const document = api.buildGrok2ApiBuildImportDocument({
    access_token: 'at',
    refresh_token: 'rt',
    id_token: '',
    token_type: 'Bearer',
    email: 'u@x.com',
    user_id: 'u-1',
    team_id: 't-1',
  });
  assert.equal(document.provider, 'grok_build');
  assert.equal(document.name, 'u@x.com');
  assert.equal(document.email, 'u@x.com');
  assert.equal(document.user_id, 'u-1');
  assert.ok(Date.parse(document.expires_at) < Date.now());
  assert.throws(() => api.buildGrok2ApiBuildImportDocument({}), /access_token\/refresh_token/);
});
