# Userscripts

个人油猴脚本仓库。

线上入口：

- `https://almoststable.com/userscripts/`

## Scripts

- `scripts/chatgpt-session-converter.user.js`: ChatGPT 页面内复制 session JSON、CPA JSON、sub2api、sessionToken、accessToken。默认折叠成右下角按钮，点击后展开。
- `scripts/resource-sniffer.user.js`: 资源嗅探器。左下角展示图片原图、srcset 高分候选、CSS 背景图、视频直链、HLS/DASH 流地址，可下载原资源、复制 URL、复制 `curl` / `yt-dlp` / `ffmpeg` 命令。数据只保存在当前页面内存，不上传。

## Frontend

这个仓库同时包含脚本展示前端。脚本本体仍然放在 `scripts/*.user.js`，Vite 构建时会把它们复制到 `dist/` 根目录，线上安装地址形如：

```text
/userscripts/resource-sniffer.user.js
```

新增脚本时：

1. 把 `.user.js` 放进 `scripts/`。
2. 在 `src/scripts.js` 添加一条脚本元数据。
3. 运行 `npm run validate`。

## Install

1. 打开 Tampermonkey。
2. 新建脚本。
3. 粘贴目标 `.user.js` 的内容并保存，或从线上入口打开脚本安装地址。
4. 打开匹配页面，右下角会出现对应脚本入口。

## Check

```bash
npm run validate
```
