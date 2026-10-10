const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

test('sidepanel exposes Grok2API target controls and isolated Grok SUB2API policy controls', () => {
  [
    'row-sub2api-url',
    'row-sub2api-email',
    'row-sub2api-password',
    'row-grok2api-url',
    'input-grok2api-url',
    'row-grok2api-key',
    'input-grok2api-key',
    'row-grok-sub2api-grok2api-upload',
    'input-grok-sub2api-grok2api-upload-enabled',
    'row-grok-sub2api-group',
    'input-grok-sub2api-group',
    'grok-sub2api-group-picker',
    'btn-add-grok-sub2api-group',
    'row-grok-sub2api-account-priority',
    'input-grok-sub2api-account-priority',
    'row-grok-sub2api-default-proxy',
    'input-grok-sub2api-default-proxy',
  ].forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));

  const priorityTag = html.match(/<input[^>]*id="input-grok-sub2api-account-priority"[^>]*>/)?.[0] || '';
  assert.match(priorityTag, /type="number"/);
  assert.match(priorityTag, /value="1"/);
  assert.match(priorityTag, /min="1"/);
  assert.match(priorityTag, /step="1"/);
  assert.ok(html.indexOf('id="row-grok-sub2api-group"') < html.indexOf('id="row-grok-sub2api-account-priority"'));
  assert.ok(html.indexOf('id="row-grok-sub2api-account-priority"') < html.indexOf('id="row-grok-sub2api-default-proxy"'));
});

test('sidepanel defaults the Grok SUB2API grok2api upload switch to off', () => {
  const inputTag = html.match(/<input[^>]*id="input-grok-sub2api-grok2api-upload-enabled"[^>]*>/)?.[0] || '';
  assert.match(inputTag, /type="checkbox"/);
  assert.doesNotMatch(inputTag, /\schecked(?:\s|>|=)/);
});

test('sidepanel saves, restores, and auto-saves isolated Grok SUB2API policy', () => {
  assert.match(source, /const DEFAULT_GROK_SUB2API_GROUP_OPTIONS = \[\];/);
  assert.match(html, /id="input-grok-sub2api-group" value=""/);
  assert.match(source, /fallbackItems: DEFAULT_GROK_SUB2API_GROUP_OPTIONS,/);
  assert.match(source, /minItems: 0,/);
  assert.match(source, /grokSub2apiGroupName:\s*selectedGrokSub2ApiGroupName/);
  assert.match(source, /grokSub2apiGroupNames/);
  assert.match(source, /grokSub2apiAccountPriority:\s*sub2apiAccountPriorityNormalizer/);
  assert.match(source, /const grokSub2apiDefaultProxyName = typeof inputGrokSub2ApiDefaultProxy/);
  assert.match(source, /grokSub2apiDefaultProxyName,/);
  assert.match(source, /const currentGrok2ApiUrlValue = typeof inputGrok2ApiUrl/);
  assert.match(source, /const currentGrok2ApiKeyValue = typeof inputGrok2ApiKey/);
  assert.match(source, /grok2ApiUrl:\s*currentGrok2ApiUrlValue/);
  assert.match(source, /grok2ApiAdminKey:\s*currentGrok2ApiKeyValue/);
  assert.match(source, /grokSub2apiGrok2ApiUploadEnabled:\s*Boolean\([\s\S]*typeof inputGrokSub2ApiGrok2ApiUploadEnabled !== 'undefined'[\s\S]*inputGrokSub2ApiGrok2ApiUploadEnabled\?\.checked/);
  assert.match(source, /renderGrokSub2ApiGroupOptions\(state, state\?\.grokSub2apiGroupName \|\| ''\);/);
  assert.match(source, /inputGrokSub2ApiAccountPriority\.value = String\(normalizeSub2ApiAccountPriorityValue\(state\?\.grokSub2apiAccountPriority\)\);/);
  assert.match(source, /inputGrokSub2ApiDefaultProxy\.value = state\?\.grokSub2apiDefaultProxyName \|\| '';/);
  assert.match(source, /inputGrok2ApiUrl\.value = String\([\s\S]*state\?\.grok2ApiUrl/);
  assert.match(source, /inputGrok2ApiKey\.value = String\([\s\S]*state\?\.grok2ApiAdminKey/);
  assert.match(source, /inputGrokSub2ApiGrok2ApiUploadEnabled\.checked = Boolean\(state\?\.grokSub2apiGrok2ApiUploadEnabled\);/);
  assert.match(source, /inputGrokSub2ApiAccountPriority\.addEventListener\('input'/);
  assert.match(source, /inputGrokSub2ApiDefaultProxy\.addEventListener\('input'/);
  assert.match(source, /btnAddGrokSub2ApiGroup\?\.addEventListener\('click'/);
  assert.match(source, /inputGrokSub2ApiGrok2ApiUploadEnabled\?\.addEventListener\('change'/);
  assert.match(source, /syncStepDefinitionsFromUiState\(\{[\s\S]*grokSub2apiGrok2ApiUploadEnabled: enabled/);
  assert.match(source, /function updateGrokSub2ApiGrok2ApiUploadUi\(/);
  assert.match(source, /normalizedTargetId === 'grok2api'[\s\S]*showGrok2ApiControls/);
  assert.match(source, /rowGrok2ApiUrl, rowGrok2ApiUser, rowGrok2ApiKey/);
  assert.match(source, /grok2api:\s*'https:\/\/github\.com\/jiujiu532\/grok2api'/);
});

test('sidepanel uses OAuth creation status labels for the Grok SUB2API target', () => {
  assert.match(source, /case 'waiting_authorization':[\s\S]*return '等待授权'/);
  assert.match(source, /case 'authorizing':[\s\S]*return '正在授权'/);
  assert.match(source, /case 'creating':[\s\S]*return '正在创建'/);
  assert.match(source, /isSub2Api \? '已创建' : '已上传'/);
  assert.match(source, /isSub2Api \? '创建失败' : '上传失败'/);
  assert.doesNotMatch(source, /isSub2Api \? '已导入' : '已上传'/);
});

test('README documents Grok SUB2API OAuth and account naming contract', () => {
  assert.match(readme, /Grok/);
  assert.match(readme, /SUB2API/);
  assert.match(readme, /OAuth/);
  assert.match(readme, /注册邮箱.*账号名称/);
  assert.match(readme, /grok2api/);
  assert.match(readme, /pool.*auto/i);
  assert.match(readme, /SUB2API.*grok2api|grok2api.*SUB2API/);
  assert.doesNotMatch(readme, /Grok SSO 导入/);
});
