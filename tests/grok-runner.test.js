const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadGrokRunnerApi() {
  const source = fs.readFileSync('flows/grok/background/register-runner.js', 'utf8');
  const globalScope = {};
  return new Function('self', `${source}; return self.MultiPageBackgroundGrokRegisterRunner;`)(globalScope);
}

function getGrokRuntime(state = {}) {
  return state?.runtimeState?.flowState?.grok || {};
}

test('grok runner delegates verification polling to the shared flow mail service', () => {
  const source = fs.readFileSync('flows/grok/background/register-runner.js', 'utf8');
  assert.match(source, /pollFlowVerificationCode/);
  assert.doesNotMatch(source, /buildGrokVerificationPollPayload/);
  assert.doesNotMatch(source, /pollHotmailVerificationCode/);
  assert.doesNotMatch(source, /pollLuckmailVerificationCode/);
  assert.doesNotMatch(source, /pollCloudflareTempEmailVerificationCode/);
  assert.doesNotMatch(source, /pollCloudMailVerificationCode/);
  assert.doesNotMatch(source, /pollYydsMailVerificationCode/);
  assert.doesNotMatch(source, /sendToMailContentScriptResilient/);
});

test('grok content script does not patch global MouseEvent prototypes', () => {
  const source = fs.readFileSync('flows/grok/content/register-page.js', 'utf8');
  assert.doesNotMatch(source, /MouseEvent\.prototype/);
  assert.doesNotMatch(source, /Object\.defineProperty\(MouseEvent/);
  assert.match(source, /screenX:/);
  assert.match(source, /screenY:/);
});

test('grok profile submission waits for human verification success before clicking complete', () => {
  const source = fs.readFileSync('flows/grok/content/register-page.js', 'utf8');
  const profileIndex = source.indexOf('async function submitGrokProfile');
  const waitIndex = source.indexOf('await waitForGrokHumanVerificationSuccess()', profileIndex);
  const buttonIndex = source.indexOf('const button = findGrokSubmitButton()', profileIndex);
  const clickIndex = source.indexOf('simulateGrokClick(button)', profileIndex);

  assert.notEqual(profileIndex, -1);
  assert.notEqual(waitIndex, -1);
  assert.notEqual(buttonIndex, -1);
  assert.notEqual(clickIndex, -1);
  assert.ok(waitIndex < buttonIndex);
  assert.ok(buttonIndex < clickIndex);
  assert.match(source, /input\[name="cf-turnstile-response"\]/);
  assert.match(source, /GROK_HUMAN_VERIFICATION_SUCCESS_TIMEOUT_MS = 5 \* 60 \* 1000/);
  assert.match(source, /人机验证等待已达到 5 分钟/);
});

test('grok profile runner submits once and waits for registration success', async () => {
  const api = loadGrokRunnerApi();
  const directSendCalls = [];
  const resilientSendCalls = [];
  const sleepCalls = [];
  let cookieReadCount = 0;
  let completedPayload = null;
  let currentState = {
    activeFlowId: 'grok',
    grokRegisterTabId: 303,
    runtimeState: {
      flowState: {
        grok: {
          session: {
            registerTabId: 303,
          },
        },
      },
    },
  };
  const runner = api.createGrokRegisterRunner({
    addLog: async () => {},
    chrome: {
      cookies: {
        get: async () => {
          cookieReadCount += 1;
          return cookieReadCount >= 4 ? { value: 'registration-cookie' } : null;
        },
      },
      tabs: {
        get: async (tabId) => ({ id: tabId }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async (_nodeId, payload) => {
      completedPayload = payload;
    },
    ensureContentScriptReadyOnTab: async () => {},
    generatePassword: () => 'StrongPassword123!',
    generateRandomName: () => ({ firstName: 'Alex', lastName: 'Morgan' }),
    getState: async () => currentState,
    getTabId: async () => 303,
    isTabAlive: async () => true,
    registerTab: async () => {},
    sendToContentScript: async (_sourceId, message, options = {}) => {
      directSendCalls.push({ message, options });
      return {
        submitted: true,
        state: 'profile_submitted',
        humanVerification: 'turnstile_response',
        url: 'https://accounts.x.ai/sign-up',
      };
    },
    sendToContentScriptResilient: async (_sourceId, message, options = {}) => {
      resilientSendCalls.push({ message, options });
      if (message.nodeId === 'grok-submit-profile') {
        throw new Error('profile submission must not use retrying transport');
      }
      return { state: 'profile_entry', url: 'https://accounts.x.ai/sign-up' };
    },
    setPasswordState: async () => {},
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    sleepWithStop: async (ms) => {
      sleepCalls.push(ms);
    },
    waitForTabStableComplete: async () => {},
  });

  await runner.executeGrokSubmitProfile({ nodeId: 'grok-submit-profile', ...currentState });

  const profileSubmitCall = directSendCalls.find(({ message }) => message.nodeId === 'grok-submit-profile');
  assert.equal(directSendCalls.length, 1);
  assert.equal(resilientSendCalls.some(({ message }) => message.nodeId === 'grok-submit-profile'), false);
  assert.equal(profileSubmitCall.options.timeoutMs, api.GROK_PROFILE_SUBMIT_COMMAND_TIMEOUT_MS);
  assert.equal(profileSubmitCall.options.timeoutMs, 330 * 1000);
  assert.equal(profileSubmitCall.options.responseTimeoutMs, api.GROK_PROFILE_SUBMIT_COMMAND_TIMEOUT_MS);
  assert.equal(cookieReadCount, 4);
  // sso×3 个域读取为空后，第 4 次读取（sso-rw 兜底）命中 → 首轮轮询即成功，无间隔 sleep。
  assert.deepEqual(sleepCalls, [60 * 1000]);
  assert.equal(completedPayload.grokPageState, 'signed_in');
  assert.match(profileSubmitCall.options.logMessage, /等待人机验证成功/);
  const runnerSource = fs.readFileSync('flows/grok/background/register-runner.js', 'utf8');
  assert.match(runnerSource, /GROK_PROFILE_WAIT_LOG_INTERVAL_MS = 60 \* 1000/);
  assert.match(runnerSource, /不会重复填写注册资料/);
});

test('grok verification runner polls by flow node and submits normalized code', async () => {
  const api = loadGrokRunnerApi();
  const calls = [];
  let completedPayload = null;
  let currentState = {
    activeFlowId: 'grok',
    mailProvider: '2925',
    grokRegisterTabId: 101,
    grokEmail: 'grok-user@example.com',
    grokVerificationRequestedAt: 1000000,
    runtimeState: {
      flowState: {
        grok: {
          session: {
            registerTabId: 101,
          },
          register: {
            email: 'grok-user@example.com',
            verificationRequestedAt: 1000000,
          },
        },
      },
    },
  };
  const runner = api.createGrokRegisterRunner({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async (tabId) => ({ id: tabId }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async (_nodeId, payload) => {
      completedPayload = payload;
    },
    ensureContentScriptReadyOnTab: async () => {},
    getState: async () => currentState,
    getTabId: async () => 101,
    isTabAlive: async () => true,
    pollFlowVerificationCode: async (options) => {
      calls.push({ type: 'poll', options });
      return { code: 'ABC-123', messageId: 'mail-001' };
    },
    registerTab: async () => {},
    sendToContentScriptResilient: async (sourceId, message) => {
      calls.push({ type: 'send', sourceId, message });
      if (message.nodeId === 'GET_PAGE_STATE') {
        return { submitted: true, state: 'verification_code_entry', url: 'https://accounts.x.ai/verify' };
      }
      return { submitted: true, state: 'profile_entry', url: 'https://accounts.x.ai/profile' };
    },
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    waitForTabStableComplete: async () => {},
  });

  await runner.executeGrokSubmitVerificationCode({ nodeId: 'grok-submit-verification-code', ...currentState });

  const pollCall = calls.find((entry) => entry.type === 'poll');
  assert.equal(pollCall.options.flowId, 'grok');
  assert.equal(pollCall.options.nodeId, 'grok-submit-verification-code');
  assert.equal(pollCall.options.step, 3);
  assert.equal(pollCall.options.logStep, 3);
  assert.equal(pollCall.options.filterAfterTimestamp, 400000);
  assert.equal(pollCall.options.state.activeFlowId, 'grok');
  assert.equal(pollCall.options.state.visibleStep, 3);

  const sendCall = calls.find((entry) => (
    entry.type === 'send' && entry.message.nodeId === 'grok-submit-verification-code'
  ));
  assert.equal(sendCall.sourceId, 'grok-register-page');
  assert.equal(sendCall.message.type, 'EXECUTE_NODE');
  assert.equal(sendCall.message.nodeId, 'grok-submit-verification-code');
  assert.deepEqual(sendCall.message.payload, { code: 'ABC123' });

  assert.equal(completedPayload.grokVerificationCode, 'ABC123');
  assert.equal(completedPayload.grokVerificationRawCode, 'ABC-123');
  assert.equal(completedPayload.grokVerificationMessageId, 'mail-001');
  assert.equal(getGrokRuntime(completedPayload).register.verificationCode, 'ABC123');
  assert.equal(getGrokRuntime(completedPayload).register.status, 'verified');
});

test('grok verification runner waits for verification page before polling mail', async () => {
  const api = loadGrokRunnerApi();
  let pollCalled = false;
  let currentState = {
    activeFlowId: 'grok',
    grokRegisterTabId: 102,
    grokEmail: 'grok-user@example.com',
    grokVerificationRequestedAt: 1000000,
    runtimeState: {
      flowState: {
        grok: {
          session: {
            registerTabId: 102,
          },
          register: {
            email: 'grok-user@example.com',
            verificationRequestedAt: 1000000,
          },
        },
      },
    },
  };
  const originalDateNow = Date.now;
  let fakeNow = 1000000;
  const runner = api.createGrokRegisterRunner({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async (tabId) => ({ id: tabId }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTab: async () => {},
    getState: async () => currentState,
    getTabId: async () => 102,
    isTabAlive: async () => true,
    pollFlowVerificationCode: async () => {
      pollCalled = true;
      return { code: 'ABC-123', messageId: 'mail-001' };
    },
    registerTab: async () => {},
    sendToContentScriptResilient: async (_sourceId, message) => {
      if (message.nodeId === 'GET_PAGE_STATE') {
        return { submitted: true, state: 'email_entry', url: 'https://accounts.x.ai/sign-up' };
      }
      return { submitted: true, state: 'profile_entry', url: 'https://accounts.x.ai/profile' };
    },
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    sleepWithStop: async (ms = 0) => {
      fakeNow += Number(ms) || 1000;
    },
    waitForTabStableComplete: async () => {},
  });

  Date.now = () => fakeNow;
  try {
    await assert.rejects(
      () => runner.executeGrokSubmitVerificationCode({ nodeId: 'grok-submit-verification-code', ...currentState }),
      /尚未进入验证码页面/
    );
  } finally {
    Date.now = originalDateNow;
  }
  assert.equal(pollCalled, false);
});

test('grok SSO extraction stores only the current cookie without logging the secret value', async () => {
  const api = loadGrokRunnerApi();
  const logs = [];
  let completedPayload = null;
  let markUsedPayload = null;
  let currentState = {
    activeFlowId: 'grok',
    grokRegisterTabId: 202,
    grokSsoCookies: ['old-cookie'],
    runtimeState: {
      flowState: {
        grok: {
          session: {
            registerTabId: 202,
          },
          sso: {
            cookies: ['old-cookie'],
          },
          upload: {
            targetId: 'sub2api',
            status: 'uploaded',
            uploadedAt: 1000,
            message: 'old upload',
            targetUrl: 'https://old.example.com/api/remote-account/inject',
          },
        },
      },
    },
  };
  const runner = api.createGrokRegisterRunner({
    addLog: async (message, level) => {
      logs.push({ message, level });
    },
    chrome: {
      cookies: {
        get: async () => ({ value: 'new-cookie' }),
      },
      tabs: {
        get: async (tabId) => ({ id: tabId }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async (_nodeId, payload) => {
      completedPayload = payload;
    },
    ensureContentScriptReadyOnTab: async () => {},
    getState: async () => currentState,
    getTabId: async () => 202,
    isTabAlive: async () => true,
    markCurrentRegistrationAccountUsed: async (state) => {
      markUsedPayload = state;
    },
    registerTab: async () => {},
    sendToContentScriptResilient: async () => {
      throw new Error('content fallback should not be used when chrome.cookies finds sso');
    },
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    sleepWithStop: async () => {},
    waitForTabStableComplete: async () => {},
  });

  await runner.executeGrokExtractSsoCookie({ nodeId: 'grok-extract-sso-cookie', ...currentState });

  assert.equal(completedPayload.grokSsoCookie, 'new-cookie');
  assert.deepEqual(completedPayload.grokSsoCookies, ['new-cookie']);
  assert.equal(completedPayload.grokWebchat2ApiUploadStatus, '');
  assert.equal(getGrokRuntime(completedPayload).sso.currentCookie, 'new-cookie');
  assert.deepEqual(getGrokRuntime(completedPayload).sso.cookies, ['new-cookie']);
  assert.equal(getGrokRuntime(completedPayload).upload.status, '');
  assert.equal(getGrokRuntime(completedPayload).upload.targetId, '');
  assert.equal(getGrokRuntime(completedPayload).upload.targetUrl, '');
  assert.equal(markUsedPayload.grokSsoCookie, 'new-cookie');
  assert.equal(logs.some(({ message }) => message.includes('new-cookie')), false);
});

test('grok sso read scans every cookie store so incognito sso is found', async () => {
  const api = loadGrokRunnerApi();
  const getCalls = [];
  let completedPayload = null;
  let currentState = {
    activeFlowId: 'grok',
    grokRegisterTabId: 404,
    runtimeState: {
      flowState: {
        grok: { session: { registerTabId: 404 } },
      },
    },
  };
  const runner = api.createGrokRegisterRunner({
    addLog: async () => {},
    chrome: {
      cookies: {
        getAllCookieStores: async () => [{ id: '0' }, { id: '1' }],
        get: async (details) => {
          getCalls.push(details);
          // sso 只存在于无痕 store（id=1）
          return details.storeId === '1' && details.name === 'sso'
            ? { value: 'incognito-sso' }
            : null;
        },
      },
      tabs: {
        get: async (tabId) => ({ id: tabId }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async (_nodeId, payload) => {
      completedPayload = payload;
    },
    ensureContentScriptReadyOnTab: async () => {},
    generatePassword: () => 'StrongPassword123!',
    generateRandomName: () => ({ firstName: 'Alex', lastName: 'Morgan' }),
    getState: async () => currentState,
    getTabId: async () => 404,
    isTabAlive: async () => true,
    registerTab: async () => {},
    sendToContentScript: async () => ({ submitted: true, state: 'profile_submitted' }),
    sendToContentScriptResilient: async () => ({ state: 'tos_gate' }),
    setPasswordState: async () => {},
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    sleepWithStop: async () => {},
    waitForTabStableComplete: async () => {},
  });

  await runner.executeGrokSubmitProfile({ nodeId: 'grok-submit-profile', ...currentState });

  assert.equal(completedPayload.grokPageState, 'signed_in');
  assert.ok(getCalls.some((call) => call.storeId === '1'), 'expected a cookie read against the incognito store');
  assert.ok(getCalls.every((call) => ['sso', 'sso-rw'].includes(call.name)));
});

test('grok registration wait auto-dismisses the tos gate page', async () => {
  const api = loadGrokRunnerApi();
  const sentCommands = [];
  const logs = [];
  let cookieReads = 0;
  let completedPayload = null;
  let currentState = {
    activeFlowId: 'grok',
    grokRegisterTabId: 505,
    runtimeState: {
      flowState: {
        grok: { session: { registerTabId: 505 } },
      },
    },
  };
  const runner = api.createGrokRegisterRunner({
    addLog: async (message, level) => {
      logs.push({ message, level });
    },
    chrome: {
      cookies: {
        get: async () => {
          cookieReads += 1;
          // 前 6 次读取为空（第一轮 sso×3 + sso-rw×3），之后返回 sso
          return cookieReads > 6 ? { value: 'late-sso' } : null;
        },
      },
      tabs: {
        get: async (tabId) => ({ id: tabId }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async (_nodeId, payload) => {
      completedPayload = payload;
    },
    ensureContentScriptReadyOnTab: async () => {},
    generatePassword: () => 'StrongPassword123!',
    generateRandomName: () => ({ firstName: 'Alex', lastName: 'Morgan' }),
    getState: async () => currentState,
    getTabId: async () => 505,
    isTabAlive: async () => true,
    registerTab: async () => {},
    sendToContentScript: async (_sourceId, message) => {
      sentCommands.push(message.nodeId);
      return { submitted: true, state: 'profile_submitted' };
    },
    sendToContentScriptResilient: async (_sourceId, message) => {
      sentCommands.push(message.nodeId);
      if (message.nodeId === 'GET_PAGE_STATE') {
        return { state: 'tos_gate', url: 'https://grok.com/tos_gate' };
      }
      if (message.nodeId === 'grok-dismiss-tos-gate') {
        return { dismissed: true, clicked: ['知道了'], state: 'unknown' };
      }
      return { state: 'unknown' };
    },
    setPasswordState: async () => {},
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    sleepWithStop: async () => {},
    waitForTabStableComplete: async () => {},
  });

  await runner.executeGrokSubmitProfile({ nodeId: 'grok-submit-profile', ...currentState });

  assert.ok(sentCommands.includes('grok-dismiss-tos-gate'));
  assert.equal(completedPayload.grokPageState, 'signed_in');
  assert.ok(logs.some(({ message }) => message.includes('服务条款更新页')));
});

test('grok register runner requires background node completion dependency', () => {
  const api = loadGrokRunnerApi();
  assert.throws(
    () => api.createGrokRegisterRunner({}),
    /requires completeNodeFromBackground/
  );
});
