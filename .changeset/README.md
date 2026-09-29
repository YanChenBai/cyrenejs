# 版本与发布

使用 Changesets 独立管理各包版本。需要发布的改动随代码提交 changeset：

```sh
vp run changeset
```

选择受影响的包、patch / minor / major，并填写面向使用者的变更说明。
只调整 CI 或文档且无需发布时，可以不添加 changeset。

## Release PR

1. 开发 PR 合入 `master` 后，工作流创建或更新 Release PR。
2. Release PR 包含包版本、包间依赖、CHANGELOG 和锁文件的更新。
3. 检查并合并 Release PR 后，工作流检查、测试、构建，再将未发布版本发布到 npm。
4. Changesets 自动创建 `包名@版本` tag 和 GitHub Release，无需手动推送 tag。
5. `scripts/release-notes.ts` 读取本次实际发布包的 Git commit，更新各自的 Release 标题和正文。

## Release 内容

包内 CHANGELOG 继续由 `@changesets/changelog-github` 生成，记录 changeset、PR 和作者。
GitHub Release 正文独立从 Git commit 生成，不读取 CHANGELOG 正文，也无需额外提供发布文案文件。
Changesets 仍负责版本意图：需要发布的改动仍须提交 changeset，commit 前缀不决定版本号。

脚本读取本包上一个可达 tag 到当前发布 tag 之间、实际修改 `packages/<包目录>` 的非 merge commit。
当前 tag 尚未创建时以 HEAD 为终点；首次发布读取此前全部包目录历史。
核心包兼容历史 `v版本` tag。使用完整 Git 历史运行（CI 已设置 `fetch-depth: 0`）。
同一个提交修改多个包时分别列入相关 Release；仓库根目录的变更不会自动归属到每个包。

| commit 前缀                                   | Release 分类                          |
| --------------------------------------------- | ------------------------------------- |
| `feat`                                        | Features                              |
| `fix`                                         | Fixes & Enhancements                  |
| `perf`                                        | Performance                           |
| `refactor`                                    | Refactoring                           |
| `docs`                                        | Docs                                  |
| `test`                                        | Tests                                 |
| `build` / `ci` / `chore` / `style` / `revert` | Build / CI / Chore / Styles / Reverts |
| 未识别前缀                                    | Other Changes                         |

`feat(core)!: ...` 等带 `!` 的提交，或正文包含 `BREAKING CHANGE:` / `BREAKING-CHANGE:` 的提交，
优先放入 Breaking Changes。scope 保留在条目中；标题末尾 `(#123)` 自动链接到 PR，所有条目都有 commit 链接。
自动版本提交 `chore: version packages` / `chore: release packages` 被忽略。
没有内容的栏目省略，不自动推测主题、Highlights 或迁移说明。

例如 `feat(core): add lazy dependencies (#123)` 会进入 Features，
`fix(elysia): handle disposal` 会进入 Fixes & Enhancements。
使用 squash merge 时，PR 标题应遵循同样的前缀规则，因为它会成为合并后的 commit 标题。

本地预览（只输出 Markdown）：

```sh
vp run release-notes cyrenejs 0.0.3
vp run test-release-notes
```

CI 通过 Changesets Action 的 `published-packages` 输出处理本次实际发布的包。
Release 正文由独立的 `release-notes` job 更新，重新检出发布提交和完整 tag 历史。
若只有正文更新失败，在 GitHub Actions 选择 Re-run failed jobs，即可重试正文更新而不重新发布 npm。
`version-packages`、`release` 和 `release-notes` 定义为不缓存的 Vite+ task，入口仍为 `vp run <名称>`。
如果发布已成功、Release 排版失败，可以在对应发布提交上单独重跑：

```sh
vp run release-notes cyrenejs 0.0.4 --publish
```

`--publish` 使用已登录的 `gh` 或 `GH_TOKEN` 更新已有 GitHub Release；不会再次发布 npm 包。
本地运行 `version-packages` 需要 `GITHUB_TOKEN` 以查询 PR 与作者。

本地可用 `vp run changeset status` 查看待发布变更。
`vp run version-packages` 会实际修改版本；`vp run release` 会实际发布，请勿用于验证。
PR 的 `pkg.pr.new` 预览流程独立保留。
预览流程会构建所有包，并通过锁文件中的 `pkg-pr-new` 一次发布 `packages/*` 的预览包。

## npm 认证与 provenance

正式发布使用 npm Trusted Publishing（OIDC），工作流授予 `id-token: write`，
并设置 `NPM_CONFIG_PROVENANCE=true`。无需配置长期 npm token。

每个发布包都需要在 npm 的 Trusted Publisher 设置中关联：

- GitHub owner：`YanChenBai`
- Repository：`cyrenejs`
- Workflow filename：`release.yml`
- 允许直接 publish

新包先完成 npm 首次发布及 Trusted Publisher 配置，再接入自动发布。
包的 `repository` 必须指向本仓库，并正确填写 `directory`。
GitHub 仓库需要启用 Actions 创建 Pull Request 的权限。
默认 GitHub token 创建的 PR 不会自动触发普通 PR 工作流；若分支保护要求这些检查，
可重新打开 Release PR 触发检查，或为 Changesets 的 `github-token` 配置 GitHub App token。

## 新增包

在 `packages/*` 中添加包及 `build` 脚本，随后为它添加 changeset；不需要修改发布工作流。
示例和内部包必须设置 `private: true`。Changesets 会发布所有尚未存在于 npm 的公开版本，
因此尚未准备发布的新包应保持私有。

参考：[Changesets 自动发布](https://changesets.dev/guide/automating)、
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。
