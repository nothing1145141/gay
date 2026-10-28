<script setup lang="ts">
/** LR 风格滑块行：左标签、右数值、中间零点双向滑轨（拖动实时预览、
 *  松手提交、双击标签/数值复位、右侧重置按钮）。 */
import { computed, onBeforeUnmount, ref } from 'vue'

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

const trackEl = ref<HTMLElement | null>(null)
const dragging = ref(false)

// 是否双向（有正有负）——决定填充从中心还是从左端起
const bipolar = computed(() => props.min < 0 && props.max > 0)

function fmt(v: number): string {
  return v.toFixed(props.decimals) + props.suffix
}
const display = computed(() => fmt(props.modelValue))

// 当前值在轨道上的百分比位置
const pct = computed(() => {
  const span = props.max - props.min || 1
  return ((props.modelValue - props.min) / span) * 100
})
// 填充区间（双向从中点到滑块；单向从左到滑块）
const fillStyle = computed(() => {
  if (bipolar.value) {
    const zeroPct = ((0 - props.min) / (props.max - props.min || 1)) * 100
    const left = Math.min(zeroPct, pct.value)
    const width = Math.abs(pct.value - zeroPct)
    return { left: left + '%', width: width + '%' }
  }
  return { left: '0%', width: pct.value + '%' }
})

function snap(v: number): number {
  const stepped = Math.round((v - props.min) / props.step) * props.step + props.min
  const clamped = Math.min(props.max, Math.max(props.min, stepped))
  // 消除浮点误差，按 decimals 对齐
  return Number(clamped.toFixed(props.decimals))
}

function valueFromX(clientX: number): number {
  const el = trackEl.value
  if (!el) return props.modelValue
  const rect = el.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / (rect.width || 1)))
  return snap(props.min + ratio * (props.max - props.min))
}

function onInput(v: number): void {
  emit('update:modelValue', v)
  emit('input')
}

function onPointerDown(e: PointerEvent): void {
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  onInput(valueFromX(e.clientX))
}
function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return
  onInput(valueFromX(e.clientX))
}
function onPointerUp(): void {
  if (!dragging.value) return
  dragging.value = false
  emit('release')
}
onBeforeUnmount(() => { dragging.value = false })

function reset(): void {
  emit('update:modelValue', props.defaultValue)
  emit('release')
}
</script>

<template>
  <div class="slider-row">
    <div class="row-head">
      <span class="label" title="双击复位" @dblclick="reset">{{ label }}</span>
      <span class="value" title="双击复位" @dblclick="reset">{{ display }}</span>
      <button class="reset" title="重置" @click="reset">↺</button>
    </div>
    <div
      ref="trackEl"
      class="track"
      :class="{ dragging }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="fill" :style="fillStyle"></div>
      <div v-if="bipolar" class="zero"></div>
      <div class="thumb" :style="{ left: pct + '%' }"></div>
    </div>
  </div>
</template>

<style scoped>
.slider-row {
  padding: 4px 0 8px;
  user-select: none;
}
.row-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}
.label {
  flex: 1;
  font-size: 11px;
  letter-spacing: 0.2px;
  color: var(--text-2);
  cursor: default;
}
.label:hover { color: var(--text); }
.value {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  min-width: 42px;
  text-align: right;
  cursor: default;
}
.reset {
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  padding: 0 1px;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s;
}
.slider-row:hover .reset { opacity: 1; }
.reset:hover { color: var(--accent); }

/* ---- LR 细滑轨 ---- */
.track {
  position: relative;
  height: 14px;          /* 触控热区 */
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}
.track::before {          /* 轨槽 */
  content: "";
  position: absolute;
  left: 0; right: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--track);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}
.fill {
  position: absolute;
  height: 3px;
  border-radius: 2px;
  background: var(--track-fill);
}
.zero {                   /* 中间零点刻度 */
  position: absolute;
  left: 50%;
  width: 1px;
  height: 9px;
  margin-left: -0.5px;
  background: var(--border-2);
}
.thumb {
  position: absolute;
  width: 13px;
  height: 13px;
  margin-left: -6.5px;
  border-radius: 50%;
  background: linear-gradient(180deg, #e8e8e8, #c8c8c8);
  border: 1px solid #9a9a9a;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  transition: transform 0.08s ease, background 0.08s;
}
.track:hover .thumb,
.track.dragging .thumb {
  background: linear-gradient(180deg, #ffffff, #d6d6d6);
}
.track.dragging .thumb {
  transform: scale(1.12);
  border-color: var(--accent);
}
</style>
