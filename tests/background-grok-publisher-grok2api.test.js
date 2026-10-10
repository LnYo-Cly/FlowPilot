const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadPublisherApi() {
  const stateSource = fs.readFileSync('flows/grok/background/state.js', 'utf8');
  const deviceFlowSource = fs.readFileSync('flows/grok/background/sso-device-flow.js', 'utf8');
  const publisherSource = fs.readFileSync('flows/grok/background/publisher-grok2api.js', 'utf8');
  const globalScope = {};
  new Function('self', `${stateSource}; ${deviceFlowSource}; ${publisherSource}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundGrokPublisherGrok2Api;
}

function createTextResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: async () => text,
  };
}

function createJsonResponse(payload, status = 200) {
  return createTextResponse(JSON.stringify(payload), status);
}

function createLoginResponse() {
  return createJsonResponse({
    data: {
      tokens: {
        accessToken: 'test-access-token',
      },
    },
  });
}

function createSseImportResponse({ created = 0, updated = 0, skipped = 0, failed = 0, synced = 0, syncFailed = 0, error = null } = {}) {
  if (error) {
    return createTextResponse(`: connected\n\nevent: error\ndata: ${JSON.stringify(error)}\n\n`);
  }
  return createTextResponse(
    `: connected\n\n`
    + `event: progress\ndata: {"completed":1,"total":1,"phase":"importing"}\n\n`
    + `event: complete\ndata: ${JSON.stringify({ created, updated, skipped, failed, synced, syncFailed })}\n\n`
  );
}

function createFetchImpl({ loginStatus = 200, importResponse = null, onRequest = null } = {}) {
  const requests = [];
  return {
    requests,
    fetch: async (url, options = {}) => {
      const entry = { url, options };
      requests.push(entry);
      if (typeof onRequest === 'function') {
        onRequest(entry);
      }
      if (url.endsWith('/api/admin/v1/auth/login')) {
        return createJsonResponse(
          loginStatus === 200 ? { data: { tokens: { accessToken: 'test-access-token' } } } : { error: { message: '登录失败' } },
          loginStatus
        );
      }
      return importResponse || createSseImportResponse({ created: 1 });
    },
  };
}

function getGrokRuntime(state = {}) {
  return state?.runtimeState?.flowState?.grok || {};
}

function makeJwt(payload = {}) {
  const segment = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${segment({ alg: 'none' })}.${segment(payload)}.sig`;
}

test('grok2api publisher exposes helpers and normalizes v1 endpoint URLs', () => {
  const api = loadPublisherApi();

  assert.equal(typeof api?.createGrok2ApiPublisher, 'function');
  assert.equal(
    api.buildGrok2ApiWebImportUrl('https://grok2api.example.com/admin/deep/path?token=ignored'),
    'https://grok2api.example.com/api/admin/v1/accounts/web/import'
  );
  assert.equal(
    api.buildGrok2ApiLoginUrl('127.0.0.1:8000/admin'),
    'http://127.0.0.1:8000/api/admin/v1/auth/login'
  );
  assert.throws(() => api.buildGrok2ApiWebImportUrl(''), /缺少 grok2api 地址/);
  assert.throws(() => api.buildGrok2ApiWebImportUrl('ftp://example.com'), /只支持 http 或 https/);
});

test('grok2api publisher logs in and uploads sso as web json plus console json', async () => {
  const api = loadPublisherApi();
  const sso = makeJwt({ sub: 'user-123' });
  const { requests, fetch } = createFetchImpl();

  const result = await api.uploadGrokSsoToGrok2Api(
    'https://grok2api.example.com/admin/path',
    { username: 'admin', password: 'pw' },
    sso,
    fetch,
    { email: 'user@example.com', cloudflareCookies: 'cf_clearance=abc123; __cf_bm=xyz' }
  );

  assert.equal(requests.length, 3);
  const [loginReq, webReq, consoleReq] = requests;
  assert.equal(loginReq.url, 'https://grok2api.example.com/api/admin/v1/auth/login');
  assert.deepEqual(JSON.parse(loginReq.options.body), { username: 'admin', password: 'pw' });
  assert.equal(webReq.url, 'https://grok2api.example.com/api/admin/v1/accounts/web/import');
  assert.equal(webReq.options.headers.Authorization, 'Bearer test-access-token');

  const webFile = webReq.options.body.get('files');
  assert.match(webFile.name, /^g2a-web-.*\.json$/);
  const webDoc = JSON.parse(await webFile.text());
  assert.equal(webDoc.provider, 'grok_web');
  assert.equal(webDoc.accounts[0].sso_token, sso);
  assert.equal(webDoc.accounts[0].email, 'user@example.com');
  assert.equal(webDoc.accounts[0].user_id, 'user-123');
  assert.equal(webDoc.accounts[0].name, 'Grok Web user');
  assert.equal(webDoc.accounts[0].tier, 'basic');
  assert.equal(webDoc.accounts[0].token, '');
  assert.equal(webDoc.accounts[0].cloudflare_cookies, '');

  assert.equal(consoleReq.url, 'https://grok2api.example.com/api/admin/v1/accounts/console/import');
  const consoleFile = consoleReq.options.body.get('files');
  const consoleDoc = JSON.parse(await consoleFile.text());
  assert.equal(consoleDoc.provider, 'grok_console');
  assert.equal(consoleDoc.accounts[0].sso_token, sso);
  assert.equal(consoleDoc.accounts[0].email, 'user@example.com');
  assert.equal(consoleDoc.accounts[0].user_id, 'user-123');
  assert.equal(consoleDoc.accounts[0].cloudflare_cookies, '');

  assert.equal(result.endpointUrl, 'https://grok2api.example.com/api/admin/v1/accounts/web/import');
  assert.equal(result.created, 2);
  assert.match(result.message, /web：.*console：/);
});

test('grok2api publisher uploads grok_build auth.json when an oauth token record is provided', async () => {
  const api = loadPublisherApi();
  const { requests, fetch } = createFetchImpl();

  const result = await api.uploadGrokSsoToGrok2Api(
    'http://127.0.0.1:8000',
    { password: 'pw' },
    'sso-token',
    fetch,
    {
      email: 'user@example.com',
      tokenRecord: {
        access_token: makeJwt({ sub: 'grok-user-1', email: 'user@example.com' }),
        refresh_token: 'refresh-token-1',
        id_token: '',
        token_type: 'Bearer',
        expires_in: 3600,
        email: 'user@example.com',
        user_id: 'grok-user-1',
      },
    }
  );

  const buildReq = requests.find((entry) => entry.url.endsWith('/api/admin/v1/accounts/import'));
  assert.ok(buildReq);
  const file = buildReq.options.body.get('file');
  assert.ok(file);
  assert.equal(file.name, 'auth.json');
  const document = JSON.parse(await file.text());
  assert.equal(document.provider, 'grok_build');
  assert.equal(document.client_id, 'b1a00492-073a-47ea-816f-4c329264a828');
  assert.equal(document.email, 'user@example.com');
  assert.equal(document.user_id, 'grok-user-1');
  assert.equal(document.refresh_token, 'refresh-token-1');
  assert.ok(Number.isFinite(Date.parse(document.expires_at)));
  assert.ok(Date.parse(document.expires_at) < Date.now());

  const webReq = requests.find((entry) => entry.url.endsWith('/api/admin/v1/accounts/web/import'));
  const webDoc = JSON.parse(await webReq.options.body.get('files').text());
  assert.equal(webDoc.accounts[0].user_id, 'grok-user-1');

  assert.equal(result.results.length, 3);
  assert.match(result.message, /build：/);
});

test('grok2api publisher treats skipped/updated imports as idempotent success', async () => {
  const api = loadPublisherApi();
  const { fetch } = createFetchImpl({
    importResponse: createSseImportResponse({ created: 0, updated: 0, skipped: 1 }),
  });

  const result = await api.uploadGrokSsoToGrok2Api(
    'http://127.0.0.1:8000',
    { password: 'pw' },
    'sso-token',
    fetch
  );

  assert.equal(result.skipped, 2);
  assert.match(result.message, /跳过 1 个/);
});

test('grok2api publisher requires credentials, sso and a positive import outcome', async () => {
  const api = loadPublisherApi();
  let requestCount = 0;
  const { fetch } = createFetchImpl({ onRequest: () => { requestCount += 1; } });

  await assert.rejects(
    () => api.uploadGrokSsoToGrok2Api('http://127.0.0.1:8000', { password: '' }, 'sso', fetch),
    /缺少 grok2api 管理员密码/
  );
  await assert.rejects(
    () => api.uploadGrokSsoToGrok2Api('http://127.0.0.1:8000', { password: 'pw' }, '', fetch),
    /缺少 Grok SSO Cookie/
  );
  assert.equal(requestCount, 0);

  const { fetch: emptyFetch } = createFetchImpl({
    importResponse: createSseImportResponse({ created: 0, updated: 0, skipped: 0 }),
  });
  await assert.rejects(
    () => api.uploadGrokSsoToGrok2Api('http://127.0.0.1:8000', 'pw', 'sso', emptyFetch),
    /新增 0 个|未导入任何账号/
  );

  const { fetch: errFetch } = createFetchImpl({
    importResponse: createSseImportResponse({ error: { code: 'authImportFailed', message: '导入账号失败' } }),
  });
  await assert.rejects(
    () => api.uploadGrokSsoToGrok2Api('http://127.0.0.1:8000', 'pw', 'sso', errFetch),
    /导入账号失败/
  );
});

test('grok2api publisher surfaces sse error and http error with secrets redacted', async () => {
  const api = loadPublisherApi();

  const { fetch: sseFail } = createFetchImpl({
    importResponse: createSseImportResponse({ error: { message: 'invalid token secret-sso' } }),
  });
  await assert.rejects(
    () => api.uploadGrokSsoToGrok2Api('http://127.0.0.1:8000', { password: 'secret-key' }, 'secret-sso', sseFail),
    (error) => {
      assert.match(error.message, /invalid token \[REDACTED\]/);
      return true;
    }
  );

  const { fetch: httpFail } = createFetchImpl({
    importResponse: createJsonResponse({ error: { message: 'permission denied' } }, 500),
  });
  await assert.rejects(
    () => api.uploadGrokSsoToGrok2Api('http://127.0.0.1:8000', { password: 'secret-key' }, 'secret-sso', httpFail),
    (error) => {
      assert.match(error.message, /permission denied/);
      assert.doesNotMatch(error.message, /secret-sso|secret-key/);
      return true;
    }
  );
});

test('grok2api publisher relogins once when the import rejects the token', async () => {
  const api = loadPublisherApi();
  let loginCount = 0;
  let importCount = 0;
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push(url);
    if (url.endsWith('/api/admin/v1/auth/login')) {
      loginCount += 1;
      return createLoginResponse();
    }
    importCount += 1;
    return importCount === 1
      ? createJsonResponse({ error: { message: 'token expired' } }, 401)
      : createSseImportResponse({ updated: 1 });
  };

  const result = await api.uploadGrokSsoToGrok2Api(
    'http://127.0.0.1:8000',
    { username: 'admin', password: 'pw' },
    'sso-token',
    fetch
  );

  assert.equal(loginCount, 2);
  assert.equal(importCount, 3);
  assert.equal(result.updated, 2);
});

