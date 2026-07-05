// ==UserScript==
// @name         API Capture Assistant
// @namespace    https://almoststable.com/userscripts/
// @version      0.1.0
// @description  Local fetch/XHR API inbox with request, response, curl, JSON copy helpers. Data stays in the current page.
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const ROOT_ID = "qx-api-capture-root";
  const STYLE_ID = "qx-api-capture-style";
  const STORAGE_KEY = "qx_api_capture_settings_v1";
  const MAX_RECORDS = 120;
  const MAX_BODY_CHARS = 64000;
  const MAX_RENDER_BODY_CHARS = 16000;
  const SLOW_MS = 1200;
  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const sensitiveHeaderNames = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "x-csrf-token",
    "x-xsrf-token",
    "x-auth-token",
  ]);
  const sensitiveKeyPattern = /(token|secret|password|passwd|pwd|cookie|authorization|credential|apikey|api_key|access[_-]?key|session)/i;

  const state = {
    open: false,
    paused: false,
    filter: "all",
    query: "",
    selectedId: "",
    tab: "response",
    unsafeCopy: false,
    records: [],
  };

  let idSeed = 0;
  let renderQueued = false;
  let root = null;

  loadSettings();
  patchFetch();
  patchXHR();
  installKeyboardShortcut();
  whenReady(injectPanel);

  function loadSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.unsafeCopy = Boolean(settings.unsafeCopy);
    } catch {
      state.unsafeCopy = false;
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          unsafeCopy: state.unsafeCopy,
        }),
      );
    } catch {
      // Ignore storage failures on strict pages.
    }
  }

  function nextId() {
    idSeed += 1;
    return `qx-api-${Date.now().toString(36)}-${idSeed.toString(36)}`;
  }

  function nowTime() {
    return performance.now ? performance.now() : Date.now();
  }

  function wallTime() {
    const date = new Date();
    return date.toTimeString().slice(0, 8);
  }

  function whenReady(callback) {
    if (document.body) {
      callback();
      return;
    }
    document.addEventListener("DOMContentLoaded", callback, { once: true });
    window.addEventListener("load", callback, { once: true });
  }

  function scheduleRender() {
    if (!root || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function shouldIgnoreUrl(url) {
    const text = String(url || "");
    return (
      !text ||
      text.startsWith("data:") ||
      text.startsWith("blob:") ||
      text.startsWith("about:") ||
      text.startsWith("chrome:") ||
      text.startsWith("chrome-extension:")
    );
  }

  function parseUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return {
        url: parsed.href,
        host: parsed.host,
        path: `${parsed.pathname}${parsed.search}`,
      };
    } catch {
      return {
        url: String(url || ""),
        host: "",
        path: String(url || ""),
      };
    }
  }

  function headersToEntries(headers) {
    const entries = [];
    if (!headers) return entries;
    try {
      if (isInstance(headers, "Headers")) {
        headers.forEach((value, key) => entries.push([key, value]));
      } else if (Array.isArray(headers)) {
        for (const item of headers) {
          if (Array.isArray(item) && item.length >= 2) entries.push([String(item[0]), String(item[1])]);
        }
      } else if (typeof headers === "object") {
        for (const [key, value] of Object.entries(headers)) {
          entries.push([key, Array.isArray(value) ? value.join(", ") : String(value)]);
        }
      }
    } catch {
      // Some host objects throw when enumerated.
    }
    return entries;
  }

  function mergeHeaders(...headerSets) {
    const map = new Map();
    for (const headers of headerSets) {
      for (const [key, value] of headersToEntries(headers)) {
        map.set(key.toLowerCase(), { key, value });
      }
    }
    return Array.from(map.values());
  }

  function parseResponseHeaders(rawHeaders) {
    return String(rawHeaders || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(":");
        if (index < 0) return [line.trim(), ""];
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      });
  }

  function bodyToPreview(body) {
    if (body == null) return "";
    if (typeof body === "string") return truncateText(body);
    if (isInstance(body, "URLSearchParams")) return truncateText(body.toString());
    if (isInstance(body, "FormData")) {
      const lines = [];
      body.forEach((value, key) => {
        if (isInstance(value, "File")) {
          lines.push(`${key}: [File ${value.name}, ${value.type || "application/octet-stream"}, ${value.size} bytes]`);
        } else {
          lines.push(`${key}: ${String(value)}`);
        }
      });
      return truncateText(lines.join("\n"));
    }
    if (isInstance(body, "Blob")) {
      return `[Blob ${body.type || "application/octet-stream"}, ${body.size} bytes]`;
    }
    if (isInstance(body, "ArrayBuffer")) {
      return `[ArrayBuffer ${body.byteLength} bytes]`;
    }
    if (ArrayBuffer.isView(body)) {
      return `[${body.constructor.name} ${body.byteLength} bytes]`;
    }
    try {
      return truncateText(JSON.stringify(body, null, 2));
    } catch {
      return `[${Object.prototype.toString.call(body)}]`;
    }
  }

  function truncateText(value) {
    const text = String(value ?? "");
    if (text.length <= MAX_BODY_CHARS) return text;
    return `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated ${text.length - MAX_BODY_CHARS} chars]`;
  }

  function isReadableContentType(contentType) {
    const type = String(contentType || "").toLowerCase();
    return (
      !type ||
      type.includes("json") ||
      type.includes("text") ||
      type.includes("xml") ||
      type.includes("html") ||
      type.includes("javascript") ||
      type.includes("graphql") ||
      type.includes("x-www-form-urlencoded")
    );
  }

  async function readFetchResponseBody(response) {
    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (!isReadableContentType(contentType)) {
      return `[${contentType || response.type || "binary"} response not previewed]`;
    }
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_CHARS * 4) {
      return `[response is ${contentLength} bytes, skipped locally]`;
    }
    try {
      return truncateText(await response.clone().text());
    } catch (error) {
      return `[response preview failed: ${error instanceof Error ? error.message : String(error)}]`;
    }
  }

  function snapshotFetch(input, init) {
    const isRequest = isInstance(input, "Request");
    const urlInfo = parseUrl(isRequest ? input.url : String(input));
    const method = String(init?.method || (isRequest ? input.method : "GET") || "GET").toUpperCase();
    const requestHeaders = mergeHeaders(isRequest ? input.headers : null, init?.headers);
    let requestBody = bodyToPreview(init?.body);
    if (!requestBody && isRequest && !["GET", "HEAD"].includes(method)) {
      requestBody = "[Request body stream not copied]";
    }
    return {
      method,
      url: urlInfo.url,
      host: urlInfo.host,
      path: urlInfo.path,
      requestHeaders,
      requestBody,
    };
  }

  function createRecord(base) {
    return {
      id: nextId(),
      type: base.type,
      method: base.method,
      url: base.url,
      host: base.host,
      path: base.path,
      status: "pending",
      statusText: "",
      ok: false,
      duration: 0,
      startedAt: nowTime(),
      timeLabel: wallTime(),
      requestHeaders: base.requestHeaders || [],
      requestBody: base.requestBody || "",
      responseHeaders: [],
      responseBody: "",
      contentType: "",
      error: "",
    };
  }

  function addRecord(record) {
    if (state.paused || shouldIgnoreUrl(record.url)) return null;
    state.records.unshift(record);
    if (state.records.length > MAX_RECORDS) state.records.length = MAX_RECORDS;
    if (!state.selectedId) state.selectedId = record.id;
    scheduleRender();
    return record;
  }

  function finishRecord(record, patch) {
    if (!record) return;
    Object.assign(record, patch, {
      duration: Math.max(0, Math.round(nowTime() - record.startedAt)),
    });
    scheduleRender();
  }

  function patchFetch() {
    const originalFetch = pageWindow.fetch;
    if (typeof originalFetch !== "function" || originalFetch.__qxApiCapturePatched) return;

    function capturedFetch(input, init) {
      const snapshot = snapshotFetch(input, init);
      const record = addRecord(
        createRecord({
          ...snapshot,
          type: "fetch",
        }),
      );

      return originalFetch.apply(this, arguments).then(
        (response) => {
          finishRecord(record, {
            status: response.status,
            statusText: response.statusText || "",
            ok: response.ok,
            responseHeaders: headersToEntries(response.headers),
            contentType: response.headers.get("content-type") || "",
          });
          if (record) {
            readFetchResponseBody(response).then((body) => {
              finishRecord(record, { responseBody: body });
            });
          }
          return response;
        },
        (error) => {
          finishRecord(record, {
            status: "ERR",
            statusText: "fetch failed",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        },
      );
    }

    capturedFetch.__qxApiCapturePatched = true;
    capturedFetch.__qxApiCaptureOriginal = originalFetch;
    pageWindow.fetch = capturedFetch;
  }

  function patchXHR() {
    const proto = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
    if (!proto || proto.__qxApiCapturePatched) return;

    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetRequestHeader = proto.setRequestHeader;

    proto.open = function (method, url) {
      const urlInfo = parseUrl(url);
      this.__qxApiCapture = {
        method: String(method || "GET").toUpperCase(),
        url: urlInfo.url,
        host: urlInfo.host,
        path: urlInfo.path,
        requestHeaders: [],
        record: null,
      };
      return originalOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function (key, value) {
      if (this.__qxApiCapture) {
        this.__qxApiCapture.requestHeaders.push([String(key), String(value)]);
      }
      return originalSetRequestHeader.apply(this, arguments);
    };

    proto.send = function (body) {
      const meta = this.__qxApiCapture;
      if (meta && !shouldIgnoreUrl(meta.url)) {
        meta.record = addRecord(
          createRecord({
            type: "xhr",
            method: meta.method,
            url: meta.url,
            host: meta.host,
            path: meta.path,
            requestHeaders: meta.requestHeaders,
            requestBody: bodyToPreview(body),
          }),
        );
        this.addEventListener(
          "loadend",
          () => {
            const record = meta.record;
            if (!record) return;
            let responseBody = "";
            try {
              if (!this.responseType || this.responseType === "text") {
                responseBody = truncateText(this.responseText || "");
              } else if (this.responseType === "json") {
                responseBody = truncateText(JSON.stringify(this.response, null, 2));
              } else {
                responseBody = `[XHR ${this.responseType} response not previewed]`;
              }
            } catch (error) {
              responseBody = `[response preview failed: ${error instanceof Error ? error.message : String(error)}]`;
            }
            const responseHeaders = parseResponseHeaders(this.getAllResponseHeaders());
            const contentType = headerValue(responseHeaders, "content-type");
            finishRecord(record, {
              status: this.status || "ERR",
              statusText: this.statusText || "",
              ok: this.status >= 200 && this.status < 300,
              responseHeaders,
              responseBody,
              contentType,
              error: this.status ? "" : "XHR failed or was blocked",
            });
          },
          { once: true },
        );
      }
      return originalSend.apply(this, arguments);
    };

    proto.__qxApiCapturePatched = true;
  }

  function installKeyboardShortcut() {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.altKey && event.shiftKey && event.code === "KeyA") {
          event.preventDefault();
          state.open = !state.open;
          scheduleRender();
        }
      },
      true,
    );
  }

  function injectPanel() {
    if (document.getElementById(ROOT_ID)) return;
    installStyle();
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
    root.addEventListener("click", handleClick);
    root.addEventListener("input", handleInput);
    render();
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
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        color: #eef6ff;
        font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${ROOT_ID} button,
      #${ROOT_ID} input {
        font: inherit;
      }
      #${ROOT_ID} button {
        cursor: pointer;
      }
      #${ROOT_ID} .qx-api-trigger {
        min-width: 128px;
        height: 44px;
        border: 1px solid rgba(112, 243, 214, 0.6);
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: #06110f;
        background: linear-gradient(135deg, #86f7df, #ffd76a);
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
        font-weight: 900;
      }
      #${ROOT_ID} .qx-api-trigger span {
        border-radius: 999px;
        padding: 2px 7px;
        color: #86f7df;
        background: rgba(3, 10, 15, 0.88);
        font: 900 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} .qx-api-trigger strong {
        font-size: 13px;
      }
      #${ROOT_ID} .qx-api-panel {
        width: min(940px, calc(100vw - 28px));
        height: min(720px, calc(100vh - 28px));
        border: 1px solid rgba(128, 151, 174, 0.34);
        border-radius: 16px;
        overflow: hidden;
        background:
          radial-gradient(circle at 16% 0%, rgba(112, 243, 214, 0.16), transparent 32%),
          linear-gradient(145deg, rgba(8, 13, 19, 0.97), rgba(11, 18, 29, 0.97));
        box-shadow: 0 26px 88px rgba(0, 0, 0, 0.48);
        backdrop-filter: blur(18px);
      }
      #${ROOT_ID} .qx-api-panel-head {
        min-height: 82px;
        border-bottom: 1px solid rgba(128, 151, 174, 0.2);
        padding: 16px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 14px;
        align-items: start;
      }
      #${ROOT_ID} .qx-api-title {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      #${ROOT_ID} .qx-api-mark {
        width: 42px;
        height: 42px;
        border: 1px solid rgba(112, 243, 214, 0.54);
        border-radius: 11px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #86f7df;
        background: rgba(112, 243, 214, 0.1);
        font: 900 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} h2,
      #${ROOT_ID} h3,
      #${ROOT_ID} p {
        margin: 0;
      }
      #${ROOT_ID} h2 {
        color: #fffaf0;
        font-size: 18px;
        line-height: 1.18;
      }
      #${ROOT_ID} .qx-api-subtitle {
        margin-top: 4px;
        color: #9eb0c5;
        font-size: 12px;
      }
      #${ROOT_ID} .qx-api-badges,
      #${ROOT_ID} .qx-api-actions,
      #${ROOT_ID} .qx-api-filters,
      #${ROOT_ID} .qx-api-copy-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #${ROOT_ID} .qx-api-badges {
        justify-content: flex-end;
      }
      #${ROOT_ID} .qx-api-badge {
        min-height: 34px;
        border: 1px solid rgba(128, 151, 174, 0.24);
        border-radius: 999px;
        padding: 7px 10px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: #aabed4;
        background: rgba(5, 9, 14, 0.56);
        font-size: 12px;
      }
      #${ROOT_ID} .qx-api-badge strong {
        color: #ffd76a;
      }
      #${ROOT_ID} .qx-api-toolbar {
        border-bottom: 1px solid rgba(128, 151, 174, 0.16);
        padding: 12px 16px;
        display: grid;
        grid-template-columns: minmax(180px, 1fr) auto;
        gap: 10px;
        align-items: center;
      }
      #${ROOT_ID} .qx-api-search {
        height: 38px;
        border: 1px solid rgba(128, 151, 174, 0.32);
        border-radius: 10px;
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 8px;
        padding: 0 11px;
        color: #86f7df;
        background: rgba(3, 8, 13, 0.72);
      }
      #${ROOT_ID} .qx-api-search input {
        min-width: 0;
        border: 0;
        outline: 0;
        color: #eef6ff;
        background: transparent;
      }
      #${ROOT_ID} .qx-api-search input::placeholder {
        color: #66788e;
      }
      #${ROOT_ID} .qx-api-button,
      #${ROOT_ID} .qx-api-filter,
      #${ROOT_ID} .qx-api-close {
        min-height: 34px;
        border: 1px solid rgba(128, 151, 174, 0.28);
        border-radius: 9px;
        padding: 0 11px;
        color: #c2d3e6;
        background: rgba(6, 11, 17, 0.7);
      }
      #${ROOT_ID} .qx-api-button:hover,
      #${ROOT_ID} .qx-api-filter:hover,
      #${ROOT_ID} .qx-api-filter.is-active {
        border-color: rgba(112, 243, 214, 0.7);
        color: #86f7df;
        background: rgba(112, 243, 214, 0.1);
      }
      #${ROOT_ID} .qx-api-button.is-danger:hover {
        border-color: rgba(251, 113, 133, 0.72);
        color: #fda4af;
        background: rgba(251, 113, 133, 0.1);
      }
      #${ROOT_ID} .qx-api-close {
        width: 36px;
        padding: 0;
        color: #8fa3ba;
        font-size: 18px;
      }
      #${ROOT_ID} .qx-api-main {
        height: calc(100% - 143px);
        display: grid;
        grid-template-columns: minmax(280px, 38%) minmax(0, 1fr);
      }
      #${ROOT_ID} .qx-api-list {
        border-right: 1px solid rgba(128, 151, 174, 0.18);
        overflow: auto;
      }
      #${ROOT_ID} .qx-api-row {
        width: 100%;
        min-height: 76px;
        border: 0;
        border-bottom: 1px solid rgba(128, 151, 174, 0.13);
        padding: 11px 13px;
        display: grid;
        gap: 7px;
        color: #dbe8f5;
        background: transparent;
        text-align: left;
      }
      #${ROOT_ID} .qx-api-row:hover,
      #${ROOT_ID} .qx-api-row.is-selected {
        background: rgba(112, 243, 214, 0.08);
      }
      #${ROOT_ID} .qx-api-row-top,
      #${ROOT_ID} .qx-api-row-meta {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #${ROOT_ID} .qx-api-row-top {
        justify-content: space-between;
      }
      #${ROOT_ID} .qx-api-method,
      #${ROOT_ID} .qx-api-status,
      #${ROOT_ID} .qx-api-chip {
        border-radius: 7px;
        padding: 3px 6px;
        font: 900 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} .qx-api-method {
        color: #08110f;
        background: #86f7df;
      }
      #${ROOT_ID} .qx-api-status {
        color: #08110f;
        background: #ffd76a;
      }
      #${ROOT_ID} .qx-api-status.is-ok {
        background: #86f7df;
      }
      #${ROOT_ID} .qx-api-status.is-error {
        color: #fff7f7;
        background: #ef476f;
      }
      #${ROOT_ID} .qx-api-url {
        min-width: 0;
        overflow: hidden;
        color: #fffaf0;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .qx-api-row-meta {
        color: #8fa3ba;
        font-size: 12px;
      }
      #${ROOT_ID} .qx-api-latency {
        position: relative;
        height: 5px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(128, 151, 174, 0.18);
      }
      #${ROOT_ID} .qx-api-latency span {
        position: absolute;
        inset: 0 auto 0 0;
        width: var(--latency, 4%);
        border-radius: inherit;
        background: linear-gradient(90deg, #86f7df, #ffd76a, #ef476f);
      }
      #${ROOT_ID} .qx-api-detail {
        min-width: 0;
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        overflow: hidden;
      }
      #${ROOT_ID} .qx-api-detail-head {
        border-bottom: 1px solid rgba(128, 151, 174, 0.14);
        padding: 15px;
      }
      #${ROOT_ID} .qx-api-detail-title {
        margin-top: 8px;
        color: #fffaf0;
        font: 900 18px/1.25 ui-sans-serif, system-ui, sans-serif;
        word-break: break-all;
      }
      #${ROOT_ID} .qx-api-meta-grid {
        margin-top: 12px;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }
      #${ROOT_ID} .qx-api-meta-grid div {
        min-width: 0;
        border: 1px solid rgba(128, 151, 174, 0.17);
        border-radius: 10px;
        padding: 8px;
        background: rgba(5, 9, 14, 0.42);
      }
      #${ROOT_ID} .qx-api-meta-grid dt {
        margin: 0 0 4px;
        color: #71859c;
        font-size: 11px;
      }
      #${ROOT_ID} .qx-api-meta-grid dd {
        margin: 0;
        overflow: hidden;
        color: #dce8f5;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .qx-api-tabs {
        border-bottom: 1px solid rgba(128, 151, 174, 0.14);
        padding: 10px 15px;
        display: flex;
        gap: 8px;
      }
      #${ROOT_ID} .qx-api-tab {
        min-height: 32px;
        border: 1px solid rgba(128, 151, 174, 0.24);
        border-radius: 8px;
        padding: 0 10px;
        color: #9eb0c5;
        background: rgba(5, 9, 14, 0.48);
      }
      #${ROOT_ID} .qx-api-tab.is-active {
        border-color: rgba(112, 243, 214, 0.72);
        color: #86f7df;
        background: rgba(112, 243, 214, 0.12);
      }
      #${ROOT_ID} .qx-api-detail-body {
        min-height: 0;
        overflow: auto;
        padding: 15px;
      }
      #${ROOT_ID} .qx-api-copy-actions {
        margin-bottom: 10px;
      }
      #${ROOT_ID} .qx-api-code {
        min-height: 240px;
        border: 1px solid rgba(128, 151, 174, 0.2);
        border-radius: 12px;
        margin: 0;
        padding: 13px;
        overflow: auto;
        color: #dff7f3;
        background: rgba(2, 6, 10, 0.66);
        font: 12px/1.58 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${ROOT_ID} .qx-api-empty {
        height: 100%;
        padding: 40px 20px;
        display: grid;
        place-items: center;
        color: #8fa3ba;
        text-align: center;
      }
      #${ROOT_ID} .qx-api-toast {
        position: absolute;
        right: 16px;
        bottom: 16px;
        border: 1px solid rgba(112, 243, 214, 0.46);
        border-radius: 999px;
        padding: 8px 12px;
        color: #86f7df;
        background: rgba(3, 8, 13, 0.9);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
        font-weight: 800;
      }
      @media (max-width: 820px) {
        #${ROOT_ID} {
          inset: auto 8px 8px 8px;
        }
        #${ROOT_ID} .qx-api-panel {
          width: 100%;
          height: min(760px, calc(100vh - 16px));
        }
        #${ROOT_ID} .qx-api-panel-head,
        #${ROOT_ID} .qx-api-toolbar,
        #${ROOT_ID} .qx-api-main {
          grid-template-columns: minmax(0, 1fr);
        }
        #${ROOT_ID} .qx-api-main {
          height: calc(100% - 220px);
        }
        #${ROOT_ID} .qx-api-list {
          max-height: 260px;
          border-right: 0;
          border-bottom: 1px solid rgba(128, 151, 174, 0.18);
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const openButton = target.closest("[data-qx-open]");
    if (openButton) {
      state.open = true;
      scheduleRender();
      return;
    }

    const action = target.closest("[data-qx-action]")?.dataset.qxAction;
    if (action) {
      handleAction(action);
      return;
    }

    const filterButton = target.closest("[data-qx-filter]");
    if (filterButton) {
      state.filter = filterButton.dataset.qxFilter || "all";
      scheduleRender();
      return;
    }

    const tabButton = target.closest("[data-qx-tab]");
    if (tabButton) {
      state.tab = tabButton.dataset.qxTab || "response";
      scheduleRender();
      return;
    }

    const row = target.closest("[data-qx-id]");
    if (row) {
      state.selectedId = row.dataset.qxId || "";
      scheduleRender();
      return;
    }
  }

  function handleInput(event) {
    if (event.target instanceof HTMLInputElement && event.target.matches("[data-qx-search]")) {
      state.query = event.target.value;
      scheduleRender();
    }
  }

  function handleAction(action) {
    if (action === "close") state.open = false;
    if (action === "pause") state.paused = !state.paused;
    if (action === "clear") {
      state.records = [];
      state.selectedId = "";
    }
    if (action === "toggle-sensitive") {
      state.unsafeCopy = !state.unsafeCopy;
      saveSettings();
    }
    if (action.startsWith("copy-")) {
      const record = selectedRecord();
      if (record) {
        const kind = action.replace("copy-", "");
        void copyValue(copyPayload(record, kind), copyLabel(kind));
      }
    }
    scheduleRender();
  }

  function render() {
    if (!root) return;
    const records = filteredRecords();
    const selected = selectedRecord() || records[0] || state.records[0] || null;
    if (selected && state.selectedId !== selected.id) state.selectedId = selected.id;

    root.innerHTML = state.open ? renderPanel(records, selected) : renderTrigger();
  }

  function renderTrigger() {
    const errors = state.records.filter(isProblemRecord).length;
    const label = errors ? `${errors} issues` : `${state.records.length} calls`;
    return `
      <button class="qx-api-trigger" type="button" data-qx-open="1" title="API Capture Assistant (Alt+Shift+A)">
        <span>API</span>
        <strong>${escapeHtml(label)}</strong>
      </button>
    `;
  }

  function renderPanel(records, selected) {
    const totals = summarizeRecords();
    return `
      <section class="qx-api-panel" aria-label="API Capture Assistant">
        <header class="qx-api-panel-head">
          <div class="qx-api-title">
            <span class="qx-api-mark">API</span>
            <div>
              <h2>网页 API 抓包助手</h2>
              <p class="qx-api-subtitle">监听页面 fetch / XHR。本页内存展示，不上传数据；复制时默认脱敏敏感头和值。</p>
            </div>
          </div>
          <div class="qx-api-actions">
            <div class="qx-api-badges">
              <span class="qx-api-badge"><strong>${totals.all}</strong> 全部</span>
              <span class="qx-api-badge"><strong>${totals.errors}</strong> 问题</span>
              <span class="qx-api-badge"><strong>${totals.slow}</strong> 慢请求</span>
            </div>
            <button class="qx-api-close" type="button" data-qx-action="close" title="折叠">×</button>
          </div>
        </header>
        <section class="qx-api-toolbar">
          <label class="qx-api-search">
            <span>搜索</span>
            <input data-qx-search type="search" value="${escapeHtml(state.query)}" placeholder="路径、域名、状态码、方法">
          </label>
          <div class="qx-api-filters">
            ${renderFilter("all", "全部")}
            ${renderFilter("errors", "问题")}
            ${renderFilter("slow", "慢请求")}
            ${renderFilter("fetch", "fetch")}
            ${renderFilter("xhr", "XHR")}
            <button class="qx-api-button" type="button" data-qx-action="pause">${state.paused ? "继续记录" : "暂停记录"}</button>
            <button class="qx-api-button" type="button" data-qx-action="toggle-sensitive">${state.unsafeCopy ? "复制原文" : "复制脱敏"}</button>
            <button class="qx-api-button is-danger" type="button" data-qx-action="clear">清空</button>
          </div>
        </section>
        <section class="qx-api-main">
          <div class="qx-api-list">
            ${records.length ? records.map(renderRow).join("") : renderEmptyList()}
          </div>
          ${selected ? renderDetail(selected) : renderEmptyDetail()}
        </section>
      </section>
    `;
  }

  function renderFilter(filter, label) {
    return `
      <button class="qx-api-filter ${state.filter === filter ? "is-active" : ""}" type="button" data-qx-filter="${filter}">
        ${escapeHtml(label)}
      </button>
    `;
  }

  function renderRow(record) {
    const statusClass = statusClassName(record);
    const width = Math.max(4, Math.min(100, Math.round((record.duration / 2200) * 100)));
    return `
      <button class="qx-api-row ${record.id === state.selectedId ? "is-selected" : ""}" type="button" data-qx-id="${escapeHtml(record.id)}">
        <div class="qx-api-row-top">
          <span class="qx-api-row-meta">
            <span class="qx-api-method">${escapeHtml(record.method)}</span>
            <span class="qx-api-status ${statusClass}">${escapeHtml(record.status)}</span>
            <span>${escapeHtml(record.type)}</span>
          </span>
          <span class="qx-api-row-meta">${escapeHtml(formatDuration(record.duration))}</span>
        </div>
        <div class="qx-api-url">${escapeHtml(record.path || record.url)}</div>
        <div class="qx-api-row-meta">
          <span>${escapeHtml(record.host || "same page")}</span>
          <span>${escapeHtml(record.timeLabel)}</span>
        </div>
        <div class="qx-api-latency" aria-hidden="true"><span style="--latency: ${width}%"></span></div>
      </button>
    `;
  }

  function renderDetail(record) {
    const body = detailBody(record);
    return `
      <article class="qx-api-detail">
        <div class="qx-api-detail-head">
          <div class="qx-api-row-meta">
            <span class="qx-api-method">${escapeHtml(record.method)}</span>
            <span class="qx-api-status ${statusClassName(record)}">${escapeHtml(record.status)}</span>
            <span>${escapeHtml(record.type)}</span>
          </div>
          <div class="qx-api-detail-title">${escapeHtml(record.url)}</div>
          <dl class="qx-api-meta-grid">
            <div><dt>耗时</dt><dd>${escapeHtml(formatDuration(record.duration))}</dd></div>
            <div><dt>类型</dt><dd>${escapeHtml(record.contentType || "-")}</dd></div>
            <div><dt>时间</dt><dd>${escapeHtml(record.timeLabel)}</dd></div>
            <div><dt>复制模式</dt><dd>${state.unsafeCopy ? "原文" : "脱敏"}</dd></div>
          </dl>
        </div>
        <div class="qx-api-tabs">
          ${renderTab("response", "响应")}
          ${renderTab("request", "请求")}
          ${renderTab("headers", "头信息")}
          ${renderTab("curl", "curl")}
        </div>
        <div class="qx-api-detail-body">
          <div class="qx-api-copy-actions">
            <button class="qx-api-button" type="button" data-qx-action="copy-curl">复制 curl</button>
            <button class="qx-api-button" type="button" data-qx-action="copy-request">复制请求</button>
            <button class="qx-api-button" type="button" data-qx-action="copy-response">复制响应</button>
            <button class="qx-api-button" type="button" data-qx-action="copy-bundle">复制调试包</button>
          </div>
          <pre class="qx-api-code">${escapeHtml(body)}</pre>
        </div>
      </article>
    `;
  }

  function renderTab(tab, label) {
    return `
      <button class="qx-api-tab ${state.tab === tab ? "is-active" : ""}" type="button" data-qx-tab="${tab}">
        ${escapeHtml(label)}
      </button>
    `;
  }

  function renderEmptyList() {
    return `<div class="qx-api-empty"><div><h3>还没有接口记录</h3><p>刷新页面或操作业务功能后，这里会出现 fetch / XHR。</p></div></div>`;
  }

  function renderEmptyDetail() {
    return `<div class="qx-api-empty"><div><h3>选择一个接口</h3><p>查看响应、请求、headers，并一键复制 curl 或调试包。</p></div></div>`;
  }

  function filteredRecords() {
    const query = state.query.trim().toLowerCase();
    return state.records.filter((record) => {
      if (state.filter === "errors" && !isProblemRecord(record)) return false;
      if (state.filter === "slow" && record.duration < SLOW_MS) return false;
      if (state.filter === "fetch" && record.type !== "fetch") return false;
      if (state.filter === "xhr" && record.type !== "xhr") return false;
      if (!query) return true;
      return [record.method, record.status, record.url, record.host, record.path, record.type]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }

  function selectedRecord() {
    return state.records.find((record) => record.id === state.selectedId) || null;
  }

  function summarizeRecords() {
    return {
      all: state.records.length,
      errors: state.records.filter(isProblemRecord).length,
      slow: state.records.filter((record) => record.duration >= SLOW_MS).length,
    };
  }

  function isProblemRecord(record) {
    if (record.error) return true;
    if (record.status === "pending") return false;
    const status = Number(record.status);
    return !Number.isFinite(status) || status >= 400;
  }

  function statusClassName(record) {
    if (record.status === "pending") return "";
    if (isProblemRecord(record)) return "is-error";
    return "is-ok";
  }

  function detailBody(record) {
    if (state.tab === "request") {
      return stringifyForView({
        method: record.method,
        url: record.url,
        headers: normalizeHeadersForCopy(record.requestHeaders),
        body: safeText(record.requestBody),
      });
    }
    if (state.tab === "headers") {
      return stringifyForView({
        requestHeaders: normalizeHeadersForCopy(record.requestHeaders),
        responseHeaders: normalizeHeadersForCopy(record.responseHeaders),
      });
    }
    if (state.tab === "curl") return buildCurl(record);
    return formatBodyForView(record.responseBody, record.contentType || headerValue(record.responseHeaders, "content-type"));
  }

  function stringifyForView(value) {
    const text = JSON.stringify(state.unsafeCopy ? value : redactValue(value), null, 2);
    return text.length > MAX_RENDER_BODY_CHARS ? `${text.slice(0, MAX_RENDER_BODY_CHARS)}\n\n[preview truncated]` : text;
  }

  function formatBodyForView(body, contentType) {
    const text = safeText(body);
    if (!text) return recordPendingText();
    if (contentType && contentType.toLowerCase().includes("json")) {
      try {
        return stringifyForView(JSON.parse(text));
      } catch {
        return limitRenderText(state.unsafeCopy ? text : redactText(text));
      }
    }
    return limitRenderText(state.unsafeCopy ? text : redactText(text));
  }

  function recordPendingText() {
    return "响应尚未读取，或该接口没有文本响应体。";
  }

  function limitRenderText(text) {
    const value = String(text || "");
    return value.length > MAX_RENDER_BODY_CHARS ? `${value.slice(0, MAX_RENDER_BODY_CHARS)}\n\n[preview truncated]` : value;
  }

  function safeText(value) {
    return String(value ?? "");
  }

  function copyPayload(record, kind) {
    if (kind === "curl") return buildCurl(record);
    if (kind === "response") return state.unsafeCopy ? safeText(record.responseBody) : redactText(record.responseBody);
    if (kind === "request") {
      return stringifyForCopy({
        method: record.method,
        url: record.url,
        headers: normalizeHeadersForCopy(record.requestHeaders),
        body: safeText(record.requestBody),
      });
    }
    return stringifyForCopy({
      capturedAt: new Date().toISOString(),
      source: "API Capture Assistant",
      note: state.unsafeCopy ? "raw local copy" : "sensitive headers and common token fields redacted",
      request: {
        type: record.type,
        method: record.method,
        url: record.url,
        headers: normalizeHeadersForCopy(record.requestHeaders),
        body: safeText(record.requestBody),
      },
      response: {
        status: record.status,
        statusText: record.statusText,
        durationMs: record.duration,
        headers: normalizeHeadersForCopy(record.responseHeaders),
        body: safeText(record.responseBody),
        error: record.error,
      },
    });
  }

  function copyLabel(kind) {
    return {
      curl: "curl 已复制",
      request: "请求已复制",
      response: "响应已复制",
      bundle: "调试包已复制",
    }[kind] || "已复制";
  }

  function stringifyForCopy(value) {
    return JSON.stringify(state.unsafeCopy ? value : redactValue(value), null, 2);
  }

  function buildCurl(record) {
    const lines = [`curl ${shellQuote(record.url)}`];
    if (record.method && record.method !== "GET") lines.push(`  -X ${shellQuote(record.method)}`);
    for (const [key, value] of normalizeHeadersForCopy(record.requestHeaders)) {
      if (/^content-length$/i.test(key)) continue;
      lines.push(`  -H ${shellQuote(`${key}: ${state.unsafeCopy ? value : redactHeaderValue(key, value)}`)}`);
    }
    if (record.requestBody && !record.requestBody.startsWith("[Request body stream")) {
      lines.push(`  --data-raw ${shellQuote(state.unsafeCopy ? record.requestBody : redactText(record.requestBody))}`);
    }
    return lines.join(" \\\n");
  }

  function normalizeHeadersForCopy(headers) {
    return (headers || []).map(([key, value]) => [String(key), String(value)]);
  }

  function headerValue(headers, name) {
    const target = String(name).toLowerCase();
    const item = (headers || []).find(([key]) => String(key).toLowerCase() === target);
    return item ? String(item[1]) : "";
  }

  function redactValue(value) {
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object") {
      const next = {};
      for (const [key, item] of Object.entries(value)) {
        next[key] = sensitiveKeyPattern.test(key) ? "[redacted]" : redactValue(item);
      }
      return next;
    }
    if (typeof value === "string") return redactText(value);
    return value;
  }

  function redactText(value) {
    if (state.unsafeCopy) return String(value ?? "");
    return String(value ?? "")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[redacted]")
      .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted-key]")
      .replace(/("(?:access_token|accessToken|refresh_token|refreshToken|session_token|sessionToken|id_token|idToken|token|password|secret)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
      .replace(/((?:access_token|accessToken|refresh_token|refreshToken|session_token|sessionToken|token|password|secret)=)[^&\s]+/gi, "$1[redacted]");
  }

  function redactHeaderValue(key, value) {
    if (sensitiveHeaderNames.has(String(key).toLowerCase())) return "[redacted]";
    return redactText(value);
  }

  function shellQuote(value) {
    return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
  }

  async function copyValue(text, label) {
    try {
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(text, "text");
      } else {
        await navigator.clipboard.writeText(text);
      }
      showToast(label);
    } catch {
      window.prompt("复制内容", text);
    }
  }

  function showToast(text) {
    if (!root) return;
    const toast = document.createElement("div");
    toast.className = "qx-api-toast";
    toast.textContent = text;
    root.appendChild(toast);
    window.setTimeout(() => toast.remove(), 1500);
  }

  function formatDuration(duration) {
    if (!duration) return "0 ms";
    if (duration < 1000) return `${duration} ms`;
    return `${(duration / 1000).toFixed(2)} s`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function isInstance(value, className) {
    const CurrentClass = window[className];
    const PageClass = pageWindow[className];
    return Boolean(
      value &&
        ((typeof CurrentClass === "function" && value instanceof CurrentClass) ||
          (typeof PageClass === "function" && value instanceof PageClass)),
    );
  }
})();
