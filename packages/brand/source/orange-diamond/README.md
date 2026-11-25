# 橙红钻石 Logo 图稿

使用 Photopea 处理，保留原始渐变、纹理和几何结构。

| 文件                    | 用途                                                     |
| ----------------------- | -------------------------------------------------------- |
| `original.png`          | 用户提供的原图，1254 × 1254，未修改                      |
| `tile-transparent.png`  | 保留石墨底板，移除底板以外的背景，1254 × 1254 RGBA       |
| `glyph-transparent.png` | 移除全部底色，保留三个橙红图形及原画布，1254 × 1254 RGBA |
| `glyph-ui-1024.png`     | 透明图形，调整画布留白至适合界面使用，1024 × 1024 RGBA   |
| `logo-editable.psd`     | 原图、透明底板、透明图形三个独立图层                     |
| `preview.png`           | 浅色／深色背景及 16–96 px 显示对照                       |

已重新打开 PSD，并逐像素验证其中的原图层与 `original.png` 一致。透明 PNG 已检查 alpha 通道和四角透明度。

`glyph-ui-1024.png` 与 `tile-transparent.png` 已接入品牌生成流程。根目录运行 `bun run icons:generate`，同步更新桌面端、官网、README 使用的资源及系统 PNG、ICO、ICNS；已安装应用的图标需重新打包安装后更新。
