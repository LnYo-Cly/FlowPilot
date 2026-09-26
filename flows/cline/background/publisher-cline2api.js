(function attachBackgroundCline2ApiPublisher(root, factory) {
  root.MultiPageBackgroundClinePublisher = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundCline2ApiPublisherModule(root = globalThis) {
  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function getClineClient(scope = root) {
    return scope?.MultiPageClineClient || null;
  }

  function readClineRuntime(state = {}) {
    return state?.runtimeState?.flowState?.cline || {};
  }

  function createCline2ApiPublisher(deps = {}) {
    const {
      addLog = async () => {},
      completeNodeFromBackground,
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      getState = async () => ({}),
      setState = async () => {},
    } = deps;

    if (typeof completeNodeFromBackground !== 'function') {
      throw new Error('Cline2API publisher requires completeNodeFromBackground.');
    }

    async function log(message, level = 'info') {
      await addLog(`Cline：${message}`, level);
    }

    async function executeClineUploadCredential(state = {}) {
      const currentState = state && typeof state === 'object' && Object.keys(state).length
        ? state
        : await getState();
      const runtime = readClineRuntime(currentState);
      const client = getClineClient();
      if (!client?.importCline2ApiAccounts) {
        throw new Error('Cline 客户端模块未加载。');
      }
      const email = cleanString(runtime.email || currentState.email);
      const record = client.toCline2ApiImportRecord({
        email,
        accessToken: runtime.accessToken,
        refreshToken: runtime.refreshToken,
        expiresAt: runtime.expiresAt,
      });
      if (!record) {
        throw new Error('缺少可上传的 Cline 凭据（email/accessToken/refreshToken/expiresAt 不完整）。');
      }
      const baseUrl = cleanString(currentState.cline2apiBaseUrl);
      const adminToken = cleanString(currentState.cline2apiAdminToken);
      if (!baseUrl) {
        throw new Error('请先填写 cline2api 网关地址。');
      }

      const summary = await client.importCline2ApiAccounts({
        baseUrl,
        adminToken,
        records: [record],
        fetchImpl,
      });
      await log(
        `已推送 ${record.email} 到 cline2api（新增 ${summary.imported} / 覆盖 ${summary.updated} / 跳过 ${summary.skipped}）。`,
        'ok'
      );
      await setState({
        runtimeState: {
          flowState: {
            cline: {
              ...runtime,
              uploadedAt: Date.now(),
              uploadSummary: summary,
            },
          },
        },
      });
      return completeNodeFromBackground('cline-upload-credential', {});
    }

    async function testCline2ApiConnection(overrides = {}) {
      const currentState = await getState();
      const client = getClineClient();
      if (!client?.probeCline2Api) {
        throw new Error('Cline 客户端模块未加载。');
      }
      const baseUrl = cleanString(overrides.baseUrl ?? currentState.cline2apiBaseUrl);
      const adminToken = cleanString(overrides.adminToken ?? currentState.cline2apiAdminToken);
      return client.probeCline2Api({ baseUrl, adminToken, fetchImpl });
    }

    return {
      executeClineUploadCredential,
      testCline2ApiConnection,
    };
  }

  return {
    createCline2ApiPublisher,
  };
});
