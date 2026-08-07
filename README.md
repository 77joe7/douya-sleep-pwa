# 小豆芽 · 宝宝睡眠计划计算助手（PWA）

单文件离线优先的婴幼儿睡眠计划计算 PWA。前端为单文件 `index.html` + `app-sync.js`，支持本地模式与 Supabase 云端家庭共享同步。

## 当前版本
v3.3.1 —— 已删除登录页右下角「本地模式」徽标；本地模式下「设置 → 家庭共享」卡片点击后先弹登录小卡片，登录后可编辑身份、修改家庭名称、查看设备 ID、修改密码。

## 目录结构（本仓库为发布产物）
- `index.html` — 应用主文件（内嵌 CSS/JS）
- `app-sync.js` — 云端同步（Supabase：6 位家庭 ID + 密码 + JWT）
- `config.js` — Supabase 地址与公开密钥（留空则仅本地模式）
- `service-worker.js` — 离线缓存
- `manifest.json` — PWA 清单
- `.nojekyll` — 关闭 GitHub Pages 的 Jekyll 处理

## 部署
通过 GitHub Actions（`.github/workflows/deploy.yml`）自动发布到 GitHub Pages：
- 仅 `push` 到 `main` 触发，单运行单次上传 + 单次部署，避免触发速率限制；
- 使用官方 `GITHUB_TOKEN`（OIDC 鉴权）与 `actions/deploy-pages`，不手动轮询 REST API；
- `concurrency.cancel-in-progress` 取消重叠运行。

本地预览可用 `npx serve .` 或任意静态服务器。
