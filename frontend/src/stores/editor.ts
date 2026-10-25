/** 编辑器全局状态（单例 composable）。
 *  调度语义照抄旧版：拖动 -> preview（服务端最新覆盖），松手/空闲 400ms -> full；
 *  帧按 rid 丢弃过期（与 ProcessorThread.frameReady 接收端一致）。
 */
import { reactive, toRaw } from 'vue'
import {
  Adjustments, CURVE_CHANNELS, GRADING_RANGES, TONE_FIELDS, aiMask, aiMaskPixels,
  defaultAdjustments,
} from '@/api/types'
import type { AdjustmentsLike, AiMaskTarget, MaskKind, MaskState, PickerState, WheelState } from '@/api/types'
import { defaultMask } from '@/api/types'
import * as api from '@/api/client'
import type { AiConfig, HistData, LibraryItem, LocalModelsStatus, RectNorm, ServerEvent } from '@/api/client'
import { presetColor } from '@/lib/presets'

interface Frame { bmp: ImageBitmap; rid: number }

/** AI 端点配置（localStorage 持久化；服务端也支持环境变量回退）。 */
const AI_CONFIG_KEY = 'photolab.ai-config'

function loadAiConfig(): AiConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || '')
    return {
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      model: typeof raw.model === 'string' ? raw.model : '',
    }
  } catch {
    return api.emptyAiConfig()
  }
}

const state = reactive({
  loaded: false,
  busy: false,
  connected: false,
  width: 0,
  height: 0,
  serial: 0,
  adjustments: defaultAdjustments() as Adjustments,
  previewFrame: null as Frame | null,
  fullFrame: null as Frame | null,
  frameVersion: 0,
  histogram: null as HistData | null,
  status: '',
  meta: null as api.Meta | null,
  // 多图图库：每张图独立参数（imageParams），当前图 currentImageId
  library: [] as LibraryItem[],
  currentImageId: null as number | null,
  // AI 设置（顶栏 ⚙ 打开；未配置时 AI 功能会提示先配置）
  aiConfig: loadAiConfig(),
  aiSettingsOpen: false,
  aiBusy: null as AiMaskTarget | null,
  // 本地像素级引擎（SAM2 + U2Net；就绪时 AI 蒙版默认走本地，图像不出本机）
  localAI: null as LocalModelsStatus | null,
  // 取色模式：null=未激活 | 'new'=新建取色点 | number=重新取色第 i 个
  pickTarget: null as null | 'new' | number,
  pickSelected: null as number | null,
  // 编辑模式（对照旧 PreviewWidget.set_edit_mode / crop / stamp）
  editMode: null as null | 'crop' | 'stamp' | 'mask',
  maskSelected: null as number | null,
  // 图章（服务端持有工作副本；前端记源矩形与羽化档位）
  stampSource: null as RectNorm | null,
  stampFeather: 20,
  // 裁剪（归一化 rect + 拉直角度 + 比例锁定；应用时服务端权威计算）
  cropRect: null as { x0: number; y0: number; x1: number; y1: number } | null,
  cropAngle: 0,
  cropAspect: 'free' as string,           // free|orig|1|3:2|4:3|16:9（:t=转置）
  cropPending: false,
  // 对比原图（按住 `\`）
  comparing: false,
  originalBmp: null as ImageBitmap | null,
  // 蒙版叠加显示（LR 的 O 键开关；仅影响叠加显示，不影响渲染）
  maskOverlay: true,
})

// 每图独立状态（非响应式：体积大且只在切换时整体读写）
const imageParams = new Map<number, Adjustments>()      // id -> 调色参数
const originalBmps = new Map<number, ImageBitmap>()     // id -> 对比用原位图
const originalBlobs = new Map<number, Blob>()           // id -> 上传的原始字节（浏览器模式）

export function aiConfigured(): boolean {
  return api.aiConfigComplete(state.aiConfig)
}

/** 拉取本地像素级引擎状态（就绪时 AI 蒙版默认走本地引擎）。 */
export async function refreshLocalAI(): Promise<void> {
  try { state.localAI = await api.getLocalModels() } catch { state.localAI = null }
}

export function saveAiConfig(cfg: AiConfig): void {
  state.aiConfig = { ...cfg }
  try { localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(state.aiConfig)) } catch { /* 忽略 */ }
}

