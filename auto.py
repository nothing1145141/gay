"""PhotoLab 自动调色 + AI 蒙版：规则版 + AI 版。

- 「自动」：纯本地规则（灰世界白平衡 + 直方图自动色阶），瞬时、可预期；
- 「AI 调色」：把降采样图与统计数据发给视觉大模型，由它返回参数 JSON；
- 「AI 蒙版」：让视觉大模型按网格分割图像（主体/人物/背景/天空），
  返回 0/1 网格，由 core 渲染成软边蒙版。

端点为任意 OpenAI 兼容 chat/completions 服务，配置解析顺序：
    1. 前端「AI 设置」界面传入的 {base_url, api_key, model}
    2. 环境变量 PHOTOLAB_AI_BASE_URL / PHOTOLAB_AI_KEY / PHOTOLAB_AI_MODEL

两个版本都只产出参数/网格数据，渲染仍由 core 流水线完成，便于统一钳制与撤销。
"""
from __future__ import annotations

import base64
import json
import math
import os
import re
import urllib.request

import numpy as np

import core

# 应用到 Adjustments 的标量字段及其合法范围
_SCALAR_FIELDS = {
    "temperature": (-100.0, 100.0),
    "tint": (-100.0, 100.0),
    "exposure": (-5.0, 5.0),
    "contrast": (-100.0, 100.0),
    "highlights": (-100.0, 100.0),
    "shadows": (-100.0, 100.0),
    "whites": (-100.0, 100.0),
    "blacks": (-100.0, 100.0),
    "saturation": (-100.0, 100.0),
    "vibrance": (-100.0, 100.0),
    "blackwhite": (0.0, 100.0),
}


def _clamp(v, lo, hi) -> float:
    return float(max(lo, min(hi, float(v))))


