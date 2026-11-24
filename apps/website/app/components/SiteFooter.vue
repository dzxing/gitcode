<script setup lang="ts">
import logo from '@gitcode/brand/assets/logo-glyph-transparent.svg'
</script>

<template>
  <footer class="site-footer">
    <div class="footer-top wrap">
      <div class="footer-brand">
        <NuxtLink
          class="brand"
          to="/"
          aria-label="GitCode 首页"
        >
          <img
            :src="logo"
            alt=""
            width="32"
            height="32"
          /><span>GitCode</span>
        </NuxtLink>
        <p>让分支关系清晰，<br />让下一次提交更从容。</p>
      </div>
      <nav aria-label="产品链接">
        <h2>产品</h2>
        <NuxtLink to="/#features">功能概览</NuxtLink>
        <NuxtLink to="/download">下载 GitCode</NuxtLink>
        <NuxtLink to="/changelog">更新日志</NuxtLink>
      </nav>
      <nav aria-label="帮助链接">
        <h2>开始使用</h2>
        <NuxtLink to="/docs/quickstart">安装与入门</NuxtLink>
        <NuxtLink to="/docs/gitflow">GitFlow 指南</NuxtLink>
        <NuxtLink to="/docs/faq">常见问题</NuxtLink>
      </nav>
    </div>
    <div class="footer-bottom wrap">
      <span>GitCode · 可视化 Git 工作台</span>
      <span>本地运行，为开发者而造。</span>
    </div>
  </footer>
</template>
