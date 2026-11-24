<script setup lang="ts">
import logo from '@gitcode/brand/assets/logo-glyph-transparent.svg'
import { release } from '../data/downloads'

const route = useRoute()
const menuOpen = ref(false)
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false
  },
)
const links = [
  { label: '产品功能', to: '/#features' },
  { label: 'GitFlow', to: '/#gitflow' },
  { label: '使用文档', to: '/docs' },
  { label: '更新日志', to: '/changelog' },
]
function closeMenu() {
  menuOpen.value = false
  void nextTick(() => document.querySelector<HTMLButtonElement>('.mobile-menu-toggle')?.focus())
}
</script>

<template>
  <header
    class="site-header"
    @keydown.esc.prevent="closeMenu"
  >
    <div class="release-banner">
      <div class="release-banner-inner wrap">
        <span class="release-banner-title"
          >GitCode Desktop <strong>v{{ release.version }}</strong></span
        >
        <span class="release-banner-description">提交图、GitFlow 与终端，一个工作区。</span>
        <NuxtLink to="/changelog">查看更新</NuxtLink>
      </div>
    </div>
    <div class="site-header-inner wrap">
      <NuxtLink
        class="brand"
        to="/"
        aria-label="GitCode 首页"
      >
        <img
          :src="logo"
          alt=""
          width="36"
          height="36"
        />
        <span>GitCode</span>
      </NuxtLink>
      <nav
        class="desktop-navigation"
        aria-label="主导航"
      >
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          >{{ link.label }}</NuxtLink
        >
      </nav>
      <div class="header-actions">
        <UButton
          class="header-download"
          to="/download"
          aria-label="下载 GitCode"
          size="lg"
          icon="i-lucide-download"
          ><span>下载<span class="download-wordmark"> GitCode</span></span></UButton
        >
        <UButton
          class="mobile-menu-toggle"
          color="neutral"
          variant="ghost"
          :icon="menuOpen ? 'i-lucide-x' : 'i-lucide-menu'"
          :aria-label="menuOpen ? '关闭导航' : '打开导航'"
          :aria-expanded="menuOpen"
          aria-controls="mobile-navigation"
          @click="menuOpen = !menuOpen"
        />
      </div>
    </div>
    <nav
      v-if="menuOpen"
      id="mobile-navigation"
      class="mobile-navigation wrap"
      aria-label="移动导航"
    >
      <NuxtLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        @click="menuOpen = false"
        >{{ link.label }}</NuxtLink
      >
    </nav>
  </header>
</template>
