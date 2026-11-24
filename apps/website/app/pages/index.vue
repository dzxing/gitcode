<script setup lang="ts">
import type { AccordionItem, TabsItem } from '@nuxt/ui'
import { downloads, release } from '../data/downloads'

const assetBase = useRuntimeConfig().app.baseURL

useSeoMeta({
  title: '看清每次变更，掌控每条分支',
  description:
    '用 GitCode 看清提交关系、审阅文件差异、管理 GitFlow。在本地桌面工作区，完成从变更到发布的日常 Git 工作。',
})
const previews = [
  {
    label: '提交关系',
    icon: 'i-lucide-git-fork',
    value: 'graph',
    image: '/product/workbench.png',
    alt: 'GitCode 实际界面：示例仓库中的提交关系图、分支导航和工作区变更',
  },
  {
    label: 'GitFlow',
    icon: 'i-lucide-git-branch',
    value: 'flow',
    image: '/product/gitflow.png',
    alt: 'GitCode 实际界面：配置完成后的 GitFlow 操作面板与基础分支',
  },
] satisfies TabsItem[]
const questions: AccordionItem[] = [
  {
    label: 'GitCode 需要服务器吗？',
    content:
      '桌面应用在本机运行，使用本机安装的 Git 操作仓库，无需部署 GitCode 服务器。访问远程仓库时，仍需要对应网络和访问权限。',
  },
  {
    label: '已有的 Git 仓库可以直接打开吗？',
    content:
      '可以。安装 Git 2.30 或更高版本后，打开已有仓库目录即可。GitCode 使用你现有的远程地址、SSH 密钥与凭证配置。',
  },
  {
    label: '需要额外安装 git-flow 扩展吗？',
    content:
      '不需要。GitCode 直接使用 Git 完成 GitFlow 操作，可配置基础分支和分支前缀，开始或完成功能、发布与修复分支。',
  },
  {
    label: '在哪里获取安装包？',
    content: downloads.length
      ? '请前往下载页，按系统和架构选择安装包，并核对 SHA-256 校验信息。'
      : '公开下载正在准备中。发布后，下载页将按系统和架构提供安装包与 SHA-256 校验信息；目前可以先阅读使用指南。',
  },
]
</script>

