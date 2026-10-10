const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('flows/grok/content/sub2api-oauth-page.js', 'utf8');

function loadApi() {
  const scope = {};
  return new Function('self', `${source}; return self.MultiPageGrokSub2ApiOAuthPage;`)(scope);
}

test('Grok SUB2API OAuth page detects Chinese and English consent actions', () => {
  const api = loadApi();

  assert.deepEqual(api.classifyPageSnapshot({
    pageText: '授权 Grok Build Verify your identity',
    actionTexts: ['拒绝', '允许'],
    codeCandidates: [],
  }), {
    state: 'consent_page',
    actionIndex: 1,
  });
  assert.deepEqual(api.classifyPageSnapshot({
    pageText: 'Authorize Grok Build Verify your identity',
    actionTexts: ['Deny', 'Allow'],
    codeCandidates: [],
  }), {
    state: 'consent_page',
    actionIndex: 1,
  });
});

test('Grok SUB2API OAuth page prioritizes a visible allow action over code-like consent copy', () => {
  const api = loadApi();

  assert.deepEqual(api.classifyPageSnapshot({
    pageText: '授权 Grok Build 输入此代码以完成登录',
    actionTexts: ['拒绝', '允许'],
    codeCandidates: [],
  }), {
    state: 'consent_page',
    actionIndex: 1,
  });
});

test('Grok SUB2API OAuth consent page wins over SPA error-string noise', () => {
  const api = loadApi();
  const result = api.classifyPageSnapshot({
    pageText: 'Authorize Grok Build Verify your identity access denied something went wrong Deny Allow',
    actionTexts: ['Deny', 'Allow'],
    codeCandidates: [],
    pathname: '/oauth2/consent',
  });

  assert.equal(result.state, 'consent_page');
  assert.equal(result.actionIndex, 1);
});

test('Grok SUB2API OAuth page never treats /sign-in as a code page', () => {
  const api = loadApi();
  const code = 'lrpwLq7npJDut-lef4f9HDZ_OH3INQUQIkYdvFsVSpA3hcVEf1';
  const result = api.classifyPageSnapshot({
    pageText: `Sign in Enter this code to finish signing in Copy the code below into Grok Build ${code}`,
    actionTexts: ['Continue'],
    codeCandidates: [code],
    pathname: '/sign-in',
  });

  assert.equal(result.state, 'sign_in');
  assert.equal(result.code, undefined);
});

test('Grok SUB2API OAuth page reads only a visible code-page value', () => {
  const api = loadApi();
  const code = 'ilUTmu195dD7ZtMI-huPjKMXjR65M6K-dloR3XzL1vTnypRYqC';

  assert.deepEqual(api.classifyPageSnapshot({
    pageText: '输入此代码以完成登录 将下面的代码复制到 Grok Build 以完成登录。',
    actionTexts: [],
    codeCandidates: ['', code],
  }), {
    state: 'code_page',
    code,
  });
  assert.deepEqual(api.classifyPageSnapshot({
    pageText: 'Unrelated settings page',
    actionTexts: [],
    codeCandidates: [code],
  }), {
    state: 'loading',
  });
});

test('Grok SUB2API OAuth page extracts the visible English code text', () => {
  const api = loadApi();
  const code = 'lrpwLq7npJDut-lef4f9HDZ_OH3INQUQIkYdvFsVSpA3hcVEf1';
  const result = api.classifyPageSnapshot({
    pageText: `Enter this code to finish signing in Copy the code below into Grok Build ${code}`,
    actionTexts: [],
    codeCandidates: [],
    pathname: '/oauth2/consent',
  });

  assert.equal(result.state, 'code_page');
  assert.equal(result.code, code);
});

test('Grok SUB2API OAuth page detects the device-flow done state before consent handling', () => {
  const api = loadApi();

  assert.deepEqual(api.classifyPageSnapshot({
    pageText: '设备已授权，你可以关闭此页面',
    actionTexts: [],
    codeCandidates: [],
    pathname: '/oauth2/device/done',
  }), { state: 'device_done', pathname: '/oauth2/device/done' });

  assert.equal(api.classifyPageSnapshot({
    pageText: 'Device is authorized You have authorized this device',
    actionTexts: ['Allow'],
    codeCandidates: [],
    url: 'https://auth.x.ai/oauth2/device/verify',
  }).state, 'device_done');
});