test('grok2api executor reads canonical state and completes with upload runtime', async () => {
  const api = loadPublisherApi();
  const requests = [];
  const logs = [];
  const completed = [];
  let liveState = {
    grok2ApiUrl: 'https://stale.example.com',
    grok2ApiAdminKey: 'stale-key',
    grokSsoCookie: 'stale-sso',
    grokEmail: 'live@example.com',
    settingsState: {
      flows: {
        grok: {
          targets: {
            grok2api: {
              baseUrl: 'https://grok2api.example.com/admin',
              username: 'admin',
              password: 'live-key',
            },
          },
        },
      },
    },
    runtimeState: {
      flowState: {
        grok: {
          sso: { currentCookie: 'live-sso' },
        },
      },
    },
  };
  const publisher = api.createGrok2ApiPublisher({
    addLog: async (message, level) => logs.push({ message, level }),
    completeNodeFromBackground: async (nodeId, payload) => completed.push({ nodeId, payload }),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/api/admin/v1/auth/login')) {
        return createLoginResponse();
      }
      return createSseImportResponse({ skipped: 1 });
    },
    getState: async () => ({ ...liveState }),
    setState: async (updates = {}) => {
      liveState = {
        ...liveState,
        ...updates,
        runtimeState: {
          ...(liveState.runtimeState || {}),
          ...(updates.runtimeState || {}),
          flowState: {
            ...(liveState.runtimeState?.flowState || {}),
            ...(updates.runtimeState?.flowState || {}),
          },
        },
      };
    },
  });

  await publisher.executeGrokUploadSsoToGrok2Api({
    nodeId: 'grok-upload-sso-to-grok2api',
    grok2ApiAdminKey: 'request-stale-key',
    grokSsoCookie: 'request-stale-sso',
  });

  const importReq = requests.find((entry) => entry.url.includes('/accounts/web/import'));
  assert.ok(importReq);
  const file = importReq.options.body.get('files');
  const webDoc = JSON.parse(await file.text());
  assert.equal(webDoc.provider, 'grok_web');
  assert.equal(webDoc.accounts[0].sso_token, 'live-sso');

  const consoleReq = requests.find((entry) => entry.url.includes('/accounts/console/import'));
  assert.ok(consoleReq);
  const consoleDoc = JSON.parse(await consoleReq.options.body.get('files').text());
  assert.equal(consoleDoc.accounts[0].sso_token, 'live-sso');
  assert.equal(consoleDoc.accounts[0].email, 'live@example.com');

  assert.equal(completed.length, 1);
  assert.equal(getGrokRuntime(completed[0].payload).upload.targetId, 'grok2api');
  assert.equal(getGrokRuntime(completed[0].payload).upload.status, 'uploaded');
  assert.equal(
    getGrokRuntime(completed[0].payload).upload.targetUrl,
    'https://grok2api.example.com/api/admin/v1/accounts/web/import'
  );
  const completedRuntime = getGrokRuntime(completed[0].payload);
  const serialized = JSON.stringify({
    logs,
    upload: completedRuntime.upload,
    lastError: completedRuntime.session?.lastError,
  });
  assert.doesNotMatch(serialized, /live-sso|live-key|request-stale-sso|request-stale-key/);
});

