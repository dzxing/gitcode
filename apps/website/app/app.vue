<script setup lang="ts">
import logo from '@gitcode/brand/assets/logo-glyph-transparent-256.png'
useHead({ link: [{ rel: 'icon', type: 'image/png', href: logo }] })
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
