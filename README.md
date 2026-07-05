# Userscripts

个人油猴脚本仓库。

## Scripts

- `scripts/chatgpt-session-converter.user.js`: ChatGPT 页面内复制 session JSON、CPA JSON、sub2api、sessionToken、accessToken。默认折叠成右下角按钮，点击后展开。

## Install

1. 打开 Tampermonkey。
2. 新建脚本。
3. 粘贴 `scripts/chatgpt-session-converter.user.js` 的内容并保存。
4. 打开 `https://chatgpt.com/`，右下角会出现 `Session Copy` 按钮。

## Check

```bash
npm run check
```
