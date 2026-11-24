<script setup lang="ts">
import { downloads, release } from '../data/downloads'
useHead({ title: '下载' })
const platforms = [
  { name: 'Windows', icon: 'i-lucide-app-window', detail: '桌面安装程序' },
  { name: 'macOS', icon: 'i-lucide-laptop', detail: 'Apple Silicon 与 Intel' },
  { name: 'Linux', icon: 'i-lucide-terminal', detail: '桌面应用' },
]
</script>

<template>
  <div class="wrap inner-page">
    <section class="page-heading">
      <p class="eyebrow">GitCode Desktop · v{{ release.version }}</p>
      <h1>你的下一次提交，<br />从这里开始。</h1>
      <p class="lead">为你的系统选择 GitCode。使用已有仓库，继续熟悉的 Git 工作流。</p>
    </section>
    <div
      v-if="!downloads.length"
      class="download-note"
      role="status"
    >
      <UIcon
        name="i-lucide-package"
        aria-hidden="true"
      />
      <div>
        <h2>公开下载准备中</h2>
        <p>安装包尚未发布到公开下载地址。发布后，这里将提供系统、架构和 SHA-256 校验信息。</p>
      </div>
    </div>
    <div
      v-if="downloads.length"
      class="feature-grid"
    >
      <article
        v-for="item in downloads"
        :key="item.url"
        class="card"
      >
        <UIcon
          name="i-lucide-monitor-down"
          class="download-platform"
          aria-hidden="true"
        />
        <h2>{{ item.platform }}</h2>
        <p>{{ item.architecture }}</p>
        <UButton
          :to="item.url"
          external
          size="lg"
          icon="i-lucide-download"
          >下载安装包</UButton
        >
        <p class="checksum">
          SHA-256 <code>{{ item.sha256 }}</code>
        </p>
      </article>
    </div>
    <div
      v-else
      class="feature-grid"
    >
      <article
        v-for="platform in platforms"
        :key="platform.name"
        class="card"
      >
        <UIcon
          :name="platform.icon"
          class="download-platform"
          aria-hidden="true"
        />
        <h2>{{ platform.name }}</h2>
        <p class="platform-detail">{{ platform.detail }}</p>
        <span class="release-status">尚未发布</span>
      </article>
    </div>
    <div class="download-help">
      <p class="lead">
        运行前请安装 Git 2.30 或更高版本。已有 Git？直接沿用你的 SSH 密钥与凭证配置。
      </p>
      <UButton
        to="/docs/quickstart"
        size="lg"
        color="neutral"
        variant="outline"
        class="mt-6"
        >阅读安装指南</UButton
      >
    </div>
  </div>
</template>
