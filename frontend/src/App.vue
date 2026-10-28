<script setup lang="ts">
/** 主布局：顶栏 + （裁剪/图章条）+ 左视口 + 右调整面板 + 状态栏。
 *  快捷键对照 README：Ctrl+O 打开 / Ctrl+S 保存 / Ctrl+R 重置 / `\` 对比原图
 *  / Delete 删除选中取色点 / Esc 退出编辑 / 0、1、+、- 缩放（Viewport 内）。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NConfigProvider, NDropdown, NSwitch, darkTheme } from 'naive-ui'
import Viewport from '@/components/Viewport.vue'
import Section from '@/components/Section.vue'
import SliderRow from '@/components/SliderRow.vue'
import Histogram from '@/components/Histogram.vue'
import CurveEditor from '@/components/CurveEditor.vue'
import GradingPanel from '@/components/GradingPanel.vue'
import PickerPanel from '@/components/PickerPanel.vue'
import MaskPanel from '@/components/MaskPanel.vue'
import AiSettings from '@/components/AiSettings.vue'
import Filmstrip from '@/components/Filmstrip.vue'
import {
  useEditor, resetAll, notifyChanged, notifyCommitted,
  toggleBlackwhite, saveBrowser, autoRule, autoAI, cancelPick, deletePicker,
  targetAdj, setComparing, enterCrop, cancelCrop, applyCrop, rotate90,
  stampUndo, stampClear, exitMaskEdit, toggleMaskOverlay, openFiles, openPaths,
  initLibrary, openAiSettings, aiConfigured, rotateLinearMask, refreshLocalAI,
} from '@/stores/editor'
import { native, openDesktop, saveDesktop } from '@/api/client'

const store = useEditor()
const fileInput = ref<HTMLInputElement | null>(null)

// ---- 面板目标（选中蒙版 → 局部参数）----
const target = computed(() => targetAdj())
const isMaskTarget = computed(() => store.maskSelected !== null)

// ---- 保存 ----
const saveOptions = [
  { label: 'PNG（无损）', key: 'png' },
  { label: 'JPEG（质量 95）', key: 'jpg' },
  { label: 'WebP', key: 'webp' },
]

function onOpenClick(): void {
  if (native) {
    void openDesktop().then((paths) => {
      if (!paths || !paths.length) return
      openPaths(paths).catch((err) => {
        store.status = `打开失败：${err instanceof Error ? err.message : err}`
      })
    })
  } else {
    fileInput.value?.click()
  }
}
async function onFileChosen(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  if (!files.length) return
  try {
    await openFiles(files)
  } catch (err) {
    store.status = `打开失败：${err instanceof Error ? err.message : err}`
  }
  input.value = ''
}

async function onSavePick(key: string): Promise<void> {
  try {
    if (native) {
      const path = await saveDesktop(store.adjustments, `photolab.${key}`)
      if (path) store.status = `已保存：${path}`
    } else {
      await saveBrowser(key)
    }
  } catch (err) {
    store.status = `保存失败：${err instanceof Error ? err.message : err}`
  }
}

async function onAuto(): Promise<void> {
  try { await autoRule() }
  catch (err) { store.status = `自动调色失败：${err instanceof Error ? err.message : err}` }
}

const aiRunning = ref(false)
async function onAutoAI(): Promise<void> {
  if (aiRunning.value) return
  aiRunning.value = true
  try { await autoAI() }
  catch (err) { store.status = `AI 调色失败：${err instanceof Error ? err.message : err}` }
  finally { aiRunning.value = false }
}

// ---- 工具栏状态 ----
const bwChecked = computed({
  get: () => store.adjustments.blackwhite > 0,
  set: () => toggleBlackwhite(),
})
const cropActive = computed(() => store.editMode === 'crop')
const stampActive = computed(() => store.editMode === 'stamp')
const comparing = computed(() => store.comparing)

function toggleCrop(): void {
  if (cropActive.value) cancelCrop()
  else enterCrop()
}
function toggleStamp(): void {
  if (stampActive.value) {
    store.editMode = null
    store.status = ''
  } else {
    store.editMode = 'stamp'
    store.status = '图章：Alt+拖动选源矩形，直接拖动覆盖目标区域'
  }
}
function toggleCompare(): void {
  setComparing(!store.comparing)
}

// ---- 裁剪条 ----
const aspectOptions = [
  { label: '自由', key: 'free' }, { label: '原始', key: 'orig' },
  { label: '1:1', key: '1:1' }, { label: '3:2', key: '3:2' },
  { label: '4:3', key: '4:3' }, { label: '16:9', key: '16:9' },
  { label: '2:3（转置）', key: '3:2:t' }, { label: '9:16（转置）', key: '16:9:t' },
]
const aspectLabel = computed(() =>
  aspectOptions.find(o => o.key === store.cropAspect)?.label ?? '自由')

// ---- 快捷键 ----
function onKey(e: KeyboardEvent): void {
  if (e.target instanceof HTMLInputElement) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault(); onOpenClick(); return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); void onSavePick('png'); return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
    e.preventDefault(); resetAll(); return
  }
  if (e.key === '\\') { setComparing(true); return }
  if (e.key === 'Enter' && cropActive.value) {
    e.preventDefault(); void applyCrop(); return
  }
  if (e.key === 'Delete') {
    if (store.pickSelected !== null) deletePicker(store.pickSelected)
    return
  }
  if (e.key === 'Escape') {
    if (store.pickTarget !== null) { cancelPick(); return }
    if (cropActive.value) { cancelCrop(); return }
    if (stampActive.value) { toggleStamp(); return }
    if (store.editMode === 'mask') { exitMaskEdit(); return }
  }
  if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey) {
    if (store.editMode === 'mask') toggleMaskOverlay()
  }
  // Q/E 旋转选中的线性渐变蒙版（±1°，Shift ±15°；Q=逆时针，E=顺时针）
  if ((e.key === 'q' || e.key === 'Q' || e.key === 'e' || e.key === 'E')
      && !e.ctrlKey && !e.metaKey) {
    const i = store.maskSelected
    if (i !== null && store.adjustments.masks[i]?.kind === 'linear') {
      e.preventDefault()
      const step = (e.shiftKey ? 15 : 1) * (e.key === 'q' || e.key === 'Q' ? 1 : -1)
      rotateLinearMask(i, step)
    }
  }
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.key === '\\') setComparing(false)
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKeyUp)
  void initLibrary()
  void refreshLocalAI()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKeyUp)
})

const themeOverrides = {
  common: {
    primaryColor: '#4a9eff',
    primaryColorHover: '#6cb2ff',
    primaryColorPressed: '#3a82d6',
    bodyColor: '#2b2b2b',
    cardColor: '#333333',
    popoverColor: '#2b2b2b',
    borderColor: '#3d3d3d',
    textColorBase: '#d4d4d4',
    textColor1: '#d4d4d4',
    textColor2: '#a2a2a2',
    textColor3: '#727272',
    placeholderColor: '#6a6a6a',
    hoverColor: 'rgba(255,255,255,0.06)',
  },
  Button: {
    colorSecondary: '#3a3a3a',
    colorSecondaryHover: '#454545',
    colorSecondaryPressed: '#303030',
  },
}
</script>

<template>
  <NConfigProvider :theme="darkTheme" :theme-overrides="themeOverrides" class="provider">
    <div class="app">
      <header class="toolbar">
        <span class="brand">PhotoLab</span>
        <input ref="fileInput" type="file" accept="image/*,.dng,.cr2,.cr3,.nef,.arw,.rw2,.raf,.orf" hidden multiple
               @change="onFileChosen" />
        <NButton size="small" @click="onOpenClick">打开</NButton>
        <NDropdown :options="saveOptions" trigger="click" @select="onSavePick">
          <NButton size="small" :disabled="!store.loaded">保存</NButton>
        </NDropdown>
        <NButton size="small" :disabled="!store.loaded" @click="resetAll">重置</NButton>
        <NButton size="small" :disabled="!store.loaded" @click="onAuto">自动</NButton>
        <NButton size="small" :disabled="!store.loaded || aiRunning" :loading="aiRunning" @click="onAutoAI">AI</NButton>
        <NButton size="small" :title="aiConfigured() ? 'AI 端点设置' : 'AI 未配置，点击设置 URL / Key / 模型 ID'"
                 :type="!aiConfigured() ? 'warning' : 'default'" @click="openAiSettings">AI 设置</NButton>
        <div class="toolbar-sep" />
        <span class="bw-label">黑白</span>
        <NSwitch v-model:value="bwChecked" size="small" />
        <div class="toolbar-sep" />
        <NButton size="small" :disabled="!store.loaded" :type="cropActive ? 'primary' : 'default'"
                 @click="toggleCrop">裁剪</NButton>
        <NButton size="small" :disabled="!store.loaded" @click="rotate90(false)">左转</NButton>
        <NButton size="small" :disabled="!store.loaded" @click="rotate90(true)">右转</NButton>
        <NButton size="small" :disabled="!store.loaded" :type="stampActive ? 'primary' : 'default'"
                 @click="toggleStamp">图章</NButton>
        <NButton size="small" :disabled="!store.loaded || !store.originalBmp"
                 :type="comparing ? 'primary' : 'default'" @click="toggleCompare">对比</NButton>
        <div class="spacer" />
        <span v-if="store.busy" class="busy">⏳ 处理中…</span>
      </header>

      <!-- 裁剪条 -->
      <div v-if="cropActive" class="subbar">
        <NDropdown :options="aspectOptions" trigger="click"
                   @select="(k: string) => store.cropAspect = k">
          <NButton size="small">比例：{{ aspectLabel }}</NButton>
        </NDropdown>
        <span class="sub-label">拉直</span>
        <NSlider v-model:value="store.cropAngle" :min="-45" :max="45" :step="0.1"
                 style="width: 200px" :tooltip="false" @update:value="() => notifyChanged()" />
        <span class="sub-val">{{ store.cropAngle.toFixed(1) }}°</span>
        <NButton size="small" type="primary" :loading="store.cropPending" @click="applyCrop">应用 (Enter)</NButton>
        <NButton size="small" @click="cancelCrop">取消 (Esc)</NButton>
        <span class="sub-hint">拖动调整裁剪框与手柄</span>
      </div>

      <!-- 图章条 -->
      <div v-if="stampActive" class="subbar">
        <span class="sub-label">边缘羽化</span>
        <NSlider v-model:value="store.stampFeather" :min="0" :max="100" :step="1"
                 style="width: 160px" :tooltip="false" />
        <span class="sub-val">{{ store.stampFeather.toFixed(0) }}</span>
        <NButton size="small" @click="store.stampSource = null; store.status = '按住 Alt 拖出新源矩形'">重选源区</NButton>
        <NButton size="small" @click="stampUndo()">撤销一笔</NButton>
        <NButton size="small" @click="stampClear()">全部清除</NButton>
        <span class="sub-hint">Alt+拖动 = 选源矩形；直接拖动 = 覆盖目标区域</span>
      </div>

      <div class="main">
        <div class="viewport-col">
          <Viewport />
          <Filmstrip />
        </div>
        <aside class="panel">
          <Section title="直方图">
            <Histogram :hist="store.histogram" />
          </Section>
          <Section title="蒙版" :expanded="false">
            <MaskPanel />
          </Section>
          <Section :title="isMaskTarget ? '基础（蒙版局部）' : '基础'">
            <SliderRow label="曝光" :min="-5" :max="5" :step="0.01" :decimals="2" suffix=" EV"
                       v-model="target.exposure" @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="对比度" :min="-100" :max="100" v-model="target.contrast"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="高光" :min="-100" :max="100" v-model="target.highlights"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="阴影" :min="-100" :max="100" v-model="target.shadows"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="白色" :min="-100" :max="100" v-model="target.whites"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="黑色" :min="-100" :max="100" v-model="target.blacks"
                       @input="notifyChanged" @release="notifyCommitted" />
          </Section>
          <Section :title="isMaskTarget ? '颜色（蒙版局部）' : '颜色'">
            <SliderRow label="色温" :min="-100" :max="100" v-model="target.temperature"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="色调" :min="-100" :max="100" v-model="target.tint"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="饱和度" :min="-100" :max="100" v-model="target.saturation"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow v-if="!isMaskTarget" label="自然饱和度" :min="-100" :max="100"
                       v-model="store.adjustments.vibrance"
                       @input="notifyChanged" @release="notifyCommitted" />
          </Section>
          <Section :title="isMaskTarget ? '效果（蒙版局部）' : '效果'">
            <SliderRow label="清晰度" :min="-100" :max="100" v-model="target.clarity"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="降噪" :min="0" :max="100" v-model="target.denoise"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="锐度" :min="0" :max="100" v-model="target.sharpen"
                       @input="notifyChanged" @release="notifyCommitted" />
            <SliderRow label="去朦胧" :min="-100" :max="100" v-model="target.dehaze"
                       @input="notifyChanged" @release="notifyCommitted" />
          </Section>
          <Section title="曲线">
            <CurveEditor :curves="target.curves" :hist="store.histogram"
                         @changed="() => notifyChanged()" @committed="() => notifyCommitted()" />
          </Section>
          <Section title="颜色分级" :expanded="false">
            <GradingPanel :adj="target" />
          </Section>
          <Section title="取色器" :expanded="false">
            <PickerPanel :pickers="target.pickers" />
          </Section>
        </aside>
      </div>

      <footer class="statusbar">
        <span>{{ store.loaded ? `${store.width} × ${store.height}` : '' }}</span>
        <span v-if="store.maskSelected !== null" class="dim">蒙版 #{{ store.maskSelected + 1 }} 编辑中</span>
        <span v-if="store.meta" class="dim">GPU: {{ store.meta.gpu ? '可用' : 'CPU' }}</span>
        <span class="spacer" />
        <span class="status">{{ store.status }}</span>
      </footer>
    </div>
    <AiSettings />
  </NConfigProvider>
</template>

<style scoped>
.provider { height: 100%; }
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-deep);
  color: var(--text);
}

/* ---- 顶栏（LR 模块条风格） ---- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  height: 42px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex-wrap: wrap;
}
.brand {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text);
  margin-right: 14px;
  user-select: none;
}
.brand::first-letter { color: var(--accent); }
.toolbar-sep {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 6px;
}
.bw-label { font-size: 11px; color: var(--text-2); }
.spacer { flex: 1; }
.busy { font-size: 11px; color: var(--warn); }

/* ---- 子条（裁剪 / 图章） ---- */
.subbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surf);
}
.sub-label { font-size: 11px; color: var(--text-2); }
.sub-val { font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; min-width: 44px; }
.sub-hint { font-size: 10px; color: var(--text-3); margin-left: auto; }

/* ---- 主体：左视口 + 右调整面板 ---- */
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.viewport-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.viewport-col > :first-child { flex: 1; min-height: 0; }
.panel {
  width: 312px;
  overflow-y: auto;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
}

/* ---- 状态栏 ---- */
.statusbar {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 4px 14px;
  height: 26px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: 11px;
  color: var(--text-2);
}
.dim { color: var(--text-3); }
.status { color: var(--text); }
</style>