export function openAiSettings(): void {
  state.aiSettingsOpen = true
  void refreshLocalAI()
}

let ridCounter = 0
let newestRid = -1
const sock = new api.RenderSocket()

// ------------------------------------------------------------ 帧接收
sock.onFrame = (rid, isFull, jpeg) => {
  if (rid < newestRid) return                       // 过期帧（已被更新的请求取代）
  newestRid = rid
  createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })).then((bmp) => {
    if (rid < newestRid) { bmp.close(); return }    // 解码期间又来了新帧
    const slot = isFull ? 'fullFrame' : 'previewFrame'
    state[slot]?.bmp.close()
    state[slot] = { bmp, rid }
    state.frameVersion++
    if (isFull) scheduleHistogram()
  }).catch(() => { /* 坏帧忽略 */ })
}

sock.onEvent = (ev: ServerEvent) => {
  if (ev.type === 'busy') {
    state.busy = !!ev.busy
  } else if (ev.type === 'saved') {
    state.status = ev.ok ? `已保存：${ev.path}` : `保存失败：${ev.error ?? ''}`
  } else if (ev.type === 'error') {
    state.status = '渲染出错（详见服务端日志）'
  }
}

sock.onState = (ok) => {
  state.connected = ok
  if (!ok) state.status = '与服务端断开，正在重连…'
  else state.status = ''
}
sock.connect()

// ------------------------------------------------------------ 调度
function sendFull(): void {
  const rid = ++ridCounter
  sock.sendRender(rid, 'full', toRaw(state.adjustments))
}

function sendPreview(): void {
  const rid = ++ridCounter
  sock.sendRender(rid, 'preview', toRaw(state.adjustments))
}

let previewTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** 参数变化（拖动中）：节流发 preview + 空闲 400ms 后发 full。 */
export function notifyChanged(): void {
  if (!state.loaded) return
  if (previewTimer === null) {
    previewTimer = setTimeout(() => { previewTimer = null; sendPreview() }, 30)
  }
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { idleTimer = null; sendFull() }, 400)
}

/** 参数提交（松手/开关切换）：立即全图。 */
export function notifyCommitted(): void {
  if (!state.loaded) return
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  sendFull()
}

// ---- 直方图：full 帧后节流拉取（对照旧版 0.3s 节流）----
let lastHistAt = 0
function scheduleHistogram(): void {
  const now = performance.now()
  if (now - lastHistAt < 300) return
  lastHistAt = now
  api.fetchHistogram().then((h) => { state.histogram = h }).catch(() => { /* 忽略 */ })
}

// ------------------------------------------------------------ 多图导入 / 切换
function _resetEditState(): void {
  state.editMode = null
  state.maskSelected = null
  state.pickTarget = null
  state.pickSelected = null
  state.stampSource = null
  state.cropRect = null
  state.cropAngle = 0
  state.comparing = false
}

function _stashParams(): void {
  if (state.currentImageId !== null && state.loaded) {
    imageParams.set(state.currentImageId,
      JSON.parse(JSON.stringify(toRaw(state.adjustments))) as Adjustments)
  }
}

/** 对比用原位图：浏览器模式直接解码上传字节，Electron 模式向服务端取原图。 */
async function _ensureOriginal(id: number): Promise<void> {
  if (originalBmps.has(id)) {
    if (state.currentImageId === id) state.originalBmp = originalBmps.get(id)!
    return
  }
  let bmp: ImageBitmap | null = null
  try {
    const blob = originalBlobs.get(id)
      ?? await (await fetch(api.originalUrl(id))).blob()
    bmp = await createImageBitmap(blob)
  } catch { bmp = null }
  if (bmp) originalBmps.set(id, bmp)
  if (state.currentImageId === id) state.originalBmp = bmp     // 竞态防护：迟到的解码不覆盖新图
}

function _applyLoaded(meta: { id: number; name?: string; width: number; height: number;
                              serial: number }, status = ''): void {
  state.currentImageId = meta.id
  state.width = meta.width
  state.height = meta.height
  state.serial = meta.serial
  state.previewFrame?.bmp.close()
  state.fullFrame?.bmp.close()
  state.previewFrame = null
  state.fullFrame = null
  newestRid = -1
  _resetEditState()
  state.originalBmp = null
  state.adjustments = imageParams.get(meta.id) ?? defaultAdjustments()
  state.loaded = true
  state.status = status
  state.histogram = null
  void _ensureOriginal(meta.id)
  void refreshLibrary()
  sendFull()
}

