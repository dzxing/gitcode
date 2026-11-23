# GitCode 品牌资源

桌面与官网通过 `@gitcode/brand/assets/*` 使用同一套品牌源文件。此包不包含应用组件、主题或 Git 业务。

- `source/logo-original.png`：保留背景的原始图稿，仅用于设计追溯，不参与图标生成或应用打包。
- `assets/logo-glyph-transparent.svg`：透明 Logo 的标准矢量源。
- `assets/logo-master.png`：桌面大尺寸图标源图。
- `assets/logo-ui-compact.svg`：小尺寸光学校正版本，由生成脚本派生。
- `scripts/generate.mjs`：使用 Resvg 从矢量源重建透明 PNG 与深浅变体。

在根目录运行 `bun run icons:generate`，会先生成共享资源，再生成桌面的 ICO、ICNS 和 favicon。派生资源保留在版本控制中，因此应用构建不依赖现场生成或跨系统图像工具。
