/** 预设与展示色：从 core.py / legacy ui_widgets 移植（曲线通道色/标签、影调范围标签、
 *  取色器预设色相、色相→RGB）。 */
import type { CurveChannel, GradingRange } from '@/api/types'

export const CURVE_CHANNEL_LABELS: Record<CurveChannel, string> = {
  master: 'RGB',
  red: '红',
  green: '绿',
  blue: '蓝',
}

export const CURVE_CHANNEL_COLORS: Record<CurveChannel, string> = {
  master: '#e1e1e8',
  red: '#e25c5c',
  green: '#60c878',
  blue: '#6092ff',
}

export const RANGE_LABELS: Record<GradingRange, string> = {
  shadows: '阴影',
  midtones: '中间调',
  highlights: '高光',
  global: '全局',
}

/** 取色器预设色相：名称 + 色相（度）。 */
export const HS_PRESETS: { name: string; hue: number }[] = [
  { name: '红', hue: 0 },
  { name: '橙', hue: 30 },
  { name: '黄', hue: 60 },
  { name: '绿', hue: 120 },
  { name: '青', hue: 180 },
  { name: '蓝', hue: 240 },
  { name: '紫', hue: 280 },
  { name: '洋红', hue: 300 },
]

/** 色相 → RGB（0..1），用于面板色块。等价 core.preset_color(hue, sat=0.85, val=0.95)。 */
export function presetColor(hue: number, sat = 0.85, val = 0.95): [number, number, number] {
  return hsvToRgb((((hue % 360) + 360) % 360) / 360, sat, val)
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0: return [v, t, p]
    case 1: return [q, v, p]
    case 2: return [p, v, t]
    case 3: return [p, q, v]
    case 4: return [t, p, v]
    default: return [v, p, q]
  }
}
