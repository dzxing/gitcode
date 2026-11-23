<script setup lang="ts">
import logo from '@gitcode/brand/assets/logo-glyph-transparent.svg'
</script>

<template>
  <div>
    <a
      class="skip-link"
      href="#content"
      >跳到内容</a
    >
    <header class="site-header wrap">
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
      <nav aria-label="主导航">
        <NuxtLink to="/">产品</NuxtLink>
        <NuxtLink to="/docs">文档</NuxtLink>
        <NuxtLink to="/changelog">更新日志</NuxtLink>
        <NuxtLink
          class="button small"
          to="/download"
          >下载</NuxtLink
        >
      </nav>
    </header>
    <main
      id="content"
      class="wrap"
    >
      <NuxtPage />
    </main>
    <footer class="site-footer wrap">
      <span>GitCode · 让提交关系清晰可见</span>
      <NuxtLink to="/docs/quickstart">快速开始</NuxtLink>
    </footer>
  </div>
</template>
