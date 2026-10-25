/** REST + WebSocket 客户端。协议见 PhotoLab-Web化改造方案.md §4。
 *  - backend/token 来自页面 URL 参数（Electron 以 ?backend=http://127.0.0.1:PORT&token=xx 打开）；
 *    缺省 = 同源（开发模式走 vite 代理）。
 */
import type { Adjustments, AiMaskTarget, MaskState } from './types'

const qs = new URLSearchParams(location.search)
export const backendBase = (qs.get('backend') ?? '').replace(/\/+$/, '')
export const authToken = qs.get('token') ?? ''

function authUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return backendBase + path + (authToken ? `${sep}token=${encodeURIComponent(authToken)}` : '')
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(authUrl(path), init)
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch { /* 保留 statusText */ }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return req<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// ---- 数据类型 ----
export interface Meta { app: string; version: string; rawpy: boolean; gpu: boolean; width: number; height: number }
export interface HistData { master: number[]; red: number[]; green: number[]; blue: number[] }
export interface PickResult { r: number; g: number; b: number; hue: number }
export type RectNorm = [number, number, number, number]

/** 打开结果（单图入列并选中）。 */
export interface OpenResult {
  id: number; name: string; width: number; height: number; serial: number; library: number
}

export interface LibraryItem {
  id: number; name: string; width: number; height: number; serial: number; current: boolean
}

// ---- REST ----
export const getMeta = () => req<Meta>('/api/meta')
export const getDefaults = () => req<{ adjustments: Adjustments }>('/api/defaults')

export async function openUpload(file: File): Promise<OpenResult> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(authUrl('/api/open-upload'), { method: 'POST', body: fd })
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try { detail = (await res.json()).detail ?? detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  return res.json()
}

/** Electron 模式：传本地路径（含 RAW），入列并选中。 */
export const openPath = (path: string) => post<OpenResult>('/api/open', { path })

// ---- 多图图库 ----
export const getLibrary = () => req<{ images: LibraryItem[] }>('/api/library')
export const selectLibrary = (id: number) =>
  post<{ id: number; name: string; width: number; height: number; serial: number }>(
    '/api/library/select', { id })
export const removeLibrary = (id: number) =>
  post<{ images: LibraryItem[] }>('/api/library/remove', { id })
export const thumbUrl = (id: number, serial: number) => {
  const base = authUrl(`/api/library/${id}/thumb`)
  return base + (base.includes('?') ? '&' : '?') + `v=${serial}`
}
export const originalUrl = (id: number) => authUrl(`/api/library/${id}/original`)

/** Electron 模式：服务端渲染后直写磁盘（urgent 槽位）。 */
export const saveToPath = (path: string, adjustments: Adjustments) =>
  post<{ rid: number; saved: boolean; path: string }>('/api/save', { path, adjustments })

