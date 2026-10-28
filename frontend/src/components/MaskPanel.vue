<script setup lang="ts">
/** 蒙版面板：AI 识别 / 列表（选中即进入编辑）/ 新建三种 / 羽化 / 反向 / 画笔与径向参数。 */
import { NSlider, NSwitch } from 'naive-ui'
import { useEditor, notifyChanged, notifyCommitted,
         addMask, selectMask, deleteMask, undoBrushStroke, clearBrushStrokes,
         exitMaskEdit, toggleMaskOverlay, addAiMask, AI_TARGET_NAMES,
         linearMaskAngle, setLinearMaskAngle } from '@/stores/editor'
import type { AiMaskTarget } from '@/api/types'

const store = useEditor()

const KIND_ICON = { linear: '▬', radial: '◎', brush: '✎', ai: '✦' } as const
const AI_TARGETS: AiMaskTarget[] = ['subject', 'person', 'background', 'sky']

function setGeom(i: number, field: 'feather' | 'size' | 'radius' | 'aspect' | 'angle', v: number): void {
  const m = store.adjustments.masks[i]
  if (!m) return
  ;(m as unknown as Record<string, number>)[field] = v
  notifyChanged()
}
</script>

<template>
  <div class="mask-panel">
    <div class="ai-group">
      <div class="ai-title">AI 识别</div>
      <div class="ai-actions">
        <button v-for="t in AI_TARGETS" :key="t" class="ai-add"
                :disabled="!store.loaded || store.aiBusy !== null"
                :title="store.aiBusy === t ? '识别中…' : `由 AI 识别画面中的${AI_TARGET_NAMES[t]}并创建蒙版`"
                @click="addAiMask(t)">
          {{ store.aiBusy === t ? '…' : '✦' }} {{ AI_TARGET_NAMES[t] }}
        </button>
      </div>
      <div class="ai-hint">LR 式 AI 蒙版：识别结果可羽化/反向，并支持全套局部调整</div>
    </div>

    <div class="actions">
      <button class="add" @click="addMask('linear')">＋ 线性</button>
      <button class="add" @click="addMask('radial')">＋ 径向</button>
      <button class="add" @click="addMask('brush')">＋ 画笔</button>
    </div>

    <div v-if="!store.adjustments.masks.length" class="empty">
      无蒙版。蒙版可对画面局部做全套调整（基础/效果/曲线/色轮/取色器）。
    </div>

    <div
      v-for="(m, i) in store.adjustments.masks"
      :key="i"
      class="row"
      :class="{ selected: store.maskSelected === i }"
      @click="selectMask(i)"
    >
      <div class="row-head">
        <span class="icon">{{ KIND_ICON[m.kind] }}</span>
        <span class="name">{{ m.name || m.kind }}</span>
        <label class="chk" title="启用/停用" @click.stop>
          <NSwitch :value="m.enabled" size="small"
                   @update:value="(v: boolean) => { m.enabled = v; notifyCommitted() }" />
        </label>
        <button class="mini danger" title="删除蒙版" @click.stop="deleteMask(i)">✕</button>
      </div>

      <div v-if="store.maskSelected === i" class="row-body" @click.stop>
        <div class="done-row">
          <span class="done-hint">正在编辑此蒙版的局部调整</span>
          <button class="done-btn" title="退出局部编辑（面板恢复全局）" @click="exitMaskEdit()">完成</button>
          <button class="mini" title="O 键切换叠加显示" @click="toggleMaskOverlay()">
            {{ store.maskOverlay ? '隐藏叠加' : '显示叠加' }}
          </button>
        </div>
        <div class="s-row">
          <span class="s-label">羽化</span>
          <NSlider :value="m.feather" :min="0" :max="100" :step="1" :tooltip="false"
                   @update:value="(v: number) => setGeom(i, 'feather', v)" />
          <span class="s-val">{{ m.feather.toFixed(0) }}</span>
        </div>
        <div class="s-row">
          <span class="s-label">反向</span>
          <NSwitch :value="m.invert" size="small"
                   @update:value="(v: boolean) => { m.invert = v; notifyCommitted() }" />
          <span class="s-hint">反向 = 作用于蒙版之外</span>
        </div>
        <template v-if="m.kind === 'ai'">
          <div class="s-row">
            <span class="s-label">来源</span>
            <span class="s-hint">{{ m.mask_png ? '本地像素级' : 'AI 网格' }}识别{{ AI_TARGET_NAMES[m.ai_target as AiMaskTarget] || '' }}{{ m.mask_png ? '' : ` · ${m.grid_w}×${m.grid_h}` }}</span>
          </div>
        </template>
        <template v-if="m.kind === 'linear'">
          <div class="s-row">
            <span class="s-label">角度</span>
            <NSlider :value="linearMaskAngle(m)" :min="0" :max="360" :step="0.5" :tooltip="false"
                     @update:value="(v: number) => setLinearMaskAngle(i, v)" />
            <span class="s-val">{{ linearMaskAngle(m).toFixed(1) }}°</span>
          </div>
          <div class="s-row">
            <span class="s-label">旋转</span>
            <div class="rot-btns">
              <button class="mini" title="逆时针 15°（Q 微调 1°，Shift+Q 15°）"
                      @click="setLinearMaskAngle(i, linearMaskAngle(m) - 15)">↺ 15°</button>
              <button class="mini" title="顺时针 15°（E 微调 1°，Shift+E 15°）"
                      @click="setLinearMaskAngle(i, linearMaskAngle(m) + 15)">↻ 15°</button>
            </div>
            <span class="s-hint">拖画布橙色手柄或 Q/E 键旋转</span>
          </div>
        </template>
        <template v-if="m.kind === 'radial'">
          <div class="s-row">
            <span class="s-label">半径</span>
            <NSlider :value="m.radius" :min="0.02" :max="1.5" :step="0.005" :tooltip="false"
                     @update:value="(v: number) => setGeom(i, 'radius', v)" />
            <span class="s-val">{{ m.radius.toFixed(2) }}</span>
          </div>
          <div class="s-row">
            <span class="s-label">长宽比</span>
            <NSlider :value="m.aspect" :min="0.1" :max="5" :step="0.02" :tooltip="false"
                     @update:value="(v: number) => setGeom(i, 'aspect', v)" />
            <span class="s-val">{{ m.aspect.toFixed(2) }}</span>
          </div>
          <div class="s-row">
            <span class="s-label">旋转</span>
            <NSlider :value="m.angle" :min="0" :max="360" :step="0.5" :tooltip="false"
                     @update:value="(v: number) => setGeom(i, 'angle', v)" />
            <span class="s-val">{{ m.angle.toFixed(0) }}°</span>
          </div>
        </template>
        <template v-if="m.kind === 'brush'">
          <div class="s-row">
            <span class="s-label">笔刷大小</span>
            <NSlider :value="m.size" :min="1" :max="100" :step="1" :tooltip="false"
                     @update:value="(v: number) => setGeom(i, 'size', v)" />
            <span class="s-val">{{ m.size.toFixed(0) }}</span>
          </div>
          <div class="brush-actions">
            <button class="mini" @click="undoBrushStroke(i)">撤销一笔</button>
            <button class="mini" @click="clearBrushStrokes(i)">清除笔迹</button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="store.maskSelected !== null" class="hint">
      在画布上拖动编辑；再点一次蒙版或按「完成」退出局部编辑（Esc 亦可）。O 键开关叠加显示。
    </div>
  </div>