test('Grok SUB2API OAuth page detects a device code entry form only with a visible input', () => {
  const api = loadApi();

  assert.equal(api.classifyPageSnapshot({
    pageText: 'Enter the code shown on your device',
    actionTexts: [],
    codeCandidates: [],
    hasCodeEntryInput: true,
    pathname: '/oauth2/device/verify',
  }).state, 'device_code_form');

  assert.equal(api.classifyPageSnapshot({
    pageText: 'Enter the code shown on your device',
    actionTexts: [],
    codeCandidates: [],
    hasCodeEntryInput: false,
    pathname: '/oauth2/device/verify',
  }).state, 'loading');
});

test('Grok SUB2API OAuth device code fill uses the native setter and events', () => {
  const api = loadApi();
  const dispatched = [];
  const input = {
    value: '',
    dispatchEvent: (event) => dispatched.push(event),
  };
  // Node 环境没有 HTMLInputElement/真 DOM；原生 setter 缺失时走 el.value 分支。
  const ok = api.fillCodeEntryInput(input, 'ABCD-EFGH');
  assert.equal(ok, true);
  assert.equal(input.value, 'ABCD-EFGH');
  assert.equal(dispatched.length, 2);
  assert.equal(api.fillCodeEntryInput(input, ''), false);
  assert.equal(api.fillCodeEntryInput(null, 'ABCD-EFGH'), false);
});

test('Grok SUB2API OAuth content driver never uses the clipboard API', () => {
  assert.doesNotMatch(source, /navigator\.clipboard|clipboardData|execCommand\(['"]copy/);
});

test('Grok SUB2API OAuth error state does not return page text that may contain a code', () => {
  const api = loadApi();
  const code = 'ilUTmu195dD7ZtMI-huPjKMXjR65M6K-dloR3XzL1vTnypRYqC';

  const result = api.classifyPageSnapshot({
    pageText: `Authorization failed. Diagnostic code: ${code}`,
    actionTexts: [],
    codeCandidates: [code],
  });

  assert.deepEqual(result, {
    state: 'error_page',
    error: 'Grok OAuth 授权页面显示失败。',
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(code));
});

test('Grok SUB2API OAuth page reads action and code values without concatenating accessibility labels', () => {
  const api = loadApi();
  const code = 'ilUTmu195dD7ZtMI-huPjKMXjR65M6K-dloR3XzL1vTnypRYqC';
  const element = (values) => ({
    ...values,
    getAttribute(name) {
      return values[name] || '';
    },
  });

  assert.equal(api.getActionText(element({ textContent: 'Allow', 'aria-label': 'Authorize Grok Build' })), 'Allow');
  assert.equal(api.getCodeCandidate(element({ value: code, 'aria-label': 'Copy code' })), code);
});

test('Grok SUB2API OAuth page text uses innerText so embedded SPA bundle strings do not mislead state detection', () => {
  // x.ai SPA 的 body textContent 含脚本/i18n JSON（"device is authorized" 等），
  // 曾把输码页误分类成 device_done 导致不点「继续/允许」。
  assert.match(source, /body\?\.innerText\s*\?\?\s*document\.body\?\.textContent/);
});

test('Grok SUB2API OAuth device approve only trusts redirect URLs for done detection', () => {
  // SPA 外壳 HTML 内嵌 i18n 含 "authorization complete" 字符串，
  // body 文本判定会让 verify/approve 首响应误报已授权、跳过真正的 approve。
  assert.match(source, /isDoneUrl/);
  assert.doesNotMatch(source, /AUTHORIZED_TEXT/);
  assert.match(source, /probeConsent/);
});

test('Grok SUB2API OAuth device code form detects a prefilled user code', () => {
  const api = loadApi();
  const mk = (value) => ({ value });
  assert.equal(api.codeEntryInputsHaveCode([mk('4TKC'), mk('YQE3')], '4TKC-YQE3'), true);
  assert.equal(api.codeEntryInputsHaveCode([mk('4TKC'), mk('')], '4TKC-YQE3'), false);
  assert.equal(api.codeEntryInputsHaveCode([mk('')], '4TKC-YQE3'), false);
  assert.equal(api.codeEntryInputsHaveCode([], '4TKC-YQE3'), false);
});

test('Grok SUB2API OAuth distributes a device code across OTP inputs by maxlength', () => {
  const api = loadApi();
  const mk = (maxLength) => ({ value: '', maxLength, dispatchEvent() { return true; } });
  const inputs = [mk(4), mk(4)];
  assert.equal(api.fillCodeEntryInputs(inputs, '4TKC-YQE3'), true);
  assert.deepEqual(inputs.map((input) => input.value), ['4TKC', 'YQE3']);
  const single = mk(-1);
  assert.equal(api.fillCodeEntryInputs([single], '4TKC-YQE3'), true);
  assert.equal(single.value, '4TKC-YQE3');
});