/** 浏览器模式：同步渲染整幅并触发下载。 */
export async function renderDownload(adjustments: Adjustments, format: string, filename: string): Promise<void> {
  const bytes = await renderBytes(adjustments, format)
  const url = URL.createObjectURL(new Blob([bytes]))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 渲染整幅并返回字节（Electron 原生保存与浏览器下载共用）。 */
export async function renderBytes(adjustments: Adjustments, format: string): Promise<ArrayBuffer> {
  const res = await fetch(authUrl('/api/render'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adjustments, format }),
  })
  if (!res.ok) {
    let detail = `${res.status}`
    try { detail = (await res.json()).detail ?? detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  return res.arrayBuffer()
}

// ---- Electron 原生桥（desktop/preload.cjs 注入；浏览器里不存在）----
export interface NativeBridge {
  openImageDialog: () => Promise<string[] | null>
  saveImageDialog: (defaultName: string) => Promise<string | null>
  writeFile: (filePath: string, bytes: Uint8Array) => Promise<boolean>
}

export const native: NativeBridge | null =
  (window as unknown as { photolabNative?: NativeBridge }).photolabNative ?? null

/** Electron：原生打开对话框（支持多选）→ 按路径逐张入列（支持 RAW）。 */
export async function openDesktop(): Promise<string[] | null> {
  if (!native) return null
  return native.openImageDialog()
}

/** Electron：原生保存对话框 → 渲染 → 落盘。返回保存路径（取消返回 null）。 */
export async function saveDesktop(adjustments: Adjustments, defaultName = 'photolab.png'): Promise<string | null> {
  if (!native) return null
  const path = await native.saveImageDialog(defaultName)
  if (!path) return null
  const ext = (path.split('.').pop() || 'png').toLowerCase()
  const format = ext === 'jpeg' ? 'jpg' : ext
  const bytes = await renderBytes(adjustments, format)
  await native.writeFile(path, new Uint8Array(bytes))
  return path
}

export const applyStamp = (src_rect: RectNorm, dst_rect: RectNorm, feather: number) =>
  post<{ serial: number }>('/api/stamp', { src_rect, dst_rect, feather })
export const stampUndo = () => post<{ serial: number }>('/api/stamp/undo', {})
export const stampClear = () => post<{ serial: number }>('/api/stamp/clear', {})

export const cropGeometry = (rect: RectNorm, angle: number, masks: MaskState[]) =>
  post<{ masks: MaskState[]; baked: boolean; width: number; height: number }>(
    '/api/geometry/crop', { rect, angle, masks })
export const rotateGeometry = (clockwise: boolean, masks: MaskState[]) =>
  post<{ masks: MaskState[]; width: number; height: number }>(
    '/api/geometry/rotate', { clockwise, masks })

export const pickAt = (x: number, y: number, patch = 5) =>
  post<PickResult>('/api/pick', { x, y, patch })

/** 前端「AI 设置」保存的 OpenAI 兼容端点配置（localStorage 持久化）。 */
export interface AiConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export const emptyAiConfig = (): AiConfig => ({ baseUrl: '', apiKey: '', model: '' })

export const aiConfigComplete = (c: AiConfig): boolean =>
  !!(c.baseUrl.trim() && c.apiKey.trim() && c.model.trim())

function aiConfigPayload(c: AiConfig): Record<string, string> {
  return { base_url: c.baseUrl.trim(), api_key: c.apiKey.trim(), model: c.model.trim() }
}

/** 测试端点连通性：GET {base}/models，返回可用模型 id 列表。 */
export const testAiConfig = (cfg: AiConfig) =>
  post<{ ok: boolean; models: string[] }>('/api/ai/test', { config: aiConfigPayload(cfg) })

/** AI 蒙版识别（vlm=大模型网格 / local=本地像素级 SAM2），返回掩码数据。 */
export interface AiMaskResult {
  target: string
  model: string
  // engine=vlm
  grid?: string[]; width?: number; height?: number
  // engine=local
  mask_png?: string
}
export const aiMask = (target: AiMaskTarget, cfg: AiConfig, engine: 'vlm' | 'local' = 'vlm') =>
  post<AiMaskResult>('/api/mask/ai', { target, engine, config: aiConfigPayload(cfg) })

// ---- 本地分割模型（SAM2 + U2Net 家族，ONNX）----
export interface LocalModelsStatus {
  runtime: boolean
  ready: boolean
  models: Record<string, { file: string; ready: boolean; size: number }>
}
export interface LocalModelsProgress extends LocalModelsStatus {
  running: boolean; done: boolean; error: string
  current: string; received: number; total: number
}
export const getLocalModels = () => req<LocalModelsStatus>('/api/ai/models')
export const downloadLocalModels = () => post<{ started: boolean; reason?: string }>('/api/ai/models/download', {})
export const localModelsProgress = () => req<LocalModelsProgress>('/api/ai/models/progress')

export const autoGrade = (mode: 'rule' | 'ai', cfg?: AiConfig) =>
  post<{ adjustments: Partial<Adjustments>; note: string; model: string }>(
    '/api/auto', { mode, config: cfg ? aiConfigPayload(cfg) : undefined })
export const fetchHistogram = () => req<HistData>('/api/histogram')

// ---- WebSocket 帧通道 ----
export interface ServerEvent {
  type: 'busy' | 'saved' | 'error'
  busy?: boolean
  rid?: number
  ok?: boolean
  path?: string
  error?: string
  message?: string
  kind?: string
}

export class RenderSocket {
  private ws: WebSocket | null = null
  private retry = 0
  private closed = false
  onFrame: ((rid: number, isFull: boolean, jpeg: ArrayBuffer) => void) | null = null
  onEvent: ((ev: ServerEvent) => void) | null = null
  onState: ((connected: boolean) => void) | null = null

  connect(): void {
    this.closed = false
    const base = (backendBase || location.origin).replace(/^http/, 'ws')
    const url = `${base}/ws${authToken ? `?token=${encodeURIComponent(authToken)}` : ''}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => { this.retry = 0; this.onState?.(true) }
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength <= 5) return
        const view = new DataView(ev.data)
        const rid = view.getUint32(0)
        const isFull = view.getUint8(4) === 1
        this.onFrame?.(rid, isFull, ev.data.slice(5))
      } else {
        try { this.onEvent?.(JSON.parse(ev.data as string)) } catch { /* 忽略坏消息 */ }
      }
    }
    ws.onclose = () => {
      this.ws = null
      this.onState?.(false)
      if (!this.closed && this.retry < 8) {
        setTimeout(() => this.connect(), 400 * 2 ** this.retry++)
      }
    }
    ws.onerror = () => ws.close()
  }

  sendRender(rid: number, kind: 'preview' | 'full', adjustments: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'render', rid, kind, adjustments }))
    }
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }
}
