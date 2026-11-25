# 开发与工作区

GitCode 是使用 Vue 3、TypeScript 和 Electron 开发的本地 Git 工作台。此仓库使用 Bun Workspaces 管理桌面应用和共享品牌资源；门户独立维护，不属于公开工作区。

```text
apps/
  desktop/           Electron + Vue 桌面应用及浏览器开发预览
packages/
  brand/             共享 Logo 源文件与派生资源
scripts/             工作区边界检查
legacy/              已归档的 Tauri、Python 原型，不参与运行和打包
release/
  desktop/<版本号>/   桌面安装包及同版本历史产物（不提交）
bun.lock             唯一依赖锁文件
.prettierrc          统一 Prettier 配置，YAML 格式
```

## 环境与安装

统一开发环境使用 Node.js 22.22.3（见 `.node-version`）和 Bun 1.3.14，也支持 Node.js 24.15 或更高的 24.x 版本。`.node-version` 供版本管理工具和 CI 读取，不会自动升级或切换系统 Node；安装依赖前请确认 `node --version`。桌面 Git 操作需要系统 Git 2.30 或更高版本，应用不自带 Git。

```bash
bun install --frozen-lockfile
```

Windows、WSL、macOS 应各自安装依赖，不要跨系统复用 `node_modules` 或终端原生模块。
公开工作区显式包含 `apps/desktop` 和 `packages/*`，不会因为本机存在门户目录而安装其依赖。

## 常用命令

所有命令都可在仓库根目录运行：

| 命令                                      | 用途                                           |
| ----------------------------------------- | ---------------------------------------------- |
| `bun run dev`                             | 桌面界面的浏览器预览，`http://127.0.0.1:43187` |
| `bun run desktop`                         | 启动 Electron 桌面应用                         |
| `bun run desktop:wsl`                     | WSL 桌面开发，软件渲染                         |
| `bun run build`                           | 检查并构建桌面前端                             |
| `bun run check`                           | 全仓库检查：边界、桌面应用检查及全仓格式检查   |
| `bun run typecheck`                       | 桌面 TypeScript 类型检查                       |
| `bun run lint`                            | 桌面及公共脚本的 ESLint 检查                   |
| `bun run lint:shared`                     | 根目录与品牌生成脚本的 ESLint 检查             |
| `bun run test`                            | 桌面 Git、IPC、组件等回归测试                  |
| `bun run test:ui`                         | 桌面浏览器交互测试                             |
| `bun run test:core-reload`                | 本机 Git 核心热重载测试                        |
| `bun run format` / `bun run format:check` | 全仓库格式化 / 检查                            |
| `bun run icons:generate`                  | 从共享品牌源文件生成桌面图标                   |
| `bun run desktop:build`                   | 在当前系统构建桌面安装包                       |
| `bun run desktop:build:win`               | 从 Windows 调用完整 Windows 构建脚本           |

为兼容原有命令，`dev`、`build`、`preview` 和 `test` 默认针对桌面应用。根目录 `typecheck` 与 `lint` 检查整个工作区，也可用 `typecheck:desktop`、`lint:desktop` 单独检查应用；整仓质量检查使用 `bun run check`。Vue／TypeScript 执行严格类型检查；Electron、开发脚本及 JS 测试执行对应的 JavaScript ESLint 检查。

首次执行浏览器测试前，在根目录运行 `bunx playwright install chromium` 安装当前 Playwright 版本对应的浏览器。Linux 若缺少浏览器系统依赖，可按 Playwright 的提示安装；已有其他版本的 Chromium 不一定能被默认测试配置复用。

Windows 可从仓库根目录运行 `bun run desktop:build:win`，也可双击 `apps/desktop/build-windows.cmd`。该脚本安装锁定的桌面依赖、构建并打包，产物输出到 `release/desktop/<版本号>/`。macOS 安装包需要 macOS 构建环境，签名与公证需要另行配置。

桌面的功能、平台支持与验证说明见 [桌面文档](../apps/desktop/README.md)。门户源码保留在本地 `apps/website/`，不提交到后续公开版本。