def _finite(v) -> bool:
    """数值字段可用性：json.loads 会接受 NaN/Infinity 字面量，必须显式排除。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool) \
        and math.isfinite(float(v))


# ======================================================================
# 1. 规则版自动调色
# ======================================================================

def suggest_rule(rgb8: np.ndarray) -> dict:
    """直方图/灰世界启发式：只输出白平衡 + 影调 + 饱和度字段。

    全部保守取值并钳制，保证可预期；不碰曲线/蒙版/取色器。
    """
    small = core.downscale_max_edge(rgb8, 640)
    lin = core.rgb8_to_linear(small)
    lum = core.luminance(lin)
    srgb = core.to_srgb(lin)

    p05, p10, p50, p90, p995, p999 = np.percentile(
        lum, [0.5, 10, 50, 90, 99.5, 99.9])

    out: dict = {}

    # ---- 白平衡：灰世界（几何均值归一后反解 t/ti），只校正 70% ----
    s = srgb.reshape(-1, 3)
    mean_rgb = s.mean(axis=0)
    target = 1.0 / np.maximum(mean_rgb, 1e-4)
    tg = target / float(np.prod(target) ** (1.0 / 3.0))       # 几何均值归一
    k = 2.909 / max(float(tg[0] + tg[2] + 0.909 * tg[1]), 1e-4)
    ti = (1.0 - k * float(tg[1])) / 0.22            # t/ti ∈ [-1,1]，模型单位
    t = k * (float(tg[0]) - float(tg[2])) / 0.7
    out["temperature"] = _clamp(t * 70.0, -70, 70)  # ×100 转参数档位，再保留 70% 力度
    out["tint"] = _clamp(ti * 70.0, -70, 70)

    # ---- 曝光：线性中位数 -> 0.42 ----
    out["exposure"] = _clamp(np.log2(0.42 / max(float(p50), 1e-4)) * 0.8, -2.0, 2.0)

    # ---- 黑场/白场：雾感拉伸与高光保护 ----
    if p05 > 0.03:
        out["blacks"] = _clamp(-(p05 - 0.03) * 350, -35, 0)
    elif p05 < 0.008:
        out["blacks"] = _clamp((0.008 - p05) * 800, 0, 12)
    if p995 < 0.85:
        out["whites"] = _clamp((0.9 - p995) * 150, 0, 45)
    if p999 > 0.995:
        out["whites"] = min(out.get("whites", 0.0), -12.0)

    # ---- 高光/阴影：两端占比过大时回收/提亮 ----
    f_hi = float((lum > 0.95).mean())
    if f_hi > 0.10:
        out["highlights"] = _clamp(-(f_hi - 0.10) * 70, -40, 0)
    f_lo = float((lum < 0.05).mean())
    if f_lo > 0.30:
        out["shadows"] = _clamp((f_lo - 0.30) * 60, 0, 35)

    # ---- 对比度：p90-p10 分布过窄时拉开 ----
    spread = float(p90 - p10)
    if spread < 0.70:
        out["contrast"] = _clamp((0.70 - spread) * 60, 0, 30)

    # ---- 自然饱和度：平均彩度偏低时提升 ----
    mx = s.max(axis=1)
    mn = s.min(axis=1)
    chroma = float(((mx - mn) / (mx + mn + 1e-5)).mean())
    if chroma < 0.28:
        out["vibrance"] = _clamp((0.28 - chroma) * 120, 0, 30)

    return {k: round(v, 2) for k, v in out.items() if abs(v) > 0.4}


# ======================================================================
# 2. AI 端点配置 / 请求 / 解析
# ======================================================================

def resolve_config(cfg: dict | None = None) -> tuple | None:
    """返回 (baseUrl, apiKey, model)；未配置返回 None。

    优先级：前端「AI 设置」传入的字典 > 环境变量
    PHOTOLAB_AI_BASE_URL / PHOTOLAB_AI_KEY / PHOTOLAB_AI_MODEL。
    """
    c = cfg or {}
    base = str(c.get("base_url") or "").rstrip("/")
    key = str(c.get("api_key") or "")
    model = str(c.get("model") or "")
    if not (base and key and model):
        base = os.environ.get("PHOTOLAB_AI_BASE_URL", "").rstrip("/")
        key = os.environ.get("PHOTOLAB_AI_KEY", "")
        model = os.environ.get("PHOTOLAB_AI_MODEL", "")
    if base and key and model:
        return base, key, model
    return None


def resolve_candidates() -> list:
    """旧版 UI 兼容入口：环境变量配置的单一端点（可能为空列表）。"""
    cfg = resolve_config()
    return [cfg] if cfg else []


def fetch_models(base: str, key: str, timeout: int = 8) -> list:
    """GET {base}/models（OpenAI 兼容），返回模型 id 列表；失败抛异常。"""
    req = urllib.request.Request(
        base + "/models", headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return [m.get("id", "") for m in data.get("data", []) if m.get("id")]


def _chat(base: str, key: str, model: str, messages: list,
          timeout: int = 90, max_tokens: int = 2000,
          temperature: float = 0.3) -> str:
    """POST chat/completions，返回拼接后的文本内容。HTTP 错误带响应体消息。"""
    body = {"model": model, "messages": messages, "temperature": temperature,
            "max_tokens": max_tokens}
    req = urllib.request.Request(
        base + "/chat/completions", data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        detail = ""
        if hasattr(exc, "read"):                     # HTTPError 带响应体
            try:
                err = json.loads(exc.read().decode()).get("error", {})
                detail = err.get("message", "") if isinstance(err, dict) else str(err)
            except Exception:
                pass
        raise RuntimeError(f"{exc}{('：' + detail) if detail else ''}") from exc
    content = data["choices"][0]["message"]["content"]
    if isinstance(content, list):
        # 部分实现把 content 拆成多段（{"type": "text", "text": ...}）
        content = "".join(part.get("text", "")
                          for part in content if isinstance(part, dict))
    return str(content or "")


def _no_config_error() -> RuntimeError:
    return RuntimeError("未配置 AI 模型：请在顶栏「AI 设置」中填写 URL / API Key / "
                        "模型 ID（OpenAI 兼容接口 + 视觉模型）")


def _extract_json(text: str) -> dict:
    """从模型回复中稳健地取出 JSON 对象（容忍 markdown 围栏与前后缀）。"""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("回复中没有 JSON 对象")
    return json.loads(text[start:end + 1])


def sanitize_ai_params(data: dict) -> dict:
    """把模型返回的参数钳制到合法范围，丢弃非法/无效果的字段。"""
    if not isinstance(data, dict):
        return {}
    out: dict = {}
    for name, (lo, hi) in _SCALAR_FIELDS.items():
        if name in data and _finite(data[name]):
            v = _clamp(data[name], lo, hi)
            if abs(v) > 0.4:
                out[name] = round(v, 2)

    curves = data.get("curves")
    if isinstance(curves, dict):
        clean = {}
        for ch in core.CURVE_CHANNELS:
            pts = curves.get(ch)
            if not isinstance(pts, (list, tuple)) or len(pts) < 2:
                continue
            try:
                norm = [(float(x), float(y)) for x, y in pts[:6]]
                if not all(np.isfinite(x) and np.isfinite(y) for x, y in norm):
                    continue
                sp = core.sanitize_points(norm)
            except Exception:
                continue
            if [tuple(p) for p in sp] != core.default_curves()[ch]:
                clean[ch] = [tuple(p) for p in sp]
        if clean:
            out["curves"] = clean

    wheels = data.get("wheels")
    if isinstance(wheels, dict):
        clean = {}
        for name in core.GRADING_RANGES:
            w = wheels.get(name)
            if not isinstance(w, dict):
                continue
            raw = (w.get("hue", 0), w.get("saturation", 0), w.get("luminance", 0))
            if not all(_finite(v) for v in raw):     # NaN/Infinity 直接丢弃
                continue
            try:
                sat = _clamp(raw[1], -100, 100)
                lum_v = _clamp(raw[2], -100, 100)
                hue = float(raw[0]) % 360.0
            except Exception:
                continue
            if abs(sat) > 0.4 or abs(lum_v) > 0.4:
                clean[name] = {"hue": round(hue, 1), "saturation": round(sat, 1),
                               "luminance": round(lum_v, 1)}
        if clean:
            out["wheels"] = clean

    pickers = data.get("pickers")
    if isinstance(pickers, list):
        clean = []
        for p in pickers[:4]:
            if not isinstance(p, dict):
                continue
            raw = (p.get("hue", 0), p.get("span", 30), p.get("hue_shift", 0),
                   p.get("saturation", 0), p.get("luminance", 0))
            if not all(_finite(v) for v in raw):     # NaN/Infinity 直接丢弃
                continue
            try:
                hue = float(raw[0]) % 360.0
                span = _clamp(raw[1], 5, 180)
                shift = _clamp(raw[2], -60, 60)
                sat = _clamp(raw[3], -100, 100)
                lum_v = _clamp(raw[4], -100, 100)
            except Exception:
                continue
            if abs(shift) > 0.4 or abs(sat) > 0.4 or abs(lum_v) > 0.4:
                clean.append({"hue": round(hue, 1), "span": round(span, 1),
                              "hue_shift": round(shift, 1), "saturation": round(sat, 1),
                              "luminance": round(lum_v, 1)})
        if clean:
            out["pickers"] = clean
    return out


def _stats_text(rgb8: np.ndarray) -> str:
    """给模型的测量数据：让数字说话，弥补视觉估计不精的问题。"""
    small = core.downscale_max_edge(rgb8, 640)
    lin = core.rgb8_to_linear(small)
    lum = core.luminance(lin)
    p = np.percentile(lum, [1, 25, 50, 75, 99])
    s = core.to_srgb(lin).reshape(-1, 3)
    mean_rgb = s.mean(axis=0)
    mx = s.max(axis=1)
    mn = s.min(axis=1)
    chroma = float(((mx - mn) / (mx + mn + 1e-5)).mean())
    return (f"线性亮度分位数 p1={p[0]:.3f} p25={p[1]:.3f} p50={p[2]:.3f} "
            f"p75={p[3]:.3f} p99={p[4]:.3f}；"
            f"sRGB 通道均值 R={mean_rgb[0]:.3f} G={mean_rgb[1]:.3f} B={mean_rgb[2]:.3f}；"
            f"平均彩度={chroma:.3f}")


def _build_messages(rgb8: np.ndarray) -> list:
    small = core.downscale_max_edge(rgb8, 1024)
    ok, buf = _encode_jpeg(small)
    data_url = "data:image/jpeg;base64," + base64.b64encode(buf).decode()
    prompt = (
        "你是专业照片调色师。根据图像与统计数据，输出 JSON 调整参数。\n\n"
        "可用字段（全部可选，省略=0/不变）：\n"
        '- 标量: temperature/tint (-100..100)，exposure (-5..5 EV)，'
        "contrast/highlights/shadows/whites/blacks/saturation/vibrance (-100..100)，"
        "blackwhite (0..100，仅当图像确实适合黑白)\n"
        '- "curves": {"master"|"red"|"green"|"blue": [[x,y],...]}，每通道 2~5 个控制点，'
        "x∈[0,1] 严格递增、y∈[0,1]，首点 x=0、末点 x=1\n"
        '- "wheels": {"shadows"|"midtones"|"highlights"|"global": '
        '{"hue":0..360,"saturation":-100..100,"luminance":-100..100}}\n'
        '- "pickers": [{"hue":0..360,"span":5..180,"hue_shift":-60..60,'
        '"saturation":-100..100,"luminance":-100..100}]，最多 4 个，'
        "用于对特定色相做局部调整\n"
        '- "note": 一句话说明调色思路（中文）\n\n'
        "原则：白平衡校正偏色但保留日落/灯光等有意的暖调；曝光使中位数亮度约 0.42"
        "（线性）；整体自然耐看、不过度，宁可保守；只输出 JSON，不要 markdown。\n\n"
        + _stats_text(rgb8)
    )
    return [{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": data_url}},
    ]}]


def _encode_jpeg(rgb8: np.ndarray, quality: int = 88):
    import cv2
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb8, cv2.COLOR_RGB2BGR),
                           [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG 编码失败")
    return ok, buf.tobytes()


def suggest_ai(rgb8: np.ndarray, config: dict | None = None,
               timeout: int = 90) -> tuple:
    """AI 自动调色：返回 (参数字典, 说明, 使用的模型描述)。

    config 为前端「AI 设置」传入的 {base_url, api_key, model}，缺省回退
    环境变量；两者都没有时抛 RuntimeError。
    """
    cfg = resolve_config(config)
    if cfg is None:
        raise _no_config_error()
    base, key, model = cfg
    messages = _build_messages(rgb8)
    try:
        text = _chat(base, key, model, messages, timeout=timeout)
        raw = _extract_json(text)
    except ValueError as exc:
        raise RuntimeError(f"{model}: {exc}") from exc
    note = str(raw.get("note", "")).strip()[:100]
    params = sanitize_ai_params(raw)
    if not params:
        raise RuntimeError(f"{model}: 返回参数为空")
    return params, note, f"{model}@{base}"


# ======================================================================
# 3. AI 蒙版：视觉大模型网格分割（主体 / 人物 / 背景 / 天空）
# ======================================================================

# 目标 -> (中文名, 提示词中的定义)
AI_MASK_TARGETS = {
    "subject": ("主体", "画面中最主要、最突出的拍摄主体（人物、动物、车辆、"
                        "建筑、静物等），即摄影师想突出表现的对象；不包括背景环境"),
    "person": ("人物", "所有出现的人物（脸部与身体，含多人、远景人物）；"
                       "画面中没有任何人时全部填 '0'"),
    "background": ("背景", "拍摄主体之外的背景环境（地面、墙面、植物、"
                           "远处景物等一切非主体内容），与主体互补"),
    "sky": ("天空", "天空区域（蓝天、白云、晚霞、星空等可见天空）；"
                    "没有天空（室内/特写）时全部填 '0'"),
}

# 分辨率取舍：网格越细边界越准，但视觉模型在过细网格上错误率上升。
# 96 为实测折中（4:3 横幅约 96×72），配合连通域清理与羽化后边界平滑；
# 32~48 的粗网格在细目标（人物四肢、树枝间天空）上锯齿明显。
_GRID_LONG_EDGE = 96


def _seg_grid_dims(rgb8: np.ndarray, long_edge: int = _GRID_LONG_EDGE) -> tuple:
    """按图像宽高比规划网格 (gw, gh)，长边固定、格子接近正方形。"""
    h, w = rgb8.shape[:2]
    if w >= h:
        gw, gh = long_edge, max(4, round(h / w * long_edge))
    else:
        gw, gh = max(4, round(w / h * long_edge)), long_edge
    return gw, gh


def _cell01(x) -> str:
    """列表行里的单元格 -> '0'/'1'（数字、布尔、"1"/"0" 字符串均可；坏值为 0）。"""
    try:
        return "1" if float(x) >= 0.5 else "0"
    except (TypeError, ValueError):
        return "0"


def _parse_grid(raw, gw: int, gh: int) -> list:
    """从模型回复中稳健解析 0/1 网格 -> ['0101...', ...] 共 gh 行、每行 gw 字符。

    容忍：markdown 围栏（调用方已剥）、行内空格/逗号、数字列表、行数/列数
    轻微不齐（截断补 0）。行数不足一半视为失败。
    """
    rows = None
    if isinstance(raw, dict):
        for k in ("rows", "grid", "mask"):
            v = raw.get(k)
            if isinstance(v, list) and v:
                rows = v
                break
    elif isinstance(raw, list) and raw:
        rows = raw
    if not rows:
        raise ValueError("回复中没有网格数据")
    clean = []
    for r in rows:
        if isinstance(r, (list, tuple)):         # 容忍 0/1 数字（或 "0"/"1"）列表
            r = "".join(_cell01(x) for x in r)
        if not isinstance(r, str):
            continue
        s = "".join(ch for ch in r if ch in "01")
        if s:
            clean.append(s)
    if len(clean) < max(2, gh // 2):
        raise ValueError(f"网格行数不足（收到 {len(clean)} 行，需要 {gh}）")
    out = [r[:gw].ljust(gw, "0") for r in clean[:gh]]
    while len(out) < gh:
        out.append("0" * gw)
    return out


_GRID_MIN_AREA = 3      # 面积小于此值的碎片/小孔直接清理（网格通常 48×36，1~2 格视为噪声）


def _cleanup_grid(rows: list) -> list:
    """网格级清理：去小连通域（碎点）+ 填不贴边的小孔。

    用连通域而非形态学：开/闭运算的边框语义在图像边缘不一致（cv2 腐蚀默认
    边框按极大值填充，贴边的孤立点删不掉；置 0 又会啃掉贴边的正常区域，
    而天空/背景蒙版必然贴边）。连通域过滤对任意位置行为一致。
    """
    import cv2
    arr = core.grid_to_array(rows, len(rows[0]) if rows else 0, len(rows))
    if arr.size == 0 or float(arr.max()) == 0.0:
        return core.array_to_grid(arr)
    u8 = (arr >= 0.5).astype(np.uint8)
    h, w = u8.shape
    # 1) 去小连通域（孤点/碎块）
    n, lab, stats, _ = cv2.connectedComponentsWithStats(u8, connectivity=8)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < _GRID_MIN_AREA:
            u8[lab == i] = 0
    # 2) 填不贴边的小孔（背景连通域面积小且不接触图像边缘 -> 视为孔洞）
    inv = (u8 == 0).astype(np.uint8)
    n2, lab2, stats2, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    for i in range(1, n2):
        x, y, cw, ch, area = (int(stats2[i, j]) for j in range(5))
        touches = x == 0 or y == 0 or x + cw >= w or y + ch >= h
        if area < _GRID_MIN_AREA and not touches:
            u8[lab2 == i] = 1
    return core.array_to_grid(u8.astype(np.float32))


def _build_seg_messages(rgb8: np.ndarray, target: str, gw: int, gh: int) -> list:
    if target not in AI_MASK_TARGETS:
        raise ValueError(f"未知的 AI 蒙版目标：{target}")
    label, define = AI_MASK_TARGETS[target]
    small = core.downscale_max_edge(rgb8, 768)
    ok, buf = _encode_jpeg(small)
    data_url = "data:image/jpeg;base64," + base64.b64encode(buf).decode()
    prompt = (
        "你是图像分割助手。任务：把图像划分为 "
        f"{gw} 列 × {gh} 行 的网格，逐格判断其中心是否属于【{label}】。\n"
        f"目标定义：{define}。\n\n"
        "做法：先通读全图、确定目标的整体范围；再从第一行到最后一行、每行从左到右"
        "逐格判断。边界格按格子中心点是否落在目标内判断；不要整行照抄上一行，"
        "也不要跳行。\n\n"
        "只输出 JSON（不要 markdown、不要解释）：\n"
        '{"rows": ["..", "..", ...]}\n'
        f"rows 共 {gh} 个字符串，每个长度恰好 {gw}，仅含字符 '0' 或 '1'："
        "'1' = 该格属于目标，'0' = 不属于。\n"
        "画面中没有目标时输出全 '0'。"
    )
    return [{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": data_url}},
    ]}]


def segment_ai(rgb8: np.ndarray, target: str, config: dict | None = None,
               timeout: int = 180) -> dict:
    """AI 网格分割：返回 {target, grid, width, height, model}。

    grid 是 ['0101...', ...]（每行 width 个字符、共 height 行），交给
    MaskState(kind='ai') 后由 core 渲染成软边蒙版。
    画面中未识别到目标时抛 ValueError（区别于网络/模型错误的 RuntimeError）。
    """
    cfg = resolve_config(config)
    if cfg is None:
        raise _no_config_error()
    base, key, model = cfg
    gw, gh = _seg_grid_dims(rgb8)
    messages = _build_seg_messages(rgb8, target, gw, gh)
    # 网格本身即输出预算：96×72 ≈ 7k 字符，再留 JSON 结构与说明余量
    max_tokens = min(16000, gw * gh * 2 + 1024)
    try:
        text = _chat(base, key, model, messages, timeout=timeout,
                     max_tokens=max_tokens, temperature=0.1)
        raw = _extract_json(text)
        rows = _parse_grid(raw, gw, gh)
    except ValueError as exc:
        raise RuntimeError(f"{model}: {exc}") from exc
    rows = _cleanup_grid(rows)
    label = AI_MASK_TARGETS[target][0]
    if core.grid_to_array(rows, gw, gh).max() < 0.5:
        raise ValueError(f"画面中未识别到「{label}」")
    return {"target": target, "grid": rows, "width": gw, "height": gh,
            "model": f"{model}@{base}"}
