<script setup lang="ts">
useHead({ title: '可视化 Git 工作台' })
const features = [
  { title: '看清每一次合并', description: '通过提交图、分支标签和差异视图，理解代码如何演进。' },
  { title: '管理日常 Git 工作', description: '提交、获取、拉取、推送与贮藏，在同一个工作区完成。' },
  {
    title: '让分支流程有序',
    description: '配置 GitFlow 基础分支，开始和完成 feature、release 与 hotfix。',
  },
]
</script>

<template>
  <section class="hero">
    <p class="eyebrow">本地运行的 Git 工作台</p>
    <h1>看清代码的来路，<br /><span>从容提交下一步。</span></h1>
    <p class="lead">提交关系、文件差异、分支协作。将日常 Git 操作收拢在清晰的桌面工作区里。</p>
    <div class="actions">
      <NuxtLink
        class="button"
        to="/download"
        >获取 GitCode</NuxtLink
      >
      <NuxtLink
        class="button secondary"
        to="/docs/quickstart"
        >阅读使用指南</NuxtLink
      >
    </div>
    <p class="muted">使用本机 Git，仓库操作在本地执行。</p>
  </section>
  <section
    class="feature-grid"
    aria-label="主要功能"
  >
    <article
      v-for="feature in features"
      :key="feature.title"
      class="card"
    >
      <h2>{{ feature.title }}</h2>
      <p>{{ feature.description }}</p>
    </article>
  </section>
  <section class="callout">
    <h2>从你的第一个仓库开始</h2>
    <p>安装 Git，打开已有仓库，查看提交图与工作区变更。</p>
    <NuxtLink to="/docs/quickstart">查看快速开始</NuxtLink>
  </section>
</template>