test('grok2api executor persists a redacted failure without completing the node', async () => {
  const api = loadPublisherApi();
  const logs = [];
  const completed = [];
  let liveState = {
    settingsState: {
      flows: {
        grok: {
          targets: {
            grok2api: {
              baseUrl: 'https://grok2api.example.com',
              password: 'secret-key',
            },
          },
        },
      },
    },
    runtimeState: {
      flowState: {
        grok: {
          sso: { currentCookie: 'secret-sso' },
        },
      },
    },
  };
  const publisher = api.createGrok2ApiPublisher({
    addLog: async (message, level) => logs.push({ message, level }),
    completeNodeFromBackground: async (nodeId, payload) => completed.push({ nodeId, payload }),
    fetchImpl: async (url) => {
      if (url.endsWith('/api/admin/v1/auth/login')) {
        return createLoginResponse();
      }
      return createJsonResponse({
        error: { message: 'rejected secret-sso with secret-key' },
      }, 422);
    },
    getState: async () => ({ ...liveState }),
    setState: async (updates = {}) => {
      liveState = {
        ...liveState,
        ...updates,
        runtimeState: {
          ...(liveState.runtimeState || {}),
          ...(updates.runtimeState || {}),
          flowState: {
            ...(liveState.runtimeState?.flowState || {}),
            ...(updates.runtimeState?.flowState || {}),
          },
        },
      };
    },
  });

  await assert.rejects(
    () => publisher.executeGrokUploadSsoToGrok2Api({ nodeId: 'grok-upload-sso-to-grok2api' }),
    /rejected \[REDACTED\] with \[REDACTED\]/
  );

  assert.equal(completed.length, 0);
  assert.equal(getGrokRuntime(liveState).upload.targetId, 'grok2api');
  assert.equal(getGrokRuntime(liveState).upload.status, 'error');
  assert.match(getGrokRuntime(liveState).upload.message, /\[REDACTED\]/);
  const failedRuntime = getGrokRuntime(liveState);
  const serialized = JSON.stringify({
    logs,
    upload: failedRuntime.upload,
    lastError: failedRuntime.session?.lastError,
  });
  assert.doesNotMatch(serialized, /secret-sso|secret-key/);
});
