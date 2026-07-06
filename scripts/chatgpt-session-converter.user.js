// ==UserScript==
// @name         ChatGPT Session Copier
// @namespace    https://web-tools.local/
// @version      0.1.2
// @author       qxslimg
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
    status.dataset.state = isError ? "error" : "success";
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
        <div class="maysafe-session-brand">
          <span class="maysafe-session-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <path d="M8 7.5A2.5 2.5 0 0 1 10.5 5h6A2.5 2.5 0 0 1 19 7.5v6A2.5 2.5 0 0 1 16.5 16h-6A2.5 2.5 0 0 1 8 13.5v-6Z"></path>
              <path d="M5 10.5A2.5 2.5 0 0 1 7.5 8H8v5.5A2.5 2.5 0 0 0 10.5 16H16v.5A2.5 2.5 0 0 1 13.5 19h-6A2.5 2.5 0 0 1 5 16.5v-6Z"></path>
            </svg>
          </span>
          <div>
            <strong>Session Copier</strong>
            <span>本地读取当前 ChatGPT 账号</span>
          </div>
        </div>
        <button class="maysafe-session-close" type="button" aria-label="折叠">×</button>
      </div>
      <div class="maysafe-session-actions">
        <button data-kind="cpa"><strong>CPA JSON</strong><span>Codex / account 配置</span></button>
        <button data-kind="sub"><strong>sub2api</strong><span>代理服务账号包</span></button>
        <button data-kind="raw"><strong>原始 Session</strong><span>/api/auth/session 响应</span></button>
        <button data-kind="session"><strong>sessionToken</strong><span>只复制 session token</span></button>
        <button data-kind="access"><strong>accessToken</strong><span>只复制 access token</span></button>
      </div>
      <div class="maysafe-session-foot">
        <div id="maysafe-session-status" data-state="idle">选择格式后复制到剪贴板</div>
        <span>local only</span>
      </div>
    `;
    const trigger = document.createElement("button");
    trigger.id = "maysafe-session-trigger";
    trigger.type = "button";
    trigger.setAttribute("aria-label", "打开 Session Copier");
    trigger.innerHTML = `
      <span class="maysafe-session-trigger-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" role="img">
          <path d="M8 7.5A2.5 2.5 0 0 1 10.5 5h6A2.5 2.5 0 0 1 19 7.5v6A2.5 2.5 0 0 1 16.5 16h-6A2.5 2.5 0 0 1 8 13.5v-6Z"></path>
          <path d="M5 10.5A2.5 2.5 0 0 1 7.5 8H8v5.5A2.5 2.5 0 0 0 10.5 16H16v.5A2.5 2.5 0 0 1 13.5 19h-6A2.5 2.5 0 0 1 5 16.5v-6Z"></path>
        </svg>
      </span>
      <span class="maysafe-session-trigger-text">Session</span>
    `;
    const style = document.createElement("style");
    style.textContent = `
      #maysafe-session-root,
      #maysafe-session-root * {
        box-sizing: border-box;
      }
      #maysafe-session-root {
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 2147483647;
        display: grid;
        justify-items: end;
        gap: 10px;
        color: #e7edf4;
        font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #maysafe-session-trigger {
        height: 42px;
        min-width: 116px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        padding: 0 13px 0 9px;
        border: 1px solid rgba(114, 133, 153, 0.38);
        border-radius: 999px;
        background:
          linear-gradient(180deg, rgba(18, 25, 35, 0.94), rgba(8, 12, 18, 0.94));
        color: #e7edf4;
        cursor: pointer;
        box-shadow:
          0 16px 42px rgba(0, 0, 0, 0.3),
          inset 0 1px 0 rgba(255, 255, 255, 0.06);
        backdrop-filter: blur(16px);
        transition: border-color 140ms ease, transform 140ms ease, background 140ms ease, box-shadow 140ms ease;
      }
      #maysafe-session-trigger:hover {
        border-color: rgba(116, 242, 214, 0.7);
        transform: translateY(-1px);
        box-shadow:
          0 20px 50px rgba(0, 0, 0, 0.34),
          0 0 0 4px rgba(116, 242, 214, 0.08);
      }
      #maysafe-session-trigger[hidden] {
        display: none;
      }
      #maysafe-session-trigger:focus-visible,
      #maysafe-session-panel button:focus-visible {
        outline: 2px solid rgba(116, 242, 214, 0.72);
        outline-offset: 2px;
      }
      #maysafe-session-trigger .maysafe-session-trigger-icon {
        width: 28px;
        height: 28px;
        border: 1px solid rgba(116, 242, 214, 0.34);
        border-radius: 999px;
        display: inline-grid;
        place-items: center;
        color: #74f2d6;
        background: rgba(116, 242, 214, 0.09);
      }
      #maysafe-session-trigger svg,
      #maysafe-session-panel .maysafe-session-logo svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linejoin: round;
      }
      #maysafe-session-trigger .maysafe-session-trigger-text {
        color: #f8fafc;
        font-size: 13px;
        font-weight: 850;
        letter-spacing: 0;
      }
      #maysafe-session-panel {
        width: min(380px, calc(100vw - 32px));
        padding: 14px;
        border: 1px solid rgba(114, 133, 153, 0.28);
        border-radius: 18px;
        background:
          radial-gradient(circle at 0% 0%, rgba(116, 242, 214, 0.14), transparent 32%),
          linear-gradient(145deg, rgba(13, 19, 28, 0.98), rgba(7, 11, 17, 0.98));
        box-shadow:
          0 28px 80px rgba(0, 0, 0, 0.44),
          inset 0 1px 0 rgba(255, 255, 255, 0.05);
        color: #e7edf4;
        backdrop-filter: blur(20px);
      }
      #maysafe-session-panel[hidden] {
        display: none;
      }
      #maysafe-session-panel .maysafe-session-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(114, 133, 153, 0.16);
      }
      #maysafe-session-panel .maysafe-session-brand {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 11px;
      }
      #maysafe-session-panel .maysafe-session-logo {
        width: 36px;
        height: 36px;
        border: 1px solid rgba(116, 242, 214, 0.34);
        border-radius: 12px;
        display: inline-grid;
        place-items: center;
        flex: none;
        color: #74f2d6;
        background: rgba(116, 242, 214, 0.09);
      }
      #maysafe-session-panel .maysafe-session-head strong {
        display: block;
        color: #f8fafc;
        font-size: 16px;
        line-height: 1.2;
        font-weight: 880;
      }
      #maysafe-session-panel .maysafe-session-head span {
        display: block;
        margin-top: 2px;
        color: #91a4b8;
        font-size: 12px;
      }
      #maysafe-session-panel .maysafe-session-close {
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(114, 133, 153, 0.22);
        border-radius: 10px;
        background: rgba(9, 14, 21, 0.72);
        color: #91a4b8;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      #maysafe-session-panel .maysafe-session-close:hover {
        border-color: rgba(116, 242, 214, 0.46);
        color: #f8fafc;
        background: rgba(116, 242, 214, 0.08);
      }
      #maysafe-session-panel .maysafe-session-actions {
        margin-top: 12px;
        display: grid;
        gap: 9px;
      }
      #maysafe-session-panel .maysafe-session-actions button {
        width: 100%;
        min-height: 54px;
        margin: 0;
        border: 1px solid rgba(114, 133, 153, 0.22);
        border-radius: 13px;
        padding: 10px 12px;
        display: grid;
        gap: 3px;
        background: rgba(9, 14, 21, 0.66);
        color: #e7edf4;
        cursor: pointer;
        font: inherit;
        text-align: left;
        transition: border-color 140ms ease, color 140ms ease, background 140ms ease, transform 140ms ease;
      }
      #maysafe-session-panel .maysafe-session-actions button:hover {
        border-color: rgba(116, 242, 214, 0.58);
        background: rgba(116, 242, 214, 0.08);
        transform: translateY(-1px);
      }
      #maysafe-session-panel .maysafe-session-actions button strong {
        color: #f8fafc;
        font-size: 13px;
        font-weight: 850;
      }
      #maysafe-session-panel .maysafe-session-actions button span {
        color: #91a4b8;
        font-size: 12px;
      }
      #maysafe-session-panel .maysafe-session-foot {
        margin-top: 12px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
      }
      #maysafe-session-status {
        min-height: 36px;
        padding: 9px 10px;
        border: 1px solid rgba(114, 133, 153, 0.18);
        border-radius: 12px;
        background: rgba(5, 9, 14, 0.54);
        color: #91a4b8;
        font-size: 12px;
        word-break: break-word;
      }
      #maysafe-session-status[data-state="success"] {
        border-color: rgba(116, 242, 214, 0.36);
        color: #74f2d6;
      }
      #maysafe-session-status[data-state="error"] {
        border-color: rgba(251, 113, 133, 0.4);
        color: #fda4af;
      }
      #maysafe-session-panel .maysafe-session-foot > span {
        border: 1px solid rgba(116, 242, 214, 0.24);
        border-radius: 999px;
        padding: 5px 8px;
        color: #74f2d6;
        background: rgba(116, 242, 214, 0.08);
        font: 800 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-transform: uppercase;
      }
      @media (max-width: 520px) {
        #maysafe-session-root {
          right: 12px;
          bottom: 12px;
        }
        #maysafe-session-panel {
          width: calc(100vw - 24px);
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
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest(".maysafe-session-close")) {
        setOpen(false);
        return;
      }
      const button = target.closest("button[data-kind]");
      if (!button) return;
      void copyPayload(button.dataset.kind);
    });
  }

  injectPanel();
})();