export async function refreshLibrary(): Promise<void> {
  try { state.library = (await api.getLibrary()).images } catch { /* 忽略 */ }
}

/** 页面加载时恢复服务端已有图库（F5 后参数不保，图像与文档状态仍在）。 */
export async function initLibrary(): Promise<void> {
  if (state.loaded) return
  try {
    const r = await api.getLibrary()
    state.library = r.images
    const cur = r.images.find(i => i.current)
    if (cur) {
      const meta = await api.selectLibrary(cur.id)
      _applyLoaded(meta)
    }
  } catch { /* 服务端未就绪等情况忽略 */ }
}

/** 浏览器模式：一次导入多张（依次上传入列，选中新导入的最后一张）。 */
export async function openFiles(files: File[]): Promise<void> {
  if (!files.length) return
  _stashParams()
  let last: api.OpenResult | null = null
  try {
    for (const f of files) {
      const meta = await api.openUpload(f)
      originalBlobs.set(meta.id, f)
      last = meta
    }
  } catch (err) {
    state.status = `打开失败：${err instanceof Error ? err.message : err}`
    if (last) _applyLoaded(last)
    return
  }
  if (last) _applyLoaded(last, files.length > 1 ? `已导入 ${files.length} 张图像` : '')
}

/** 兼容入口：单文件打开（自动化测试钩子同款）。 */
export async function openFile(file: File): Promise<void> {
  return openFiles([file])
}

/** Electron 模式：按路径逐张入列（支持 RAW、多选）。 */
export async function openPaths(paths: string[]): Promise<void> {
  if (!paths.length) return
  _stashParams()
  let last: api.OpenResult | null = null
  try {
    for (const p of paths) last = await api.openPath(p)
  } catch (err) {
    state.status = `打开失败：${err instanceof Error ? err.message : err}`
    if (last) _applyLoaded(last)
    return
  }
  if (last) _applyLoaded(last, paths.length > 1 ? `已导入 ${paths.length} 张图像` : '')
}

/** 兼容入口：单路径打开。 */
export async function openByPath(path: string): Promise<void> {
  return openPaths([path])
}

/** 切换当前图：暂存当前参数 -> 服务端切文档 -> 载入目标参数并全图渲染。 */
export async function selectImage(id: number): Promise<void> {
  if (id === state.currentImageId) return
  _stashParams()
  try {
    const meta = await api.selectLibrary(id)
    _applyLoaded(meta)
  } catch (err) {
    state.status = `切换失败：${err instanceof Error ? err.message : err}`
  }
}

/** 从图库删除一张（删当前图时服务端自动切到相邻一张，前端跟随）。 */
export async function removeImage(id: number): Promise<void> {
  try {
    const r = await api.removeLibrary(id)
    imageParams.delete(id)
    originalBmps.get(id)?.close()
    originalBmps.delete(id)
    originalBlobs.delete(id)
    state.library = r.images
    const cur = r.images.find(i => i.current)
    if (!cur) {                                  // 图库清空
      state.currentImageId = null
      state.loaded = false
      state.adjustments = defaultAdjustments()
      state.previewFrame?.bmp.close()
      state.fullFrame?.bmp.close()
      state.previewFrame = null
      state.fullFrame = null
      state.originalBmp?.close()
      state.originalBmp = null
      state.histogram = null
      newestRid = -1
      _resetEditState()
      state.status = '图库已清空'
    } else if (cur.id !== state.currentImageId) {
      _applyLoaded(cur)
    }
  } catch (err) {
    state.status = `删除失败：${err instanceof Error ? err.message : err}`
  }
}

/** 对比原图（按住 `\`）：显示打开时的原始位图。 */
export function setComparing(on: boolean): void {
  if (state.loaded && state.originalBmp) state.comparing = on
}

export function resetAll(): void {
  state.adjustments = defaultAdjustments()
  notifyCommitted()
}

export function toggleBlackwhite(): void {
  state.adjustments.blackwhite = state.adjustments.blackwhite > 0 ? 0 : 100
  notifyCommitted()
}

