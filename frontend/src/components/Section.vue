<script setup lang="ts">
/** LR 风格可折叠面板：标题条 + 右侧三角，标题大写小字距。 */
import { ref } from 'vue'

const props = withDefaults(defineProps<{ title: string; expanded?: boolean }>(), { expanded: true })
const open = ref(props.expanded)

function toggle(): void { open.value = !open.value }
</script>

<template>
  <div class="section">
    <div class="section-head" :class="{ open }" @click="toggle">
      <span class="title">{{ title }}</span>
      <span class="tri">▾</span>
    </div>
    <div v-show="open" class="section-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.section {
  border-bottom: 1px solid var(--border);
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  background: var(--bg-surf);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.section-head:hover { background: var(--bg-hover); }
.title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1.2px;
  color: var(--text-2);
}
.section-head:hover .title { color: var(--text); }
.tri {
  font-size: 9px;
  color: var(--text-3);
  transition: transform 0.15s;
}
.tri.open,
.section-head.open .tri { transform: rotate(0deg); }
.section-head:not(.open) .tri { transform: rotate(-90deg); }
.section-body {
  padding: 6px 14px 12px;
}
</style>
