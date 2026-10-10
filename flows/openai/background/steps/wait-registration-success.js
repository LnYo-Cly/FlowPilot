(function attachBackgroundStep6(root, factory) {
  root.MultiPageBackgroundStep6 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep6Module() {
  const DEFAULT_REGISTRATION_SUCCESS_WAIT_MS = 7000;
  const STEP6_COOKIE_CLEAR_DOMAINS = [
    'chatgpt.com',
    'chat.openai.com',
    'openai.com',
    'auth.openai.com',
    'auth0.openai.com',
    'accounts.openai.com',
  ];
  const STEP6_COOKIE_CLEAR_ORIGINS = [
    'https://chatgpt.com',
    'https://chat.openai.com',
    'https://auth.openai.com',
    'https://auth0.openai.com',
    'https://accounts.openai.com',
    'https://openai.com',
  ];

  function normalizeStep6CookieDomain(domain) {
    return String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  }

  function shouldClearStep6Cookie(cookie) {
    const domain = normalizeStep6CookieDomain(cookie?.domain);
    if (!domain) return false;
    return STEP6_COOKIE_CLEAR_DOMAINS.some((target) => (
      domain === target || domain.endsWith(`.${target}`)
    ));
  }

  function buildStep6CookieRemovalUrl(cookie) {
    const host = normalizeStep6CookieDomain(cookie?.domain);
    const rawPath = String(cookie?.path || '/');
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    return `https://${host}${path}`;
  }

  async function collectStep6Cookies(chromeApi) {
    if (!chromeApi.cookies?.getAll) {
      return [];
    }

    const stores = chromeApi.cookies.getAllCookieStores
      ? await chromeApi.cookies.getAllCookieStores()
      : [{ id: undefined }];
    const cookies = [];
    const seen = new Set();

    for (const store of stores) {
      const storeId = store?.id;
      const batch = await chromeApi.cookies.getAll(storeId ? { storeId } : {});
      for (const cookie of batch || []) {
        if (!shouldClearStep6Cookie(cookie)) continue;
        const key = [
          cookie.storeId || storeId || '',
          cookie.domain || '',
          cookie.path || '',
          cookie.name || '',
          cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : '',
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        cookies.push(cookie);
      }
    }

    return cookies;
  }

  async function removeStep6Cookie(chromeApi, cookie, getErrorMessage) {
    const details = {
      url: buildStep6CookieRemovalUrl(cookie),
      name: cookie.name,
    };
    if (cookie.storeId) {
      details.storeId = cookie.storeId;
    }
    if (cookie.partitionKey) {
      details.partitionKey = cookie.partitionKey;
    }

    try {
      const result = await chromeApi.cookies.remove(details);
      return Boolean(result);
    } catch (error) {
      console.warn('[MultiPage:step6] remove cookie failed', {
        domain: cookie?.domain,
        name: cookie?.name,
        message: getErrorMessage(error),
      });
      return false;
    }
  }

  function createStep6Executor(deps = {}) {
    const {
      addLog = async () => {},
      chrome: chromeApi = globalThis.chrome,
      completeNodeFromBackground,
      dismissChatGptOnboarding = null,
      reloadChatGptSessionTab = null,
      getErrorMessage = (error) => error?.message || String(error || '未知错误'),
      registrationSuccessWaitMs = DEFAULT_REGISTRATION_SUCCESS_WAIT_MS,
      sleepWithStop = async (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))),
    } = deps;

    async function clearCookiesIfEnabled(state = {}) {
      if (!state?.step6CookieCleanupEnabled) {
        return;
      }
      if (!chromeApi?.cookies?.getAll || !chromeApi.cookies?.remove) {
        await addLog('步骤 6：当前浏览器不支持 cookies API，跳过第六步 Cookies 清理。', 'warn');
        return;
      }

      try {
        await addLog('步骤 6：已开启 Cookies 清理，正在清理 ChatGPT / OpenAI cookies...', 'info');
        const cookies = await collectStep6Cookies(chromeApi);
        let removedCount = 0;
        for (const cookie of cookies) {
          if (await removeStep6Cookie(chromeApi, cookie, getErrorMessage)) {
            removedCount += 1;
          }
        }

        if (chromeApi.browsingData?.removeCookies) {
          try {
            await chromeApi.browsingData.removeCookies({
              since: 0,
              origins: STEP6_COOKIE_CLEAR_ORIGINS,
            });
          } catch (error) {
            await addLog(`步骤 6：browsingData 补扫 cookies 失败：${getErrorMessage(error)}`, 'warn');
          }
        }

        await addLog(`步骤 6：已清理 ${removedCount} 个 ChatGPT / OpenAI cookies。`, 'ok');
      } catch (error) {
        await addLog(`步骤 6：Cookies 清理失败，已跳过并继续后续流程：${getErrorMessage(error)}`, 'warn');
      }
    }

    async function dismissOnboardingIfPresent(state = {}, { quiet = false } = {}) {
      if (typeof dismissChatGptOnboarding !== 'function') {
        return;
      }
      const result = await Promise.resolve(dismissChatGptOnboarding(state)).catch((error) => ({
        ok: false,
        error: getErrorMessage(error),
      }));
      if (result?.clicked) {
        await addLog(`步骤 6：检测到「你已准备就绪」注册引导页，已自动点击「${result?.label || '继续'}」进入 ChatGPT。`, 'ok');
      } else if (result?.found && result?.ok === false) {
        await addLog(`步骤 6：注册引导页「继续」点击失败：${result?.error || '未知原因'}`, 'warn');
      } else if (!quiet && result?.ok === false && result?.error) {
        await addLog(`步骤 6：注册引导页检查未执行（${result.error}），由后续步骤兜底处理。`, 'info');
      }
    }

    async function reloadSessionTabIfPresent(state = {}) {
      if (typeof reloadChatGptSessionTab !== 'function') {
        return;
      }
      const result = await Promise.resolve(reloadChatGptSessionTab(state)).catch((error) => ({
        ok: false,
        error: getErrorMessage(error),
      }));
      if (result?.reloaded) {
        await addLog('步骤 6：已刷新 chatgpt.com 标签页，确保会话接口可用。', 'ok');
      } else if (result?.ok === false && result?.error) {
        await addLog(`步骤 6：chatgpt.com 刷新未执行（${result.error}），由后续步骤兜底处理。`, 'info');
      }
    }

    async function executeStep6(state = {}) {
      const waitMs = Math.max(0, Math.floor(Number(registrationSuccessWaitMs) || 0));
      void dismissOnboardingIfPresent(state, { quiet: true });
      if (waitMs > 0) {
        await addLog(`步骤 6：等待 ${Math.round(waitMs / 1000)} 秒，确认注册成功并让页面稳定...`, 'info');
        await sleepWithStop(waitMs);
      }
      await reloadSessionTabIfPresent(state);
      await dismissOnboardingIfPresent(state);
      await clearCookiesIfEnabled(state);
      await addLog('步骤 6：注册成功等待完成，准备继续获取 OAuth 链接并登录。', 'ok');
      await completeNodeFromBackground('wait-registration-success');
    }

    return { executeStep6 };
  }

  return { createStep6Executor };
});
