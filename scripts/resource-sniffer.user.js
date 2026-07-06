// ==UserScript==
// @name         Resource Sniffer
// @namespace    https://almoststable.com/userscripts/
// @version      0.1.1
// @author       qxslimg
// @description  Sniff original images, video files, HLS/DASH streams, and media candidates from DOM, srcset, CSS, performance, fetch, and XHR. Local only.
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const ROOT_ID = "qx-resource-sniffer-root";
  const STYLE_ID = "qx-resource-sniffer-style";
  const STORAGE_KEY = "qx_resource_sniffer_settings_v1";
  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const imageExtPattern = /\.(?:avif|webp|png|jpe?g|gif|svg|bmp|ico|tiff?)(?:[?#]|$)/i;
  const videoExtPattern = /\.(?:mp4|m4v|m4s|m4a|webm|mov|mkv|flv|avi|wmv|ts|m2ts|3gp)(?:[?#]|$)/i;
  const streamExtPattern = /\.(?:m3u8|mpd)(?:[?#]|$)/i;
  const blockedUrlPattern = /^(?:data|javascript|about|chrome|chrome-extension):/i;
  const scanDebounceMs = 700;
  const maxRecords = 600;

  const state = {
    open: false,
    filter: "all",
    query: "",
    selectedKey: "",
    sort: "quality",
    scanning: true,
    records: new Map(),
    contextMenu: {
      open: false,
      x: 16,
      y: 16,
    },
  };

  let root = null;
  let renderQueued = false;
  let scanTimer = 0;
  let idSeed = 0;

  loadSettings();
  patchFetchForMedia();
  patchXHRForMedia();
  observePerformance();
  observeDom();
  installShortcut();
  installMenuCommand();
  installContextMenu();
  whenReady(() => {
    injectPanel();
    scanPage();
    scheduleScan();
  });

  function loadSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.sort = typeof settings.sort === "string" ? settings.sort : state.sort;
      state.filter = typeof settings.filter === "string" ? settings.filter : state.filter;
    } catch {
      // Keep defaults.
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sort: state.sort,
          filter: state.filter,
        }),
      );
    } catch {
      // Some pages disable localStorage. Records still stay in memory.
    }
  }

  function whenReady(callback) {
    if (document.body) {
      callback();
      return;
    }
    document.addEventListener("DOMContentLoaded", callback, { once: true });
    window.addEventListener("load", callback, { once: true });
  }

  function scheduleScan() {
    if (!state.scanning) return;
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanPage, scanDebounceMs);
  }

  function scheduleRender() {
    if (!root || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function nextId() {
    idSeed += 1;
    return `resource-${Date.now().toString(36)}-${idSeed.toString(36)}`;
  }

  function normalizeUrl(value) {
    const text = String(value || "").trim();
    if (!text || blockedUrlPattern.test(text)) return "";
    try {
      return new URL(text, location.href).href;
    } catch {
      return "";
    }
  }

  function stripHash(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return url;
    }
  }

  function inferKind(url, contentType = "", hint = "") {
    const type = String(contentType || "").toLowerCase();
    const text = String(url || "").toLowerCase();
    const label = String(hint || "").toLowerCase();
    if (streamExtPattern.test(text) || type.includes("mpegurl") || type.includes("dash+xml") || type.includes("mpd")) return "stream";
    if (videoExtPattern.test(text) || type.startsWith("video/") || label === "video") return "video";
    if (imageExtPattern.test(text) || type.startsWith("image/") || label === "image") return "image";
    return "";
  }

  function mediaExtension(url) {
    try {
      const pathname = new URL(url, location.href).pathname;
      const match = /\.([a-z0-9]{2,6})$/i.exec(pathname);
      return match ? match[1].toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function isLikelyMediaUrl(url) {
    const text = String(url || "");
    return imageExtPattern.test(text) || videoExtPattern.test(text) || streamExtPattern.test(text);
  }

  function addResource(input) {
    const url = normalizeUrl(input.url);
    if (!url) return null;
    const kind = input.kind || inferKind(url, input.contentType, input.hint);
    if (!kind) return null;

    const key = stripHash(url);
    const existing = state.records.get(key);
    const previousSelectedKey = state.selectedKey;
    const beforeSignature = existing ? recordSignature(existing) : "";
    const now = Date.now();
    const width = toNumber(input.width);
    const height = toNumber(input.height);
    const score = scoreResource(kind, width, height, input.descriptor, url);
    const tags = new Set(existing?.tags || []);
    for (const tag of input.tags || []) {
      if (tag) tags.add(tag);
    }
    if (input.source) tags.add(input.source);
    if (input.descriptor) tags.add(input.descriptor);
    if (kind === "stream") tags.add(streamExtPattern.test(url) ? "stream-url" : "stream");
    if (kind === "image" && width && height && width >= 1600) tags.add("high-res");
    if (kind === "video") tags.add("direct-video");

    const record = existing || {
      id: nextId(),
      key,
      url,
      kind,
      ext: mediaExtension(url),
      sources: [],
      tags: [],
      width: 0,
      height: 0,
      score: 0,
      title: "",
      contentType: "",
      firstSeen: now,
      lastSeen: now,
      previewUrl: "",
      downloadable: true,
      note: "",
    };

    record.kind = rankKind(record.kind, kind);
    record.ext = record.ext || mediaExtension(url);
    record.width = Math.max(record.width || 0, width || 0);
    record.height = Math.max(record.height || 0, height || 0);
    record.score = Math.max(record.score || 0, score);
    record.contentType = record.contentType || input.contentType || "";
    record.title = input.title || record.title || bestTitleFromUrl(url);
    record.lastSeen = now;
    record.previewUrl = choosePreview(record, input.previewUrl || url);
    record.tags = Array.from(tags).slice(0, 12);
    record.sources = mergeUnique(record.sources, [input.source || "unknown"]).slice(0, 8);
    record.downloadable = /^https?:/i.test(url);
    record.note = record.downloadable ? "" : "blob/MSE 是播放器内存地址，不是原始视频文件。请在列表里找 .m4s、.m3u8、.mpd 等真实网络候选，必要时用专门下载器和登录 Cookie。";

    state.records.set(key, record);
    trimRecords();
    if (!state.selectedKey || !state.records.has(state.selectedKey)) state.selectedKey = key;
    if (!existing || beforeSignature !== recordSignature(record) || previousSelectedKey !== state.selectedKey) scheduleRender();
    return record;
  }

  function recordSignature(record) {
    return [
      record.kind,
      record.ext,
      record.width,
      record.height,
      record.score,
      record.title,
      record.contentType,
      record.previewUrl,
      record.downloadable ? "1" : "0",
      record.note,
      (record.sources || []).join("|"),
      (record.tags || []).join("|"),
    ].join("\n");
  }

  function rankKind(a, b) {
    const order = { stream: 3, video: 2, image: 1 };
    return (order[b] || 0) > (order[a] || 0) ? b : a;
  }

  function scoreResource(kind, width, height, descriptor, url) {
    if (kind === "stream") return 9_000_000;
    if (kind === "video") return 7_000_000;
    const pixels = width && height ? width * height : 0;
    const descriptorText = String(descriptor || "");
    const widthDescriptor = /(\d+)w/.exec(descriptorText);
    const scaleDescriptor = /(\d+(?:\.\d+)?)x/.exec(descriptorText);
    let score = pixels || 1000;
    if (widthDescriptor) score = Math.max(score, Number(widthDescriptor[1]) * 1200);
    if (scaleDescriptor) score = Math.max(score, Number(scaleDescriptor[1]) * 1_000_000);
    if (/\borig(?:inal)?\b|raw|large|master|source|download/i.test(url)) score += 350_000;
    return score;
  }

  function choosePreview(record, candidate) {
    if (record.kind !== "image") return "";
    if (!candidate || candidate.startsWith("blob:")) return record.previewUrl || "";
    return record.previewUrl || candidate;
  }

  function trimRecords() {
    if (state.records.size <= maxRecords) return;
    const records = Array.from(state.records.values()).sort((a, b) => a.lastSeen - b.lastSeen);
    for (const record of records.slice(0, state.records.size - maxRecords)) {
      state.records.delete(record.key);
    }
  }

  function scanPage() {
    if (!state.scanning) return;
    scanDocumentMedia();
    scanCssBackgrounds();
    scanLinksAndMeta();
    scanPerformanceEntries(performance.getEntriesByType ? performance.getEntriesByType("resource") : []);
  }

  function scanDocumentMedia() {
    document.querySelectorAll("img").forEach((img) => {
      if (isInOwnPanel(img)) return;
      const title = elementTitle(img);
      const naturalWidth = img.naturalWidth || img.width || 0;
      const naturalHeight = img.naturalHeight || img.height || 0;
      addResource({
        url: img.currentSrc || img.src,
        kind: "image",
        source: "img-current",
        width: naturalWidth,
        height: naturalHeight,
        title,
        previewUrl: img.currentSrc || img.src,
        tags: ["dom"],
      });
      for (const candidate of parseSrcset(img.getAttribute("srcset"))) {
        addResource({
          url: candidate.url,
          kind: "image",
          source: "img-srcset",
          descriptor: candidate.descriptor,
          width: candidate.width || naturalWidth,
          height: naturalHeight,
          title,
          previewUrl: candidate.url,
          tags: ["srcset"],
        });
      }
    });

    document.querySelectorAll("picture source, source[srcset]").forEach((source) => {
      if (isInOwnPanel(source)) return;
      for (const candidate of parseSrcset(source.getAttribute("srcset"))) {
        addResource({
          url: candidate.url,
          kind: "image",
          source: "picture-source",
          descriptor: candidate.descriptor,
          width: candidate.width,
          title: elementTitle(source),
          previewUrl: candidate.url,
          tags: ["srcset", "picture"],
        });
      }
    });

    document.querySelectorAll("video").forEach((video) => {
      if (isInOwnPanel(video)) return;
      const title = elementTitle(video);
      addResource({
        url: video.currentSrc || video.src,
        kind: "video",
        source: "video-current",
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        title,
        tags: ["dom"],
      });
      addResource({
        url: video.poster,
        kind: "image",
        source: "video-poster",
        title: `${title || "video"} poster`,
        tags: ["poster"],
      });
      video.querySelectorAll("source[src]").forEach((source) => {
        const src = source.getAttribute("src");
        addResource({
          url: src,
          kind: inferKind(src, source.type, "video") || "video",
          contentType: source.type,
          source: "video-source",
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          title,
          tags: ["source"],
        });
      });
    });
  }

  function scanCssBackgrounds() {
    const elements = Array.from(document.querySelectorAll("body, body *"))
      .filter((element) => !isInOwnPanel(element))
      .slice(0, 2500);
    for (const element of elements) {
      let style;
      try {
        style = getComputedStyle(element);
      } catch {
        continue;
      }
      const text = `${style.backgroundImage || ""},${style.listStyleImage || ""},${style.content || ""}`;
      for (const url of extractCssUrls(text)) {
        if (!isLikelyMediaUrl(url)) continue;
        addResource({
          url,
          kind: inferKind(url, "", "image") || "image",
          source: "css-url",
          title: elementTitle(element),
          previewUrl: url,
          tags: ["css"],
        });
      }
    }
  }

  function scanLinksAndMeta() {
    document.querySelectorAll("a[href], link[href], meta[property], meta[name]").forEach((element) => {
      if (isInOwnPanel(element)) return;
      const rawUrl =
        element.getAttribute("href") ||
        element.getAttribute("content") ||
        element.getAttribute("src") ||
        "";
      if (!rawUrl || !isLikelyMediaUrl(rawUrl)) return;
      addResource({
        url: rawUrl,
        kind: inferKind(rawUrl),
        source: element.tagName.toLowerCase(),
        title: elementTitle(element),
        previewUrl: rawUrl,
        tags: ["link"],
      });
    });
  }

  function scanPerformanceEntries(entries) {
    for (const entry of entries || []) {
      const url = entry.name;
      const initiator = String(entry.initiatorType || "");
      const hint = initiator === "img" || initiator === "css" ? "image" : initiator === "video" ? "video" : "";
      const kind = inferKind(url, "", hint);
      if (!kind) continue;
      addResource({
        url,
        kind,
        source: `performance:${initiator || "resource"}`,
        tags: ["network"],
      });
    }
  }

  function observePerformance() {
    if (typeof PerformanceObserver !== "function") return;
    try {
      const observer = new PerformanceObserver((list) => scanPerformanceEntries(list.getEntries()));
      observer.observe({ entryTypes: ["resource"] });
    } catch {
      // Not supported on some pages.
    }
  }

  function observeDom() {
    whenReady(() => {
      try {
        const observer = new MutationObserver((mutations) => {
          let shouldScan = false;
          for (const mutation of mutations) {
            if (isInOwnPanel(mutation.target)) continue;
            if (mutation.type === "attributes") shouldScan = true;
            for (const node of mutation.addedNodes) {
              if (isInOwnPanel(node)) continue;
              if (node.nodeType === 1) scanElement(node);
              shouldScan = true;
            }
          }
          if (shouldScan) scheduleScan();
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src", "srcset", "href", "poster", "style"],
        });
      } catch {
        // Ignore strict pages.
      }
    });
  }

  function scanElement(node) {
    if (!(node instanceof Element)) return;
    if (isInOwnPanel(node)) return;
    if (node.matches?.("img, video, source, a[href], link[href]")) scheduleScan();
    if (node.querySelector?.("img, video, source, a[href], link[href]")) scheduleScan();
  }

  function patchFetchForMedia() {
    const originalFetch = pageWindow.fetch;
    if (typeof originalFetch !== "function" || originalFetch.__qxResourceSnifferPatched) return;

    function sniffedFetch(input, init) {
      const requestUrl = requestToUrl(input);
      return originalFetch.apply(this, arguments).then((response) => {
        try {
          const contentType = response.headers?.get?.("content-type") || "";
          const responseUrl = response.url || requestUrl;
          const kind = inferKind(responseUrl, contentType);
          if (kind) {
            addResource({
              url: responseUrl,
              kind,
              contentType,
              source: "fetch",
              tags: ["network"],
            });
          }
        } catch {
          // Do not break page fetch.
        }
        return response;
      });
    }

    sniffedFetch.__qxResourceSnifferPatched = true;
    sniffedFetch.__qxResourceSnifferOriginal = originalFetch;
    pageWindow.fetch = sniffedFetch;
  }

  function patchXHRForMedia() {
    const proto = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
    if (!proto || proto.__qxResourceSnifferPatched) return;

    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function (method, url) {
      this.__qxResourceSnifferUrl = normalizeUrl(url);
      return originalOpen.apply(this, arguments);
    };

    proto.send = function () {
      this.addEventListener(
        "loadend",
        () => {
          try {
            const responseUrl = this.responseURL || this.__qxResourceSnifferUrl;
            const contentType = headerValue(parseResponseHeaders(this.getAllResponseHeaders()), "content-type");
            const kind = inferKind(responseUrl, contentType);
            if (kind) {
              addResource({
                url: responseUrl,
                kind,
                contentType,
                source: "xhr",
                tags: ["network"],
              });
            }
          } catch {
            // Do not break page XHR.
          }
        },
        { once: true },
      );
      return originalSend.apply(this, arguments);
    };

    proto.__qxResourceSnifferPatched = true;
  }

  function requestToUrl(input) {
    if (isInstance(input, "Request")) return input.url;
    return String(input || "");
  }

  function parseSrcset(value) {
    const text = String(value || "").trim();
    if (!text) return [];
    return splitSrcset(text)
      .map((part) => {
        const [url, descriptor = ""] = part.trim().split(/\s+/, 2);
        const widthMatch = /(\d+)w/.exec(descriptor);
        return {
          url,
          descriptor,
          width: widthMatch ? Number(widthMatch[1]) : 0,
        };
      })
      .filter((item) => Boolean(normalizeUrl(item.url)));
  }

  function splitSrcset(srcset) {
    const parts = [];
    let buffer = "";
    let inParens = 0;
    for (const char of srcset) {
      if (char === "(") inParens += 1;
      if (char === ")") inParens = Math.max(0, inParens - 1);
      if (char === "," && inParens === 0) {
        if (buffer.trim()) parts.push(buffer.trim());
        buffer = "";
      } else {
        buffer += char;
      }
    }
    if (buffer.trim()) parts.push(buffer.trim());
    return parts;
  }

  function extractCssUrls(value) {
    const urls = [];
    const pattern = /url\((['"]?)(.*?)\1\)/gi;
    let match;
    while ((match = pattern.exec(String(value || "")))) {
      urls.push(match[2]);
    }
    return urls;
  }

  function elementTitle(element) {
    if (!element) return "";
    const title =
      element.getAttribute?.("alt") ||
      element.getAttribute?.("title") ||
      element.getAttribute?.("aria-label") ||
      element.closest?.("[title]")?.getAttribute("title") ||
      document.title ||
      "";
    return String(title).trim().slice(0, 120);
  }

  function bestTitleFromUrl(url) {
    try {
      const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
      return name || new URL(url).hostname;
    } catch {
      return "resource";
    }
  }

  function parseResponseHeaders(rawHeaders) {
    return String(rawHeaders || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(":");
        return index < 0 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      });
  }

  function headerValue(headers, name) {
    const target = String(name).toLowerCase();
    const item = (headers || []).find(([key]) => String(key).toLowerCase() === target);
    return item ? String(item[1]) : "";
  }

  function installShortcut() {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.altKey && event.shiftKey && event.code === "KeyR") {
          event.preventDefault();
          state.open ? closePanel() : openPanel();
          scheduleRender();
        }
        if (event.code === "Escape") {
          if (state.contextMenu.open) {
            hideContextMenu();
            scheduleRender();
          }
        }
      },
      true,
    );
  }

  function installMenuCommand() {
    try {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("打开资源嗅探器", openPanel);
        GM_registerMenuCommand("重新扫描媒体资源", () => {
          scanPage();
          scheduleRender();
        });
      }
    } catch {
      // Menu command is optional across userscript managers.
    }
  }

  function installContextMenu() {
    document.addEventListener(
      "contextmenu",
      (event) => {
        const target = event.target;
        if (event.shiftKey) return;
        if (isInOwnPanel(target) || isEditableTarget(target)) return;
        event.preventDefault();
        state.contextMenu.open = true;
        state.contextMenu.x = clamp(event.clientX, 8, Math.max(8, window.innerWidth - 220));
        state.contextMenu.y = clamp(event.clientY, 8, Math.max(8, window.innerHeight - 160));
        scheduleRender();
      },
      true,
    );
    document.addEventListener(
      "click",
      (event) => {
        if (!state.contextMenu.open || isInOwnPanel(event.target)) return;
        hideContextMenu();
        scheduleRender();
      },
      true,
    );
    window.addEventListener(
      "scroll",
      () => {
        if (!state.contextMenu.open) return;
        hideContextMenu();
        scheduleRender();
      },
      true,
    );
  }

  function openPanel() {
    hideContextMenu();
    state.open = true;
    scanPage();
    scheduleRender();
  }

  function closePanel() {
    state.open = false;
    hideContextMenu();
  }

  function hideContextMenu() {
    state.contextMenu.open = false;
  }

  function isEditableTarget(target) {
    const element = target instanceof Element ? target : null;
    if (!element) return false;
    return Boolean(element.closest("input, textarea, select, [contenteditable]"));
  }

  function isInOwnPanel(node) {
    if (!node || !root) return false;
    if (node === root) return true;
    const element = node instanceof Element ? node : node.parentElement;
    return Boolean(element && root.contains(element));
  }

  function injectPanel() {
    if (document.getElementById(ROOT_ID)) return;
    installStyle();
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
    root.addEventListener("click", handleClick);
    root.addEventListener("input", handleInput);
    root.addEventListener("change", handleChange);
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
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        color: #f4f7fb;
        font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${ROOT_ID} button,
      #${ROOT_ID} input,
      #${ROOT_ID} select {
        font: inherit;
      }
      #${ROOT_ID} button {
        cursor: pointer;
      }
      #${ROOT_ID} .rs-panel {
        position: fixed;
        left: 16px;
        bottom: 16px;
        width: min(1040px, calc(100vw - 28px));
        height: min(740px, calc(100vh - 28px));
        border: 1px solid rgba(130, 151, 174, 0.34);
        border-radius: 16px;
        overflow: hidden;
        background:
          radial-gradient(circle at 0% 0%, rgba(123, 235, 215, 0.16), transparent 30%),
          radial-gradient(circle at 100% 6%, rgba(255, 214, 107, 0.13), transparent 28%),
          linear-gradient(145deg, rgba(8, 13, 19, 0.97), rgba(11, 18, 29, 0.98));
        box-shadow: 0 28px 92px rgba(0, 0, 0, 0.52);
        backdrop-filter: blur(18px);
        pointer-events: auto;
      }
      #${ROOT_ID} .rs-context-menu {
        position: fixed;
        width: 206px;
        border: 1px solid rgba(123, 235, 215, 0.42);
        border-radius: 14px;
        overflow: hidden;
        background:
          radial-gradient(circle at 0% 0%, rgba(123, 235, 215, 0.16), transparent 42%),
          linear-gradient(145deg, rgba(8, 13, 19, 0.98), rgba(11, 18, 29, 0.98));
        box-shadow: 0 20px 54px rgba(0, 0, 0, 0.42);
        backdrop-filter: blur(16px);
        pointer-events: auto;
      }
      #${ROOT_ID} .rs-context-item {
        width: 100%;
        min-height: 42px;
        border: 0;
        border-bottom: 1px solid rgba(130, 151, 174, 0.12);
        border-radius: 0;
        padding: 9px 12px;
        display: grid;
        gap: 2px;
        color: #f4f7fb;
        background: transparent;
        text-align: left;
      }
      #${ROOT_ID} .rs-context-item:last-child {
        border-bottom: 0;
      }
      #${ROOT_ID} .rs-context-item:hover {
        color: #7bebd7;
        background: rgba(123, 235, 215, 0.1);
      }
      #${ROOT_ID} .rs-context-item span {
        color: #8fa3ba;
        font-size: 11px;
      }
      #${ROOT_ID} .rs-head {
        border-bottom: 1px solid rgba(130, 151, 174, 0.19);
        padding: 16px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 16px;
        align-items: start;
      }
      #${ROOT_ID} .rs-brand {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      #${ROOT_ID} .rs-mark {
        width: 42px;
        height: 42px;
        border: 1px solid rgba(123, 235, 215, 0.54);
        border-radius: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #7bebd7;
        background: rgba(123, 235, 215, 0.09);
        font: 900 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} h2,
      #${ROOT_ID} h3,
      #${ROOT_ID} p {
        margin: 0;
      }
      #${ROOT_ID} h2 {
        color: #fffaf0;
        font-size: 19px;
        line-height: 1.2;
      }
      #${ROOT_ID} .rs-sub {
        margin-top: 4px;
        max-width: 720px;
        color: #a7b8cb;
        font-size: 12px;
      }
      #${ROOT_ID} .rs-stats,
      #${ROOT_ID} .rs-actions,
      #${ROOT_ID} .rs-filters,
      #${ROOT_ID} .rs-detail-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #${ROOT_ID} .rs-stats {
        justify-content: flex-end;
      }
      #${ROOT_ID} .rs-pill {
        min-height: 34px;
        border: 1px solid rgba(130, 151, 174, 0.24);
        border-radius: 999px;
        padding: 7px 10px;
        color: #a9bad0;
        background: rgba(5, 9, 14, 0.58);
        font-size: 12px;
      }
      #${ROOT_ID} .rs-pill strong {
        color: #ffd66b;
        margin-right: 5px;
      }
      #${ROOT_ID} .rs-toolbar {
        border-bottom: 1px solid rgba(130, 151, 174, 0.14);
        padding: 12px 16px;
        display: grid;
        grid-template-columns: minmax(220px, 1fr) auto;
        gap: 10px;
        align-items: center;
      }
      #${ROOT_ID} .rs-search {
        height: 38px;
        border: 1px solid rgba(130, 151, 174, 0.32);
        border-radius: 10px;
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 8px;
        padding: 0 12px;
        color: #7bebd7;
        background: rgba(3, 8, 13, 0.74);
      }
      #${ROOT_ID} .rs-search input {
        min-width: 0;
        border: 0;
        outline: 0;
        color: #f4f7fb;
        background: transparent;
      }
      #${ROOT_ID} .rs-button,
      #${ROOT_ID} .rs-filter,
      #${ROOT_ID} .rs-select,
      #${ROOT_ID} .rs-close {
        min-height: 34px;
        border: 1px solid rgba(130, 151, 174, 0.28);
        border-radius: 9px;
        padding: 0 11px;
        color: #c4d4e6;
        background: rgba(6, 11, 17, 0.72);
      }
      #${ROOT_ID} .rs-button:hover,
      #${ROOT_ID} .rs-filter:hover,
      #${ROOT_ID} .rs-filter.is-active {
        border-color: rgba(123, 235, 215, 0.72);
        color: #7bebd7;
        background: rgba(123, 235, 215, 0.11);
      }
      #${ROOT_ID} .rs-close {
        width: 36px;
        padding: 0;
        color: #8fa3ba;
        font-size: 18px;
      }
      #${ROOT_ID} .rs-main {
        height: calc(100% - 144px);
        display: grid;
        grid-template-columns: minmax(350px, 43%) minmax(0, 1fr);
      }
      #${ROOT_ID} .rs-list {
        border-right: 1px solid rgba(130, 151, 174, 0.18);
        overflow: auto;
        padding: 10px;
        display: grid;
        align-content: start;
        gap: 9px;
      }
      #${ROOT_ID} .rs-row {
        width: 100%;
        min-height: 98px;
        border: 1px solid rgba(130, 151, 174, 0.18);
        border-radius: 12px;
        padding: 9px;
        display: grid;
        grid-template-columns: 72px minmax(0, 1fr);
        gap: 10px;
        color: #dce8f5;
        background: rgba(6, 11, 17, 0.58);
        text-align: left;
      }
      #${ROOT_ID} .rs-row:hover,
      #${ROOT_ID} .rs-row.is-selected {
        border-color: rgba(123, 235, 215, 0.72);
        background: rgba(123, 235, 215, 0.08);
      }
      #${ROOT_ID} .rs-thumb {
        width: 72px;
        height: 72px;
        border: 1px solid rgba(130, 151, 174, 0.22);
        border-radius: 10px;
        overflow: hidden;
        display: grid;
        place-items: center;
        color: #7bebd7;
        background: rgba(3, 8, 13, 0.78);
        font: 900 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} .rs-thumb img {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: cover;
      }
      #${ROOT_ID} .rs-row-body {
        min-width: 0;
        display: grid;
        gap: 6px;
      }
      #${ROOT_ID} .rs-row-top,
      #${ROOT_ID} .rs-row-meta,
      #${ROOT_ID} .rs-tags {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      #${ROOT_ID} .rs-row-top {
        justify-content: space-between;
      }
      #${ROOT_ID} .rs-kind {
        border-radius: 7px;
        padding: 3px 6px;
        color: #06110f;
        background: #7bebd7;
        font: 900 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} .rs-kind.is-stream {
        background: #ffd66b;
      }
      #${ROOT_ID} .rs-kind.is-video {
        background: #ff9ab4;
      }
      #${ROOT_ID} .rs-title {
        overflow: hidden;
        color: #fffaf0;
        font-weight: 900;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .rs-url {
        overflow: hidden;
        color: #9fb2c8;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .rs-row-meta,
      #${ROOT_ID} .rs-tags {
        color: #8195ac;
        font-size: 12px;
      }
      #${ROOT_ID} .rs-tag {
        border: 1px solid rgba(123, 235, 215, 0.22);
        border-radius: 999px;
        padding: 2px 6px;
        color: #9df1e3;
        background: rgba(123, 235, 215, 0.08);
      }
      #${ROOT_ID} .rs-detail {
        min-width: 0;
        overflow: auto;
        padding: 16px;
      }
      #${ROOT_ID} .rs-preview {
        min-height: 210px;
        border: 1px solid rgba(130, 151, 174, 0.2);
        border-radius: 14px;
        overflow: hidden;
        display: grid;
        place-items: center;
        color: #8094ab;
        background:
          linear-gradient(rgba(130, 151, 174, 0.06) 1px, transparent 1px),
          linear-gradient(90deg, rgba(130, 151, 174, 0.06) 1px, transparent 1px),
          rgba(2, 6, 10, 0.5);
        background-size: 24px 24px;
      }
      #${ROOT_ID} .rs-preview img {
        max-width: 100%;
        max-height: 360px;
        display: block;
        object-fit: contain;
      }
      #${ROOT_ID} .rs-detail h3 {
        margin-top: 14px;
        color: #fffaf0;
        font-size: 22px;
        line-height: 1.2;
        word-break: break-word;
      }
      #${ROOT_ID} .rs-detail-url {
        margin-top: 8px;
        color: #9fb2c8;
        font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        word-break: break-all;
      }
      #${ROOT_ID} .rs-metrics {
        margin-top: 12px;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }
      #${ROOT_ID} .rs-metrics div {
        border: 1px solid rgba(130, 151, 174, 0.18);
        border-radius: 10px;
        padding: 9px;
        background: rgba(5, 9, 14, 0.48);
      }
      #${ROOT_ID} .rs-metrics dt {
        margin: 0 0 4px;
        color: #758aa2;
        font-size: 11px;
      }
      #${ROOT_ID} .rs-metrics dd {
        margin: 0;
        overflow: hidden;
        color: #e5edf7;
        font-weight: 900;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .rs-detail-actions {
        margin-top: 13px;
      }
      #${ROOT_ID} .rs-code {
        margin: 13px 0 0;
        border: 1px solid rgba(130, 151, 174, 0.2);
        border-radius: 12px;
        padding: 12px;
        overflow: auto;
        color: #dff7f3;
        background: rgba(2, 6, 10, 0.64);
        font: 12px/1.58 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${ROOT_ID} .rs-note {
        margin-top: 10px;
        border: 1px solid rgba(255, 214, 107, 0.24);
        border-radius: 10px;
        padding: 9px 10px;
        color: #f7d88a;
        background: rgba(255, 214, 107, 0.08);
        font-size: 12px;
      }
      #${ROOT_ID} .rs-empty {
        height: 100%;
        padding: 40px 20px;
        display: grid;
        place-items: center;
        color: #8fa3ba;
        text-align: center;
      }
      #${ROOT_ID} .rs-toast {
        position: fixed;
        left: 16px;
        bottom: 16px;
        border: 1px solid rgba(123, 235, 215, 0.5);
        border-radius: 999px;
        padding: 8px 12px;
        color: #7bebd7;
        background: rgba(3, 8, 13, 0.92);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
        font-weight: 900;
      }
      @media (max-width: 860px) {
        #${ROOT_ID} .rs-panel {
          left: 8px;
          bottom: 8px;
          width: 100%;
          height: min(780px, calc(100vh - 16px));
        }
        #${ROOT_ID} .rs-head,
        #${ROOT_ID} .rs-toolbar,
        #${ROOT_ID} .rs-main {
          grid-template-columns: minmax(0, 1fr);
        }
        #${ROOT_ID} .rs-main {
          height: calc(100% - 222px);
        }
        #${ROOT_ID} .rs-list {
          max-height: 290px;
          border-right: 0;
          border-bottom: 1px solid rgba(130, 151, 174, 0.18);
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const action = target.closest("[data-rs-action]")?.dataset.rsAction;
    if (action) {
      handleAction(action);
      return;
    }

    const filter = target.closest("[data-rs-filter]")?.dataset.rsFilter;
    if (filter) {
      state.filter = filter;
      saveSettings();
      scheduleRender();
      return;
    }

    const row = target.closest("[data-rs-key]");
    if (row) {
      state.selectedKey = row.dataset.rsKey || "";
      scheduleRender();
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches("[data-rs-search]")) {
      state.query = target.value;
      scheduleRender();
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.matches("[data-rs-sort]")) {
      state.sort = target.value;
      saveSettings();
      scheduleRender();
    }
  }

  function handleAction(action) {
    const selected = selectedRecord();
    if (state.contextMenu.open && action !== "open-panel") hideContextMenu();
    if (action === "open-panel") openPanel();
    if (action === "close") closePanel();
    if (action === "scan") scanPage();
    if (action === "toggle-scan") state.scanning = !state.scanning;
    if (action === "clear") {
      state.records.clear();
      state.selectedKey = "";
    }
    if (action === "open" && selected) window.open(selected.url, "_blank", "noopener,noreferrer");
    if (action === "download" && selected) downloadRecord(selected);
    if (action === "copy-url" && selected) void copyText(selected.url, "URL 已复制");
    if (action === "copy-command" && selected) void copyText(downloadCommand(selected), "下载命令已复制");
    if (action === "copy-selected" && selected) void copyText(recordBundle(selected), "资源信息已复制");
    if (action === "copy-list") void copyText(filteredRecords().map((item) => item.url).join("\n"), "列表 URL 已复制");
    scheduleRender();
  }

  function render() {
    if (!root) return;
    const records = filteredRecords();
    const selected = selectedRecord() || records[0] || null;
    if (selected && state.selectedKey !== selected.key) state.selectedKey = selected.key;
    const scrollSnapshot = snapshotPanelScroll();
    root.innerHTML = `${state.open ? renderPanel(records, selected) : ""}${renderContextMenu()}`;
    restorePanelScroll(scrollSnapshot);
  }

  function renderContextMenu() {
    if (!state.contextMenu.open) return "";
    const stats = summarizeRecords();
    return `
      <section class="rs-context-menu" style="left: ${state.contextMenu.x}px; top: ${state.contextMenu.y}px" aria-label="Resource Sniffer menu">
        <button class="rs-context-item" type="button" data-rs-action="open-panel">
          打开资源嗅探器
          <span>${stats.all} 个候选，Shift+右键保留原菜单</span>
        </button>
        <button class="rs-context-item" type="button" data-rs-action="scan">
          重新扫描本页
          <span>图片、视频、srcset、HLS/DASH</span>
        </button>
      </section>
    `;
  }

  function snapshotPanelScroll() {
    if (!root || !state.open) return null;
    return {
      listTop: root.querySelector(".rs-list")?.scrollTop || 0,
      detailTop: root.querySelector(".rs-detail")?.scrollTop || 0,
    };
  }

  function restorePanelScroll(snapshot) {
    if (!snapshot || !root || !state.open) return;
    const list = root.querySelector(".rs-list");
    const detail = root.querySelector(".rs-detail");
    if (list) list.scrollTop = snapshot.listTop;
    if (detail) detail.scrollTop = snapshot.detailTop;
  }

  function renderPanel(records, selected) {
    const stats = summarizeRecords();
    return `
      <section class="rs-panel" aria-label="Resource Sniffer">
        <header class="rs-head">
          <div class="rs-brand">
            <span class="rs-mark">RES</span>
            <div>
              <h2>资源嗅探器</h2>
              <p class="rs-sub">本地嗅探图片原图、srcset 高分候选、视频直链、HLS/DASH 流地址。默认不显示悬浮按钮，右键页面或 Alt+Shift+R 打开。</p>
            </div>
          </div>
          <div class="rs-actions">
            <div class="rs-stats">
              <span class="rs-pill"><strong>${stats.all}</strong>全部</span>
              <span class="rs-pill"><strong>${stats.image}</strong>图片</span>
              <span class="rs-pill"><strong>${stats.video}</strong>视频</span>
              <span class="rs-pill"><strong>${stats.stream}</strong>流</span>
            </div>
            <button class="rs-close" type="button" data-rs-action="close" title="折叠">×</button>
          </div>
        </header>
        <section class="rs-toolbar">
          <label class="rs-search">
            <span>搜索</span>
            <input data-rs-search type="search" value="${escapeHtml(state.query)}" placeholder="域名、文件名、格式、来源">
          </label>
          <div class="rs-filters">
            ${renderFilter("all", "全部")}
            ${renderFilter("image", "图片")}
            ${renderFilter("video", "视频")}
            ${renderFilter("stream", "流媒体")}
            ${renderFilter("high", "高分")}
            <select class="rs-select" data-rs-sort aria-label="排序">
              <option value="quality" ${state.sort === "quality" ? "selected" : ""}>质量优先</option>
              <option value="newest" ${state.sort === "newest" ? "selected" : ""}>最新优先</option>
              <option value="host" ${state.sort === "host" ? "selected" : ""}>域名分组</option>
            </select>
            <button class="rs-button" type="button" data-rs-action="scan">重新扫描</button>
            <button class="rs-button" type="button" data-rs-action="toggle-scan">${state.scanning ? "暂停观察" : "继续观察"}</button>
            <button class="rs-button" type="button" data-rs-action="copy-list">复制列表</button>
            <button class="rs-button" type="button" data-rs-action="clear">清空</button>
          </div>
        </section>
        <section class="rs-main">
          <div class="rs-list">
            ${records.length ? records.map(renderRow).join("") : renderEmptyList()}
          </div>
          ${selected ? renderDetail(selected) : renderEmptyDetail()}
        </section>
      </section>
    `;
  }

  function renderFilter(filter, label) {
    return `<button class="rs-filter ${state.filter === filter ? "is-active" : ""}" type="button" data-rs-filter="${filter}">${escapeHtml(label)}</button>`;
  }

  function renderRow(record) {
    return `
      <button class="rs-row ${record.key === state.selectedKey ? "is-selected" : ""}" type="button" data-rs-key="${escapeHtml(record.key)}">
        <div class="rs-thumb">${renderThumb(record)}</div>
        <div class="rs-row-body">
          <div class="rs-row-top">
            <span class="rs-kind is-${escapeHtml(record.kind)}">${escapeHtml(labelKind(record.kind))}</span>
            <span class="rs-row-meta">${escapeHtml(record.ext || "-")}</span>
          </div>
          <div class="rs-title">${escapeHtml(record.title || bestTitleFromUrl(record.url))}</div>
          <div class="rs-url">${escapeHtml(record.url)}</div>
          <div class="rs-row-meta">
            <span>${escapeHtml(sizeLabel(record))}</span>
            <span>${escapeHtml(hostOf(record.url))}</span>
          </div>
          <div class="rs-tags">${record.tags.slice(0, 4).map((tag) => `<span class="rs-tag">${escapeHtml(tag)}</span>`).join("")}</div>
        </div>
      </button>
    `;
  }

  function renderThumb(record) {
    if (record.kind === "image" && record.previewUrl) {
      return `<img src="${escapeHtml(record.previewUrl)}" loading="lazy" alt="">`;
    }
    if (record.kind === "stream") return "HLS";
    if (record.kind === "video") return "VID";
    return "RES";
  }

  function renderDetail(record) {
    return `
      <article class="rs-detail">
        <div class="rs-preview">${record.kind === "image" && record.previewUrl ? `<img src="${escapeHtml(record.previewUrl)}" alt="">` : escapeHtml(previewLabel(record))}</div>
        <h3>${escapeHtml(record.title || bestTitleFromUrl(record.url))}</h3>
        <div class="rs-detail-url">${escapeHtml(record.url)}</div>
        <dl class="rs-metrics">
          <div><dt>类型</dt><dd>${escapeHtml(labelKind(record.kind))}</dd></div>
          <div><dt>尺寸</dt><dd>${escapeHtml(sizeLabel(record))}</dd></div>
          <div><dt>格式</dt><dd>${escapeHtml(record.ext || contentTypeLabel(record) || "-")}</dd></div>
          <div><dt>来源</dt><dd>${escapeHtml(record.sources.join(", ") || "-")}</dd></div>
        </dl>
        <div class="rs-detail-actions">
          <button class="rs-button" type="button" data-rs-action="download">${downloadButtonLabel(record)}</button>
          <button class="rs-button" type="button" data-rs-action="open">新标签打开</button>
          <button class="rs-button" type="button" data-rs-action="copy-url">复制 URL</button>
          <button class="rs-button" type="button" data-rs-action="copy-command">复制下载命令</button>
          <button class="rs-button" type="button" data-rs-action="copy-selected">复制资源信息</button>
        </div>
        ${record.note ? `<div class="rs-note">${escapeHtml(record.note)}</div>` : ""}
        ${record.kind === "stream" ? `<div class="rs-note">浏览器脚本能抓到 HLS/DASH 地址，但合并分片建议用 yt-dlp 或 ffmpeg；遇到 DRM 加密流不会绕过保护。</div>` : ""}
        <pre class="rs-code">${escapeHtml(recordBundle(record))}</pre>
      </article>
    `;
  }

  function renderEmptyList() {
    return `<div class="rs-empty"><div><h3>还没有资源</h3><p>刷新页面、滚动图片列表、播放视频，或点“重新扫描”。</p></div></div>`;
  }

  function renderEmptyDetail() {
    return `<div class="rs-empty"><div><h3>选择一个资源</h3><p>查看原始地址、尺寸、来源和下载命令。</p></div></div>`;
  }

  function filteredRecords() {
    const query = state.query.trim().toLowerCase();
    const records = Array.from(state.records.values()).filter((record) => {
      if (state.filter === "image" && record.kind !== "image") return false;
      if (state.filter === "video" && record.kind !== "video") return false;
      if (state.filter === "stream" && record.kind !== "stream") return false;
      if (state.filter === "high" && !(record.kind === "stream" || record.kind === "video" || record.score > 1_920_000)) return false;
      if (!query) return true;
      return [record.url, record.title, record.kind, record.ext, record.contentType, record.sources.join(" "), record.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return records.sort((a, b) => {
      if (state.sort === "newest") return b.lastSeen - a.lastSeen;
      if (state.sort === "host") return hostOf(a.url).localeCompare(hostOf(b.url)) || b.score - a.score;
      return b.score - a.score || b.lastSeen - a.lastSeen;
    });
  }

  function selectedRecord() {
    return state.records.get(state.selectedKey) || null;
  }

  function summarizeRecords() {
    const items = Array.from(state.records.values());
    return {
      all: items.length,
      image: items.filter((item) => item.kind === "image").length,
      video: items.filter((item) => item.kind === "video").length,
      stream: items.filter((item) => item.kind === "stream").length,
    };
  }

  function downloadRecord(record) {
    if (!record.downloadable) {
      void copyText(recordBundle(record), "blob/MSE 不能直接下载，已复制资源信息");
      return;
    }
    if (record.kind === "stream") {
      void copyText(downloadCommand(record), "流下载命令已复制");
      return;
    }
    const filename = filenameFor(record);
    try {
      if (typeof GM_download === "function" && /^https?:/i.test(record.url)) {
        GM_download({
          url: record.url,
          name: filename,
          saveAs: true,
          onerror: () => openDownload(record, filename),
        });
        showToast("已调用下载");
        return;
      }
    } catch {
      // Fall back to native anchor.
    }
    openDownload(record, filename);
  }

  function openDownload(record, filename) {
    const anchor = document.createElement("a");
    anchor.href = record.url;
    anchor.download = filename;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    showToast("已打开资源");
  }

  function downloadCommand(record) {
    const filename = filenameFor(record);
    if (!record.downloadable) {
      return [
        "# blob/MSE 地址不能用 curl 直接下载。",
        "# 在资源列表里继续找 .m4s、.m3u8、.mpd 或 fetch/xhr 捕获到的真实网络地址。",
        `# captured: ${record.url}`,
      ].join("\n");
    }
    if (record.kind === "stream") {
      return [`yt-dlp ${shellQuote(record.url)} -o ${shellQuote("%(title)s.%(ext)s")}`, `ffmpeg -i ${shellQuote(record.url)} -c copy ${shellQuote(filename.replace(/\.(m3u8|mpd)$/i, ".mp4"))}`].join("\n");
    }
    return `curl -L ${shellQuote(record.url)} -o ${shellQuote(filename)}`;
  }

  function downloadButtonLabel(record) {
    if (!record.downloadable) return "复制资源信息";
    if (record.kind === "stream") return "复制流下载命令";
    return "下载原资源";
  }

  function recordBundle(record) {
    return JSON.stringify(
      {
        title: record.title || bestTitleFromUrl(record.url),
        kind: record.kind,
        url: record.url,
        size: sizeLabel(record),
        extension: record.ext,
        contentType: record.contentType,
        downloadable: record.downloadable,
        sources: record.sources,
        tags: record.tags,
        note: record.note,
        download: downloadCommand(record),
      },
      null,
      2,
    );
  }

  async function copyText(text, label) {
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
    toast.className = "rs-toast";
    toast.textContent = text;
    root.appendChild(toast);
    window.setTimeout(() => toast.remove(), 1500);
  }

  function filenameFor(record) {
    const fromUrl = bestTitleFromUrl(record.url).replace(/[\\/:*?"<>|]+/g, "_");
    if (/\.[a-z0-9]{2,6}$/i.test(fromUrl)) return fromUrl;
    const ext = record.ext || (record.kind === "image" ? "jpg" : record.kind === "stream" ? "mp4" : "mp4");
    return `${fromUrl || record.kind}.${ext}`;
  }

  function previewLabel(record) {
    if (record.kind === "stream") return "HLS / DASH stream";
    if (record.kind === "video") return "Direct video resource";
    return "Resource";
  }

  function labelKind(kind) {
    return {
      image: "图片",
      video: "视频",
      stream: "流",
    }[kind] || "资源";
  }

  function sizeLabel(record) {
    if (record.width && record.height) return `${record.width} × ${record.height}`;
    if (record.kind === "stream") return "adaptive";
    if (record.kind === "video") return "video";
    return "unknown";
  }

  function contentTypeLabel(record) {
    return record.contentType ? record.contentType.split(";")[0] : "";
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function mergeUnique(a, b) {
    return Array.from(new Set([...(a || []), ...(b || [])].filter(Boolean)));
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

  function shellQuote(value) {
    return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
