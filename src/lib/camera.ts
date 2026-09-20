/**
 * 画布视口（相机）：屏幕 CSS 像素 ↔ 展厅世界坐标（米）的唯一换算边界。
 *
 * 不变量：
 * - 世界坐标（米）是唯一的业务坐标：展位数据、碰撞、净空、寻路、尺寸输入全部使用它。
 * - 指针坐标只在 client（视口像素）→ local（画布内 CSS 像素）→ world（米）这一条
 *   路径上转换一次；缩放、平移、旋转、设备像素比（DPR）都不会被重复叠加，因而不会累积误差。
 * - 一切数值均以 CSS 像素为准：getBoundingClientRect()/clientX/clientY 本身就是 CSS 像素，
 *   devicePixelRatio 只影响光栅化（由浏览器处理），绝不参与这里的任何计算。
 *
 * 纯函数，无 React/DOM 依赖（rect 作为参数传入），交互层与测试共用同一实现。
 */
import type { Point } from '../types';
import { HALL_HEIGHT, HALL_WIDTH } from '../constants';

export interface Viewport {
  /** 每米对应的 CSS 像素数（fit 基准的 100% 即 baseScale）。 */
  scale: number;
  /** 世界原点 (0,0) 在画布元素内的 CSS 像素位置。 */
  pan: Point;
}

export interface Size {
  w: number;
  h: number;
}

/** 视口相对 fit 基准的缩放倍率上下限。 */
export const ZOOM_RATIO_MIN = 0.3;
export const ZOOM_RATIO_MAX = 6;

/** fit 时四周预留的边距（CSS 像素）。 */
const FIT_PAD_X = 90;
const FIT_PAD_Y = 110;
const FIT_OFFSET_Y = 6;

/** 拖动时允许展位越过展厅边界的余量（米，用于演示越界告警）。 */
export const DRAG_OVERFLOW = 4;

/* ------------------------------------------------------------------ */
/* 唯一的坐标边界转换                                                   */
/* ------------------------------------------------------------------ */

/**
 * client 视口坐标 → 画布内 local CSS 像素。
 * 这是“明确边界”：getBoundingClientRect 给出画布左上在视口中的 CSS 像素位置，
 * 与 DPR 无关；返回值可直接喂给 localToWorld。
 */
export function clientToLocal(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
): Point {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/** local CSS 像素 → 世界米坐标。 */
export function localToWorld(local: Point, vp: Viewport): Point {
  return {
    x: (local.x - vp.pan.x) / vp.scale,
    y: (local.y - vp.pan.y) / vp.scale,
  };
}

/** 世界米坐标 → local CSS 像素。 */
export function worldToLocal(world: Point, vp: Viewport): Point {
  return {
    x: world.x * vp.scale + vp.pan.x,
    y: world.y * vp.scale + vp.pan.y,
  };
}
/**
 * 指针事件 → 世界米坐标。交互代码应只调用这一个函数，避免多处手工相减/相除
 * 而在缩放或平移后引入不一致。
 */
export function clientToWorld(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  vp: Viewport,
): Point {
  return localToWorld(clientToLocal(clientX, clientY, rect), vp);
}

/* ------------------------------------------------------------------ */
/* 缩放 / 平移 / 适应窗口                                               */
/* ------------------------------------------------------------------ */

/** 把绝对比例（像素/米）钳制在允许的倍率区间内。 */
export function clampScale(scale: number, baseScale: number): number {
  return Math.max(
    baseScale * ZOOM_RATIO_MIN,
    Math.min(baseScale * ZOOM_RATIO_MAX, scale),
  );
}

/**
 * 以某个 local 锚点（通常是光标）为中心缩放。
 *
 * 关键：先把比例钳制到 nextScale，令 r = nextScale / scale，
 * 再令 pan' = anchor - (anchor - pan) * r。该恒等式保证锚点正下方的世界点
 * 在缩放前后屏幕位置不变；缩放以乘法因子一次性作用，不与旧缩放叠加，
 * 因此连续多轮滚轮/按钮缩放不会产生漂移。
 */
export function zoomAt(
  vp: Viewport,
  factor: number,
  anchor: Point,
  baseScale: number,
  canvasSize: Size,
): Viewport {
  const scale = clampScale(vp.scale * factor, baseScale);
  const ratio = scale / vp.scale;
  const pan = clampPan(
    {
      x: anchor.x - (anchor.x - vp.pan.x) * ratio,
      y: anchor.y - (anchor.y - vp.pan.y) * ratio,
    },
    scale,
    canvasSize,
  );
  return { scale, pan };
}

/** 以画布中心为锚点缩放（工具栏 ＋/－ 按钮）。 */
export function zoomCentered(
  vp: Viewport,
  factor: number,
  baseScale: number,
  canvasSize: Size,
): Viewport {
  return zoomAt(
    vp,
    factor,
    { x: canvasSize.w / 2, y: canvasSize.h / 2 },
    baseScale,
    canvasSize,
  );
}

/**
 * 计算“适应窗口”的基准比例（100%）与居中平移。
 * 同时也是 ResizeObserver 首次挂载时的初始视口。
 */
export function fitViewport(canvasSize: Size): { baseScale: number } & Viewport {
  const scale = Math.min(
    (canvasSize.w - FIT_PAD_X) / HALL_WIDTH,
    (canvasSize.h - FIT_PAD_Y) / HALL_HEIGHT,
  );
  const pan = {
    x: (canvasSize.w - HALL_WIDTH * scale) / 2,
    y: (canvasSize.h - HALL_HEIGHT * scale) / 2 - FIT_OFFSET_Y,
  };
  return { baseScale: scale, scale, pan };
}

/** 平移量钳制：让展厅始终在画布边缘附近保留一条可见带。 */
export function clampPan(pan: Point, scale: number, canvasSize: Size): Point {
  const cw = canvasSize.w;
  const ch = canvasSize.h;
  const ws = HALL_WIDTH * scale;
  const hs = HALL_HEIGHT * scale;
  const minX = Math.min(24, cw - ws - 24);
  const maxX = Math.max(cw - 24, 24);
  const minY = Math.min(24, ch - hs - 24);
  const maxY = Math.max(ch - 24, 24);
  return {
    x: Math.min(maxX, Math.max(minX, pan.x)),
    y: Math.min(maxY, Math.max(minY, pan.y)),
  };
}

/* ------------------------------------------------------------------ */
/* 拖动边界（与交互层共享，保证落点与告警/渲染使用同一世界坐标）          */
/* ------------------------------------------------------------------ */

/**
 * 拖动展位时对左上角世界坐标的钳制：允许越过展厅边界 DRAG_OVERFLOW 米
 * （以演示越界告警），同时保留可见部分。minSize 为展位最小尺寸。
 */
export function clampDragPosition(
  x: number,
  y: number,
  minSize: number,
): Point {
  return {
    x: Math.min(HALL_WIDTH - minSize, Math.max(-DRAG_OVERFLOW, x)),
    y: Math.min(HALL_HEIGHT - minSize, Math.max(-DRAG_OVERFLOW, y)),
  };
}

/** 当前相对基准的百分比（用于 UI 显示）。 */
export function zoomRatio(vp: Viewport, baseScale: number): number {
  return vp.scale / baseScale;
}
