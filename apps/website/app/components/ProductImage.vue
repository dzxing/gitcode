<script setup lang="ts">
defineProps<{ src: string; alt: string; eager?: boolean }>()
const config = useRuntimeConfig()
const asset = (value: string) => `${config.app.baseURL}${value.replace(/^\//, '')}`
</script>

<template>
  <div class="product-window">
    <img
      :src="asset(src)"
      :alt="alt"
      width="1600"
      height="1000"
      :loading="eager ? 'eager' : 'lazy'"
      :fetchpriority="eager ? 'high' : 'auto'"
    />
  </div>
</template>
