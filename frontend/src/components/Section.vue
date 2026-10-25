<script setup lang="ts">
/** 可折叠分区（对照旧 CollapsibleSection）。 */
import { ref } from 'vue'

const props = withDefaults(defineProps<{ title: string; expanded?: boolean }>(), { expanded: true })
const open = ref(props.expanded)

function toggle(): void { open.value = !open.value }
</script>

<template>
  <div class="section">
    <div class="section-head" @click="toggle">
      <span>{{ title }}</span>
      <span class="arrow" :class="{ open }">▾</span>
    </div>
    <div v-show="open" class="section-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.section {
  border-bottom: 1px solid #232329;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 14px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 2px;
  color: #9a9aa4;
  cursor: pointer;
  user-select: none;
}
.section-head:hover { color: #d8d8de; }
.arrow {
  transition: transform 0.15s;
  color: #55555e;
}
.arrow.open { transform: rotate(0deg); }
.arrow:not(.open) { transform: rotate(-90deg); }
.section-body {
  padding: 2px 14px 10px;
}
</style>
