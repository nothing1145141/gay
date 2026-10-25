<script setup lang="ts">
/** 取色器面板：从图像取色 / 8 预设色相（可单独微调）/ 取色点列表（范围/色相偏移/饱和度/明亮度）。
 *  对照旧 PickerPanel + _PickerRow 行为。 */
import { computed } from 'vue'
import { NSlider } from 'naive-ui'
import type { PickerState } from '@/api/types'
import { HS_PRESETS, presetColor } from '@/lib/presets'
import { useEditor, notifyChanged,
         armNewPick, armRepick, cancelPick, newPresetPicker, deletePicker } from '@/stores/editor'

const props = defineProps<{ pickers: PickerState[] }>()
const store = useEditor()

const pickers = computed(() => props.pickers)

function swatchCss(color: [number, number, number]): string {
  const [r, g, b] = color.map(c => Math.round(c * 255))
  return `rgb(${r},${g},${b})`
}

function presetCss(hue: number): string {
  const [r, g, b] = presetColor(hue).map(c => Math.round(c * 255))
  return `background: rgb(${r},${g},${b}); color:#101012;`
}

function setField(i: number, field: 'span' | 'hue_shift' | 'saturation' | 'luminance', v: number): void {
  const p = pickers.value[i]
  if (!p) return
  ;(p as unknown as Record<string, number>)[field] = v
  notifyChanged()
}

function infoText(i: number): string {
  const p = pickers.value[i]
  return `色相 ${p.hue.toFixed(0)}°  范围 ±${p.span.toFixed(0)}°`
}

const pickActive = computed(() => store.pickTarget !== null)
const hint = computed(() => {
  if (store.pickTarget === 'new') return '在图像上单击拾取颜色…'
  if (typeof store.pickTarget === 'number') return `在图像上单击以更新取色点 ${store.pickTarget + 1}…`
  return '在图像上单击拾取颜色'
})
</script>

<template>
  <div class="picker-panel">
    <div class="top">
      <button
        class="pick-btn"
        :class="{ armed: store.pickTarget === 'new' }"
        @click="store.pickTarget === 'new' ? cancelPick() : armNewPick()"
      >＋ 从图像取色</button>
      <span class="hint" :class="{ armed: pickActive }">{{ hint }}</span>
    </div>

    <div class="presets">
      <button
        v-for="p in HS_PRESETS"
        :key="p.name"
        class="preset"
        :style="presetCss(p.hue)"
        :title="`新建「${p.name}」取色点（色相 ${p.hue}°，可再微调）`"
        @click="newPresetPicker(p.hue)"
      >{{ p.name }}</button>
    </div>

    <div v-if="!pickers.length" class="empty">暂无取色点：点击上方按钮或预设颜色创建</div>

    <div
      v-for="(p, i) in pickers"
      :key="i"
      class="row"
      :class="{ selected: store.pickSelected === i }"
    >
      <div class="row-head">
        <span class="swatch" :style="{ background: swatchCss(p.color) }" />
        <span class="info">{{ infoText(i) }}</span>
        <button class="mini" title="然后在图像上单击以重新拾取颜色" @click="armRepick(i)">重新取色</button>
        <button class="mini danger" title="删除此取色点" @click="deletePicker(i)">✕</button>
      </div>
      <div class="row-sliders">
        <div class="s-row">
          <span class="s-label">影响范围</span>
          <NSlider :value="p.span" :min="5" :max="180" :step="1" :tooltip="false"
                   @update:value="(v: number) => setField(i, 'span', v)" />
          <span class="s-val">{{ p.span.toFixed(0) }}°</span>
        </div>
        <div class="s-row">
          <span class="s-label">色相偏移</span>
          <NSlider :value="p.hue_shift" :min="-60" :max="60" :step="1" :tooltip="false"
                   @update:value="(v: number) => setField(i, 'hue_shift', v)" />
          <span class="s-val">{{ p.hue_shift.toFixed(0) }}°</span>
        </div>
        <div class="s-row">
          <span class="s-label">饱和度</span>
          <NSlider :value="p.saturation" :min="-100" :max="100" :step="1" :tooltip="false"
                   @update:value="(v: number) => setField(i, 'saturation', v)" />
          <span class="s-val">{{ p.saturation.toFixed(0) }}</span>
        </div>
        <div class="s-row">
          <span class="s-label">明亮度</span>
          <NSlider :value="p.luminance" :min="-100" :max="100" :step="1" :tooltip="false"
                   @update:value="(v: number) => setField(i, 'luminance', v)" />
          <span class="s-val">{{ p.luminance.toFixed(0) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker-panel { display: flex; flex-direction: column; gap: 8px; }
.top { display: flex; align-items: center; gap: 8px; }
.pick-btn {
  border: 1px solid #2f2f38;
  background: #1d1d23;
  color: #d8d8de;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.pick-btn.armed { border-color: #4a9eff; color: #4a9eff; }
.hint { font-size: 11px; color: #6d6d76; }
.hint.armed { color: #4a9eff; }
.presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}
.preset {
  border: 0;
  border-radius: 4px;
  font-size: 12px;
  padding: 4px 0;
  cursor: pointer;
  font-weight: 600;
}
.preset:hover { filter: brightness(1.15); }
.empty { font-size: 11px; color: #55555e; padding: 4px 0; }
.row {
  border: 1px solid #2a2a31;
  border-radius: 6px;
  padding: 6px 8px;
  background: #1a1a20;
}
.row.selected { border-color: #4a9eff; }
.row-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.swatch {
  width: 20px; height: 20px;
  border-radius: 4px;
  border: 1px solid #3a3a41;
  flex: none;
}
.info { flex: 1; font-size: 11px; color: #9a9aa4; }
.mini {
  border: 1px solid #2f2f38;
  background: transparent;
  color: #9a9aa4;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}
.mini:hover { color: #d8d8de; border-color: #4a9eff; }
.mini.danger:hover { color: #ff6b6b; border-color: #ff6b6b; }
.s-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.s-label { font-size: 11px; color: #b9b9c0; width: 56px; flex: none; }
.s-row :deep(.n-slider) { flex: 1; }
.s-val { font-size: 11px; color: #e8e8ec; width: 36px; text-align: right;
         font-variant-numeric: tabular-nums; flex: none; }
</style>
