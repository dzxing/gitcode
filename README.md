<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/brand/assets/logo-glyph-transparent-256.png" />
    <img src="packages/brand/assets/logo-glyph-light-256.png" alt="GitCode Logo" width="100" height="100" />
  </picture>
</p>

<h1 align="center">GitCode</h1>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center"><strong>See every change. Manage every branch.</strong></p>
<p align="center">A local Git workbench for your history, changes, and GitFlow workflows.</p>

<p align="center">
  <img src="docs/assets/badges/version.svg" alt="Version 1.0.1" />
  <img src="docs/assets/badges/electron.svg" alt="Electron 45" />
  <img src="docs/assets/badges/vue.svg" alt="Vue 3" />
  <img src="docs/assets/badges/typescript.svg" alt="TypeScript" />
  <a href="LICENSE"><img src="docs/assets/badges/license.svg" alt="Custom non-commercial, no-derivatives license" /></a>
</p>

<p align="center">
  <a href="http://8.138.163.129/">Website</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="apps/desktop/README.md">Guide (中文)</a> ·
  <a href="https://github.com/dzxing/gitcode/issues">Issues</a>
</p>

<p align="center">
  <img src="apps/website/public/product/workbench.png" alt="GitCode: repository navigation, commit graph, and working tree changes" width="1200" />
</p>

## Quick start

Install **Git 2.30+, Node.js 22.22.3, and Bun 1.3.14**, then run:

```bash
git clone https://github.com/dzxing/gitcode.git
cd gitcode
bun install --frozen-lockfile
bun run desktop
```

On WSL, start with `bun run desktop:wsl`. See the [build guide (中文)](docs/DEVELOPMENT.md) for other supported runtimes and packaging commands.

## Usage

### Open a repository

Choose **Open repository** on the home screen and select an existing Git repository. You can also clone or create a repository there.
If Git is not detected, select its executable under **Settings → Git → Git runtime**.

### Commit changes

1. Select a file under **Working tree changes** to review its diff.
2. Stage the changes you want to commit.
3. Enter a commit message and click **Commit**.

### Sync with a remote

- **Fetch** updates remote-tracking branch information.
- **Pull** merges remote updates into the current branch.
- **Push** publishes local commits. Confirm the remote and target branch on the first push.

If conflicts occur, open the affected files, resolve and mark them as resolved, then continue the operation.

### Use GitFlow

1. Open the **GitFlow** panel in the repository sidebar and configure the production branch, development branch, and branch prefixes.
2. Select **Feature**, enter a name, and confirm the starting point to create and check out the feature branch.
3. Commit your changes and push the feature branch when needed.
4. When finishing a feature, review the merge targets and resolve any conflicts, then push the merged changes when needed.

<details>
  <summary>View the GitFlow panel</summary>
  <p><img src="apps/website/public/product/gitflow.png" alt="GitCode GitFlow panel" width="1200" /></p>
</details>

## Guides and feedback

[Desktop guide (中文)](apps/desktop/README.md) · [Development and builds (中文)](docs/DEVELOPMENT.md) · [Website maintenance (中文)](apps/website/README.md) · [Report an issue](https://github.com/dzxing/gitcode/issues)

## License

Non-commercial use only; modifications and derivative works require separate written permission. See [LICENSE](LICENSE). Third-party components retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
