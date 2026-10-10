const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const grokSource = fs.readFileSync('flows/grok/content/register-page.js', 'utf8');

function extractFunction(source, name) {
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
      if (parenDepth === 0) signatureEnded = true;
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
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

function extractConst(source, name) {
  const start = source.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`missing const ${name}`);
  const end = source.indexOf(';', start);
  return source.slice(start, end + 1);
}

function buildTosHarness({ hostname = 'grok.com', pathname = '/tos_gate', bodyText = '', buttons = [], cookie = '' } = {}) {
  return new Function(`
    const clicked = [];
    const document = {
      body: { innerText: ${JSON.stringify(bodyText)} },
      cookie: ${JSON.stringify(cookie)},
      querySelectorAll: () => [],
    };
    const location = {
      hostname: ${JSON.stringify(hostname)},
      pathname: ${JSON.stringify(pathname)},
      href: 'https://' + ${JSON.stringify(hostname)} + ${JSON.stringify(pathname)},
    };
    ${extractConst(grokSource, 'GROK_TOS_GATE_PATH_PATTERN')}
    ${extractConst(grokSource, 'GROK_TOS_GATE_TEXT_PATTERN')}
    ${extractConst(grokSource, 'GROK_TOS_GATE_CONFIRM_PATTERN')}
    ${extractConst(grokSource, 'GROK_COOKIE_ACCEPT_PATTERN')}
    ${extractConst(grokSource, 'GROK_PROFILE_TEXT_PATTERN')}
    const buttons = ${JSON.stringify(buttons)};
    function findGrokClickableByText(pattern) {
      return buttons.find((el) => pattern.test(String(el.text || ''))) || null;
    }
    function getGrokElementText(el) { return el ? String(el.text || '') : ''; }
    function simulateGrokClick(el) { clicked.push(getGrokElementText(el)); }
    async function sleep() {}
    function findGrokProfileInput() { return null; }
    function findGrokPasswordInputs() { return []; }
    function findGrokOtpInputs() { return []; }
    function findGrokEmailInput() { return null; }
    function hasGrokTurnstileStructuralHint() { return false; }
    function hasGrokHumanVerificationHint() { return false; }
    function requestGrokTurnstileTrustedClick() { return Promise.resolve({ ok: false, reason: 'stub' }); }
    ${extractFunction(grokSource, 'isGrokTosGatePage')}
    ${extractFunction(grokSource, 'dismissGrokTosGate')}
    ${extractFunction(grokSource, 'getGrokPageState')}
    return { clicked, isGrokTosGatePage, dismissGrokTosGate, getGrokPageState };
  `)();
}

test('grok page state reports tos_gate on the terms gate path', () => {
  const harness = buildTosHarness({
    pathname: '/tos_gate',
    bodyText: '我们的服务条款和可接受使用政策的更新',
    buttons: [{ text: '知道了' }],
  });
  assert.equal(harness.getGrokPageState(), 'tos_gate');
});

test('grok page state detects tos gate by terms text plus confirm button', () => {
  const harness = buildTosHarness({
    pathname: '/home',
    bodyText: '我们的服务条款和可接受使用政策的更新，我们正在更新我们的服务条款。',
    buttons: [{ text: '知道了' }, { text: '登出' }],
  });
  assert.equal(harness.getGrokPageState(), 'tos_gate');
});

test('grok cookie banner alone is not treated as a tos gate', () => {
  const harness = buildTosHarness({
    pathname: '/',
    bodyText: 'Essential cookies keep the site working. Cookie Policy, Privacy Policy, and Terms of Service.',
    buttons: [{ text: '接受所有 Cookie' }, { text: 'Cookie 设置' }],
  });
  assert.notEqual(harness.getGrokPageState(), 'tos_gate');
});

test('grok signup page with terms copy and a continue button is not a tos gate', () => {
  const source = fs.readFileSync('flows/grok/content/register-page.js', 'utf8');
  // accounts.x.ai 注册页永不判为 tos_gate
  const harness = buildTosHarness({
    hostname: 'accounts.x.ai',
    pathname: '/sign-up',
    bodyText: '完成注册 Terms of Service 服务条款 可接受使用政策',
    buttons: [{ text: '继续' }, { text: '完成注册' }],
  });
  assert.notEqual(harness.getGrokPageState(), 'tos_gate');
  assert.match(source, /accounts\\\.x\\\.ai/);
});

test('grok dismiss tos gate clicks the confirm and cookie-accept buttons', async () => {
  const harness = buildTosHarness({
    pathname: '/tos_gate',
    bodyText: '我们的服务条款和可接受使用政策的更新',
    buttons: [{ text: '知道了' }, { text: '接受所有 Cookie' }, { text: '登出' }],
  });
  const result = await harness.dismissGrokTosGate();
  assert.equal(result.dismissed, true);
  assert.deepEqual(harness.clicked, ['知道了', '接受所有 Cookie']);
});

test('grok dismiss tos gate reports not-dismissed when nothing matched', async () => {
  const harness = buildTosHarness({
    pathname: '/home',
    bodyText: 'chat',
    buttons: [{ text: 'New chat' }],
  });
  const result = await harness.dismissGrokTosGate();
  assert.equal(result.dismissed, false);
  assert.deepEqual(harness.clicked, []);
});
