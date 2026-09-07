# Issue tracker: GitHub

项目规格、需求和问题使用 `tower1229/todo-by-cordis` 的 GitHub Issues，通过 gh CLI 操作；仓库位置以 git remote 核对，不使用本地 Markdown 代替正式 Issue。

- 发布规格：使用 `gh issue create --repo tower1229/todo-by-cordis --title ... --body-file ...`，完整正文写入临时文件，保留真实换行。
- 读取：使用 `gh issue view` 读取正文、标签及评论；创建前用 `gh issue list` 检查重复。
- 更新及标签：使用 `gh issue edit`，只修改授权的目标与字段。
- 评论、关闭及外部写入遵守用户授权，不因代码完成自动关闭 Issue。
- PRs as a request surface: no。拉取请求不作为默认需求分流入口。

技能要求 publish to the issue tracker 时创建 GitHub Issue；要求 fetch the relevant ticket 时读取对应 Issue 及评论。
