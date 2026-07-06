// ==UserScript==
// @name         ChatGPT Workspace Join Request
// @namespace    https://almoststable.com/userscripts/
// @version      1.0.0
// @author       qxslimg
// @description  本地管理 ChatGPT workspace ID，勾选后手动向选中空间发送加入请求。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const ROOT_ID = "qx-workspace-join-root";
  const STYLE_ID = "qx-workspace-join-style";
  const STORE_KEY = "qx_workspace_join_request_v2";
  const LEGACY_STORE_KEY = "qx_workspace_join_request_v1";
  const DEVICE_ID_KEY = "qx_workspace_join_device_id_v1";
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const JOIN_ROUTE = "request";

  const DEFAULT_CONFIG = {
    workspaces: [],
    intervalMs: 1500,
    maxRetries: 2,
    retryBackoffMs: 4000,
    sessionPollMs: 20000,
  };

  const state = {
    open: false,
    running: false,
    accessToken: "",
    session: null,
    accountInfo: null,
    config: loadConfig(),
    deviceId: loadDeviceId(),
    draft: emptyDraft(),
    editingId: "",
    logs: [],
  };

  let root = null;
  let sessionTimer = 0;

  bootWhenReady();

  function emptyDraft() {
    return {
      id: "",
      name: "",
      description: "",
    };
  }

  function loadConfig() {
    const saved = readJson(STORE_KEY);
    if (saved) return normalizeConfig(saved);

    const legacy = readJson(LEGACY_STORE_KEY);
    if (legacy?.workspaceIds) {
      const migrated = {
        ...DEFAULT_CONFIG,
        ...legacy,
        workspaces: parseIdText(legacy.workspaceIds).map((id, index) =>
          createWorkspace({
            id,
            name: `Workspace ${index + 1}`,
            description: "从旧版 textarea 配置自动迁移",
            enabled: true,
          }),
        ),
      };
      delete migrated.workspaceIds;
      return normalizeConfig(migrated);
    }

    return { ...DEFAULT_CONFIG };
  }

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  function normalizeConfig(value) {
    const config = { ...DEFAULT_CONFIG, ...(value || {}) };
    config.intervalMs = normalizeNumber(config.intervalMs, 300, 60000, DEFAULT_CONFIG.intervalMs);
    config.maxRetries = normalizeNumber(config.maxRetries, 0, 6, DEFAULT_CONFIG.maxRetries);
    config.retryBackoffMs = normalizeNumber(config.retryBackoffMs, 500, 60000, DEFAULT_CONFIG.retryBackoffMs);
    config.sessionPollMs = normalizeNumber(config.sessionPollMs, 5000, 120000, DEFAULT_CONFIG.sessionPollMs);
    config.workspaces = normalizeWorkspaces(config.workspaces);
    return config;
  }

  function normalizeWorkspaces(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : [])
      .map((item) => createWorkspace(item))
      .filter((item) => {
        const key = item.id.toLowerCase();
        if (!UUID_PATTERN.test(item.id) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function createWorkspace(input) {
    const id = String(input?.id || "").trim();
    return {
      id,
      name: String(input?.name || "").trim(),
      description: String(input?.description || "").trim(),
      enabled: input?.enabled !== false,
      lastRoute: String(input?.lastRoute || ""),
      lastStatus: String(input?.lastStatus || ""),
      lastMessage: String(input?.lastMessage || ""),
      lastRunAt: String(input?.lastRunAt || ""),
      createdAt: String(input?.createdAt || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };
  }

  function normalizeNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function saveConfig() {
    state.config = normalizeConfig(state.config);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.config));
    } catch {
      pushLog("浏览器拒绝写入 localStorage，配置只在本页临时有效。", "warn");
    }
  }

  function loadDeviceId() {
    try {
      const saved = localStorage.getItem(DEVICE_ID_KEY);
      if (saved) return saved;
      const next = crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_ID_KEY, next);
      return next;
    } catch {
      return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
  }

  function bootWhenReady() {
    if (document.body) {
      boot();
      return;
    }
    document.addEventListener("DOMContentLoaded", boot, { once: true });
    window.addEventListener("load", boot, { once: true });
  }

  function boot() {
    if (document.getElementById(ROOT_ID)) return;
    installStyle();
    renderRoot();
    pushLog("脚本已加载。Workspace 列表会保存在当前浏览器本地。", "info");
    pushLog("不会自动提交申请，只会处理已勾选的 workspace。", "info");
    void refreshSession();
    sessionTimer = window.setInterval(() => {
      if (!state.running) void refreshSession(true);
    }, state.config.sessionPollMs);
    window.addEventListener("focus", () => {
      if (!state.running) void refreshSession(true);
    });
    window.addEventListener("beforeunload", () => window.clearInterval(sessionTimer));
  }

  async function fetchSession() {
    const response = await fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json, text/plain, */*" },
    });
    if (!response.ok) throw new Error(`session HTTP ${response.status}`);
    return response.json();
  }

  async function refreshSession(silent = false) {
    try {
      if (!silent) pushLog("读取当前 ChatGPT session...", "info");
      const session = await fetchSession();
      const accessToken = firstText(session.accessToken, session.access_token);
      if (!accessToken) throw new Error("session 中没有 accessToken，请确认当前页面已登录。");
      state.session = session;
      state.accessToken = accessToken;
      state.accountInfo = decodeAccessToken(accessToken);
      if (!silent) {
        pushLog(`已读取账号：${state.accountInfo.email || state.accountInfo.accountId || "未知账号"}`, "ok");
      }
      renderRoot();
    } catch (error) {
      state.accessToken = "";
      state.accountInfo = null;
      if (!silent) pushLog(error instanceof Error ? error.message : String(error), "err");
      renderRoot();
    }
  }

  function decodeAccessToken(token) {
    try {
      const payload = JSON.parse(base64UrlDecode(String(token).split(".")[1] || ""));
      const auth = payload["https://api.openai.com/auth"] || {};
      const profile = payload["https://api.openai.com/profile"] || {};
      return {
        accountId: firstText(auth.chatgpt_account_id, auth.account_id),
        userId: firstText(auth.chatgpt_user_id, auth.user_id),
        email: firstText(profile.email, payload.email),
        planType: firstText(auth.chatgpt_plan_type),
        exp: Number(payload.exp || 0),
      };
    } catch {
      return {};
    }
  }

  function base64UrlDecode(value) {
    let normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const remainder = normalized.length % 4;
    if (remainder) normalized += "=".repeat(4 - remainder);
    return decodeURIComponent(
      Array.from(atob(normalized), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
  }

  function firstText(...values) {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text) return text;
    }
    return "";
  }

  function tokenExpiryLabel(exp) {
    if (!exp) return "有效期未知";
    const minutes = Math.round((exp * 1000 - Date.now()) / 60000);
    if (minutes <= 0) return "已过期";
    if (minutes >= 90) return `约 ${Math.round(minutes / 60)} 小时后过期`;
    return `约 ${minutes} 分钟后过期`;
  }

  function enabledWorkspaces() {
    return state.config.workspaces.filter((item) => item.enabled);
  }

  async function ensureAccessToken() {
    if (state.accessToken) return true;
    pushLog("当前没有 accessToken，先刷新 session。", "warn");
    await refreshSession();
    return Boolean(state.accessToken);
  }

  async function joinSelected() {
    if (state.running) {
      pushLog("已有任务运行中。", "warn");
      return;
    }

    const items = enabledWorkspaces();
    if (!items.length) {
      pushLog("没有勾选任何 workspace。", "err");
      return;
    }

    if (!(await ensureAccessToken())) {
      pushLog("仍未获取到 accessToken，请确认 ChatGPT 已登录。", "err");
      return;
    }

    state.running = true;
    renderRoot();
    pushLog(`开始加入：${items.length} 个已勾选 workspace。`, "info");

    let ok = 0;
    for (const [index, workspace] of items.entries()) {
      const success = await sendOne(workspace);
      if (success) ok += 1;
      if (index < items.length - 1) await sleep(state.config.intervalMs);
    }

    pushLog(`完成：成功 ${ok}/${items.length}。`, ok === items.length ? "ok" : "warn");
    state.running = false;
    saveConfig();
    renderRoot();
  }

  async function sendOne(workspace, attempt = 0) {
    const label = workspaceLabel(workspace);
    const url = `/backend-api/accounts/${workspace.id}/invites/${JOIN_ROUTE}`;
    pushLog(`POST ${label}/invites/${JOIN_ROUTE} (${attempt + 1}/${state.config.maxRetries + 1})`, "info");

    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        body: "",
        headers: {
          accept: "*/*",
          authorization: `Bearer ${state.accessToken}`,
          "content-type": "application/json",
          "oai-device-id": state.deviceId,
          "oai-language": navigator.language || "en-US",
        },
      });
      const text = await response.text();
      if (response.ok) {
        markWorkspaceResult(workspace.id, "join", "ok", `HTTP ${response.status}: ${text || "ok"}`);
        pushLog(`${label} HTTP ${response.status}: ${text || "ok"}`, "ok");
        return true;
      }

      const message = `HTTP ${response.status}: ${text.slice(0, 180) || response.statusText}`;
      markWorkspaceResult(workspace.id, "join", "warn", message);
      pushLog(`${label} ${message}`, "warn");
      if ((response.status === 401 || response.status === 403) && attempt < state.config.maxRetries) {
        state.accessToken = "";
        await refreshSession();
        await sleep(1500);
        return sendOne(workspace, attempt + 1);
      }
      if (attempt < state.config.maxRetries) {
        await sleep(state.config.retryBackoffMs * (attempt + 1));
        return sendOne(workspace, attempt + 1);
      }
      return false;
    } catch (error) {
      const message = `网络错误：${error instanceof Error ? error.message : String(error)}`;
      markWorkspaceResult(workspace.id, "join", "err", message);
      pushLog(message, "err");
      if (attempt < state.config.maxRetries) {
        await sleep(state.config.retryBackoffMs);
        return sendOne(workspace, attempt + 1);
      }
      return false;
    }
  }

  function markWorkspaceResult(id, route, status, message) {
    const item = findWorkspace(id);
    if (!item) return;
    item.lastRoute = route;
    item.lastStatus = status;
    item.lastMessage = message;
    item.lastRunAt = new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    saveConfig();
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function pushLog(message, level = "info") {
    state.logs.push({
      message,
      level,
      time: new Date().toLocaleTimeString(),
    });
    if (state.logs.length > 120) state.logs.splice(0, state.logs.length - 120);
    console.log("%c[WorkspaceJoin]", "color:#74f2d6;font-weight:bold", message);
    renderRoot();
  }

  function clearLogs() {
    state.logs = [];
    pushLog("日志已清空。", "info");
  }

  function addOrUpdateWorkspace() {
    const draft = readDraft();
    if (!UUID_PATTERN.test(draft.id)) {
      pushLog("workspace ID 格式不正确。", "err");
      return;
    }

    const existing = findWorkspace(draft.id);
    if (existing && !state.editingId) {
      pushLog("这个 workspace 已存在，已切换到编辑模式。", "warn");
      startEdit(existing.id);
      return;
    }

    if (state.editingId) {
      const editing = findWorkspace(state.editingId);
      if (!editing) {
        state.editingId = "";
      } else {
        const conflict = state.config.workspaces.some((item) => item.id.toLowerCase() === draft.id.toLowerCase() && item.id.toLowerCase() !== state.editingId.toLowerCase());
        if (conflict) {
          pushLog("目标 workspace ID 已存在，不能覆盖另一条记录。", "err");
          return;
        }
        editing.id = draft.id;
        editing.name = draft.name;
        editing.description = draft.description;
        editing.updatedAt = new Date().toISOString();
        state.editingId = "";
        state.draft = emptyDraft();
        saveConfig();
        pushLog(`已更新 workspace：${workspaceLabel(editing)}`, "ok");
        renderRoot();
        return;
      }
    }

    const next = createWorkspace({
      id: draft.id,
      name: draft.name,
      description: draft.description,
      enabled: true,
    });
    state.config.workspaces.push(next);
    state.draft = emptyDraft();
    saveConfig();
    pushLog(`已添加 workspace：${workspaceLabel(next)}`, "ok");
    renderRoot();
  }

  function startEdit(id) {
    const item = findWorkspace(id);
    if (!item) return;
    state.editingId = item.id;
    state.draft = {
      id: item.id,
      name: item.name,
      description: item.description,
    };
    renderRoot();
  }

  function cancelEdit() {
    state.editingId = "";
    state.draft = emptyDraft();
    renderRoot();
  }

  function deleteWorkspace(id) {
    const item = findWorkspace(id);
    state.config.workspaces = state.config.workspaces.filter((workspace) => workspace.id !== id);
    if (state.editingId === id) cancelEdit();
    saveConfig();
    pushLog(`已删除 workspace：${item ? workspaceLabel(item) : id.slice(0, 8)}`, "warn");
    renderRoot();
  }

  function toggleWorkspace(id, enabled) {
    const item = findWorkspace(id);
    if (!item) return;
    item.enabled = enabled;
    item.updatedAt = new Date().toISOString();
    saveConfig();
    renderRoot();
  }

  function setAllWorkspaces(enabled) {
    for (const item of state.config.workspaces) {
      item.enabled = enabled;
      item.updatedAt = new Date().toISOString();
    }
    saveConfig();
    renderRoot();
  }

  function findWorkspace(id) {
    const key = String(id || "").toLowerCase();
    return state.config.workspaces.find((item) => item.id.toLowerCase() === key) || null;
  }

  function workspaceLabel(workspace) {
    return firstText(workspace.name, workspace.description, workspace.id.slice(0, 8));
  }

  function readDraft() {
    const id = fieldValue("wj-id");
    const name = fieldValue("wj-name");
    const description = fieldValue("wj-description");
    state.draft = { id, name, description };
    return state.draft;
  }

  function fieldValue(id) {
    const element = root?.querySelector(`#${id}`);
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value.trim() : "";
  }

  function updateSettingsFromDom() {
    state.config.intervalMs = normalizeNumber(fieldValue("wj-interval"), 300, 60000, state.config.intervalMs);
    state.config.maxRetries = normalizeNumber(fieldValue("wj-retries"), 0, 6, state.config.maxRetries);
    state.config.retryBackoffMs = normalizeNumber(fieldValue("wj-backoff"), 500, 60000, state.config.retryBackoffMs);
    saveConfig();
    pushLog("运行设置已保存。", "ok");
    renderRoot();
  }

  function renderRoot() {
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.addEventListener("click", handleClick);
      root.addEventListener("change", handleChange);
      root.addEventListener("input", handleInput);
      document.body.appendChild(root);
    }
    root.innerHTML = state.open ? renderPanel() : renderTrigger();
    scrollLogToBottom();
  }

  function scrollLogToBottom() {
    const log = root?.querySelector(".wj-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  function renderTrigger() {
    const total = state.config.workspaces.length;
    const enabled = enabledWorkspaces().length;
    return `
      <button class="wj-trigger" type="button" data-action="open" aria-label="Open Workspace Join Request">
        <span class="wj-trigger-icon" aria-hidden="true">${iconSvg()}</span>
        <span>
          <strong>Workspace</strong>
          <em>${total ? `已启用 ${enabled}/${total}` : "加入管理器"}</em>
        </span>
      </button>
    `;
  }

  function renderPanel() {
    const info = state.accountInfo || {};
    const statusClass = state.accessToken ? "is-ok" : "is-warn";
    const enabledCount = enabledWorkspaces().length;
    return `
      <section class="wj-panel" aria-label="ChatGPT Workspace Join Request">
        <header class="wj-head">
          <div class="wj-brand">
            <span class="wj-logo" aria-hidden="true">${iconSvg()}</span>
            <div>
              <h2>Workspace 加入管理</h2>
              <p>本地缓存 workspace，勾选后手动发送加入请求。</p>
            </div>
          </div>
          <button class="wj-close" type="button" data-action="close" aria-label="Close">×</button>
        </header>

        <section class="wj-account ${statusClass}">
          <span class="wj-dot" aria-hidden="true"></span>
          <div>
            <strong>${escapeHtml(info.email || info.accountId || "未读取到账号")}</strong>
            <span>${escapeHtml(info.planType || "套餐未知")} · ${escapeHtml(tokenExpiryLabel(info.exp))}</span>
          </div>
        </section>

        <section class="wj-section">
          <div class="wj-section-title">
            <strong>${state.editingId ? "编辑 Workspace" : "添加 Workspace"}</strong>
            <span>保存在当前浏览器 localStorage</span>
          </div>
          <label class="wj-field">
            <span>Workspace ID</span>
            <input id="wj-id" value="${escapeAttr(state.draft.id)}" placeholder="acfb4e38-524c-4dc8-b4cf-fb3d0ce28b25" spellcheck="false">
          </label>
          <label class="wj-field">
            <span>名称</span>
            <input id="wj-name" value="${escapeAttr(state.draft.name)}" placeholder="例如：主号 / Team A / 临时邀请">
          </label>
          <label class="wj-field">
            <span>描述</span>
            <textarea id="wj-description" spellcheck="false" placeholder="记录用途、来源、注意事项，方便下次勾选。">${escapeHtml(state.draft.description)}</textarea>
          </label>
          <div class="wj-row">
            <button class="wj-button is-primary" type="button" data-action="add">${state.editingId ? "保存修改" : "添加并启用"}</button>
            ${state.editingId ? `<button class="wj-button is-subtle" type="button" data-action="cancel-edit">取消编辑</button>` : ""}
          </div>
        </section>

        <section class="wj-section">
          <div class="wj-section-title">
            <strong>Workspace 列表</strong>
            <span>已启用 ${enabledCount}/${state.config.workspaces.length}</span>
          </div>
          <div class="wj-row">
            <button class="wj-button is-subtle" type="button" data-action="enable-all">全选</button>
            <button class="wj-button is-subtle" type="button" data-action="disable-all">全不选</button>
            <button class="wj-button is-subtle" type="button" data-action="refresh">刷新 session</button>
          </div>
          <div class="wj-workspace-list">
            ${state.config.workspaces.length ? state.config.workspaces.map(renderWorkspace).join("") : `<div class="wj-empty">还没有 workspace。先添加 ID 和描述。</div>`}
          </div>
        </section>

        <section class="wj-settings">
          <label>
            <span>间隔 ms</span>
            <input id="wj-interval" type="number" min="300" step="100" value="${state.config.intervalMs}">
          </label>
          <label>
            <span>重试</span>
            <input id="wj-retries" type="number" min="0" max="6" step="1" value="${state.config.maxRetries}">
          </label>
          <label>
            <span>退避 ms</span>
            <input id="wj-backoff" type="number" min="500" step="500" value="${state.config.retryBackoffMs}">
          </label>
          <button class="wj-button is-subtle" type="button" data-action="save-settings">保存设置</button>
        </section>

        <section class="wj-actions">
          <button class="wj-button is-primary" type="button" data-action="join" ${state.running ? "disabled" : ""}>加入选中空间</button>
          <button class="wj-button is-ghost" type="button" data-action="clear">清空日志</button>
        </section>

        <section class="wj-log" aria-label="Run logs">
          ${state.logs.length ? state.logs.map(renderLog).join("") : `<div class="wj-empty">暂无日志</div>`}
        </section>
      </section>
    `;
  }

  function renderWorkspace(workspace) {
    const status = workspace.lastStatus || "idle";
    return `
      <article class="wj-workspace is-${escapeAttr(status)}">
        <label class="wj-check">
          <input type="checkbox" data-toggle="${escapeAttr(workspace.id)}" ${workspace.enabled ? "checked" : ""}>
          <span></span>
        </label>
        <div class="wj-workspace-main">
          <div class="wj-workspace-head">
            <strong>${escapeHtml(workspaceLabel(workspace))}</strong>
            <code>${escapeHtml(shortId(workspace.id))}</code>
          </div>
          ${workspace.description ? `<p>${escapeHtml(workspace.description)}</p>` : `<p class="is-muted">无描述</p>`}
          <div class="wj-workspace-meta">
            <span>${workspace.enabled ? "已启用" : "未启用"}</span>
            <span>${escapeHtml(lastStatusLabel(workspace))}</span>
          </div>
        </div>
        <div class="wj-workspace-actions">
          <button type="button" data-action="edit" data-id="${escapeAttr(workspace.id)}">编辑</button>
          <button type="button" data-action="delete" data-id="${escapeAttr(workspace.id)}">删除</button>
        </div>
      </article>
    `;
  }

  function renderLog(item) {
    return `<div class="wj-log-line is-${escapeAttr(item.level)}"><span>${escapeHtml(item.time)}</span>${escapeHtml(item.message)}</div>`;
  }

  function shortId(id) {
    return `${id.slice(0, 8)}...${id.slice(-4)}`;
  }

  function lastStatusLabel(workspace) {
    if (!workspace.lastStatus) return "未运行";
    const time = workspace.lastRunAt ? new Date(workspace.lastRunAt).toLocaleTimeString() : "";
    const route = workspace.lastRoute === "join" ? "加入" : "运行";
    const statusMap = {
      ok: "成功",
      warn: "未完成",
      err: "失败",
    };
    return `${route}${statusMap[workspace.lastStatus] || workspace.lastStatus}${time ? ` · ${time}` : ""}`;
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const actionTarget = target.closest("[data-action]");
    const action = actionTarget?.getAttribute("data-action") || "";
    if (!action) return;

    if (action === "open") {
      state.open = true;
      renderRoot();
      return;
    }
    if (action === "close") {
      state.open = false;
      renderRoot();
      return;
    }
    if (action === "add") {
      addOrUpdateWorkspace();
      return;
    }
    if (action === "cancel-edit") {
      cancelEdit();
      return;
    }
    if (action === "edit") {
      startEdit(actionTarget.getAttribute("data-id") || "");
      return;
    }
    if (action === "delete") {
      deleteWorkspace(actionTarget.getAttribute("data-id") || "");
      return;
    }
    if (action === "enable-all") {
      setAllWorkspaces(true);
      return;
    }
    if (action === "disable-all") {
      setAllWorkspaces(false);
      return;
    }
    if (action === "refresh") {
      void refreshSession();
      return;
    }
    if (action === "save-settings") {
      updateSettingsFromDom();
      return;
    }
    if (action === "join") {
      void joinSelected();
      return;
    }
    if (action === "clear") clearLogs();
  }

  function handleChange(event) {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches("[data-toggle]")) {
      toggleWorkspace(target.getAttribute("data-toggle") || "", target.checked);
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (target.id === "wj-id" || target.id === "wj-name" || target.id === "wj-description") {
        state.draft = {
          id: fieldValue("wj-id"),
          name: fieldValue("wj-name"),
          description: fieldValue("wj-description"),
        };
      }
    }
  }

  function parseIdText(value) {
    return String(value || "")
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function iconSvg() {
    return `
      <svg viewBox="0 0 24 24" role="img">
        <path d="M7 8.2h10M7 12h6M7 15.8h4"></path>
        <path d="M5.5 4.5h13A2.5 2.5 0 0 1 21 7v8.5a2.5 2.5 0 0 1-2.5 2.5H13l-4.4 3v-3H5.5A2.5 2.5 0 0 1 3 15.5V7a2.5 2.5 0 0 1 2.5-2.5Z"></path>
      </svg>
    `;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}, #${ROOT_ID} * {
        box-sizing: border-box;
      }
      #${ROOT_ID} {
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 2147483647;
        color: #e7edf4;
        font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${ROOT_ID} button,
      #${ROOT_ID} input,
      #${ROOT_ID} textarea {
        font: inherit;
      }
      #${ROOT_ID} svg {
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      #${ROOT_ID} .wj-trigger {
        min-width: 132px;
        min-height: 46px;
        border: 1px solid rgba(114, 133, 153, 0.38);
        border-radius: 999px;
        padding: 7px 13px 7px 8px;
        display: inline-flex;
        align-items: center;
        gap: 9px;
        color: #f8fafc;
        background: linear-gradient(180deg, rgba(18, 25, 35, 0.94), rgba(8, 12, 18, 0.94));
        box-shadow: 0 16px 42px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06);
        backdrop-filter: blur(16px);
        cursor: pointer;
      }
      #${ROOT_ID} .wj-trigger:hover {
        border-color: rgba(116, 242, 214, 0.7);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.34), 0 0 0 4px rgba(116, 242, 214, 0.08);
        transform: translateY(-1px);
      }
      #${ROOT_ID} .wj-trigger-icon,
      #${ROOT_ID} .wj-logo {
        border: 1px solid rgba(116, 242, 214, 0.34);
        display: grid;
        place-items: center;
        color: #74f2d6;
        background: rgba(116, 242, 214, 0.09);
        flex: none;
      }
      #${ROOT_ID} .wj-trigger-icon {
        width: 30px;
        height: 30px;
        border-radius: 999px;
      }
      #${ROOT_ID} .wj-trigger strong,
      #${ROOT_ID} .wj-trigger em {
        display: block;
        font-style: normal;
        text-align: left;
      }
      #${ROOT_ID} .wj-trigger strong {
        font-weight: 850;
        line-height: 1.1;
      }
      #${ROOT_ID} .wj-trigger em {
        margin-top: 2px;
        color: #91a4b8;
        font-size: 11px;
      }
      #${ROOT_ID} .wj-panel {
        width: min(560px, calc(100vw - 32px));
        max-height: min(760px, calc(100vh - 44px));
        border: 1px solid rgba(114, 133, 153, 0.28);
        border-radius: 18px;
        padding: 14px;
        overflow: auto;
        background:
          radial-gradient(circle at 0% 0%, rgba(116, 242, 214, 0.14), transparent 32%),
          linear-gradient(145deg, rgba(13, 19, 28, 0.98), rgba(7, 11, 17, 0.98));
        box-shadow: 0 28px 80px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.05);
        backdrop-filter: blur(20px);
      }
      #${ROOT_ID} .wj-head {
        border-bottom: 1px solid rgba(114, 133, 153, 0.16);
        padding-bottom: 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      #${ROOT_ID} .wj-brand {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 11px;
      }
      #${ROOT_ID} .wj-logo {
        width: 38px;
        height: 38px;
        border-radius: 13px;
      }
      #${ROOT_ID} h2,
      #${ROOT_ID} p {
        margin: 0;
      }
      #${ROOT_ID} h2 {
        color: #f8fafc;
        font-size: 17px;
        line-height: 1.2;
      }
      #${ROOT_ID} .wj-brand p {
        margin-top: 3px;
        color: #91a4b8;
        font-size: 12px;
      }
      #${ROOT_ID} .wj-close {
        width: 30px;
        height: 30px;
        border: 1px solid rgba(114, 133, 153, 0.22);
        border-radius: 10px;
        color: #91a4b8;
        background: rgba(9, 14, 21, 0.72);
        cursor: pointer;
        font-size: 18px;
      }
      #${ROOT_ID} .wj-close:hover {
        border-color: rgba(116, 242, 214, 0.46);
        color: #f8fafc;
        background: rgba(116, 242, 214, 0.08);
      }
      #${ROOT_ID} .wj-account,
      #${ROOT_ID} .wj-section,
      #${ROOT_ID} .wj-settings,
      #${ROOT_ID} .wj-log {
        margin-top: 12px;
        border: 1px solid rgba(114, 133, 153, 0.18);
        border-radius: 14px;
        background: rgba(5, 9, 14, 0.54);
      }
      #${ROOT_ID} .wj-account {
        min-height: 56px;
        padding: 11px 12px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #${ROOT_ID} .wj-dot {
        width: 9px;
        height: 9px;
        border-radius: 999px;
        background: #f6c85f;
        box-shadow: 0 0 0 4px rgba(246, 200, 95, 0.12);
      }
      #${ROOT_ID} .wj-account.is-ok .wj-dot {
        background: #74f2d6;
        box-shadow: 0 0 0 4px rgba(116, 242, 214, 0.12);
      }
      #${ROOT_ID} .wj-account strong,
      #${ROOT_ID} .wj-account span {
        display: block;
      }
      #${ROOT_ID} .wj-account strong {
        color: #f8fafc;
        font-size: 13px;
      }
      #${ROOT_ID} .wj-account span {
        color: #91a4b8;
        font-size: 12px;
      }
      #${ROOT_ID} .wj-section {
        padding: 12px;
      }
      #${ROOT_ID} .wj-section-title {
        margin-bottom: 10px;
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      #${ROOT_ID} .wj-section-title strong {
        color: #f8fafc;
        font-size: 13px;
      }
      #${ROOT_ID} .wj-section-title span {
        color: #91a4b8;
        font-size: 12px;
      }
      #${ROOT_ID} .wj-field {
        margin-top: 8px;
        display: grid;
        gap: 5px;
      }
      #${ROOT_ID} .wj-field span,
      #${ROOT_ID} .wj-settings span {
        color: #74f2d6;
        font: 850 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-transform: uppercase;
      }
      #${ROOT_ID} input,
      #${ROOT_ID} textarea {
        width: 100%;
        border: 1px solid rgba(114, 133, 153, 0.26);
        border-radius: 11px;
        padding: 9px 10px;
        color: #e7edf4;
        background: rgba(3, 7, 12, 0.62);
        outline: 0;
      }
      #${ROOT_ID} textarea {
        min-height: 58px;
        resize: vertical;
      }
      #${ROOT_ID} input:focus,
      #${ROOT_ID} textarea:focus {
        border-color: rgba(116, 242, 214, 0.6);
        box-shadow: 0 0 0 4px rgba(116, 242, 214, 0.08);
      }
      #${ROOT_ID} .wj-row,
      #${ROOT_ID} .wj-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #${ROOT_ID} .wj-row {
        margin-top: 9px;
        justify-content: flex-end;
      }
      #${ROOT_ID} .wj-workspace-list {
        margin-top: 10px;
        display: grid;
        gap: 8px;
        max-height: 230px;
        overflow: auto;
      }
      #${ROOT_ID} .wj-workspace {
        border: 1px solid rgba(114, 133, 153, 0.2);
        border-radius: 13px;
        padding: 10px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        background: rgba(8, 13, 19, 0.64);
      }
      #${ROOT_ID} .wj-workspace.is-ok {
        border-color: rgba(116, 242, 214, 0.35);
      }
      #${ROOT_ID} .wj-workspace.is-warn {
        border-color: rgba(246, 200, 95, 0.35);
      }
      #${ROOT_ID} .wj-workspace.is-err {
        border-color: rgba(253, 164, 175, 0.35);
      }
      #${ROOT_ID} .wj-check {
        padding-top: 3px;
      }
      #${ROOT_ID} .wj-check input {
        width: 17px;
        height: 17px;
        accent-color: #74f2d6;
      }
      #${ROOT_ID} .wj-workspace-main {
        min-width: 0;
      }
      #${ROOT_ID} .wj-workspace-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #${ROOT_ID} .wj-workspace-head strong {
        overflow: hidden;
        color: #f8fafc;
        font-size: 13px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} code {
        border: 1px solid rgba(116, 242, 214, 0.18);
        border-radius: 999px;
        padding: 2px 6px;
        color: #9bf8e5;
        background: rgba(116, 242, 214, 0.08);
        font: 800 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} .wj-workspace p {
        margin: 5px 0 0;
        color: #b8c6d8;
        font-size: 12px;
        word-break: break-word;
      }
      #${ROOT_ID} .wj-workspace p.is-muted {
        color: #607083;
      }
      #${ROOT_ID} .wj-workspace-meta {
        margin-top: 7px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      #${ROOT_ID} .wj-workspace-meta span {
        border: 1px solid rgba(114, 133, 153, 0.18);
        border-radius: 999px;
        padding: 2px 6px;
        color: #91a4b8;
        font-size: 11px;
      }
      #${ROOT_ID} .wj-workspace-actions {
        display: grid;
        align-content: start;
        gap: 6px;
      }
      #${ROOT_ID} .wj-workspace-actions button {
        min-height: 28px;
        border: 1px solid rgba(114, 133, 153, 0.22);
        border-radius: 8px;
        padding: 0 8px;
        color: #b8c6d8;
        background: rgba(9, 14, 21, 0.7);
        cursor: pointer;
        font-size: 12px;
      }
      #${ROOT_ID} .wj-workspace-actions button:hover {
        border-color: rgba(116, 242, 214, 0.45);
        color: #74f2d6;
      }
      #${ROOT_ID} .wj-settings {
        padding: 10px;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        align-items: end;
      }
      #${ROOT_ID} .wj-settings label {
        display: grid;
        gap: 5px;
      }
      #${ROOT_ID} .wj-actions {
        margin-top: 12px;
      }
      #${ROOT_ID} .wj-button {
        min-height: 36px;
        border: 1px solid rgba(114, 133, 153, 0.24);
        border-radius: 11px;
        padding: 0 13px;
        color: #e7edf4;
        background: rgba(9, 14, 21, 0.7);
        cursor: pointer;
        font-weight: 820;
      }
      #${ROOT_ID} .wj-button:hover:not(:disabled) {
        transform: translateY(-1px);
      }
      #${ROOT_ID} .wj-button:disabled {
        cursor: not-allowed;
        opacity: 0.48;
      }
      #${ROOT_ID} .wj-button.is-primary {
        border-color: rgba(116, 242, 214, 0.58);
        color: #06110f;
        background: #74f2d6;
      }
      #${ROOT_ID} .wj-button.is-subtle:hover,
      #${ROOT_ID} .wj-button.is-ghost:hover {
        border-color: rgba(116, 242, 214, 0.5);
        color: #74f2d6;
        background: rgba(116, 242, 214, 0.08);
      }
      #${ROOT_ID} .wj-log {
        height: 150px;
        padding: 8px 10px;
        overflow: auto;
        font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} .wj-log-line {
        border-bottom: 1px dashed rgba(114, 133, 153, 0.14);
        padding: 4px 0;
        color: #b8c6d8;
        word-break: break-word;
      }
      #${ROOT_ID} .wj-log-line span {
        margin-right: 8px;
        color: #607083;
      }
      #${ROOT_ID} .wj-log-line.is-ok {
        color: #74f2d6;
      }
      #${ROOT_ID} .wj-log-line.is-warn {
        color: #f6c85f;
      }
      #${ROOT_ID} .wj-log-line.is-err {
        color: #fda4af;
      }
      #${ROOT_ID} .wj-empty {
        padding: 34px 0;
        color: #607083;
        text-align: center;
      }
      @media (max-width: 620px) {
        #${ROOT_ID} {
          right: 12px;
          bottom: 12px;
        }
        #${ROOT_ID} .wj-panel {
          width: calc(100vw - 24px);
        }
        #${ROOT_ID} .wj-workspace {
          grid-template-columns: auto minmax(0, 1fr);
        }
        #${ROOT_ID} .wj-workspace-actions {
          grid-column: 2;
          grid-template-columns: repeat(2, auto);
          justify-content: start;
        }
        #${ROOT_ID} .wj-settings {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `;
    document.documentElement.appendChild(style);
  }
})();