</template>

<style scoped>
.mask-panel { display: flex; flex-direction: column; gap: 8px; }
.ai-group { border: 1px dashed #484848; border-radius: 6px; padding: 6px 8px; }
.ai-title { font-size: 11px; color: #4a9eff; margin-bottom: 5px; }
.ai-actions { display: flex; gap: 6px; }
.ai-add {
  flex: 1;
  border: 1px solid #484848;
  background: #262626;
  color: #d2d2d2;
  font-size: 12px;
  padding: 4px 0;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.ai-add:hover:not(:disabled) { border-color: #4a9eff; color: #4a9eff; }
.ai-add:disabled { opacity: 0.45; cursor: default; }
.ai-hint { font-size: 10px; color: #5c5c5c; margin-top: 5px; }
.actions { display: flex; gap: 6px; }
.add {
  flex: 1;
  border: 1px solid #484848;
  background: #262626;
  color: #d2d2d2;
  font-size: 12px;
  padding: 4px 0;
  border-radius: 4px;
  cursor: pointer;
}
.add:hover { border-color: #4a9eff; color: #4a9eff; }
.empty { font-size: 11px; color: #5c5c5c; }
.row {
  border: 1px solid #424242;
  border-radius: 6px;
  padding: 6px 8px;
  background: #242424;
  cursor: pointer;
}
.row.selected { border-color: #4a9eff; }
.row-head { display: flex; align-items: center; gap: 6px; }
.icon { color: #9a9a9a; width: 18px; text-align: center; }
.name { flex: 1; font-size: 12px; color: #d2d2d2; }
.chk { display: flex; align-items: center; }
.mini {
  border: 1px solid #484848;
  background: transparent;
  color: #9a9a9a;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
}
.mini:hover { color: #d2d2d2; border-color: #4a9eff; }
.mini.danger:hover { color: #e06c75; border-color: #e06c75; }
.row-body { margin-top: 6px; }
.done-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.done-hint { flex: 1; font-size: 11px; color: #6e6e6e; }
.done-btn {
  border: 1px solid #4a9eff;
  background: transparent;
  color: #4a9eff;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 3px;
  cursor: pointer;
}
.done-btn:hover { background: rgba(74, 158, 255, 0.12); }
.s-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.s-label { font-size: 11px; color: #a6a6a6; width: 56px; flex: none; }
.s-row :deep(.n-slider) { flex: 1; }
.s-val { font-size: 11px; color: #e2e2e2; width: 44px; text-align: right;
         font-variant-numeric: tabular-nums; flex: none; }
.s-hint { font-size: 10px; color: #5c5c5c; flex: 1; text-align: right; }
.brush-actions { display: flex; gap: 6px; padding-top: 4px; }
.rot-btns { display: flex; gap: 4px; flex: 1; }
.hint { font-size: 11px; color: #6e6e6e; }
</style>
