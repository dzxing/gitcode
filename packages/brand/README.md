# GitCode 品牌资源

桌面与文档通过 `@gitcode/brand/assets/*` 使用同一套品牌源文件。此包不包含应用组件、主题或 Git 业务。

- `source/orange-diamond/`：新 Logo 的原图、Photopea 分层 PSD、透明图形和带底板图稿。
- `source/orange-diamond/glyph-ui-1024.png`：界面 Logo 的生成源，保留原始橙红渐变。
- `source/orange-diamond/tile-transparent.png`：系统图标生成源，保留石墨底板，四角透明。
- `assets/logo-glyph-transparent*.png`：桌面及文档共用的透明图形；`logo-glyph-light-*.png` 保留兼容文件名，图形一致。
- `assets/logo-master.png`：从底板图稿同步生成，供 ICO、ICNS 和系统 PNG 使用。
- `scripts/generate.mjs`：从上述两张 PNG 确定性重建派生资源；不再使用旧 Logo 的 SVG 绘制规则。
- `source/logo-original.png`：上一版原图，仅保留设计追溯，不参与生成或应用打包。

在根目录运行 `bun run icons:generate`，会先生成共享资源，再生成桌面的 ICO、ICNS 和 favicon。派生资源保留在版本控制中，因此应用构建不依赖现场生成或跨系统图像工具。
