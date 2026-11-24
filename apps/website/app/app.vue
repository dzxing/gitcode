<script setup lang="ts">
import logo from '@gitcode/brand/assets/logo-glyph-transparent.svg'
useHead({ link: [{ rel: 'icon', type: 'image/svg+xml', href: logo }] })
</script>

<template>
  <UApp>
    <a
      class="skip-link"
      href="#content"
      >跳到内容</a
    >
    <SiteHeader />
    <main
      id="content"
      tabindex="-1"
    >
      <NuxtPage />
    </main>
    <SiteFooter />
  </UApp>
</template>
