<script setup lang="ts">
import manifest from '../data/releases.json'

useHead({ title: '下载' })
type Download = {
  platform: string
  architecture: string
  url: string
  sha256: string
}
// Only published artifacts with HTTPS URLs and checksums become download links.
const downloads = (manifest.downloads as Download[]).filter(
  (item) => /^https:\/\//.test(item.url) && /^[a-f\d]{64}$/i.test(item.sha256),
)
</script>

<template>
  <section class="page-heading">
    <p class="eyebrow">GitCode {{ manifest.version }}</p>
    <h1>下载 GitCode</h1>
    <p class="lead">选择适合你系统的安装包。运行前请安装 Git 2.30 或更高版本。</p>
  </section>
  <div
    v-if="downloads.length"
    class="feature-grid"
  >
    <article
      v-for="item in downloads"
      :key="item.url"
      class="card"
    >
      <h2>{{ item.platform }}</h2>
      <p>{{ item.architecture }}</p>
      <a
        class="button"
        :href="item.url"
        >下载安装包</a
      >
      <p class="checksum">
        SHA-256 <code>{{ item.sha256 }}</code>
      </p>
    </article>
  </div>
  <section
    v-else
    class="card"
  >
    <h2>公开下载准备中</h2>
    <p>安装包尚未发布到公开下载地址。你可以先阅读安装与使用指南。</p>
    <NuxtLink to="/docs/quickstart">查看安装指南</NuxtLink>
  </section>
</template>
