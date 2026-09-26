// FlowPilot Cline：页面 JS 运行前（document_start + MAIN world）禁用 WebAuthn。
// 微软「创建通行密钥」页会调 navigator.credentials.create()，触发 Chrome 原生
// 通行密钥选择框——那是浏览器 UI，content script 点不到，会卡死整个流程。
// 让 create/get 直接抛 NotAllowedError，并让平台认证器探测返回 false，
// 微软页只能走「跳过/取消」的 DOM 路径（由 fido-create 分支接管）。
(function clineWebauthnStub() {
  if (window.__FP_CLINE_WEBAUTHN_STUB__) return;
  window.__FP_CLINE_WEBAUTHN_STUB__ = true;
  try {
    const deny = () => Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError'));
    const fakeCredentials = {
      create: deny,
      get: deny,
      store: () => Promise.resolve(),
      preventSilentAccess: () => Promise.resolve(),
    };
    Object.defineProperty(window.navigator, 'credentials', {
      value: fakeCredentials,
      configurable: true,
    });
    if (window.PublicKeyCredential) {
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
      window.PublicKeyCredential.isConditionalMediationAvailable = async () => false;
    }
  } catch (_) {
    try {
      navigator.credentials.create = () => Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError'));
      navigator.credentials.get = () => Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError'));
    } catch (__) { /* noop */ }
  }
})();
