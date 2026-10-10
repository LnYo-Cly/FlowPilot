const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadStep6Api() {
  const source = fs.readFileSync('flows/openai/background/steps/wait-registration-success.js', 'utf8');
  const globalScope = {};
  return new Function('self', `${source}; return self.MultiPageBackgroundStep6;`)(globalScope);
}

function createExecutor(deps = {}) {
  const api = loadStep6Api();
  const events = {
    logs: [],
    completedSteps: [],
  };
  const executor = api.createStep6Executor({
    addLog: async (message, level = 'info') => {
      events.logs.push({ message, level });
    },
    completeNodeFromBackground: async (step) => {
      events.completedSteps.push(step);
    },
    registrationSuccessWaitMs: 0,
    sleepWithStop: async () => {},
    ...deps,
  });
  return { events, executor };
}

test('step 6 clicks through the ready onboarding page when the hook reports a click', async () => {
  const { events, executor } = createExecutor({
    dismissChatGptOnboarding: async (state) => {
      assert.equal(state.nodeId, 'wait-registration-success');
      return { ok: true, clicked: true, found: true, label: '继续' };
    },
  });

  await executor.executeStep6({ nodeId: 'wait-registration-success' });

  assert.deepStrictEqual(events.completedSteps, ['wait-registration-success']);
  const clickLog = events.logs.find(({ message }) => /注册引导页/.test(message) && /继续/.test(message));
  assert.ok(clickLog, 'expected a log line about the onboarding continue click');
  assert.equal(clickLog.level, 'ok');
});

test('step 6 stays quiet when no onboarding page is detected', async () => {
  const { events, executor } = createExecutor({
    dismissChatGptOnboarding: async () => ({ ok: true, clicked: false, found: false }),
  });

  await executor.executeStep6({});

  assert.deepStrictEqual(events.completedSteps, ['wait-registration-success']);
  assert.equal(
    events.logs.some(({ message }) => /注册引导页/.test(message)),
    false,
    'should not log onboarding lines when the page is not in that state',
  );
});

test('step 6 warns when the onboarding trigger exists but the click fails', async () => {
  const { events, executor } = createExecutor({
    dismissChatGptOnboarding: async () => ({
      ok: false,
      clicked: false,
      found: true,
      error: '点击「继续」失败。',
    }),
  });

  await executor.executeStep6({});

  assert.deepStrictEqual(events.completedSteps, ['wait-registration-success']);
  const warnLog = events.logs.find(({ message }) => /点击失败/.test(message));
  assert.ok(warnLog, 'expected a warning about the failed continue click');
  assert.equal(warnLog.level, 'warn');
});

test('step 6 logs and continues when the onboarding hook cannot run', async () => {
  const { events, executor } = createExecutor({
    dismissChatGptOnboarding: async () => {
      throw new Error('未找到可读取 ChatGPT 会话的标签页');
    },
  });

  await executor.executeStep6({});

  assert.deepStrictEqual(events.completedSteps, ['wait-registration-success']);
  const infoLog = events.logs.find(({ message }) => /引导页检查未执行/.test(message));
  assert.ok(infoLog, 'expected an info log that the onboarding check was skipped');
  assert.equal(infoLog.level, 'info');
});

test('step 6 works unchanged when the onboarding hook is not wired', async () => {
  const { events, executor } = createExecutor();

  await executor.executeStep6({});

  assert.deepStrictEqual(events.completedSteps, ['wait-registration-success']);
});

test('step 6 reloads chatgpt.com before the onboarding click when the hook is wired', async () => {
  const callOrder = [];
  const { events, executor } = createExecutor({
    reloadChatGptSessionTab: async () => {
      callOrder.push('reload');
      return { ok: true, reloaded: true, tabId: 77 };
    },
    dismissChatGptOnboarding: async () => {
      callOrder.push('dismiss');
      return { ok: true, clicked: true, found: true, label: '继续' };
    },
  });

  await executor.executeStep6({});

  assert.deepStrictEqual(events.completedSteps, ['wait-registration-success']);
  // The pre-wait quiet dismiss fires first, then reload, then the post-wait dismiss.
  assert.deepStrictEqual(callOrder.slice(0, 3), ['dismiss', 'reload', 'dismiss']);
  const reloadLog = events.logs.find(({ message }) => /刷新 chatgpt\.com/.test(message));
  assert.ok(reloadLog, 'expected a log line about the chatgpt.com reload');
  assert.equal(reloadLog.level, 'ok');
});

test('step 6 continues when the chatgpt.com reload hook fails', async () => {
  const { events, executor } = createExecutor({
    reloadChatGptSessionTab: async () => {
      throw new Error('未找到可读取 ChatGPT 会话的标签页');
    },
  });

  await executor.executeStep6({});

  assert.deepStrictEqual(events.completedSteps, ['wait-registration-success']);
  const infoLog = events.logs.find(({ message }) => /刷新未执行/.test(message));
  assert.ok(infoLog, 'expected an info log that the reload was skipped');
  assert.equal(infoLog.level, 'info');
});
