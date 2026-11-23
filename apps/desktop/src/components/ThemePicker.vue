<script setup lang="ts">
import { computed } from 'vue'
import { featuredThemes, themePresets, type ThemePreference } from '../themePresets'
import Icon from './Icon.vue'

const props = defineProps<{ modelValue: ThemePreference }>()
const emit = defineEmits<{ 'update:modelValue': [value: ThemePreference] }>()
const theme = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})
const description = computed(() =>
  props.modelValue === 'system'
    ? '跟随系统的深浅设置自动切换。'
    : themePresets[props.modelValue].description,
)
</script>

<template>
  <div class="theme-picker">
    <label class="theme-choice"
      ><span>主题</span
      ><select
        v-model="theme"
        aria-label="主题"
      >
        <option
          v-for="(preset, id) in themePresets"
          :key="id"
          :value="id"
        >
          {{ preset.label }}
        </option>
        <option value="system">跟随系统</option>
      </select></label
    >
    <div
      class="theme-previews"
      role="group"
      aria-label="常用软件配色"
    >
      <button
        v-for="id in featuredThemes"
        :key="id"
        class="theme-preview"
        :aria-label="themePresets[id].name"
        :aria-pressed="modelValue === id"
        :style="{
          '--preview-bg': themePresets[id].tokens['--bg'],
          '--preview-panel': themePresets[id].tokens['--panel'],
          '--preview-accent': themePresets[id].tokens['--accent'],
          '--preview-text': themePresets[id].tokens['--bright'],
          '--preview-added': themePresets[id].tokens['--git-added'],
        }"
        @click="theme = id"
      >
        <span
          class="theme-miniature"
          aria-hidden="true"
          ><span class="mini-sidebar"></span><span class="mini-content"><i></i><i></i><i></i></span
          ><span class="mini-selection"></span
        ></span>
        <span class="theme-preview-name"
          >{{ themePresets[id].name
          }}<Icon
            v-if="modelValue === id"
            name="Check"
            :size="13"
        /></span>
      </button>
    </div>
    <p
      class="theme-description"
      role="status"
    >
      {{ description }}
    </p>
  </div>
</template>

<style scoped>
.theme-choice {
  display: grid;
  grid-template-columns: var(--settings-label-width, 96px) minmax(
      0,
      var(--settings-field-width, 320px)
    );
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}
select {
  width: 100%;
  min-width: 0;
  min-height: var(--settings-control-height, 32px);
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--settings-input-bg, var(--panel));
  color: var(--text);
  font: inherit;
  color-scheme: inherit;
}
select:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
.theme-previews {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.theme-preview {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 3px;
  text-align: left;
  min-width: 0;
  background: var(--surface-input);
}
.theme-preview[aria-pressed='true'] {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.theme-preview:hover {
  border-color: var(--accent);
}
.theme-miniature {
  position: relative;
  display: flex;
  height: 36px;
  border-radius: 2px;
  overflow: hidden;
  background: var(--preview-bg);
}
.mini-sidebar {
  width: 24%;
  background: var(--preview-panel);
  border-right: 1px solid color-mix(in srgb, var(--preview-text) 15%, transparent);
}
.mini-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 9px;
  width: 70%;
}
.mini-content i {
  height: 3px;
  width: 80%;
  border-radius: 2px;
  background: color-mix(in srgb, var(--preview-text) 70%, transparent);
}
.mini-content i:nth-child(2) {
  width: 60%;
  background: var(--preview-added);
}
.mini-content i:nth-child(3) {
  width: 70%;
}
.mini-selection {
  position: absolute;
  left: 0;
  top: 0;
  width: 24%;
  height: 2px;
  background: var(--preview-accent);
}
.theme-preview-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 26px;
  padding: 4px 5px;
  font-size: var(--ui-font-help);
  color: var(--text);
}
.theme-preview-name svg {
  color: var(--accent);
}
.theme-description {
  color: var(--muted);
  margin: 12px 0 0;
  line-height: 1.6;
}
</style>
