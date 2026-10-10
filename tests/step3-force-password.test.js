const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('flows/openai/content/openai-auth.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function buildHarness(setup) {
  return new Function(`
const logs = [];
const completions = [];
const clicks = [];
const scheduled = [];
const diagnostics = [];

const passwordSnapshot = {
  state: 'password_page',
  passwordInput: { value: '', hidden: false },
  submitButton: { textContent: 'Continue', hidden: false },
  displayedEmail: 'user@example.com',
  url: 'https://auth.openai.com/create-account/password',
};
const verificationSnapshot = {
  state: 'verification_page',
  url: 'https://auth.openai.com/create-account/email-verification',
};
let snapshot = verificationSnapshot;
let triggerClicks = 0;

const window = {
  setTimeout(fn, ms) {
    scheduled.push({ fn, ms });
    return scheduled.length;
  },
  CodexOperationDelay: {
    async performOperationWithDelay(metadata, operation) {
      return operation();
    },
  },
};

const location = {
  href: 'https://auth.openai.com/create-account/email-verification',
  pathname: '/create-account/email-verification',
};

function inspectSignupEntryState() {
  return snapshot;
}

function findSignupUsePasswordTrigger() {
  return { textContent: '使用密码继续', tagName: 'A' };
}

async function ensureSignupPasswordPageReady() {
  return { ready: true, state: 'password_page' };
}

async function waitForSignupLandingState() {
  return snapshot;
}

function getSignupPasswordSubmitButton() {
  return snapshot.submitButton;
}

async function waitForElementByText() {
  return null;
}

function fillInput(input, value) {
  input.value = value;
}

async function humanPause() {}
async function sleep() {}
function throwIfStopped() {}
function isStopError() {
  return false;
}

function log(message, level = 'info') {
  logs.push({ message, level });
}

function logSignupPasswordDiagnostics(message) {
  diagnostics.push(message);
}

function reportComplete(step, payload) {
  completions.push({ step, payload });
}

function simulateClick(target) {
  triggerClicks += 1;
  clicks.push(target.textContent || 'button');
  if (CLICK_SWITCHES_TO_PASSWORD) {
    snapshot = passwordSnapshot;
    location.href = passwordSnapshot.url;
    location.pathname = '/create-account/password';
  }
}

function getOperationDelayRunner() {
  return window.CodexOperationDelay.performOperationWithDelay;
}

${extractFunction('step3_fillEmailPassword')}

return {
  async run(payload) {
    return step3_fillEmailPassword(payload);
  },
  snapshot() {
    return {
      logs,
      completions,
      clicks,
      diagnostics,
      triggerClicks,
      passwordValue: passwordSnapshot.passwordInput.value,
    };
  },
};
`.replace('CLICK_SWITCHES_TO_PASSWORD', setup.clickSwitchesToPassword ? 'true' : 'false'))();
}

test('force password: verification landing clicks 使用密码继续 then fills password', async () => {
  const api = buildHarness({ clickSwitchesToPassword: true });
  const result = await api.run({
    email: 'user@example.com',
    password: 'Secret123!',
    forcePasswordSignup: true,
  });

  const state = api.snapshot();
  assert.equal(state.triggerClicks, 1);
  assert.equal(state.passwordValue, 'Secret123!');
  assert.equal(state.completions.length, 1);
  assert.equal(result.skippedPasswordPage, undefined);
  assert.equal(result.landingState, 'password_page');
  assert.equal(result.passwordPagePath, '/create-account/password');
  assert.equal(state.logs.some(({ message }) => /落地页检测 → 状态=verification_page/.test(message)), true);
  assert.equal(state.logs.some(({ message }) => /正在点击「使用密码继续」/.test(message)), true);
  assert.equal(state.logs.some(({ message }) => /已切换到密码页/.test(message)), true);
});

test('force password off: verification landing skips password without clicking', async () => {
  const api = buildHarness({ clickSwitchesToPassword: true });
  const result = await api.run({
    email: 'user@example.com',
    password: 'Secret123!',
    forcePasswordSignup: false,
  });

  const state = api.snapshot();
  assert.equal(state.triggerClicks, 0);
  assert.equal(result.skippedPasswordPage, true);
  assert.equal(result.landingState, 'verification_page');
  assert.equal(result.forcePasswordSignup, false);
  assert.equal(typeof result.signupVerificationRequestedAt, 'number');
  assert.equal(state.logs.some(({ message }) => /强制密码=关/.test(message)), true);
  assert.equal(state.logs.some(({ message }) => /密码页按已跳过处理（强制密码未开启）/.test(message)), true);
});

test('force password: fails loudly when password page is unreachable', async () => {
  const api = buildHarness({ clickSwitchesToPassword: false });

  await assert.rejects(
    () => api.run({
      email: 'user@example.com',
      password: 'Secret123!',
      forcePasswordSignup: true,
    }),
    /强制密码已开启/
  );

  const state = api.snapshot();
  assert.equal(state.completions.length, 0);
  assert.equal(state.diagnostics.length, 1);
});