## 模块边界

- `apps/desktop` 自行管理 Electron 主进程、preload、Vue renderer、Git 核心和原生终端模块。
- 公开模块不能直接导入本地私有门户 `apps/website` 的源码。
- `packages/brand` 只提供品牌资源和离线生成工具，不依赖任何应用。
- 应用间不能直接导入源码。只有出现第二个真实消费者时才提取新的共享包，避免空泛的 `shared/utils` 层。
- Vue、SSR renderer 和 TypeScript 等公共工具版本集中在根 `workspaces.catalog`，避免 Vue peer dependency 产生两份不兼容的响应式类型。各应用仍自行声明实际使用的依赖。
- 每个应用保留自己的构建、类型检查、版本和发布流程；根目录负责命令转发与公共格式规范。暂不引入额外任务编排工具。

`bun run check:boundaries` 检查包依赖与跨应用源码导入。桌面打包使用明确的暂存文件清单，不扫描整个工作区，因此不会将本地私有模块或开发依赖带入安装包。

`.gitattributes` 保证 Git 在各平台检出 LF 文本，`.editorconfig` 约束编辑器行为，`.prettierrc` 统一代码格式；三者各有用途。PowerShell 文件使用带 BOM 的 UTF-8，兼容 Windows PowerShell 5.1。

`.github/workflows/` 包含桌面构建、完整质量检查、敏感信息扫描和依赖安全审计，支持 main 分支推送、版本标签、手动触发及 Pull Request 检查。依赖审计还会每周运行，读取完整 Bun 锁文件并阻止高危和严重告警；Dependabot 配置用于 Bun 与 Actions 的定期更新。GitHub 仓库为 `dzxing/gitcode`，原 GitLab 远程保留；尚未配置 GitLab CI。

## 发布与迁移说明

桌面应用版本由 `apps/desktop/package.json` 管理。README 截图保存在 `docs/assets/screenshots/`。

`apps/website/` 已加入忽略规则，并从后续公开版本取消跟踪；源码仍保留在本地。此前已公开的提交历史和旧 Release 源码包按维护者决定保留，忽略规则不会移除这些历史内容。公开范围检查允许既有历史，但会阻止后续新增门户源码，包括先提交再删除的情况。

本次迁移保留桌面内部目录结构与运行时路径，仅调整工作区层级。根目录原有 `dev`、`desktop:wsl`、`build`、`test` 等入口继续可用。旧 `release/1.0.1` 产物已移动至 `release/desktop/1.0.1`，同版本重打包仍自动归档。

新增模块时，在 `apps/` 或 `packages/` 创建独立 `package.json`，并显式加入工作区，通过 `workspace:*` 引用共享包，并更新边界检查、检查命令和对应 CI。依赖变更在仓库根目录执行，只提交根 `bun.lock`。

## 本地资料与产物

品牌原始图稿保存在 `packages/brand/source/`，正式资源在 `packages/brand/assets/`。研究截图和验收记录放在根目录 `design/`，临时验证资料放在 `.tmp/`；这些本地资料不参与应用运行和打包。

`release/` 保存安装包与历史归档，不提交 Git。保留需要分发、回退的版本即可，旧安装包和可重新生成的解包目录可按需清理。`legacy/` 只保留旧实现源码；其 `target/`、Python 缓存等编译产物无需保留。

`node_modules/` 是工作区安装的本地依赖，`.idea/` 是本地 IDEA 配置；均不提交 Git。`.agents/`、`.codex/`、`.aws/` 等工具环境目录由对应工具管理，不属于应用源码。根目录 `scripts/` 只放工作区公共脚本，应用专属脚本放入对应 `apps/<应用>/scripts/`。

## 源码使用边界

克隆、编译与运行本仓库仍需遵守根目录的 [LICENSE](../LICENSE)。以下开发命令不授予商业使用、修改或衍生作品的许可。第三方组件遵循各自许可，参见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
