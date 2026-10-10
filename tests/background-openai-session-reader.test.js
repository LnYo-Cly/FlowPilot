const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadSessionReaderApi() {
  const source = fs.readFileSync('flows/openai/background/session-reader.js', 'utf8');
  const globalScope = {};
  new Function('self', `${source}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundOpenAiSessionReader;
}

function createReaderHarness(api, options = {}) {
  const sessionTab = options.sessionTab || {
    id: 77,
    windowId: 42,
    url: 'https://chatgpt.com/?model=gpt-4o',
    active: true,
    currentWindow: true,
    lastAccessed: 1234,
  };
  const ensureCalls = [];
  const getTabIdCalls = [];
  const queryCalls = [];
  const registerCalls = [];
  const reloadCalls = [];
  const sentMessages = [];
  const sleepCalls = [];
  const logCalls = [];
  let sendCount = 0;
  let currentTab = sessionTab;

  const reader = api.createOpenAiSessionReader({
    addLog: async (message, level = 'info') => {
      logCalls.push({ message, level });
    },
    chrome: {
      tabs: {
        get: async (tabId) => {
          if (typeof options.getTab === 'function') {
            return options.getTab(tabId, currentTab);
          }
          return currentTab?.id === tabId ? { ...currentTab } : null;
        },
        query: async (queryInfo = {}) => {
          queryCalls.push(queryInfo);
          if (typeof options.queryTabs === 'function') {
            return options.queryTabs(queryInfo, currentTab);
          }
          return currentTab ? [{ ...currentTab }] : [];
        },
        update: async () => {},
        reload: async (tabId) => {
          reloadCalls.push(tabId);
          if (typeof options.onReload === 'function') {
            await options.onReload(tabId);
          }
        },
      },
    },
    ensureContentScriptReadyOnTabUntilStopped: async (source, tabId, injectOptions = {}) => {
      ensureCalls.push({ source, tabId, options: injectOptions });
    },
    getTabId: async (source) => {
      getTabIdCalls.push(source);
      return options.registeredTabId ?? null;
    },
    getStepIdByKeyForState: options.getStepIdByKeyForState || (() => 10),
    isTabAlive: async () => options.registeredTabAlive ?? false,
    registerTab: async (source, tabId) => registerCalls.push({ source, tabId }),
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      sentMessages.push({ tabId, source, message });
      sendCount += 1;
      if (typeof options.sendResult === 'function') {
        return options.sendResult(sendCount, {
          closeTab() {
            currentTab = null;
          },
          setTabUrl(url) {
            currentTab = currentTab ? { ...currentTab, url } : null;
          },
        });
      }
      return options.sendResult || {
        ok: true,
        session: {
          accessToken: 'session-access-token',
          user: { email: 'flow@example.com' },
        },
        accessToken: 'session-access-token',
      };
    },
    sleepWithStop: async (duration) => {
      sleepCalls.push(duration);
      if (typeof options.onSleep === 'function') {
        await options.onSleep(duration);
      }
    },
    waitForTabCompleteUntilStopped: async () => {},
  });

  return {
    ensureCalls,
    getTabIdCalls,
    logCalls,
    queryCalls,
    reader,
    registerCalls,
    reloadCalls,
    sentMessages,
    sleepCalls,
  };
}

test('OpenAI session reader recognizes only pages that can expose ChatGPT session', () => {
  const api = loadSessionReaderApi();

  assert.equal(api.isSupportedChatGptSessionUrl('https://chatgpt.com/?model=gpt-4o'), true);
  assert.equal(api.isSupportedChatGptSessionUrl('https://www.chatgpt.com/c/abc'), true);
  assert.equal(api.isSupportedChatGptSessionUrl('https://chat.openai.com/'), true);
  assert.equal(api.isSupportedChatGptSessionUrl('https://auth.openai.com/authorize'), false);
  assert.equal(api.isSupportedChatGptSessionUrl('https://platform.openai.com/settings/profile'), false);
  assert.equal(api.isSupportedChatGptSessionUrl('https://chatgpt.com.example.com/'), false);
  assert.equal(api.isSupportedChatGptSessionUrl('chrome://extensions'), false);
});

test('OpenAI session reader prefers active chatgpt tab before legacy chat.openai tab', () => {
  const api = loadSessionReaderApi();
  const picked = api.pickPreferredSessionTab([
    { id: 3, url: 'https://chat.openai.com/', active: true, currentWindow: true, lastAccessed: 999 },
    { id: 8, url: 'https://chatgpt.com/?model=gpt-4o', active: false, currentWindow: false, lastAccessed: 1 },
    { id: 9, url: 'https://example.com', active: true, currentWindow: true, lastAccessed: 1000 },
  ]);

  assert.equal(picked.id, 8);
});

test('OpenAI session reader falls back without a window lock and uses the generic protocol', async () => {
  const api = loadSessionReaderApi();
  const harness = createReaderHarness(api);

  const result = await harness.reader.readCurrentSessionFromState({}, {
    visibleStep: 12,
    targetLabel: 'webchat',
    requiredFields: ['session'],
  });

  assert.equal(result.tabId, 77);
  assert.equal(result.session.user.email, 'flow@example.com');
  assert.deepEqual(harness.getTabIdCalls, ['openai-session']);
  assert.deepEqual(harness.queryCalls, [
    { active: true, currentWindow: true },
    {},
  ]);
  assert.deepEqual(harness.registerCalls, [{ source: 'openai-session', tabId: 77 }]);
  assert.deepEqual(harness.sleepCalls, [1000]);
  assert.deepEqual(harness.ensureCalls[0], {
    source: 'openai-session',
    tabId: 77,
    options: {
      inject: [
        'content/utils.js',
        'flows/openai/content/chatgpt-session.js',
      ],
      injectSource: 'openai-session',
      logMessage: '步骤 12：正在等待 ChatGPT 会话页面完成加载，再继续读取当前登录会话...',
    },
  });
  assert.deepEqual(harness.sentMessages, [{
    tabId: 77,
    source: 'openai-session',
    message: {
      type: 'OPENAI_SESSION_GET_CURRENT',
      source: 'background',
    },
  }]);
});

test('OpenAI session reader resolves a missing visible step from the current workflow node', async () => {
  const api = loadSessionReaderApi();
  const stepResolutionCalls = [];
  const state = { nodeId: 'cpa-session-import', targetId: 'cpa' };
  const harness = createReaderHarness(api, {
    getStepIdByKeyForState: (stepKey, currentState) => {
      stepResolutionCalls.push({ stepKey, state: currentState });
      return 7;
    },
  });

  await harness.reader.readCurrentSessionFromState(state, {
    targetLabel: 'CPA',
    requiredFields: ['session'],
  });

  assert.deepEqual(stepResolutionCalls, [{ stepKey: 'cpa-session-import', state }]);
  assert.equal(
    harness.ensureCalls[0].options.logMessage,
    '步骤 7：正在等待 ChatGPT 会话页面完成加载，再继续读取当前登录会话...'
  );
});

test('background injects dynamic workflow step resolution into every OpenAI session delivery factory', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  const factoryMarkers = [
    'createSub2ApiSessionImportExecutor({',
    'createSub2ApiAgentIdentityImportExecutor({',
    'createCpaSessionImportExecutor({',
    'createOpenAiWebchatPublisher({',
    'createOpenAiChatgpt2ApiPublisher({',
  ];

  for (const marker of factoryMarkers) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `missing factory wiring: ${marker}`);
    const end = source.indexOf('\n});', start);
    assert.notEqual(end, -1, `unterminated factory wiring: ${marker}`);
    assert.match(source.slice(start, end), /\bgetStepIdByKeyForState\b/, marker);
  }
});

test('OpenAI session reader keeps registered and fallback tabs inside the automation window', async () => {
  const api = loadSessionReaderApi();
  const lockedTab = {
    id: 77,
    windowId: 42,
    url: 'https://chatgpt.com/c/locked',
    active: false,
    lastAccessed: 50,
  };
  const getCalls = [];
  const harness = createReaderHarness(api, {
    registeredTabId: 91,
    registeredTabAlive: true,
    getTab(tabId) {
      getCalls.push(tabId);
      if (tabId === 91) {
        return {
          id: 91,
          windowId: 7,
          url: 'https://chatgpt.com/c/wrong-window',
        };
      }
      return tabId === 77 ? lockedTab : null;
    },
    queryTabs(queryInfo) {
      assert.deepEqual(queryInfo, { windowId: 42 });
      return [lockedTab];
    },
  });

  const result = await harness.reader.readCurrentSessionFromState({
    automationWindowId: 42,
    plusCheckoutTabId: 333,
  }, {
    visibleStep: 10,
    requiredFields: ['session'],
  });

  assert.equal(result.tabId, 77);
  assert.deepEqual(harness.queryCalls, [{ windowId: 42 }]);
  assert.deepEqual(harness.registerCalls, [{ source: 'openai-session', tabId: 77 }]);
  assert.equal(getCalls.includes(333), false);
});

test('OpenAI session reader retries only missing required fields up to eleven reads', async () => {
  const api = loadSessionReaderApi();
  const harness = createReaderHarness(api, {
    registeredTabId: 77,
    registeredTabAlive: true,
    sendResult: {
      ok: true,
      session: { user: { email: 'flow@example.com' } },
      accessToken: '',
    },
  });

  await assert.rejects(
    () => harness.reader.readCurrentSessionFromState({}, {
      visibleStep: 10,
      targetLabel: 'ChatGPT2API',
      requiredFields: ['accessToken'],
    }),
    /连续读取 11 次.*accessToken/
  );

  assert.equal(harness.sentMessages.length, 11);
  assert.deepEqual(harness.sleepCalls, [1000, ...Array(10).fill(2000)]);
  assert.equal(harness.ensureCalls.length, 1);
});

test('OpenAI session reader reloads the tab once on HTTP 403 then retries', async () => {
  const api = loadSessionReaderApi();
  const harness = createReaderHarness(api, {
    registeredTabId: 77,
    registeredTabAlive: true,
    sendResult(attempt) {
      if (attempt === 1) {
        return { ok: false, error: '读取 ChatGPT 会话失败：HTTP 403', status: 403 };
      }
      return {
        ok: true,
        session: { user: { email: 'flow@example.com' } },
        accessToken: 'session-access-token',
      };
    },
  });

  const result = await harness.reader.readCurrentSessionFromState({}, {
    visibleStep: 7,
    targetLabel: 'ChatGPT2API',
    requiredFields: ['session'],
  });

  assert.equal(result.session.user.email, 'flow@example.com');
  assert.deepEqual(harness.reloadCalls, [77]);
  assert.equal(harness.sentMessages.length, 2);
  assert.equal(harness.ensureCalls.length, 2);
  assert.ok(
    harness.logCalls.some(({ message }) => /403/.test(message) && /刷新/.test(message)),
    'expected a log line describing the 403 reload',
  );
});

test('OpenAI session reader does not reload twice for persistent 403', async () => {
  const api = loadSessionReaderApi();
  const harness = createReaderHarness(api, {
    registeredTabId: 77,
    registeredTabAlive: true,
    sendResult: { ok: false, error: '读取 ChatGPT 会话失败：HTTP 403', status: 403 },
  });

  await assert.rejects(
    () => harness.reader.readCurrentSessionFromState({}, {
      visibleStep: 7,
      requiredFields: ['session'],
    }),
    /HTTP 403/
  );

  assert.deepEqual(harness.reloadCalls, [77]);
  assert.equal(harness.sentMessages.length, 2);
});

test('OpenAI session reader does not retry protocol errors', async () => {
  const api = loadSessionReaderApi();
  const harness = createReaderHarness(api, {
    registeredTabId: 77,
    registeredTabAlive: true,
    sendResult: {
      ok: false,
      error: 'session endpoint returned HTTP 503',
    },
  });

  await assert.rejects(
    () => harness.reader.readCurrentSessionFromState({}, {
      requiredFields: ['session'],
    }),
    /HTTP 503/
  );

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sleepCalls, [1000]);
});

test('OpenAI session reader stops retrying when the tab closes or changes to an unsupported URL', async (t) => {
  const api = loadSessionReaderApi();

  await t.test('tab closed', async () => {
    const harness = createReaderHarness(api, {
      registeredTabId: 77,
      registeredTabAlive: true,
      sendResult(_attempt, controls) {
        controls.closeTab();
        return { ok: true, session: null, accessToken: '' };
      },
    });

    await assert.rejects(
      () => harness.reader.readCurrentSessionFromState({}, { requiredFields: ['session'] }),
      /标签页不存在.*已关闭/
    );
    assert.equal(harness.sentMessages.length, 1);
  });

  await t.test('unsupported URL', async () => {
    const harness = createReaderHarness(api, {
      registeredTabId: 77,
      registeredTabAlive: true,
      sendResult(_attempt, controls) {
        controls.setTabUrl('https://example.com/left-chatgpt');
        return { ok: true, session: null, accessToken: '' };
      },
    });

    await assert.rejects(
      () => harness.reader.readCurrentSessionFromState({}, { requiredFields: ['session'] }),
      /不在可读取 ChatGPT 会话的页面/
    );
    assert.equal(harness.sentMessages.length, 1);
  });
});

test('OpenAI session reader rejects invalid required field configuration before reading', async () => {
  const api = loadSessionReaderApi();
  const harness = createReaderHarness(api);

  await assert.rejects(
    () => harness.reader.readCurrentSessionFromState({}, {
      requiredFields: ['refreshToken'],
    }),
    /requiredFields.*refreshToken/
  );

  assert.equal(harness.sentMessages.length, 0);
  assert.deepEqual(harness.sleepCalls, []);
});

test('OpenAI session reader propagates Stop before the first read', async () => {
  const api = loadSessionReaderApi();
  const harness = createReaderHarness(api, {
    registeredTabId: 77,
    registeredTabAlive: true,
    onSleep() {
      throw new Error('流程已被用户停止。');
    },
  });

  await assert.rejects(
    () => harness.reader.readCurrentSessionFromState({}, { requiredFields: ['session'] }),
    /流程已被用户停止/
  );
  assert.equal(harness.sentMessages.length, 0);
});
