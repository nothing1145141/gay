/** 曲线 LUT：从 core.py 的 sanitize_points / _pchip_slopes / build_lut 移植。
 *  PCHIP（Fritsch-Carlson）单调保形三次插值，保证曲线不过冲、端点固定在 0/1。 */
import type { CurvePoints } from '@/api/types'

const MIN_POINT_GAP = 1 / 512

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 把任意控制点规整为：x 严格递增、y ∈ [0,1]、端点固定在 x=0 / x=1。 */
function sanitizePoints(points: CurvePoints): CurvePoints {
  const pts = points
    .map(([x, y]) => [Number(x), clamp(Number(y), 0, 1)] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const out: CurvePoints = []
  for (const [x, y] of pts) {
    if (out.length && x - out[out.length - 1][0] < MIN_POINT_GAP) continue // 丢弃水平过近的点
    out.push([x, y])
  }
  if (!out.length) return [[0, 0], [1, 1]]
  if (out.length === 1) return [[0, out[0][1]], [1, out[0][1]]]
  out[0] = [0, out[0][1]]
  out[out.length - 1] = [1, out[out.length - 1][1]]
  return out
}

/** Fritsch-Carlson 单调保形三次插值的节点导数。 */
function pchipSlopes(x: number[], y: number[]): number[] {
  const n = x.length
  const h: number[] = []
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) {
    h.push(x[i + 1] - x[i])
    d.push((y[i + 1] - y[i]) / h[i])
  }
  const m = new Array<number>(n).fill(0)
  if (n === 2) {
    m[0] = d[0]
    m[1] = d[0]
    return m
  }
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0 // 局部极值点导数置零 -> 保单调
    } else {
      const w1 = 2 * h[i] + h[i - 1]
      const w2 = h[i] + 2 * h[i - 1]
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    }
  }
  // 两端单侧三点估计 + 形状保护
  let dd = ((2 * h[0] + h[1]) * d[0] - h[0] * d[1]) / (h[0] + h[1])
  if (Math.sign(dd) !== Math.sign(d[0])) dd = 0
  else if (Math.sign(d[0]) !== Math.sign(d[1]) && Math.abs(dd) > 3 * Math.abs(d[0])) dd = 3 * d[0]
  m[0] = dd
  dd = ((2 * h[n - 2] + h[n - 3]) * d[n - 2] - h[n - 2] * d[n - 3]) / (h[n - 2] + h[n - 3])
  if (Math.sign(dd) !== Math.sign(d[n - 2])) dd = 0
  else if (Math.sign(d[n - 2]) !== Math.sign(d[n - 3]) && Math.abs(dd) > 3 * Math.abs(d[n - 2])) dd = 3 * d[n - 2]
  m[n - 1] = dd
  return m
}

/** 由控制点生成长度为 size 的 LUT（值域 [0,1]）。 */
export function buildLut(points: CurvePoints, size = 2048): Float32Array {
  const pts = sanitizePoints(points)
  const x = pts.map((p) => p[0])
  const y = pts.map((p) => p[1])
  const m = pchipSlopes(x, y)

  const out = new Float32Array(size)
  const last = x.length - 2
  for (let gi = 0; gi < size; gi++) {
    const grid = size > 1 ? gi / (size - 1) : 0
    let seg = 0
    while (seg < last && grid >= x[seg + 1]) seg++
    const h = x[seg + 1] - x[seg]
    const t = h > 0 ? (grid - x[seg]) / h : 0
    const t2 = t * t
    const t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    const v = h00 * y[seg] + h10 * h * m[seg] + h01 * y[seg + 1] + h11 * h * m[seg + 1]
    out[gi] = clamp(v, 0, 1)
  }
  return out
}
