(function attachKiroMailRules(root, factory) {
  root.MultiPageKiroMailRules = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createKiroMailRulesModule(root) {
  const kiroStateApi = root.MultiPageBackgroundKiroState || null;
  const SUBMIT_VERIFICATION_CODE_RULE_ID = 'kiro-submit-verification-code';
  const DESKTOP_AUTHORIZE_CODE_RULE_ID = 'kiro-complete-desktop-authorize';
  const SUBMIT_VERIFICATION_CODE_NODE_ID = 'kiro-submit-verification-code';
  const DESKTOP_AUTHORIZE_NODE_ID = 'kiro-complete-desktop-authorize';
  const GITHUB_LAUNCH_CODE_NODE_ID = 'kiro-github-submit-launch-code';
  const GITHUB_DEVICE_CODE_NODE_ID = 'kiro-github-submit-device-code';
  const GITHUB_LAUNCH_CODE_RULE_ID = 'kiro-github-launch-code';
  const GITHUB_DEVICE_CODE_RULE_ID = 'kiro-github-device-code';
  const KIRO_AWS_VERIFICATION_CODE_PATTERNS = Object.freeze([
    Object.freeze({
      source: '(?:verification\\s*code|验证码|Your code is|code is)[：:\\s]*(\\d{6})',
      flags: 'gi',
    }),
    Object.freeze({
      source: '^\\s*(\\d{6})\\s*$',
      flags: 'gm',
    }),
    Object.freeze({
      source: '>\\s*(\\d{6})\\s*<',
      flags: 'g',
    }),
  ]);
  const KIRO_AWS_SENDER_FILTERS = Object.freeze([
    'no-reply@signin.aws',
    'no-reply@login.awsapps.com',
    'noreply@amazon.com',
    'account-update@amazon.com',
    'no-reply@aws.amazon.com',
    'noreply@aws.amazon.com',
    'aws',
  ]);
  const KIRO_AWS_SUBJECT_FILTERS = Object.freeze([
    'aws builder id',
    'verification',
    '验证码',
    'code',
    'aws',
  ]);
  const KIRO_AWS_REQUIRED_KEYWORDS = Object.freeze([
    'verification',
    '验证码',
    'code',
    'aws',
  ]);

  const GITHUB_LAUNCH_CODE_PATTERNS = Object.freeze([
    Object.freeze({
      source: '(\\d{4}-\\d{4})',
      flags: 'g',
    }),
    Object.freeze({
      source: '(?:launch\\s*code|verification\\s*code|验证码|code\\s*(?:is|:))[：:\\s]*([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})',
      flags: 'gi',
    }),
    Object.freeze({
      source: '>\\s*(\\d{4}-?\\d{4})\\s*<',
      flags: 'g',
    }),
    Object.freeze({
      source: '^\\s*(\\d{4}-\\d{4}|\\d{8})\\s*$',
      flags: 'gm',
    }),
  ]);
  const GITHUB_SENDER_FILTERS = Object.freeze([
    'noreply@github.com',
    'notifications@github.com',
    'github@github.com',
    'github',
  ]);
  const GITHUB_LAUNCH_SUBJECT_FILTERS = Object.freeze([
    'launch code',
    'github',
    'verify',
    'verification',
  ]);
  const GITHUB_LAUNCH_REQUIRED_KEYWORDS = Object.freeze([
    'launch',
    'github',
    'code',
  ]);
  const GITHUB_DEVICE_CODE_PATTERNS = Object.freeze([
    Object.freeze({
      source: '(?:verification\\s*code|code\\s*(?:is|:)|验证码)[：:\\s]*([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})',
      flags: 'gi',
    }),
    Object.freeze({
      source: '(\\d{4}-\\d{4})',
      flags: 'g',
    }),
    Object.freeze({
      source: '>\\s*([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})\\s*<',
      flags: 'g',
    }),
    Object.freeze({
      source: '^\\s*([A-Za-z0-9]{8}|\\d{6}|\\d{4}-\\d{4})\\s*$',
      flags: 'gm',
    }),
  ]);
  const GITHUB_DEVICE_SUBJECT_FILTERS = Object.freeze([
    'verification code',
    'device',
    'verify',
    'sign-in',
    'sign in',
    'github',
  ]);
  const GITHUB_DEVICE_REQUIRED_KEYWORDS = Object.freeze([
    'verification',
    'code',
    'device',
    'github',
  ]);

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function readKiroRuntime(state = {}) {
    if (typeof kiroStateApi?.ensureRuntimeState === 'function') {
      return kiroStateApi.ensureRuntimeState(state);
    }
    return state?.runtimeState?.flowState?.kiro || state?.flowState?.kiro || {};
  }

  function buildTargetEmailHints(targetEmail = '') {
    const normalizedTarget = cleanString(targetEmail).toLowerCase();
    return normalizedTarget ? [normalizedTarget] : [];
  }

  function resolveNodeId(input) {
    const directNodeId = cleanString(input?.nodeId || input);
    if (directNodeId === DESKTOP_AUTHORIZE_NODE_ID
      || directNodeId === GITHUB_LAUNCH_CODE_NODE_ID
      || directNodeId === GITHUB_DEVICE_CODE_NODE_ID) {
      return directNodeId;
    }
    return SUBMIT_VERIFICATION_CODE_NODE_ID;
  }

  function getVisibleStepForNode(nodeId, state = {}) {
    const explicitStep = Number(state?.visibleStep || state?.step);
    if (Number.isInteger(explicitStep) && explicitStep > 0) {
      return explicitStep;
    }
    return nodeId === DESKTOP_AUTHORIZE_NODE_ID ? 8 : 4;
  }

  function isMail2925Provider(state = {}) {
    return cleanString(state?.mailProvider).toLowerCase() === '2925';
  }

  function shouldMatchMail2925TargetEmail(state = {}) {
    return isMail2925Provider(state)
      && cleanString(state?.mail2925Mode).toLowerCase() === 'receive';
  }

  function createKiroMailRules(deps = {}) {
    const {
      LUCKMAIL_PROVIDER = 'luckmail-api',
      MAIL_2925_VERIFICATION_INTERVAL_MS = 15000,
      MAIL_2925_VERIFICATION_MAX_ATTEMPTS = 15,
    } = deps;

    function getRuleDefinition(input, state = {}) {
      const nodeId = resolveNodeId(input);
      const normalizedStep = getVisibleStepForNode(nodeId, state);
      const runtimeState = readKiroRuntime(state);
      const targetEmail = cleanString(runtimeState.register?.email || state?.email).toLowerCase();
      const normalizedProvider = cleanString(state?.mailProvider).toLowerCase();
      const mail2925Provider = isMail2925Provider(state);
      const luckmailProvider = normalizedProvider === cleanString(LUCKMAIL_PROVIDER).toLowerCase();
      const githubEmail = cleanString(
        runtimeState.github?.email
        || runtimeState.register?.email
        || state?.email
      ).toLowerCase();
      const isGithubLaunch = nodeId === GITHUB_LAUNCH_CODE_NODE_ID;
      const isGithubDevice = nodeId === GITHUB_DEVICE_CODE_NODE_ID;
      const isGithubRule = isGithubLaunch || isGithubDevice;

      return {
        flowId: 'kiro',
        ruleId: isGithubLaunch
          ? GITHUB_LAUNCH_CODE_RULE_ID
          : (isGithubDevice
            ? GITHUB_DEVICE_CODE_RULE_ID
            : (nodeId === DESKTOP_AUTHORIZE_NODE_ID
              ? DESKTOP_AUTHORIZE_CODE_RULE_ID
              : SUBMIT_VERIFICATION_CODE_RULE_ID)),
        nodeId,
        step: normalizedStep,
        artifactType: 'code',
        codePatterns: isGithubRule
          ? (isGithubDevice ? GITHUB_DEVICE_CODE_PATTERNS : GITHUB_LAUNCH_CODE_PATTERNS)
          : KIRO_AWS_VERIFICATION_CODE_PATTERNS,
        filterAfterTimestamp: 0,
        requiredKeywords: isGithubRule
          ? (isGithubDevice ? GITHUB_DEVICE_REQUIRED_KEYWORDS : GITHUB_LAUNCH_REQUIRED_KEYWORDS)
          : KIRO_AWS_REQUIRED_KEYWORDS,
        senderFilters: isGithubRule ? GITHUB_SENDER_FILTERS : KIRO_AWS_SENDER_FILTERS,
        subjectFilters: isGithubRule
          ? (isGithubDevice ? GITHUB_DEVICE_SUBJECT_FILTERS : GITHUB_LAUNCH_SUBJECT_FILTERS)
          : KIRO_AWS_SUBJECT_FILTERS,
        targetEmail: isGithubRule ? (githubEmail || targetEmail) : targetEmail,
        targetEmailHints: buildTargetEmailHints(isGithubRule ? (githubEmail || targetEmail) : targetEmail),
        mail2925MatchTargetEmail: shouldMatchMail2925TargetEmail(state),
        maxAttempts: luckmailProvider
          ? 3
          : (mail2925Provider ? MAIL_2925_VERIFICATION_MAX_ATTEMPTS : 5),
        intervalMs: luckmailProvider
          ? 15000
          : (mail2925Provider ? MAIL_2925_VERIFICATION_INTERVAL_MS : 3000),
      };
    }

    function getRuleDefinitionForNode(nodeId, state = {}) {
      return getRuleDefinition({ nodeId }, state);
    }

    function buildVerificationPollPayload(input, state = {}, overrides = {}) {
      return {
        ...getRuleDefinition(input, state),
        ...(overrides || {}),
      };
    }

    function buildVerificationPollPayloadForNode(nodeId, state = {}, overrides = {}) {
      return buildVerificationPollPayload({ nodeId }, state, overrides);
    }

    return {
      buildVerificationPollPayload,
      buildVerificationPollPayloadForNode,
      getRuleDefinition,
      getRuleDefinitionForNode,
    };
  }

  return {
    DESKTOP_AUTHORIZE_CODE_RULE_ID,
    DESKTOP_AUTHORIZE_NODE_ID,
    GITHUB_DEVICE_CODE_NODE_ID,
    GITHUB_DEVICE_CODE_RULE_ID,
    GITHUB_LAUNCH_CODE_NODE_ID,
    GITHUB_LAUNCH_CODE_RULE_ID,
    KIRO_AWS_REQUIRED_KEYWORDS,
    KIRO_AWS_SENDER_FILTERS,
    KIRO_AWS_SUBJECT_FILTERS,
    KIRO_AWS_VERIFICATION_CODE_PATTERNS,
    SUBMIT_VERIFICATION_CODE_NODE_ID,
    SUBMIT_VERIFICATION_CODE_RULE_ID,
    createKiroMailRules,
  };
});
