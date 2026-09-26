(function attachMultiPageClineFlowDefinition(root, factory) {
  root.MultiPageClineFlowDefinition = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createMultiPageClineFlowDefinition() {
  function freezeDeep(entry) {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) {
      return entry;
    }
    Object.getOwnPropertyNames(entry).forEach((key) => {
      freezeDeep(entry[key]);
    });
    return Object.freeze(entry);
  }

  const VALUE = freezeDeep({
  "id": "cline",
  "label": "Cline",
  "services": [
    "account",
    "proxy"
  ],
  "capabilities": {
    "supportsEmailSignup": false,
    "supportsPhoneSignup": false,
    "supportsPhoneVerificationSettings": false,
    "supportsPlusMode": false,
    "supportsContributionMode": false,
    "supportsAccountContribution": false,
    "supportsOpenAiOAuthContribution": false,
    "contributionAdapterIds": [],
    "supportedTargetIds": [
      "cline2api"
    ],
    "supportsLuckmail": false,
    "canSwitchFlow": true,
    "stepDefinitionMode": "cline",
    "targetSelectorLabel": "目标"
  },
  "baseGroups": [
    "cline-runtime-status",
    "shared-auto-run"
  ],
  "targets": {
    "cline2api": {
      "id": "cline2api",
      "label": "cline2api",
      "defaultState": {
        "baseUrl": "",
        "apiKey": ""
      },
      "groups": [
        "cline-target-cline2api"
      ]
    }
  },
  "publicationTargets": {
    "cline2api": {
      "id": "cline2api",
      "label": "cline2api"
    }
  },
  "runtimeSources": {
    "cline-microsoft-login": {
      "flowId": "cline",
      "kind": "flow-page",
      "label": "Cline 微软登录页",
      "readyPolicy": "top-frame-only",
      "family": "cline-microsoft-login-family",
      "driverId": "flows/cline/content/microsoft-login",
      "cleanupScopes": [],
      "detectionMatchers": [
        {
          "hostnames": [
            "login.microsoftonline.com",
            "login.live.com",
            "account.live.com",
            "login.windows.net"
          ]
        },
        {
          "hostnames": [
            "app.cline.bot",
            "api.cline.bot",
            "cline.bot"
          ],
          "hostnameEndsWith": [
            ".cline.bot"
          ],
          "matchMode": "any"
        },
        {
          "hostnames": [
            "authkit.app",
            "api.workos.com"
          ],
          "hostnameEndsWith": [
            ".authkit.app",
            ".workos.com"
          ],
          "matchMode": "any"
        }
      ],
      "familyMatchers": [
        {
          "hostnames": [
            "login.microsoftonline.com",
            "login.live.com",
            "account.live.com",
            "login.windows.net"
          ]
        },
        {
          "hostnames": [
            "app.cline.bot",
            "api.cline.bot",
            "cline.bot"
          ],
          "hostnameEndsWith": [
            ".cline.bot"
          ],
          "matchMode": "any"
        },
        {
          "hostnames": [
            "authkit.app",
            "api.workos.com"
          ],
          "hostnameEndsWith": [
            ".authkit.app",
            ".workos.com"
          ],
          "matchMode": "any"
        }
      ]
    },
    "cline2api-admin": {
      "flowId": "cline",
      "kind": "virtual-page",
      "label": "cline2api Admin",
      "readyPolicy": "disabled",
      "family": "cline2api-admin-family",
      "driverId": null,
      "cleanupScopes": [],
      "familyMatchers": []
    }
  },
  "driverDefinitions": {
    "flows/cline/content/microsoft-login": {
      "sourceId": "cline-microsoft-login",
      "commands": [
        "cline-get-login-state",
        "cline-drive-step",
        "cline-submit-aux-email",
        "cline-submit-security-code"
      ]
    },
    "flows/cline/background/register-runner": {
      "sourceId": "cline-microsoft-login",
      "commands": [
        "cline-prepare-account",
        "cline-open-authorize",
        "cline-drive-login",
        "cline-exchange-token"
      ]
    },
    "flows/cline/background/publisher-cline2api": {
      "sourceId": "cline2api-admin",
      "commands": [
        "cline-upload-credential"
      ]
    }
  },
  "defaultTargetId": "cline2api",
  "defaultPublicationTargetId": "cline2api",
  "defaultTargetState": {
    "baseUrl": "",
    "apiKey": ""
  },
  "settingsDefaults": {
    "apiBase": "",
    "auxMailnestProjectCode": "microsoft001",
    "auxMailnestEmail": ""
  },
  "settingsGroups": {
    "cline-target-cline2api": {
      "id": "cline-target-cline2api",
      "label": "cline2api 配置",
      "rowIds": [
        "row-cline2api-url",
        "row-cline2api-token",
        "row-cline2api-test-status"
      ]
    },
    "cline-runtime-status": {
      "id": "cline-runtime-status",
      "label": "Cline 运行态",
      "rowIds": [
        "row-cline-account-hint"
      ]
    }
  },
  "sourceAliases": {}
});

  return VALUE;
});
