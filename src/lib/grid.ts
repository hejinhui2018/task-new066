/**
 * 吸附与坐标换算 —— 全应用唯一的指针坐标边界。
 *
 * 坐标空间（只允许沿明确方向单向转换，禁止反复换算导致误差累积）：
 *   client（浏览器视口 CSS 像素，PointerEvent.clientX/Y）
 *     ── clientToLocal（减 getBoundingClientRect，自动包含页面滚动）
 *   local（画布元素内 CSS 像素；滚轮/缩放锚点都在此空间）
 *     ── localToWorld（除 scale、减 pan；DPR 不参与，浏览器指针事件本就是 CSS 像素）
 *   world（米；碰撞/净空/寻路/尺寸输入/渲染共享的唯一业务坐标）
 *
 * 设备像素比：只有当拿到的坐标本身是物理像素（如测试或非浏览器环境）时，
 * 才在边界处用 physicalToLocal 恰好除一次 dpr；正常 PointerEvent 一律走 clientToLocal。
 */
import type { Point } from '../types';
import { GRID_SIZE } from '../constants';

/** 画布视图：scale=每米 CSS 像素数；pan=世界原点在画布本地 CSS 像素中的位置。 */
export interface ViewTransform {
  scale: number;
  pan: Point;
}

/** 画布元素边框盒（getBoundingClientRect 的最小子集）；left/top 已含页面滚动。 */
export interface CanvasRect {
  left: number;
  top: number;
}

/** 将任意米坐标吸附到最近的 0.5 米网格点（四舍五入，避免浮点误差与 -0）。 */
export function snapToGrid(value: number, grid: number = GRID_SIZE): number {
  const v = Math.round(value / grid) * grid;
  return v === 0 ? 0 : v;
}

/* ---------------- 边界转换（每一步都是简单仿射，可精确往返） ---------------- */