export async function saveBrowser(format: string): Promise<void> {
  await api.renderDownload(state.adjustments, format, `photolab.${format}`)
  state.status = `已下载 photolab.${format}`
}

/** auto.suggest_* 结果按旧版 _apply_adjustment_dict 语义合并（M1 基础影调 + 曲线/色轮/取色点）。 */
export function applyAdjustmentDict(d: Record<string, unknown>): void {
  const a = state.adjustments
  for (const name of TONE_FIELDS) {
    const v = d[name]
    if (typeof v === 'number' && Number.isFinite(v)) (a as unknown as Record<string, number>)[name] = v
  }
  const curves = d['curves'] as Record<string, unknown> | undefined
  if (curves && typeof curves === 'object') {
    for (const ch of CURVE_CHANNELS) {
      const pts = curves[ch]
      if (Array.isArray(pts)) {
        a.curves[ch] = pts
          .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2)
          .map(([x, y]) => [Number(x) || 0, Number(y) || 0] as [number, number])
      }
    }
  }
  const wheels = d['wheels'] as Record<string, unknown> | undefined
  if (wheels && typeof wheels === 'object') {
    for (const range of GRADING_RANGES) {
      const w = wheels[range] as Partial<WheelState> | undefined
      if (w && typeof w === 'object') {
        a.wheels[range] = {
          hue: Number(w.hue) || 0,
          saturation: Number(w.saturation) || 0,
          luminance: Number(w.luminance) || 0,
        }
      }
    }
  }
  if (Array.isArray(d['pickers'])) {
    a.pickers = (d['pickers'] as Record<string, unknown>[]).map((p) => ({
      hue: Number(p.hue) || 0,
      color: Array.isArray(p.color) && p.color.length === 3
        ? [Number(p.color[0]) || 0, Number(p.color[1]) || 0, Number(p.color[2]) || 0]
        : [0.5, 0.5, 0.5],
      span: Number(p.span) || 30,
      hue_shift: Number(p.hue_shift) || 0,
      saturation: Number(p.saturation) || 0,
      luminance: Number(p.luminance) || 0,
      enabled: true,
    } satisfies PickerState))
  }
  notifyCommitted()
}

export async function autoRule(): Promise<void> {
  const r = await api.autoGrade('rule')
  applyAdjustmentDict(r.adjustments)
  state.status = r.note || '已应用规则自动调色'
}

export async function autoAI(): Promise<void> {
  if (!aiConfigured()) {
    state.status = '未配置 AI 模型：请在「AI 设置」中填写 URL / API Key / 模型 ID'
    openAiSettings()
    return
  }
  state.status = 'AI 分析中…'
  const r = await api.autoGrade('ai', state.aiConfig)
  applyAdjustmentDict(r.adjustments)
  state.status = (r.note || '已应用 AI 调色') + `（${r.model}）`
}

// ------------------------------------------------------------ 取色器（对照旧 PickerPanel 交互）
export function armNewPick(): void {
  if (!state.loaded) return
  state.pickTarget = 'new'
}

export function armRepick(index: number): void {
  if (!state.loaded) return
  state.pickTarget = index
  state.pickSelected = index
}

export function cancelPick(): void {
  state.pickTarget = null
}

/** 新建预设色相取色点（无需图像取色）。 */
export function newPresetPicker(hueDeg: number): void {
  targetAdj().pickers.push({
    hue: hueDeg, color: presetColor(hueDeg), span: 30,
    hue_shift: 0, saturation: 0, luminance: 0, enabled: true,
  })
  state.pickSelected = targetAdj().pickers.length - 1
  notifyCommitted()
}

export function deletePicker(index: number): void {
  const list = targetAdj().pickers
  if (index < 0 || index >= list.length) return
  list.splice(index, 1)
  if (state.pickSelected !== null && state.pickSelected >= list.length) {
    state.pickSelected = null
  }
  notifyCommitted()
}

