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
    key: "api-capture-assistant",
    title: "API Capture Assistant",
    cnTitle: "网页 API 抓包助手",
    file: "api-capture-assistant.user.js",
    version: "0.1.0",
    updated: "2026-07-06",
    status: "维护中",
    category: "Debug",
    summary:
      "监听页面 fetch / XHR，在页面右下角生成 API 收件箱，可复制请求、响应、curl 和脱敏调试包。",
    why:
      "它不是 DevTools 的替代品，而是把高频排查动作前置到页面里：问题接口筛选、慢请求标记、默认脱敏复制、本页内存记录都在一个轻浮层里完成。",
    matches: ["*://*/*"],
    grants: ["GM_setClipboard"],
    runAt: "document-start",
    tags: ["fetch", "xhr", "curl", "json", "debug", "local-only"],
    sourcePath: "scripts/api-capture-assistant.user.js",
    installNote: "安装后访问任意网页，右下角会出现 API 入口；快捷键 Alt+Shift+A 可展开或折叠。",
  },
];

export const repositoryUrl = "https://github.com/qianxunslimg/userscripts";
