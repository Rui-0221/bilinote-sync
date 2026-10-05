# 发布到 Obsidian 社区目录

核对日期：2026-10-03。以 [Obsidian 官方提交说明](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) 为准。现在新插件通过 **community.obsidian.md** 提交，不能照搬旧教程中向 `obsidian-releases` 提交 PR 的流程。

## 已准备

- 插件 ID：`bilinote-sync`；名称：`BiliNote Sync`；当前版本：`1.4.2`。
- 根目录包含可读源代码 `main.js`、`manifest.json`、`styles.css`、README、MIT LICENSE、测试与检查脚本。
- manifest 设置 `isDesktopOnly: true`，最低版本为本次实际验证的 1.13.7；没有声明未经验证的更老版本兼容性。
- README 披露仓库外文件访问、图片硬链接、缓存永久删除、平台限制和外部依赖。
- `author` 与许可证目前使用 `BiliNote Sync contributors`，公开前可改为你决定的署名。当前候选使用 MIT 许可证。

## 1. 创建公开 GitHub 仓库

用你准备维护插件的 GitHub 账号，新建公开仓库，例如 `bilinote-sync`。先在社区目录搜索名称与 ID 是否已被占用；提交表单会检查唯一性。如果发生冲突，调整 ID、插件目录、文档和清单检查脚本后重新验证。

上传这里的项目文件，使 `main.js`、`manifest.json`、`README.md`、`LICENSE` 位于默认分支根目录。**只上传这个发布项目的文件，不上传整个 Codex 工作目录、Obsidian 仓库或 BiliNote 安装目录。** 不上传 `node_modules`、`.release`、测试生成目录、`data.json`、Cookie、API Key、`.env`、数据库或个人笔记。

推荐从 Git 工具按 `.gitignore` 上传。公开仓库已经建立：[Rui-0221/bilinote-sync](https://github.com/Rui-0221/bilinote-sync)。先在本机执行 `npm ci`、`npm run check`；检查通过后提交源码。源码在 `src` 中，根目录的安装文件由构建命令重新生成。

## 2. 发布 GitHub Release

Tag 精确填写 **1.4.2**，与 manifest 的 version 完全相同，不加 `v`。推送默认分支和版本标签后，GitHub Actions 会检查 Windows 与 Linux 构建，为以下附件生成并验证来源证明，再创建正式 Release：

1. `main.js`
2. `manifest.json`
3. `styles.css`

这些文件由 `npm run build` 放在 `.release/1.4.2/`。等待 Actions 成功后确认三个附件都存在。只上传一个 ZIP 或使用 GitHub 自动生成的源码 ZIP，不能代替这三个附件。

构建回归检查会从没有根目录 `main.js`、`styles.css` 的目录开始，核对重新生成的文件与源码一致。来源证明由 GitHub 托管流水线使用临时凭据签发，无需上传个人 API Key 或签名私钥。

更新后，在社区管理页点击 **Check for new releases** 获取新版审核。直接文件系统访问与仓库枚举是读取本机 BiliNote 结果、恢复移动笔记所需的能力，README 已披露；审核可能继续展示相应提示。

## 3. 提交社区目录

1. 登录 [community.obsidian.md](https://community.obsidian.md)，需要 Obsidian 账号。
2. 在个人资料的 GitHub 区域点击 Connect，连接拥有该仓库的 GitHub 账号。
3. 到 Plugins → New plugin，填公开仓库 URL，并选择负责维护的 Owner。
4. 阅读并同意开发者政策，确认会继续维护或在无法维护时移交/移除，再提交。

官方系统会读取默认分支 HEAD 的 manifest，并进行自动检查。出现问题时按反馈修复、递增版本、发布对应新 Release，再更新提交。**本机测试通过不代表已经上架或保证审核通过。**

## 后续更新

同时修改 manifest、package 与 package-lock 的版本，在 `versions.json` 增加最低应用版本映射，运行全部检查，再推送精确同名 Tag。流水线会创建 Release、来源证明和三个附件。已经发布的插件通常无需每个版本重新提交目录。

## 参考

- [提交插件](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [设置社区账号与提交表单](https://docs.obsidian.md/community-directory/set-up-and-claim)
- [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)
- [插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Manifest 规则](https://docs.obsidian.md/Reference/Manifest)
- [官方检查工具](https://github.com/obsidianmd/eslint-plugin)
