# CI 工作流

工作流源文件在 `.github/workflows/desktop-release.yml`（本目录只留说明文档）。

> 历史备注：推送工作流文件需要 PAT 具备 `workflow` 作用域。若你的令牌只有 `repo`
> 作用域，GitHub 会直接拒绝推送：
>
> ```
> ! [remote rejected] main -> main
>   (refusing to allow a Personal Access Token to create or update workflow
>    `.github/workflows/desktop-release.yml` without `workflow` scope)
> ```
>
> 解决办法二选一：给令牌补勾 `workflow`，或在仓库 Actions 页用网页端新建（网页端不受令牌作用域限制）。

## 工作流说明

`desktop-release.yml` —— 桌面端发布链路，**只作用于本仓库**：

- 触发：push `v*.*.*` tag，或手动 `workflow_dispatch`
- 校验 tag 与 `package.json` 的 `version` 一致（桌面端版本号的唯一来源）
- 跑 `scripts/verify-release-isolation.js`：仓库内不得有移动端源码/APK、
  更新源必须指向桌面端仓库、自动更新选版必须带桌面产物过滤
- `npm run build` 出 `.exe`，随后校验 `dist/` 里没有 APK/AAB
- 上传到**本仓库**的 Release（草稿，人工确认后发布）

移动端有自己仓库里的同构工作流 `android-release.yml`，两端互不干涉。

## 发布说明文件

Release 正文取自 `docs/desktop-release/v<版本号>-notes.md`，例如
`docs/desktop-release/v1.2.3-notes.md`。发版前先建好这个文件，否则工作流会因为
`body_path` 找不到而失败。

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
