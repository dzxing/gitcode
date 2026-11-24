# GitCode 门户

独立的 Nuxt 4 + Vue 3 静态网站，包含首页、下载、Markdown 使用文档和更新日志。共享 Logo 来自 `@gitcode/brand`，不依赖桌面运行环境。

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

源码与问题反馈链接待确定公开仓库后再接入。此模块已建立运行骨架，产品截图、正式宣传内容和公开下载发布可独立迭代。
