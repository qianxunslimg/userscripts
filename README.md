# Userscripts

个人油猴脚本仓库。

线上入口：

- `https://almoststable.com/userscripts/`

## Scripts

- `scripts/chatgpt-session-converter.user.js`: ChatGPT 页面内复制 session JSON、CPA JSON、sub2api、sessionToken、accessToken。默认折叠成右下角轻量入口，点击后展开。
- `scripts/chatgpt-workspace-join-request.user.js`: ChatGPT 页面内本地缓存 workspace ID，支持名称、描述、启用勾选和运行记录，只对选中的空间手动发送加入请求。

## Frontend

这个仓库同时包含脚本展示前端。脚本本体仍然放在 `scripts/*.user.js`，Vite 构建时会把它们复制到 `dist/` 根目录，线上安装地址形如：

```text
/userscripts/chatgpt-session-converter.user.js
/userscripts/chatgpt-workspace-join-request.user.js
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
