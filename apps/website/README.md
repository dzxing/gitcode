# GitCode 门户

独立的 Nuxt 4 + Vue 3 + Nuxt UI 静态网站，包含首页、下载、Markdown 使用文档和更新日志。共享 Logo 来自 `@gitcode/brand`，不依赖桌面运行环境。

在仓库根目录运行：

```bash
bun install --filter '@gitcode/website' --frozen-lockfile
bun run dev:website
bun run check:website
bun run lint:website
bun run build:website
```

开发端口为 43189。`check:website` 包括 Nuxt 类型检查、Vue／TypeScript ESLint 及格式检查；Nuxt 自动导入的标识符由生成的类型检查验证。构建输出 `apps/website/.output/public`，可部署到普通静态托管，无需 Node 常驻服务。部署到子目录时，在构建前设置 `NUXT_APP_BASE_URL`。

文档放在 `content/*.md`，在 `app/data/documents.ts` 注册导航。Markdown 是受信任的仓库内容，不接受访客输入。更新日志维护 `content/changelog.md`。

下载信息维护 `app/data/releases.json`：

```json
{
  "version": "1.0.1",
  "downloads": [
    {
      "platform": "Windows",
      "architecture": "x64",
      "url": "https://你的公开下载域名/GitCode-Setup-1.0.1.exe",
      "sha256": "安装包的64位十六进制SHA-256"
    }
  ]
}
```

只有 HTTPS 地址且 SHA-256 格式正确的条目会显示为下载链接。未发布安装包时保持空数组。发布清单独立维护，不能导入桌面 `package.json`，也不要将私有仓库或本机路径放入官网。

源码与问题反馈链接待确定公开仓库后再接入。门户使用 Nuxt UI 的按钮、产品页签、折叠问答和页面组件，采用 GitCode 品牌与自定义深色视觉样式。页面构图参考 GitKraken 首页：左右首屏、组合产品画面、紫色渐变与炭灰层次、带界面细节的功能卡片；不使用其图片、品牌素材或文案。公共布局及内页样式在 `app/assets/main.css`，首页独立展示样式在 `app/assets/home.css`。首页、下载、文档和更新日志共享导航及页脚。

产品截图保存在 `public/product/`，来自实际 GitCode 界面，使用测试用示例仓库，不包含私人项目数据。更新桌面 UI 后可重新截图替换，主工作区截图保持 1600 × 1000 的原图比例，`graph-detail.png`、`changes-detail.png`、`diff-detail.png` 为直接截取的组件细节；首页使用 CSS 组合与裁切展示区域。

图标来自本地 `@iconify-json/lucide`，构建时通过 Nuxt Icon 客户端打包，不在运行时请求外部图标 API；动态图标需加入 `nuxt.config.ts` 的 `icon.clientBundle.icons`。关闭自动远程字体下载，使用系统字体回退。公开下载发布仍由发布清单独立控制。
