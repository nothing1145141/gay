<script setup lang="ts">
/** 颜色分级：阴影/中间调/高光/全局 四个色轮 + 各自饱和度/亮度滑块 + 混合。
 *  对照旧 GradingPanel；轮与滑块的双向语义见 ColorWheel 注释。
 *  adj 由父级传入（全局参数或选中蒙版的局部参数）。 */
import ColorWheel from '@/components/ColorWheel.vue'
import SliderRow from '@/components/SliderRow.vue'
import { notifyChanged, notifyCommitted } from '@/stores/editor'
import { RANGE_LABELS } from '@/lib/presets'
import type { AdjustmentsLike, GradingRange } from '@/api/types'
import { GRADING_RANGES } from '@/api/types'

const props = defineProps<{ adj: AdjustmentsLike }>()

function onWheelChange(range: GradingRange, displayHue: number, displaySat: number): void {
  const w = props.adj.wheels[range]
  w.hue = displayHue
  w.saturation = displaySat * 100
  notifyChanged()
}
</script>

<template>
  <div class="grading">
    <div class="grid">
      <div v-for="range in GRADING_RANGES" :key="range" class="cell">
        <div class="caption">{{ RANGE_LABELS[range] }}</div>
        <ColorWheel
          :hue="adj.wheels[range].hue"
          :saturation="adj.wheels[range].saturation"
          @wheel-change="(h: number, s: number) => onWheelChange(range, h, s)"
          @released="notifyCommitted"
        />
        <SliderRow label="饱和度" :min="-100" :max="100"
                   v-model="adj.wheels[range].saturation"
                   @input="notifyChanged" @release="notifyCommitted" />
        <SliderRow label="亮度" :min="-100" :max="100"
                   v-model="adj.wheels[range].luminance"
                   @input="notifyChanged" @release="notifyCommitted" />
      </div>
    </div>
    <SliderRow label="混合" :min="0" :max="100" :default-value="50"
               v-model="adj.blend"
               @input="notifyChanged" @release="notifyCommitted" />
  </div>
</template>

<style scoped>
.grading { width: 100%; }
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 6px;
}
.cell { display: flex; flex-direction: column; align-items: stretch; }
.caption {
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: #9a9a9a;
  margin-bottom: 4px;
  user-select: none;
}
.cell canvas { align-self: center; }
</style>