<template>
  <div class="portal-home">
    <section
      class="hero-stage"
      aria-labelledby="hero-title"
    >
      <UPageHero
        orientation="horizontal"
        class="portal-hero"
        :ui="{ container: 'hero-container', title: 'hero-title', description: 'hero-description' }"
      >
        <template #headline
          ><p class="hero-product-name">
            <UIcon
              name="i-lucide-git-fork"
              aria-hidden="true"
            />GitCode Desktop
          </p></template
        >
        <template #title
          ><span id="hero-title">看清每次变更，<br />掌控每条分支。</span></template
        >
        <template #description
          >让提交关系、文件差异和分支流程连在一起。<br
            class="desktop-break"
          />少一点工具切换，多一点对代码的把握。</template
        >
        <template #footer>
          <div class="hero-links">
            <UButton
              to="/download"
              size="xl"
              icon="i-lucide-download"
              class="hero-primary"
              >获取 GitCode Desktop</UButton
            >
            <UButton
              to="#product-preview"
              size="xl"
              color="neutral"
              variant="outline"
              class="hero-secondary"
              >查看产品界面</UButton
            >
          </div>
          <p class="hero-platforms">适用于 <span>Windows、macOS 与 Linux</span></p>
        </template>
        <ProductArtwork />
      </UPageHero>
    </section>

    <section
      class="capability-band"
      aria-label="运行环境与工作方式"
    >
      <div class="wrap">
        <h2>你的仓库，熟悉的 Git，更连贯的工作方式。</h2>
        <p>沿用已有仓库、远程地址、SSH 密钥与凭证配置，从打开项目继续工作。</p>
        <div class="capability-items">
          <span
            ><UIcon
              name="i-lucide-folder-git-2"
              aria-hidden="true"
            />已有 Git 仓库</span
          >
          <span
            ><UIcon
              name="i-lucide-key-round"
              aria-hidden="true"
            />SSH / HTTPS</span
          >
          <span
            ><UIcon
              name="i-lucide-monitor"
              aria-hidden="true"
            />Windows · macOS · Linux</span
          >
          <span
            ><UIcon
              name="i-lucide-terminal"
              aria-hidden="true"
            />本机 Git 与终端</span
          >
        </div>
      </div>
    </section>

    <section
      id="features"
      class="workflow-section wrap"
      aria-labelledby="workflow-title"
    >
      <div class="section-introduction">
        <div>
          <p class="eyebrow">让上下文保持连贯</p>
          <h2 id="workflow-title">代码在变化，<br />思路不必被打断。</h2>
        </div>
        <p>
          理解历史，检查变更，管理分支。把一次提交前后的线索放回同一个工作区，让每一步操作都有依据。
        </p>
      </div>
      <div class="workflow-cards">
        <article class="workflow-card graph-card">
          <div class="workflow-card-image">
            <img
              :src="`${assetBase}product/graph-detail.png`"
              alt="GitCode 提交关系图的实际界面"
              width="860"
              height="733"
              loading="lazy"
            />
          </div>
          <div class="workflow-card-copy">
            <UIcon
              name="i-lucide-git-fork"
              aria-hidden="true"
            />
            <h3>沿着关系，读懂历史。</h3>
            <p>本地与远程分支、合并和标签，回到同一张提交图里。</p>
            <NuxtLink to="#product-preview">探索提交关系图</NuxtLink>
          </div>
        </article>
        <article class="workflow-card diff-card">
          <div class="workflow-card-image">
            <img
              :src="`${assetBase}product/diff-detail.png`"
              alt="GitCode 文件差异视图的实际界面"
              width="860"
              height="560"
              loading="lazy"
            />
          </div>
          <div class="workflow-card-copy">
            <UIcon
              name="i-lucide-file-diff"
              aria-hidden="true"
            />
            <h3>逐处审阅，再提交。</h3>
            <p>看清新增与删除，选择需要暂存的文件，保留每一次提交的边界。</p>
            <NuxtLink to="/docs/quickstart">了解提交工作流</NuxtLink>
          </div>
        </article>
        <article class="workflow-card flow-card">
          <div class="workflow-card-image">
            <ProductImage
              src="/product/gitflow.png"
              alt="GitCode GitFlow 操作面板的实际界面"
            />
          </div>
          <div class="workflow-card-copy">
            <UIcon
              name="i-lucide-git-branch"
              aria-hidden="true"
            />
            <h3>让分支按流程前进。</h3>
            <p>从 feature 到 release，用清楚的规则组织开发与发布。</p>
            <NuxtLink to="#gitflow">探索 GitFlow</NuxtLink>
          </div>
        </article>
      </div>
    </section>

    <section
      id="product-preview"
      class="workbench-section"
    >
      <div class="wrap">
        <div class="section-heading centered">
          <p class="eyebrow">一个工作区，更多掌控</p>
          <h2>打开仓库，<br />所有线索就在眼前。</h2>
          <p>提交历史、分支导航、文件变更与操作面板，各有位置，彼此相连。</p>
        </div>
        <UTabs
          :items="previews"
          default-value="graph"
          variant="link"
          class="preview-tabs"
          :ui="{
            list: 'preview-tab-list',
            trigger: 'preview-tab-trigger',
            content: 'preview-tab-content',
          }"
        >
          <template #content="{ item }"
            ><ProductImage
              :src="item.image"
              :alt="item.alt"
          /></template>
        </UTabs>
        <p class="image-caption">GitCode 实际产品界面 · 示例仓库</p>
      </div>
    </section>

    <section
      id="gitflow"
      class="flow-section wrap"
    >
      <div class="flow-feature-visual">
        <ProductImage
          src="/product/gitflow.png"
          alt="GitCode 的 GitFlow 操作面板：开始分支、完成分支和基础规则"
        />
      </div>
      <div class="flow-feature-copy">
        <p class="eyebrow">让分支流程有序</p>
        <h2>从第一个 feature，<br />到下一次 release。</h2>
        <p>
          配置基础分支和命名前缀，开始新的功能任务，完成后核对合并目标。开发、发布与修复，都有明确的下一步。
        </p>
        <div
          class="flow-labels"
          aria-label="GitFlow 分支类型"
        >
          <span>feature/</span><span>release/</span><span>hotfix/</span>
        </div>
        <UButton
          to="/docs/gitflow"
          color="neutral"
          variant="outline"
          size="lg"
          >阅读 GitFlow 指南</UButton
        >
      </div>
    </section>

    <section class="local-section">
      <div class="local-inner wrap">
        <div
          class="local-illustration"
          aria-hidden="true"
        >
          <UIcon name="i-lucide-terminal-square" /><span>git status</span>
        </div>
        <div>
          <p class="eyebrow">留在你熟悉的环境里</p>
          <h2>需要命令行？<br />终端就在工作区。</h2>
          <p>
            继续使用本机 Git，在内置终端中执行命令。Git
            控制台记录应用执行的操作，让过程和结果都可以查看。
          </p>
          <UButton
            to="/docs/quickstart"
            color="neutral"
            variant="outline"
            size="lg"
            >查看使用指南</UButton
          >
        </div>
      </div>
    </section>

    <section
      class="faq-section wrap"
      aria-labelledby="faq-title"
    >
      <div class="section-heading">
        <p class="eyebrow">开始之前</p>
        <h2 id="faq-title">还有几个问题？</h2>
        <p>关于安装、仓库和运行环境，你想了解的都在这里。</p>
        <NuxtLink
          class="text-link"
          to="/docs/faq"
          >查看全部常见问题</NuxtLink
        >
      </div>
      <UAccordion
        :items="questions"
        :ui="{ trigger: 'faq-trigger', body: 'faq-body', item: 'faq-item' }"
      />
    </section>

    <section class="closing-section">
      <div class="wrap closing-inner">
        <div>
          <p class="eyebrow">GitCode Desktop</p>
          <h2>下一次提交，<br />带着清晰的思路出发。</h2>
          <p>从你熟悉的仓库，开始更直观的 Git 工作流。</p>
        </div>
        <div class="closing-controls">
          <UButton
            to="/download"
            size="xl"
            icon="i-lucide-download"
            class="hero-primary"
            >获取 GitCode Desktop</UButton
          ><NuxtLink to="/docs/quickstart">先阅读使用指南</NuxtLink
          ><span
            >v{{ release.version }} ·
            {{ downloads.length ? '查看各平台安装包' : '公开下载准备中' }}</span
          >
        </div>
      </div>
    </section>
  </div>
</template>
