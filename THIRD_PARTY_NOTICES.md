# 第三方声明

GitCode 的原创部分采用根目录 [LICENSE](LICENSE) 中的自定义非商业、禁止修改与衍生作品许可。第三方代码、适配的上游部分、依赖、图标和字体继续遵循各自许可；根目录许可不限制这些第三方许可原本授予的权利。

## 仓库中保留的许可与声明

| 材料                                       | 许可                      | 本地声明                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IntelliJ IDEA 图谱相关上游代码与适配来源   | Apache-2.0                | [来源与改动说明](apps/desktop/third-party/jetbrains-graph/NOTICE.txt) · [许可全文](apps/desktop/third-party/jetbrains-graph/LICENSE.txt)                                                                        |
| Google Material Symbols 图标               | Apache-2.0                | [来源说明](apps/desktop/third-party/google-material-symbols/NOTICE.txt) · [许可全文](apps/desktop/third-party/google-material-symbols/LICENSE.txt)                                                              |
| xterm.js 与终端组件                        | MIT                       | [组件说明](apps/desktop/third-party/terminal/NOTICE.txt) · [xterm.js 许可](apps/desktop/third-party/terminal/xterm-LICENSE.txt) · [Fit 插件许可](apps/desktop/third-party/terminal/xterm-addon-fit-LICENSE.txt) |
| node-pty                                   | MIT                       | [许可全文](apps/desktop/third-party/terminal/node-pty-LICENSE.txt)                                                                                                                                              |
| Cascadia Mono、Noto Sans SC 及其他内置字体 | SIL Open Font License 1.1 | [字体来源与校验清单](apps/desktop/public/fonts/manifest.json) · [字体目录与各字体 OFL 文件](apps/desktop/public/fonts)                                                                                          |

IntelliJ IDEA 相关材料的具体上游文件、版本与 GitCode 适配说明见其 NOTICE，相关源文件也保留了许可说明。第三方部分不因与 GitCode 原创部分放在同一文件或安装包中，就失去原有许可权利。

上表是仓库随附声明的索引，不是完整的依赖清单。Electron、Vue、Pinia、Nuxt、Nuxt UI、Tailwind CSS、Lucide 及其他直接和间接依赖，以锁定版本各自附带的许可为准。依赖版本由根目录 `bun.lock` 固定。

分发第三方材料时，应继续保留其许可所要求的著作权声明、许可文本及 NOTICE。根目录的限制仅适用于著作权人有权按该条件授权的 GitCode 原创部分。
