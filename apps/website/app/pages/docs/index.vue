<script setup lang="ts">
import { documents } from '../../data/documents'
useHead({ title: '使用文档' })
</script>

<template>
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
      <h2>{{ doc.title }}</h2>
      <p>{{ doc.description }}</p>
    </NuxtLink>
  </div>
</template>
