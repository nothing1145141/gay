<script setup lang="ts">
/** 直方图（64 bins）：master 亮度 + RGB 通道叠画（screen 混合），对照旧版样式。 */
import { onMounted, ref, watch } from 'vue'
import type { HistData } from '@/api/client'

const props = defineProps<{ hist: HistData | null }>()
const canvas = ref<HTMLCanvasElement | null>(null)

function drawPath(ctx: CanvasRenderingContext2D, bins: number[], w: number, h: number): void {
  const n = bins.length
  if (!n) return
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let i = 0; i < n; i++) {
    ctx.lineTo((i / (n - 1)) * w, h - Math.min(1, bins[i]) * (h - 2))
  }
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fill()
}

function redraw(): void {
  const cv = canvas.value
  if (!cv) return
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth
  const h = cv.clientHeight
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const hist = props.hist
  if (!hist) return
  ctx.globalCompositeOperation = 'screen'      // RGB 叠加处趋白，与主流直方图一致
  ctx.fillStyle = 'rgba(120,120,126,0.55)'
  drawPath(ctx, hist.master, w, h)
  ctx.fillStyle = 'rgba(255,70,70,0.55)'
  drawPath(ctx, hist.red, w, h)
  ctx.fillStyle = 'rgba(70,255,90,0.5)'
  drawPath(ctx, hist.green, w, h)
  ctx.fillStyle = 'rgba(80,120,255,0.55)'
  drawPath(ctx, hist.blue, w, h)
  ctx.globalCompositeOperation = 'source-over'
}

onMounted(redraw)
watch(() => props.hist, redraw, { deep: false })
</script>

<template>
  <canvas ref="canvas" class="hist" />
</template>

<style scoped>
.hist {
  width: 100%;
  height: 88px;
  display: block;
  background: #1a1a1a;
  border-radius: 4px;
}
</style>
