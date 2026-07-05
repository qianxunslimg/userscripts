export const scripts = [
  {
    key: "chatgpt-session-converter",
    title: "ChatGPT Session Copier",
    cnTitle: "ChatGPT 会话复制器",
    file: "chatgpt-session-converter.user.js",
    version: "0.1.0",
    updated: "2026-07-05",
    status: "维护中",
    category: "ChatGPT",
    summary:
      "在 ChatGPT 页面里一键复制 session JSON、CPA JSON、sub2api 配置、sessionToken 和 accessToken。",
    why:
      "把原本要打开 DevTools、复制接口响应、再手动整理的流程收成一个右下角浮层按钮。",
    matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
    grants: ["GM_setClipboard"],
    runAt: "document-idle",
    tags: ["session", "token", "sub2api", "clipboard"],
    sourcePath: "scripts/chatgpt-session-converter.user.js",
    installNote: "安装后打开 ChatGPT，右下角会出现 Session Copy 按钮。",
  },
  {
    key: "resource-sniffer",
    title: "Resource Sniffer",
    cnTitle: "资源嗅探器",
    file: "resource-sniffer.user.js",
    version: "0.1.0",
    updated: "2026-07-06",
    status: "维护中",
    category: "Media",
    summary:
      "嗅探页面里的图片原图、srcset 高分候选、视频直链、HLS/DASH 流地址，并提供下载、复制 URL 和下载命令。",
    why:
      "它不是泛泛的网络抓包，而是围绕“拿到尽可能原生的媒体资源”设计：DOM、srcset、CSS 背景、Performance、fetch/XHR 都会汇总到左下角资源面板。",
    matches: ["*://*/*"],
    grants: ["GM_setClipboard", "GM_download", "unsafeWindow"],
    runAt: "document-start",
    tags: ["image", "video", "hls", "dash", "download", "local-only"],
    sourcePath: "scripts/resource-sniffer.user.js",
    installNote: "安装后访问任意网页，左下角会出现 RES 入口；快捷键 Alt+Shift+R 可展开或折叠。",
  },
];

export const repositoryUrl = "https://github.com/qianxunslimg/userscripts";
