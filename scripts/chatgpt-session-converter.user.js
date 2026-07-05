// ==UserScript==
// @name         ChatGPT Session Copier
// @namespace    https://web-tools.local/
// @version      0.1.0
// @description  Copy ChatGPT session JSON, CPA JSON, sub2api bundle, session token, and access token from chatgpt.com.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const DEFAULT_PLAN_TYPE = "free";
  const DEFAULT_PRIVACY_MODE = "training_off";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function firstText(...values) {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text) return text;
    }
    return "";
  }

  function readObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value) {
    let normalized = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const remainder = normalized.length % 4;
    if (remainder) normalized += "=".repeat(4 - remainder);
    const binary = atob(normalized);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function jsonToBase64Url(value) {
    return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
  }

  function decodeJwtPayload(token) {
    try {
      const parts = String(token ?? "").split(".");
      if (parts.length < 2) return {};
      return readObject(JSON.parse(decoder.decode(base64UrlToBytes(parts[1]))));
    } catch {
      return {};
    }
  }

  function extractAuth(payload) {
    return readObject(payload["https://api.openai.com/auth"]);
  }

  function extractProfile(payload) {
    return readObject(payload["https://api.openai.com/profile"]);
  }

  function coerceTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    const text = String(value ?? "").trim();
    if (!text) return 0;
    if (/^-?\d+$/.test(text)) return Math.max(0, Number.parseInt(text, 10));
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? 0 : Math.max(0, Math.trunc(parsed / 1000));
  }

  function toIsoUtc8(date) {
    const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return shifted.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " +0800");
  }

  function formatPlan(value) {
    const text = firstText(value);
    const lower = text.toLowerCase();
    if (!text) return "-";
    if (lower.includes("enterprise")) return "Enterprise";
    if (lower.includes("team") || lower.includes("business")) return "Team";
    if (lower.includes("plus")) return "Plus";
    if (lower.includes("pro")) return "Pro";
    if (lower.includes("free")) return "Free";
    return text;
  }

  function buildCompatibilityIdToken(args) {
    const now = Math.trunc(Date.now() / 1000);
    const accountId = firstText(args.accountId);
    const userId = firstText(args.userId);
    const payload = {
      aud: [firstText(args.clientId, DEFAULT_CLIENT_ID)],
      email: firstText(args.email),
      exp: now + 3600,
      iat: now,
      iss: "https://auth.openai.com",
      "https://api.openai.com/auth": {
        account_id: accountId,
        chatgpt_account_id: accountId,
        chatgpt_user_id: userId,
        user_id: userId,
        organization_id: firstText(args.organizationId),
        project_id: firstText(args.projectId),
        chatgpt_plan_type: firstText(args.planType, DEFAULT_PLAN_TYPE),
      },
      sub: userId || accountId || "local-compat",
    };
    return `${jsonToBase64Url({ alg: "RS256", typ: "JWT", kid: "compat" })}.${jsonToBase64Url(payload)}.${bytesToBase64Url(
      encoder.encode("local_compat_signature"),
    )}`;
  }

  function normalizeSession(session) {
    const account = readObject(session.account);
    const user = readObject(session.user);
    const accessToken = firstText(session.accessToken, session.access_token);
    const idToken = firstText(session.idToken, session.id_token);
    const accessPayload = decodeJwtPayload(accessToken);
    const idPayload = decodeJwtPayload(idToken);
    const accessAuth = extractAuth(accessPayload);
    const idAuth = extractAuth(idPayload);
    const profile = extractProfile(accessPayload);
    const accountId = firstText(account.id, account.account_id, accessAuth.chatgpt_account_id, accessAuth.account_id, idAuth.chatgpt_account_id, idAuth.account_id);
    const userId = firstText(user.id, accessAuth.chatgpt_user_id, accessAuth.user_id, idAuth.chatgpt_user_id, idAuth.user_id);
    const email = firstText(user.email, session.email, profile.email, idPayload.email, accountId, "unknown-account");
    const organizationId = firstText(account.organizationId, account.organization_id, accessAuth.organization_id, idAuth.organization_id);
    const planType = firstText(account.planType, account.plan_type, accessAuth.chatgpt_plan_type, idAuth.chatgpt_plan_type, DEFAULT_PLAN_TYPE);
    const expiresAt = coerceTimestamp(firstText(session.expires, session.expiresAt, session.expires_at, accessPayload.exp));
    const teamName = firstText(account.teamName, account.team_name, account.workspaceName, account.workspace_name, readObject(account.team).name, readObject(account.workspace).name);
    const resolvedIdToken =
      idToken ||
      buildCompatibilityIdToken({
        accountId,
        userId,
        email,
        organizationId,
        planType,
        clientId: DEFAULT_CLIENT_ID,
      });

    return {
      email,
      planType,
      planLabel: formatPlan(planType),
      teamName,
      accountId,
      userId,
      organizationId,
      expiresAt,
      accessToken,
      idToken: resolvedIdToken,
      sessionToken: firstText(session.sessionToken, session.session_token),
      refreshToken: firstText(session.refreshToken, session.refresh_token),
    };
  }

  function buildCpa(session) {
    const item = normalizeSession(session);
    return {
      type: "codex",
      email: item.email,
      expired: item.expiresAt ? toIsoUtc8(new Date(item.expiresAt * 1000)) : "",
      id_token: item.idToken,
      account_id: item.accountId,
      disabled: false,
      access_token: item.accessToken,
      session_token: item.sessionToken,
      last_refresh: toIsoUtc8(new Date()),
      refresh_token: item.refreshToken,
    };
  }

  function buildSubBundle(session) {
    const item = normalizeSession(session);
    return {
      exported_at: new Date().toISOString(),
      proxies: [],
      accounts: [
        {
          name: item.email,
          platform: "openai",
          type: "oauth",
          credentials: {
            access_token: item.accessToken,
            chatgpt_account_id: item.accountId,
            chatgpt_user_id: item.userId,
            client_id: DEFAULT_CLIENT_ID,
            email: item.email,
            expires_at: item.expiresAt || Math.trunc(Date.now() / 1000) + 863999,
            id_token: item.idToken,
            organization_id: item.organizationId,
            plan_type: item.planType,
            refresh_token: item.refreshToken,
            session_token: item.sessionToken,
          },
          extra: {
            email: item.email,
            source: "chatgpt_web_session_userscript",
            privacy_mode: DEFAULT_PRIVACY_MODE,
          },
          concurrency: 10,
          priority: 1,
          rate_multiplier: 1,
          auto_pause_on_expired: true,
        },
      ],
    };
  }

  async function loadSession() {
    const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText || "读取失败"}`);
    const session = await response.json();
    if (!firstText(session.accessToken, session.access_token, session.user?.email, session.account?.id)) {
      throw new Error("没有读到有效 session，确认当前 ChatGPT 页面已经登录。");
    }
    return session;
  }

  async function copyText(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text, "text");
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  function setStatus(text, isError = false) {
    const status = document.querySelector("#maysafe-session-status");
    if (!status) return;
    status.textContent = text;
    status.style.color = isError ? "#dc2626" : "#0f766e";
  }

  async function copyPayload(kind) {
    try {
      setStatus("读取 session...");
      const session = await loadSession();
      const info = normalizeSession(session);
      const payloads = {
        raw: JSON.stringify(session, null, 2),
        cpa: JSON.stringify(buildCpa(session), null, 2),
        sub: JSON.stringify(buildSubBundle(session), null, 2),
        session: info.sessionToken,
        access: info.accessToken,
      };
      const text = payloads[kind] || payloads.raw;
      if (!text) throw new Error("这个 session 里没有对应 token。");
      await copyText(text);
      setStatus(`已复制：${info.email} / ${info.planLabel}${info.teamName ? ` / ${info.teamName}` : ""}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  }

  function injectPanel() {
    if (document.querySelector("#maysafe-session-root")) return;
    let open = false;
    const root = document.createElement("div");
    root.id = "maysafe-session-root";
    const panel = document.createElement("div");
    panel.id = "maysafe-session-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="maysafe-session-head">
        <div>
          <strong>Session Copier</strong>
          <span>本地读取当前账号</span>
        </div>
        <button class="maysafe-session-close" type="button" aria-label="折叠">×</button>
      </div>
      <div class="maysafe-session-actions">
        <button data-kind="raw">原始 JSON</button>
        <button data-kind="cpa">CPA JSON</button>
        <button data-kind="sub">sub2api</button>
        <button data-kind="session">sessionToken</button>
        <button data-kind="access">accessToken</button>
      </div>
      <div id="maysafe-session-status">选择要复制的格式</div>
    `;
    const trigger = document.createElement("button");
    trigger.id = "maysafe-session-trigger";
    trigger.type = "button";
    trigger.innerHTML = `<span>Session</span><strong>Copy</strong>`;
    const style = document.createElement("style");
    style.textContent = `
      #maysafe-session-root {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        color: #0f172a;
        font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #maysafe-session-trigger {
        min-width: 112px;
        height: 42px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        padding: 0 14px;
        border: 1px solid rgba(20, 184, 166, 0.48);
        border-radius: 999px;
        background: linear-gradient(135deg, rgba(20, 184, 166, 0.96), rgba(37, 99, 235, 0.96));
        color: #ffffff;
        cursor: pointer;
        box-shadow: 0 14px 34px rgba(15, 23, 42, 0.22);
        backdrop-filter: blur(14px);
      }
      #maysafe-session-trigger span {
        font-size: 12px;
        opacity: 0.82;
      }
      #maysafe-session-trigger strong {
        font-size: 13px;
        letter-spacing: 0;
      }
      #maysafe-session-trigger:hover {
        transform: translateY(-1px);
        box-shadow: 0 18px 42px rgba(15, 23, 42, 0.26);
      }
      #maysafe-session-panel {
        width: min(300px, calc(100vw - 28px));
        padding: 12px;
        border: 1px solid rgba(203, 213, 225, 0.72);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 22px 56px rgba(15, 23, 42, 0.2);
        color: #0f172a;
        backdrop-filter: blur(18px);
      }
      #maysafe-session-panel[hidden] {
        display: none;
      }
      #maysafe-session-panel .maysafe-session-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      #maysafe-session-panel .maysafe-session-head strong {
        display: block;
        color: #0f172a;
        font-size: 15px;
        line-height: 1.2;
        font-weight: 800;
      }
      #maysafe-session-panel .maysafe-session-head span {
        display: block;
        margin-top: 2px;
        color: #64748b;
        font-size: 12px;
      }
      #maysafe-session-panel .maysafe-session-close {
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 8px;
        background: #f1f5f9;
        color: #64748b;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      #maysafe-session-panel .maysafe-session-close:hover {
        background: #e2e8f0;
        color: #0f172a;
      }
      #maysafe-session-panel .maysafe-session-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #maysafe-session-panel .maysafe-session-actions button {
        width: 100%;
        min-height: 36px;
        margin: 0;
        border: 1px solid #dbe3ee;
        border-radius: 8px;
        background: #f8fafc;
        color: #0f172a;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        transition: border-color 140ms ease, color 140ms ease, background-color 140ms ease, transform 140ms ease;
      }
      #maysafe-session-panel .maysafe-session-actions button:hover {
        background: #ffffff;
        border-color: #12b8aa;
        color: #0f766e;
        transform: translateY(-1px);
      }
      #maysafe-session-status {
        min-height: 34px;
        margin-top: 10px;
        padding: 8px 10px;
        border-radius: 8px;
        background: #f8fafc;
        color: #64748b;
        font-size: 12px;
        word-break: break-word;
      }
      @media (max-width: 520px) {
        #maysafe-session-root {
          right: 12px;
          bottom: 12px;
        }
        #maysafe-session-panel .maysafe-session-actions {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `;
    function setOpen(nextOpen) {
      open = nextOpen;
      panel.hidden = !open;
      trigger.hidden = open;
    }
    document.documentElement.appendChild(style);
    root.appendChild(panel);
    root.appendChild(trigger);
    document.body.appendChild(root);
    trigger.addEventListener("click", () => setOpen(true));
    panel.addEventListener("click", (event) => {
      if (event.target.closest(".maysafe-session-close")) {
        setOpen(false);
        return;
      }
      const button = event.target.closest("button[data-kind]");
      if (!button) return;
      void copyPayload(button.dataset.kind);
    });
  }

  injectPanel();
})();