/** 视口单击取色：全图像素坐标 -> /api/pick -> 新建或更新取色点。 */
export async function imagePicked(x: number, y: number): Promise<void> {
  if (!state.loaded || state.pickTarget === null) return
  const patch = Math.max(3, Math.round(state.height * 0.01))   // 对照旧 _on_image_picked
  try {
    const r = await api.pickAt(Math.round(x), Math.round(y), patch)
    const color: [number, number, number] = [r.r, r.g, r.b]
    const list = targetAdj().pickers
    if (state.pickTarget === 'new') {
      list.push({
        hue: r.hue, color, span: 30, hue_shift: 0,
        saturation: 25, luminance: 0, enabled: true,
      })
      state.pickSelected = list.length - 1
    } else if (typeof state.pickTarget === 'number') {
      const p = list[state.pickTarget]
      if (p) { p.hue = r.hue; p.color = color }
    }
    state.pickTarget = null
    notifyCommitted()
  } catch (err) {
    state.status = `取色失败：${err instanceof Error ? err.message : err}`
  }
}

// ------------------------------------------------------------ 蒙版（对照旧 ui_window 蒙版面板语义）
const MASK_KIND_NAMES: Record<MaskKind, string> = {
  linear: '线性渐变', radial: '径向渐变', brush: '画笔', ai: 'AI 识别',
}

/** AI 识别目标的显示名（与 auto.AI_MASK_TARGETS 对应）。 */
export const AI_TARGET_NAMES: Record<AiMaskTarget, string> = {
  subject: '主体', person: '人物', background: '背景', sky: '天空',
}

/** AI 识别蒙版（LR 式「选择主体/人物/背景/天空」）。
 *  本地像素级引擎（SAM2）就绪时默认走本地（图像不出本机、免费），
 *  否则用所配置的视觉大模型（网格分割）。 */
export async function addAiMask(target: AiMaskTarget): Promise<void> {
  if (!state.loaded || state.aiBusy) return
  const useLocal = !!state.localAI?.ready
  if (!useLocal && !aiConfigured()) {
    state.status = '未配置 AI 模型：请在「AI 设置」中填写 URL / API Key / 模型 ID，或下载本地引擎'
    openAiSettings()
    return
  }
  state.aiBusy = target
  state.status = useLocal
    ? `AI 识别「${AI_TARGET_NAMES[target]}」中…（本地像素级引擎，约 2~10 秒）`
    : `AI 识别「${AI_TARGET_NAMES[target]}」中…（图像会上传到所配置的端点）`
  try {
    const r = await api.aiMask(target, state.aiConfig, useLocal ? 'local' : 'vlm')
    const idx = state.adjustments.masks.length + 1
    let m: MaskState
    if (r.mask_png) {
      m = aiMaskPixels(`AI ${AI_TARGET_NAMES[target]} ${idx}`, target,
        r.mask_png, r.width ?? 0, r.height ?? 0)
    } else {
      m = aiMask(`AI ${AI_TARGET_NAMES[target]} ${idx}`, target,
        r.grid ?? [], r.width ?? 0, r.height ?? 0)
    }
    state.adjustments.masks.push(m)
    state.maskSelected = state.adjustments.masks.length - 1
    state.editMode = 'mask'
    state.status = `已创建「${AI_TARGET_NAMES[target]}」蒙版（${useLocal ? '像素级' : '网格'}），可直接在右侧做局部调整`
    notifyCommitted()
  } catch (err) {
    state.status = `AI 蒙版失败：${err instanceof Error ? err.message : err}`
  } finally {
    state.aiBusy = null
  }
}

/** 面板目标：选中蒙版时其局部参数，否则全局参数（曲线/色轮/取色器/滑块共用）。 */
export function targetAdj(): AdjustmentsLike {
  const i = state.maskSelected
  if (i !== null && state.adjustments.masks[i]) return state.adjustments.masks[i].adj
  return state.adjustments
}

export function addMask(kind: MaskKind): void {
  if (!state.loaded) return
  const m = defaultMask(kind, `${MASK_KIND_NAMES[kind]} ${state.adjustments.masks.length + 1}`)
  state.adjustments.masks.push(m)
  state.maskSelected = state.adjustments.masks.length - 1
  state.editMode = 'mask'
  notifyCommitted()
}

export function selectMask(index: number | null): void {
  // 再点一次已选中的蒙版 = 退出局部编辑（对照 LR 的 Done）
  if (index !== null && state.maskSelected === index) {
    exitMaskEdit()
    return
  }
  state.maskSelected = index
  if (index !== null) {
    state.editMode = 'mask'
    state.pickTarget = null
  } else if (state.editMode === 'mask') {
    state.editMode = null
  }
}

