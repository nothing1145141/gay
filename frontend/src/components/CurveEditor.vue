<script setup lang="ts">
/** 曲线编辑器：对照旧 ui_widgets.CurveEditor。
 *  四通道（RGB/红/绿/蓝），网格 + 虚线对角线 + 直方图背景，其它通道淡色上下文；
 *  左键拖点（端点钉在 x=0/1）、双击加点（x 过近丢弃）、右键删点（端点除外）。 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildLut } from '@/lib/curve'
import { CURVE_CHANNEL_COLORS, CURVE_CHANNEL_LABELS } from '@/lib/presets'
import type { CurveChannel, CurvePoints } from '@/api/types'
import { CURVE_CHANNELS, defaultCurves } from '@/api/types'
import type { HistData } from '@/api/client'

const props = defineProps<{
  curves: Record<CurveChannel, CurvePoints>
  hist: HistData | null
}>()

const emit = defineEmits<{
  (e: 'changed', ch: CurveChannel, pts: CurvePoints): void
  (e: 'committed', ch: CurveChannel, pts: CurvePoints): void
}>()

const MARGIN = 12
const HIT_RADIUS = 9
const LUT_SIZE = 2048
const GAP = 1 / 512

const wrap = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const channel = ref<CurveChannel>('master')

let dragIndex: number | null = null
let selected: number | null = null
let sizeDirty = true

function points(): CurvePoints {
  return props.curves[channel.value] ?? []
}

// ---- 坐标变换（对照 _to_widget / _to_image）----
function plotRect() {
  const el = wrap.value!
  const w = Math.max(el.clientWidth - 2 * MARGIN, 1)
  const h = Math.max(el.clientHeight - 2 * MARGIN, 1)
  return { left: MARGIN, top: MARGIN, w, h }
}
function toWidget(x: number, y: number): [number, number] {
  const r = plotRect()
  return [r.left + x * r.w, r.top + (1 - y) * r.h]
}
function toImage(px: number, py: number): [number, number] {
  const r = plotRect()
  return [(px - r.left) / Math.max(r.w, 1e-6), 1 - (py - r.top) / Math.max(r.h, 1e-6)]
}

// ---- 绘制 ----
function drawHistogramLayer(
  ctx: CanvasRenderingContext2D, r: ReturnType<typeof plotRect>,
  data: number[], color: string, alpha: number,
): void {
  const n = data.length
  const max = Math.max(...data)
  if (!n || max <= 0) return
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(r.left, r.top + r.h)
  for (let i = 0; i < n; i++) {
    ctx.lineTo(r.left + r.w * (i / (n - 1)), r.top + r.h - Math.min(1, data[i]) * r.h * 0.92)
  }
  ctx.lineTo(r.left + r.w, r.top + r.h)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1
}

function drawCurve(
  ctx: CanvasRenderingContext2D, r: ReturnType<typeof plotRect>,
  pts: CurvePoints, color: string, alpha: number, width: number,
): void {
  const lut = buildLut(pts, LUT_SIZE)
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  const step = Math.max(1, Math.floor(LUT_SIZE / 220))
  for (let i = 0; i < LUT_SIZE; i += step) {
    const [px, py] = toWidget(i / (LUT_SIZE - 1), lut[i])
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  const [ex, ey] = toWidget(1, lut[LUT_SIZE - 1])
  ctx.lineTo(ex, ey)
  ctx.stroke()
  ctx.globalAlpha = 1
}

function redraw(): void {
  const cv = canvas.value
  const el = wrap.value
  if (!cv || !el || el.clientWidth < 20) return
  const dpr = window.devicePixelRatio || 1
  if (sizeDirty || cv.width !== Math.round(el.clientWidth * dpr)) {
    cv.width = Math.round(el.clientWidth * dpr)
    cv.height = Math.round(el.clientHeight * dpr)
    sizeDirty = false
  }
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const r = plotRect()
  ctx.fillStyle = '#202020'
  ctx.fillRect(0, 0, el.clientWidth, el.clientHeight)

  // 网格
  ctx.strokeStyle = '#3a3a3a'
  ctx.lineWidth = 1
  for (let i = 1; i <= 3; i++) {
    const x = r.left + r.w * i / 4
    const y = r.top + r.h * i / 4
    ctx.beginPath(); ctx.moveTo(x, r.top); ctx.lineTo(x, r.top + r.h); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(r.left, y); ctx.lineTo(r.left + r.w, y); ctx.stroke()
  }
  // 虚线对角线
  ctx.strokeStyle = '#4a4a4a'
  ctx.setLineDash([4, 4])
  const [dx0, dy0] = toWidget(0.02, 0.02)
  const [dx1, dy1] = toWidget(0.98, 0.98)
  ctx.beginPath(); ctx.moveTo(dx0, dy0); ctx.lineTo(dx1, dy1); ctx.stroke()
  ctx.setLineDash([])

  // 直方图背景（RGB + 亮度）
  if (props.hist) {
    drawHistogramLayer(ctx, r, props.hist.red, 'rgb(226,92,92)', 70 / 255)
    drawHistogramLayer(ctx, r, props.hist.green, 'rgb(118,200,110)', 70 / 255)
    drawHistogramLayer(ctx, r, props.hist.blue, 'rgb(96,150,230)', 70 / 255)
    drawHistogramLayer(ctx, r, props.hist.master, 'rgb(200,200,205)', 50 / 255)
  }

  // 其它通道淡色
  for (const ch of CURVE_CHANNELS) {
    if (ch !== channel.value && props.curves[ch].length >= 2) {
      drawCurve(ctx, r, props.curves[ch], CURVE_CHANNEL_COLORS[ch], 60 / 255, 1)
    }
  }
  drawCurve(ctx, r, points(), CURVE_CHANNEL_COLORS[channel.value], 1, 2)

  // 控制点
  const pts = points()
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = toWidget(pts[i][0], pts[i][1])
    const sel = i === selected || i === dragIndex
    ctx.beginPath()
    ctx.arc(px, py, sel ? 5.5 : 4.2, 0, Math.PI * 2)
    ctx.fillStyle = sel ? '#e2e2e2' : '#242424'
    ctx.fill()
    ctx.strokeStyle = sel ? '#4a9eff' : CURVE_CHANNEL_COLORS[channel.value]
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
}

// ---- 交互 ----
function hitTest(px: number, py: number): number | null {
  let best: number | null = null
  let bestD = HIT_RADIUS
  const pts = points()
  for (let i = 0; i < pts.length; i++) {
    const [wx, wy] = toWidget(pts[i][0], pts[i][1])
    const d = Math.abs(wx - px) + Math.abs(wy - py)     // manhattanLength 对照
    if (d < bestD) { best = i; bestD = d }
  }
  return best
}

function localPos(e: MouseEvent): [number, number] {
  const rect = canvas.value!.getBoundingClientRect()
  return [e.clientX - rect.left, e.clientY - rect.top]
}

function onMouseDown(e: MouseEvent): void {
  const [px, py] = localPos(e)
  if (e.button === 0) {
    const idx = hitTest(px, py)
    if (idx !== null) {
      dragIndex = idx
      selected = idx
      redraw()
    }
  } else if (e.button === 2) {
    const idx = hitTest(px, py)
    const pts = points()
    if (idx !== null && idx > 0 && idx < pts.length - 1) {
      pts.splice(idx, 1)
      selected = null
      emit('changed', channel.value, [...pts])
      emit('committed', channel.value, [...pts])
      redraw()
    }
  }
}

function onMouseMove(e: MouseEvent): void {
  if (dragIndex === null) return
  const [ix, iy] = toImage(...localPos(e))
  const pts = points().map(p => [...p] as [number, number])
  const i = dragIndex
  const y = Math.min(1, Math.max(0, iy))
  if (i === 0 || i === pts.length - 1) {
    pts[i] = [i, y]                        // 端点钉在 x=0/1（与 sanitize_points 一致）
  } else {
    const x = Math.min(pts[i + 1][0] - GAP, Math.max(pts[i - 1][0] + GAP, ix))
    pts[i] = [x, y]
  }
  props.curves[channel.value] = pts
  emit('changed', channel.value, pts.map(p => [...p] as [number, number]))
  redraw()
}

function onMouseUp(e: MouseEvent): void {
  if (dragIndex !== null && e.button === 0) {
    dragIndex = null
    emit('committed', channel.value, points().map(p => [...p] as [number, number]))
    redraw()
  }
}

function onDblClick(e: MouseEvent): void {
  const [ix, iy] = toImage(...localPos(e))
  if (ix < 0 || ix > 1 || iy < 0 || iy > 1) return
  const pts = points()
  if (pts.some(([px]) => Math.abs(ix - px) < GAP)) return
  const newPt: [number, number] = [Math.min(1, Math.max(0, ix)), Math.min(1, Math.max(0, iy))]
  const next = [...pts, newPt].sort((a, b) => a[0] - b[0])
  selected = next.findIndex(p => p[0] === newPt[0] && p[1] === newPt[1])
  props.curves[channel.value] = next
  emit('changed', channel.value, next.map(p => [...p] as [number, number]))
  emit('committed', channel.value, next.map(p => [...p] as [number, number]))
  redraw()
}

function onContextmenu(e: MouseEvent): void { e.preventDefault() }

let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(() => { sizeDirty = true; redraw() })
  ro.observe(wrap.value!)
  redraw()
})
onBeforeUnmount(() => ro?.disconnect())

watch(() => props.hist, () => redraw(), { deep: false })
watch(channel, () => { selected = null; redraw() })
watch(() => props.curves, () => redraw(), { deep: true })

function resetChannel(): void {
  const diag = defaultCurves()[channel.value]
  props.curves[channel.value] = diag
  emit('committed', channel.value, diag)
  redraw()
}
</script>

<template>
  <div class="curve-editor">
    <div class="channel-tabs">
      <button
        v-for="ch in CURVE_CHANNELS"
        :key="ch"
        class="ch-tab"
        :class="{ active: ch === channel }"
        :style="ch === channel ? { color: CURVE_CHANNEL_COLORS[ch] } : {}"
        @click="channel = ch"
      >{{ CURVE_CHANNEL_LABELS[ch] }}</button>
      <button class="ch-reset" title="复位当前通道" @click="resetChannel">↺</button>
    </div>
    <div ref="wrap" class="plot">
      <canvas
        ref="canvas"
        @mousedown="onMouseDown"
        @mousemove="onMouseMove"
        @mouseup="onMouseUp"
        @mouseleave="onMouseUp"
        @dblclick="onDblClick"
        @contextmenu="onContextmenu"
      />
    </div>
  </div>
</template>

<style scoped>
.curve-editor { width: 100%; }
.channel-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 6px;
  align-items: center;
}
.ch-tab {
  border: 1px solid transparent;
  background: transparent;
  color: #868686;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.ch-tab.active {
  border-color: #484848;
  background: #262626;
  color: #e2e2e2;
}
.ch-tab:hover { color: #d2d2d2; }
.ch-reset {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #6e6e6e;
  cursor: pointer;
  font-size: 12px;
}
.ch-reset:hover { color: #4a9eff; }
.plot {
  position: relative;
  width: 100%;
  height: 190px;
  border-radius: 4px;
  overflow: hidden;
}
.plot canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
