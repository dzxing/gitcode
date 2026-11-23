<script setup lang="ts">
import { marked } from 'marked'
import { documents } from '../../data/documents'

const route = useRoute()
const document = computed(() => documents[String(route.params.slug)])
if (!document.value) throw createError({ statusCode: 404, statusMessage: '文档不存在' })
const html = computed(() => marked.parse(document.value?.markdown || '', { async: false }))
useHead({ title: () => document.value?.title || '文档' })
</script>

<template>
  <div class="docs-layout">
    <nav
      class="docs-nav"
      aria-label="文档目录"
    >
      <NuxtLink
        v-for="(doc, slug) in documents"
        :key="slug"
        :to="`/docs/${slug}`"
      >
        {{ doc.title }}
      </NuxtLink>
    </nav>
    <!-- Markdown is trusted, reviewed repository content; never render user input here. -->
    <article
      class="prose"
      v-html="html"
    />
  </div>
</template>
