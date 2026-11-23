<script setup lang="ts">
import { marked } from 'marked'
import markdown from '../../content/changelog.md?raw'
useHead({ title: '更新日志' })
const html = marked.parse(markdown, { async: false })
</script>

<template>
  <article
    class="prose standalone"
    v-html="html"
  />
</template>