export function exitMaskEdit(): void {
  state.maskSelected = null
  if (state.editMode === 'mask') state.editMode = null
  state.status = ''
}

export function toggleMaskOverlay(): void {
  state.maskOverlay = !state.maskOverlay
}

export function deleteMask(index: number): void {
  const list = state.adjustments.masks
  if (index < 0 || index >= list.length) return
  list.splice(index, 1)
  if (state.maskSelected !== null) {
    if (state.maskSelected >= list.length) {
      state.maskSelected = list.length ? list.length - 1 : null
    }
    if (state.maskSelected === null) state.editMode = null
  }
  notifyCommitted()
}

/** 蒙版几何变化（视口拖动手柄/端点）：只需 preview；松手时 commit。 */
export function maskGeometryChanged(): void {
  notifyChanged()
}
export function maskGeometryCommitted(): void {
  notifyCommitted()
}

// ---- 线性渐变旋转 ----
/** 线性渐变角度（起点->终点方向，0°=水平向右，逆时针为正，0..360）。 */
export function linearMaskAngle(m: MaskState): number {
  const deg = -Math.atan2(m.y2 - m.y1, m.x2 - m.x1) * 180 / Math.PI
  return (deg + 360) % 360
}

/** 把线性渐变绕中线中心旋转到绝对角度（保持长度与中心；端点允许出画布）。 */
export function setLinearMaskAngle(index: number, deg: number): void {
  const m = state.adjustments.masks[index]
  if (!m || m.kind !== 'linear') return
  const cx = (m.x1 + m.x2) / 2, cy = (m.y1 + m.y2) / 2
  const half = Math.max(Math.hypot(m.x2 - m.x1, m.y2 - m.y1) / 2, 1e-3)
  const rad = -(deg % 360) * Math.PI / 180   // 视觉逆时针为正 -> 屏幕 y 向下取负
  m.x1 = cx - Math.cos(rad) * half
  m.y1 = cy - Math.sin(rad) * half
  m.x2 = cx + Math.cos(rad) * half
  m.y2 = cy + Math.sin(rad) * half
  notifyChanged()
}

/** 相对旋转（键盘 Q/E：±1°，Shift ±15°）。 */
export function rotateLinearMask(index: number, deltaDeg: number): void {
  const m = state.adjustments.masks[index]
  if (!m || m.kind !== 'linear') return
  setLinearMaskAngle(index, linearMaskAngle(m) + deltaDeg)
}

/** 画笔：笔画即几何，笔画结束提交全图。 */
export function brushStrokeCommitted(index: number): void {
  void index
  notifyCommitted()
}
export function undoBrushStroke(index: number): void {
  const m = state.adjustments.masks[index]
  if (m?.strokes.length) {
    m.strokes.pop()
    notifyCommitted()
  }
}
export function clearBrushStrokes(index: number): void {
  const m = state.adjustments.masks[index]
  if (m?.strokes.length) {
    m.strokes = []
    notifyCommitted()
  }
}

// ------------------------------------------------------------ 图章（服务端工作副本，对照旧 _on_clone_apply）
export function setStampSource(rect: RectNorm): void {
  state.stampSource = rect
  state.status = '已选源区域：在目标处拖出矩形覆盖'
}

export async function applyStampAt(dst: RectNorm): Promise<void> {
  if (!state.stampSource) {
    state.status = '请先按住 Alt 拖出源矩形'
    return
  }
  try {
    await api.applyStamp(state.stampSource, dst, state.stampFeather)
    state.serial++
    notifyCommitted()
  } catch (err) {
    state.status = `图章失败：${err instanceof Error ? err.message : err}`
  }
}

export async function stampUndo(): Promise<void> {
  try {
    await api.stampUndo()
    state.serial++
    notifyCommitted()
  } catch (err) {
    state.status = `撤销失败：${err instanceof Error ? err.message : err}`
  }
}

export async function stampClear(): Promise<void> {
  try {
    await api.stampClear()
    state.serial++
    state.stampSource = null
    notifyCommitted()
    state.status = '已清除全部图章修改'
  } catch (err) {
    state.status = `清除失败：${err instanceof Error ? err.message : err}`
  }
}