/** client CSS 像素 → 画布本地 CSS 像素。rect 实时获取时滚动位置自动计入。 */
export function clientToLocal(
  clientX: number,
  clientY: number,
  rect: CanvasRect,
): Point {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/** 画布本地 CSS 像素 → 画布本地 client CSS 像素（逆变换）。 */
export function localToClient(
  localX: number,
  localY: number,
  rect: CanvasRect,
): Point {
  return { x: localX + rect.left, y: localY + rect.top };
}

/** 画布本地 CSS 像素 → 世界米坐标。 */
export function localToWorld(
  localX: number,
  localY: number,
  view: ViewTransform,
): Point {
  return {
    x: (localX - view.pan.x) / view.scale,
    y: (localY - view.pan.y) / view.scale,
  };
}

/** 世界米坐标 → 画布本地 CSS 像素（逆变换）。 */
export function worldToLocal(
  worldX: number,
  worldY: number,
  view: ViewTransform,
): Point {
  return {
    x: worldX * view.scale + view.pan.x,
    y: worldY * view.scale + view.pan.y,
  };
}

/**
 * 指针坐标进入世界的唯一入口：client → local → world，一次完成。
 * 缩放、滚动、旋转、DPR 变化都不会在这里累积任何误差。
 */
export function clientToWorld(
  clientX: number,
  clientY: number,
  rect: CanvasRect,
  view: ViewTransform,
): Point {
  const local = clientToLocal(clientX, clientY, rect);
  return localToWorld(local.x, local.y, view);
}

/** 世界坐标 → client 坐标（渲染命中点/测试断言用）。 */
export function worldToClient(
  worldX: number,
  worldY: number,
  rect: CanvasRect,
  view: ViewTransform,
): Point {
  const local = worldToLocal(worldX, worldY, view);
  return localToClient(local.x, local.y, rect);
}

/**
 * 物理（设备）像素坐标 → 画布本地 CSS 像素：dpr 只在这道边界除一次。
 * 用于坐标已是物理像素的环境（测试/非标准输入）；浏览器 PointerEvent 请用 clientToLocal。
 */
export function physicalToLocal(
  deviceX: number,
  deviceY: number,
  rect: CanvasRect,
  dpr: number,
): Point {
  const d = dpr > 0 ? dpr : 1;
  // rect 是 CSS 像素，先把物理坐标还原为 client CSS 像素再减偏移。
  return { x: deviceX / d - rect.left, y: deviceY / d - rect.top };
}

/** 物理像素坐标 → 世界米坐标（dpr 在边界处处理一次，之后全是世界坐标）。 */
export function physicalToWorld(
  deviceX: number,
  deviceY: number,
  rect: CanvasRect,
  dpr: number,
  view: ViewTransform,
): Point {
  const local = physicalToLocal(deviceX, deviceY, rect, dpr);
  return localToWorld(local.x, local.y, view);
}

/* ---------------- 兼容旧签名（内部全部走新边界实现） ---------------- */

/** 像素坐标 -> 展厅米坐标，考虑画布缩放与平移。 */
export function screenToWorld(
  px: number,
  py: number,
  scale: number,
  pan: Point,
): Point {
  return localToWorld(px, py, { scale, pan });
}

/** 展厅米坐标 -> 像素坐标。 */
export function worldToScreen(
  x: number,
  y: number,
  scale: number,
  pan: Point,
): Point {
  return worldToLocal(x, y, { scale, pan });
}

/** 像素位移 -> 米位移（仅受缩放影响，平移在做差时抵消）。 */
export function screenDeltaToWorld(
  dxPx: number,
  dyPx: number,
  scale: number,
): Point {
  return { x: dxPx / scale, y: dyPx / scale };
}

/* ---------------- 以光标为锚点的缩放（纯函数，多轮复合无误差） ---------------- */

export interface ZoomOptions {
  /** 绝对比例（像素/米）钳制，如缩放倍率上下限。 */
  clampScale?: (scale: number) => number;
  /** 平移钳制（如边界留白）；注意：钳制会有意地轻微移动锚点。 */
  clampPan?: (pan: Point, scale: number) => Point;
}

/**
 * 以画布本地锚点（通常是光标位置）为不动点计算新视图。
 *
 * 纯函数：结果只由 (anchor, view, factor) 决定。在不触发 pan 钳制时
 *   zoomAroundLocal(a, zoomAroundLocal(a, v, f1), f2) === zoomAroundLocal(a, v, f1·f2)
 * 即连续多轮滚轮缩放与一次缩放在代数上完全一致，不存在中间态累积误差；
 * 锚点下的世界点缩放前后在屏幕上位置不变。
 */
export function zoomAroundLocal(
  anchor: Point,
  view: ViewTransform,
  factor: number,
  opts: ZoomOptions = {},
): ViewTransform {
  const scale = opts.clampScale ? opts.clampScale(view.scale * factor) : view.scale * factor;
  const ratio = scale / view.scale;
  const rawPan: Point = {
    x: anchor.x - (anchor.x - view.pan.x) * ratio,
    y: anchor.y - (anchor.y - view.pan.y) * ratio,
  };
  return {
    scale,
    pan: opts.clampPan ? opts.clampPan(rawPan, scale) : rawPan,
  };
}

/** 以 client 坐标为锚点缩放（内部先做一次 client→local 边界转换）。 */
export function zoomAroundClient(
  clientX: number,
  clientY: number,
  rect: CanvasRect,
  view: ViewTransform,
  factor: number,
  opts: ZoomOptions = {},
): ViewTransform {
  return zoomAroundLocal(clientToLocal(clientX, clientY, rect), view, factor, opts);
}

/* ---------------- 吸附辅助 ---------------- */

/**
 * 拖拽时计算吸附后的展位左上角。
 * @param grabOffsetM 抓取点相对展位左上角的偏移（米，拖拽开始时锁定）
 */
export function snapDragPosition(
  pointerWorldX: number,
  pointerWorldY: number,
  grabOffsetM: Point,
  grid: number = GRID_SIZE,
): Point {
  return {
    x: snapToGrid(pointerWorldX - grabOffsetM.x, grid),
    y: snapToGrid(pointerWorldY - grabOffsetM.y, grid),
  };
}

/** 缩放手柄时计算吸附后的新尺寸（不小于一个网格）。 */
export function snapResize(
  sizeM: number,
  grid: number = GRID_SIZE,
  minSize: number = grid,
): number {
  return Math.max(minSize, snapToGrid(sizeM, grid));
}

/** 米 -> SVG 显示字符串（去掉 0.30000000000000004 之类的浮点尾巴）。 */
export function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}
