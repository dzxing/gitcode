<script setup lang="ts">
import { documents } from '../../data/documents'
useHead({ title: '使用文档' })
const icons: Record<string, string> = {
  quickstart: 'i-lucide-rocket',
  gitflow: 'i-lucide-git-branch',
  faq: 'i-lucide-circle-help',
}
</script>

<template>
  <div class="wrap inner-page">
    <section class="page-heading">
      <p class="eyebrow">使用文档</p>
      <h1>开始你的 GitCode 工作流</h1>
      <p class="lead">从打开仓库，到查看差异和管理分支。</p>
    </section>
    <div class="feature-grid">
      <NuxtLink
        v-for="(doc, slug) in documents"
        :key="slug"
        class="card doc-link"
        :to="`/docs/${slug}`"
      >
        <UIcon
          :name="icons[slug] || 'i-lucide-book-open'"
          class="doc-icon"
          aria-hidden="true"
        />
        <h2>{{ doc.title }}</h2>
        <p>{{ doc.description }}</p>
        <span class="doc-card-label">阅读指南</span>
      </NuxtLink>
    </div>
  </div>
</template>
