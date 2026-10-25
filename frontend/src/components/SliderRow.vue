<script setup lang="ts">
/** 滑块行：拖动实时预览、松手提交、双击标签复位、右侧重置按钮。 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { NSlider } from 'naive-ui'

const props = withDefaults(defineProps<{
  label: string
  min: number
  max: number
  modelValue: number
  defaultValue?: number
  step?: number
  decimals?: number
  suffix?: string
}>(), {
  defaultValue: 0,
  step: 1,
  decimals: 0,
  suffix: '',
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: number): void
  (e: 'input'): void        // 拖动中
  (e: 'release'): void      // 松手
}>()

const dragging = ref(false)

function fmt(v: number): string {
  return v.toFixed(props.decimals) + props.suffix
}
const display = computed(() => fmt(props.modelValue))

function onInput(v: number): void {
  emit('update:modelValue', v)
  emit('input')
}

function onPointerDown(): void { dragging.value = true; window.addEventListener('pointerup', onWindowUp) }
function onWindowUp(): void {
  window.removeEventListener('pointerup', onWindowUp)
  if (dragging.value) {
    dragging.value = false
    emit('release')
  }
}
onBeforeUnmount(() => window.removeEventListener('pointerup', onWindowUp))

function reset(): void {
  emit('update:modelValue', props.defaultValue)
  emit('release')
}
</script>

<template>
  <div class="slider-row">
    <div class="row-head">
      <span class="label" title="双击复位" @dblclick="reset">{{ label }}</span>
      <span class="value" @dblclick="reset">{{ display }}</span>
      <button class="reset" title="重置" @click="reset">↺</button>
    </div>
    <NSlider
      :value="modelValue"
      :min="min"
      :max="max"
      :step="step"
      :tooltip="false"
      @update:value="onInput"
      @pointerdown="onPointerDown"
    />
  </div>
</template>

<style scoped>
.slider-row {
  padding: 3px 0 7px;
  user-select: none;
}
.row-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}
.label {
  flex: 1;
  font-size: 12px;
  color: #b9b9c0;
  cursor: default;
}
.value {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #e8e8ec;
  min-width: 48px;
  text-align: right;
}
.reset {
  border: 0;
  background: transparent;
  color: #6d6d76;
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
}
.reset:hover { color: #4a9eff; }
</style>
