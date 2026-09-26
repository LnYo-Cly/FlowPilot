(function attachMultiPageClineWorkflow(root, factory) {
  root.MultiPageClineWorkflow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createMultiPageClineWorkflow() {
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
      "key": "cline-prepare-account",
      "title": "分配微软账号",
      "sourceId": "cline-microsoft-login",
      "driverId": "flows/cline/background/register-runner",
      "command": "cline-prepare-account",
      "flowId": "cline"
    },
    {
      "id": 2,
      "order": 20,
      "key": "cline-open-authorize",
      "title": "打开 Cline 授权页",
      "sourceId": "cline-microsoft-login",
      "driverId": "flows/cline/background/register-runner",
      "command": "cline-open-authorize",
      "flowId": "cline"
    },
    {
      "id": 3,
      "order": 30,
      "key": "cline-drive-login",
      "title": "驱动微软登录",
      "sourceId": "cline-microsoft-login",
      "driverId": "flows/cline/background/register-runner",
      "command": "cline-drive-login",
      "flowId": "cline"
    },
    {
      "id": 4,
      "order": 40,
      "key": "cline-exchange-token",
      "title": "换取 Cline 令牌",
      "sourceId": "cline-microsoft-login",
      "driverId": "flows/cline/background/register-runner",
      "command": "cline-exchange-token",
      "flowId": "cline"
    },
    {
      "id": 5,
      "order": 50,
      "key": "cline-upload-credential",
      "title": "上传凭据到 cline2api",
      "sourceId": "cline2api-admin",
      "driverId": "flows/cline/background/publisher-cline2api",
      "command": "cline-upload-credential",
      "flowId": "cline"
    }
  ]
});

  function getVariantStepDefinitions(variantKey = 'default') {
    return Array.isArray(STEP_VARIANTS[variantKey]) ? STEP_VARIANTS[variantKey] : STEP_VARIANTS.default;
  }

  function getModeStepDefinitions() {
    return getVariantStepDefinitions('default');
  }

  function getAllSteps() {
    return getVariantStepDefinitions('default');
  }

  function getPlusPaymentStepTitle() {
    return '';
  }

  function resolveStepTitle(step = {}) {
    return step?.title || '';
  }

  return {
    flowId: 'cline',
    getAllSteps,
    getModeStepDefinitions,
    getPlusPaymentStepTitle,
    getVariantStepDefinitions,
    resolveStepTitle,
  };
});
