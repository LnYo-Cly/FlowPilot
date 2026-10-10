(function attachMultiPageKiroWorkflow(root, factory) {
  root.MultiPageKiroWorkflow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createMultiPageKiroWorkflow() {
  const KIRO_CONTRIBUTION_STEP_TITLE = '\u8d21\u732e\u4e0a\u4f20';

  function freezeDeep(entry) {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) {
      return entry;
    }
    Object.getOwnPropertyNames(entry).forEach((key) => {
      freezeDeep(entry[key]);
    });
    return Object.freeze(entry);
  }

  const STEP_VARIANTS = freezeDeep({
  "default": [
    {
      "id": 1,
      "order": 10,
      "key": "kiro-open-register-page",
      "title": "打开注册页",
      "sourceId": "kiro-register-page",
      "driverId": "flows/kiro/background/register-runner",
      "command": "kiro-open-register-page",
      "flowId": "kiro"
    },
    {
      "id": 2,
      "order": 20,
      "key": "kiro-submit-email",
      "title": "获取邮箱并继续",
      "sourceId": "kiro-register-page",
      "driverId": "flows/kiro/background/register-runner",
      "command": "kiro-submit-email",
      "flowId": "kiro"
    },
    {
      "id": 3,
      "order": 30,
      "key": "kiro-submit-name",
      "title": "填写姓名并继续",
      "sourceId": "kiro-register-page",
      "driverId": "flows/kiro/background/register-runner",
      "command": "kiro-submit-name",
      "flowId": "kiro"
    },
    {
      "id": 4,
      "order": 40,
      "key": "kiro-submit-verification-code",
      "title": "获取验证码并继续",
      "sourceId": "kiro-register-page",
      "driverId": "flows/kiro/background/register-runner",
      "command": "kiro-submit-verification-code",
      "flowId": "kiro"
    },
    {
      "id": 5,
      "order": 50,
      "key": "kiro-submit-password",
      "title": "设置密码并继续",
      "sourceId": "kiro-register-page",
      "driverId": "flows/kiro/background/register-runner",
      "command": "kiro-submit-password",
      "flowId": "kiro"
    },
    {
      "id": 6,
      "order": 60,
      "key": "kiro-complete-register-consent",
      "title": "完成注册授权",
      "sourceId": "kiro-register-page",
      "driverId": "flows/kiro/background/register-runner",
      "command": "kiro-complete-register-consent",
      "flowId": "kiro"
    },
    {
      "id": 7,
      "order": 70,
      "key": "kiro-start-desktop-authorize",
      "title": "启动桌面授权",
      "sourceId": "kiro-desktop-authorize",
      "driverId": "flows/kiro/background/desktop-authorize-runner",
      "command": "kiro-start-desktop-authorize",
      "flowId": "kiro"
    },
    {
      "id": 8,
      "order": 80,
      "key": "kiro-complete-desktop-authorize",
      "title": "完成桌面授权",
      "sourceId": "kiro-desktop-authorize",
      "driverId": "flows/kiro/background/desktop-authorize-runner",
      "command": "kiro-complete-desktop-authorize",
      "flowId": "kiro"
    },
    {
      "id": 9,
      "order": 90,
      "key": "kiro-upload-credential",
      "title": "上传凭据到 kiro.rs",
      "sourceId": "kiro-rs-admin",
      "driverId": "flows/kiro/background/publisher-kiro-rs",
      "command": "kiro-upload-credential",
      "flowId": "kiro"
    }
  ],
  "github": [
    {
      "id": 1,
      "order": 10,
      "key": "kiro-github-open-signup",
      "title": "打开 GitHub 注册页",
      "sourceId": "kiro-github-signup",
      "driverId": "flows/kiro/background/github-register-runner",
      "command": "kiro-github-open-signup",
      "flowId": "kiro"
    },
    {
      "id": 2,
      "order": 20,
      "key": "kiro-github-submit-email",
      "title": "获取邮箱并继续",
      "sourceId": "kiro-github-signup",
      "driverId": "flows/kiro/background/github-register-runner",
      "command": "kiro-github-submit-email",
      "flowId": "kiro"
    },
    {
      "id": 3,
      "order": 30,
      "key": "kiro-github-submit-password",
      "title": "设置密码并继续",
      "sourceId": "kiro-github-signup",
      "driverId": "flows/kiro/background/github-register-runner",
      "command": "kiro-github-submit-password",
      "flowId": "kiro"
    },
    {
      "id": 4,
      "order": 40,
      "key": "kiro-github-submit-username",
      "title": "填写用户名并继续",
      "sourceId": "kiro-github-signup",
      "driverId": "flows/kiro/background/github-register-runner",
      "command": "kiro-github-submit-username",
      "flowId": "kiro"
    },
    {
      "id": 5,
      "order": 50,
      "key": "kiro-github-submit-email-prefs",
      "title": "处理邮件偏好",
      "sourceId": "kiro-github-signup",
      "driverId": "flows/kiro/background/github-register-runner",
      "command": "kiro-github-submit-email-prefs",
      "flowId": "kiro"
    },
    {
      "id": 6,
      "order": 60,
      "key": "kiro-github-submit-launch-code",
      "title": "获取验证码并继续",
      "sourceId": "kiro-github-signup",
      "driverId": "flows/kiro/background/github-register-runner",
      "command": "kiro-github-submit-launch-code",
      "flowId": "kiro"
    },
    {
      "id": 7,
      "order": 70,
      "key": "kiro-open-github-auth",
      "title": "打开 Kiro GitHub 授权",
      "sourceId": "kiro-register-page",
      "driverId": "flows/kiro/background/github-register-runner",
      "command": "kiro-open-github-auth",
      "flowId": "kiro"
    },
    {
      "id": 8,
      "order": 80,
      "key": "kiro-github-complete-oauth",
      "title": "完成 GitHub 授权",
      "sourceId": "kiro-github-signup",
      "driverId": "flows/kiro/background/github-register-runner",
      "command": "kiro-github-complete-oauth",
      "flowId": "kiro"
    },
    {
      "id": 9,
      "order": 90,
      "key": "kiro-upload-credential",
      "title": "上传凭据到 kiro.rs",
      "sourceId": "kiro-rs-admin",
      "driverId": "flows/kiro/background/publisher-kiro-rs",
      "command": "kiro-upload-credential",
      "flowId": "kiro"
    }
  ]
});

const KIRO_AUTH_METHOD_BUILDER_ID = 'builder-id';
const KIRO_AUTH_METHOD_GITHUB = 'github';

function normalizeKiroAuthMethod(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === KIRO_AUTH_METHOD_GITHUB ? KIRO_AUTH_METHOD_GITHUB : KIRO_AUTH_METHOD_BUILDER_ID;
}

  function getVariantStepDefinitions(variantKey = 'default') {
    return Array.isArray(STEP_VARIANTS[variantKey]) ? STEP_VARIANTS[variantKey] : STEP_VARIANTS.default;
  }

  function getModeStepDefinitions(options = {}) {
    const authMethod = normalizeKiroAuthMethod(
      options?.kiroAuthMethod
      ?? options?.settingsState?.flows?.kiro?.authMethod
      ?? options?.state?.kiroAuthMethod
      ?? ''
    );
    return getVariantStepDefinitions(authMethod === KIRO_AUTH_METHOD_GITHUB ? 'github' : 'default');
  }

  function getAllSteps() {
    const merged = new Map();
    Object.values(STEP_VARIANTS).forEach((variantSteps) => {
      (Array.isArray(variantSteps) ? variantSteps : []).forEach((step) => {
        const key = `${Number(step?.id) || 0}:${String(step?.key || '').trim()}`;
        if (!merged.has(key)) {
          merged.set(key, step);
        }
      });
    });
    return Array.from(merged.values());
  }

  function getPlusPaymentStepTitle() {
    return '';
  }

  function resolveStepTitle(step = {}, options = {}) {
    if (step?.key === 'kiro-upload-credential' && Boolean(options?.accountContributionEnabled || options?.state?.accountContributionEnabled)) {
      return KIRO_CONTRIBUTION_STEP_TITLE;
    }
    return step?.title || '';
  }

  return {
    KIRO_AUTH_METHOD_BUILDER_ID,
    KIRO_AUTH_METHOD_GITHUB,
    flowId: 'kiro',
    getAllSteps,
    getModeStepDefinitions,
    getPlusPaymentStepTitle,
    getVariantStepDefinitions,
    normalizeKiroAuthMethod,
    resolveStepTitle,
  };
});
