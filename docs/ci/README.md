# CI 工作流（待激活）

本目录存放 GitHub Actions 工作流文件的**源稿**。它们放在这里而不是
`.github/workflows/`，是因为推送工作流文件需要 PAT 具备 `workflow` 作用域，
当前发布用的令牌只有 `repo` 作用域，GitHub 会直接拒绝：

```
! [remote rejected] main -> main
  (refusing to allow a Personal Access Token to create or update workflow
   `.github/workflows/desktop-release.yml` without `workflow` scope)
```

## 激活方式（任选其一）

**A. 给令牌加 `workflow` 作用域**（推荐，一次到位）

1. GitHub → Settings → Developer settings → Personal access tokens → 选该令牌
2. 勾选 `workflow`，保存
3. 把文件放到正式位置并推送：

   ```bash
   mkdir -p .github/workflows
   git mv docs/ci/desktop-release.yml .github/workflows/desktop-release.yml
   git commit -m "ci: 启用桌面端发布工作流"
   git push origin main
   ```

**B. 在网页端直接新建**

打开仓库的 Actions 页 → New workflow → set up a workflow yourself，
把 yml 内容粘进去（网页端创建不受令牌作用域限制）。

## 工作流说明

`desktop-release.yml` —— 桌面端发布链路，**只作用于本仓库**：

- 触发：push `v*.*.*` tag，或手动 `workflow_dispatch`
- 校验 tag 与 `package.json` 的 `version` 一致（桌面端版本号的唯一来源）
- 跑 `scripts/verify-release-isolation.js`：仓库内不得有移动端源码/APK、
  更新源必须指向桌面端仓库、自动更新选版必须带桌面产物过滤
- `npm run build` 出 `.exe`，随后校验 `dist/` 里没有 APK/AAB
- 上传到**本仓库**的 Release（草稿，人工确认后发布）

移动端有自己仓库里的同构工作流 `android-release.yml`，两端互不干涉。

## 本地发版

不想走 CI 也可以本地发布（只认桌面端产物）：

```bash
npm run build
set GH_TOKEN=<你的 PAT>
node scripts/release-desktop.js --insecure     # 本机代理有 SSL 拦截，必须加 --insecure
```

先加 `--dry-run` 可以只看计划、不上传。

## 需要的密钥

| 位置 | 名称 | 用途 |
|---|---|---|
| 本机环境变量 | `GH_TOKEN` | 本地脚本发布用（repo 作用域即可） |
| 仓库 Secrets | 无 | 工作流用 Actions 自动注入的 `GITHUB_TOKEN` |