// ------------------------------------------------------------ 裁剪/旋转（服务端 crop_rotate 权威计算）
const ASPECT_MAP: Record<string, number | null> = {
  free: null, orig: 0, '1:1': 1, '3:2': 3 / 2, '4:3': 4 / 3, '16:9': 16 / 9,
}

export function enterCrop(): void {
  if (!state.loaded) return
  state.editMode = 'crop'
  state.cropRect = { x0: 0, y0: 0, x1: 1, y1: 1 }
  state.cropAngle = 0
  state.cropAspect = 'free'
  state.status = '拖动调整裁剪框；Enter 应用，Esc 取消'
}

export function cancelCrop(): void {
  if (state.editMode === 'crop') {
    state.editMode = null
    state.cropRect = null
    state.cropAngle = 0
    state.status = ''
  }
}

export async function applyCrop(): Promise<void> {
  if (state.editMode !== 'crop' || !state.cropRect || state.cropPending) return
  state.cropPending = true
  try {
    const r = await api.cropGeometry(
      [state.cropRect.x0, state.cropRect.y0, state.cropRect.x1, state.cropRect.y1],
      state.cropAngle, toRaw(state.adjustments.masks) as MaskState[])
    state.adjustments.masks = r.masks
    state.width = r.width
    state.height = r.height
    state.serial++
    state.editMode = null
    state.cropRect = null
    state.cropAngle = 0
    state.status = r.baked ? '已应用裁剪；图章修改已一并合并' : '已应用裁剪'
    notifyCommitted()
  } catch (err) {
    state.status = `裁剪失败：${err instanceof Error ? err.message : err}`
  } finally {
    state.cropPending = false
  }
}

export async function rotate90(clockwise: boolean): Promise<void> {
  if (!state.loaded) return
  try {
    const r = await api.rotateGeometry(clockwise,
      toRaw(state.adjustments.masks) as MaskState[])
    state.adjustments.masks = r.masks
    state.width = r.width
    state.height = r.height
    state.serial++
    notifyCommitted()
    state.status = clockwise ? '已右转 90°' : '已左转 90°'
  } catch (err) {
    state.status = `旋转失败：${err instanceof Error ? err.message : err}`
  }
}

/** 比例锁定换算（裁剪框拖动时由视口调用）：返回约束后的 rect。 */
export function constrainCropRect(
  rect: { x0: number; y0: number; x1: number; y1: number },
): { x0: number; y0: number; x1: number; y1: number } {
  const key = state.cropAspect.replace(':t', '')
  let ratio = ASPECT_MAP[key]
  if (ratio === undefined) ratio = null
  if (ratio === null) return rect
  const transposed = state.cropAspect.endsWith(':t')
  const w = state.width, h = state.height
  let target: number
  if (ratio === 0) {
    target = w / h                                  // 原始比例
  } else {
    target = ratio
  }
  if (transposed) target = 1 / target
  // 图像像素空间的比例（rect 为归一化坐标）
  const pixelW = (rect.x1 - rect.x0) * w
  const pixelH = (rect.y1 - rect.y0) * h
  const cur = pixelW / Math.max(pixelH, 1e-6)
  let nw = pixelW, nh = pixelH
  if (Math.abs(cur - target) > 1e-6) {
    if (cur > target) nw = nh * target
    else nh = nw / target
  }
  const cxN = (rect.x0 + rect.x1) / 2, cyN = (rect.y0 + rect.y1) / 2
  let x0 = cxN - nw / w / 2, x1 = cxN + nw / w / 2
  let y0 = cyN - nh / h / 2, y1 = cyN + nh / h / 2
  // 夹回 [0,1]
  if (x0 < 0) { x1 -= x0; x0 = 0 }
  if (y0 < 0) { y1 -= y0; y0 = 0 }
  if (x1 > 1) { x0 -= x1 - 1; x1 = 1 }
  if (y1 > 1) { y0 -= y1 - 1; y1 = 1 }
  return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(1, x1), y1: Math.min(1, y1) }
}

// ---- 导出状态 ----
export function useEditor() {
  return state
}

// 自动化测试/调试钩子（生产保留：体积可忽略，供 UI 端到端测试驱动打开文件）
declare global {
  interface Window {
    __photolab?: { openFile: typeof openFile; state: typeof state }
  }
}
window.__photolab = { openFile, state }
