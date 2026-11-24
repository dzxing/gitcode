<script setup lang="ts">
const base = useRuntimeConfig().app.baseURL
</script>

<template>
  <div class="product-artwork">
    <div
      class="artwork-halo"
      aria-hidden="true"
    />
    <div class="artwork-main">
      <img
        :src="`${base}product/graph-detail.png`"
        alt="GitCode 实际提交图：分支、合并线和标签显示在同一视图"
        width="860"
        height="733"
        fetchpriority="high"
      />
    </div>
    <div
      class="artwork-orbit"
      aria-hidden="true"
    >
      <UIcon name="i-lucide-monitor" />
    </div>
    <div class="artwork-detail">
      <div class="artwork-detail-heading">
        <UIcon
          name="i-lucide-files"
          aria-hidden="true"
        /><span>工作区变更</span>
      </div>
      <img
        :src="`${base}product/changes-detail.png`"
        alt="GitCode 工作区变更中的文件列表与暂存分组"
        width="329"
        height="459"
      />
    </div>
    <div class="artwork-caption">
      <strong>GitCode Desktop</strong><span>提交关系与文件变更，始终在眼前。</span
      ><small>实际产品界面 · 示例仓库</small>
    </div>
  </div>
</template>
