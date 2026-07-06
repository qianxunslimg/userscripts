export const scripts = [
  {
    key: "chatgpt-session-converter",
    title: "ChatGPT Session Copier",
    cnTitle: "ChatGPT 会话复制器",
    file: "chatgpt-session-converter.user.js",
    version: "0.1.2",
    updated: "2026-07-06",
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
    installNote: "安装后打开 ChatGPT，右下角会出现一个轻量 Session 入口。",
  },
];

export const repositoryUrl = "https://github.com/qianxunslimg/userscripts";
