/**
 * 画布指针交互控制器（与 React/DOM 事件解耦，便于单测）。
 *
 * 设计约定（对应坐标统一性要求）：
 * - 指针坐标只在 move/down 处经 clientToWorld 转换一次，得到世界米坐标后不再回算；
 *   rect 每次实时读取（容器滚动 / 页面滚动不产生误差），view 经 getView() 实时读取。
 * - 拖拽抓取偏移 grab 以“世界米坐标”在会话开始时锁定一次；缩放/旋转/DPR 变化后
 *   旧会话一律 interrupt() 安全结束，绝不带着失效的中间量继续换算。
 * - 会话状态保存在控制器内部（事实源），React 只镜像一个只读版本用于光标样式。
 * - 丢失 pointer capture（lostpointercapture / pointercancel）时按最近一次有效世界
 *   位置提交结束：画展位停在哪、历史就落在哪，撤销可回原网格位置。
 */
import type { Booth, Point } from '../types';
import { GRID_SIZE, HALL_HEIGHT, HALL_WIDTH } from '../constants';
import { clientToWorld, snapResize, snapToGrid } from './grid';
import type { ViewTransform } from './grid';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type SessionKind = 'drag' | 'resize' | 'pan';

export interface ResizeStart {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 最小展位尺寸（米），与吸附网格一致。 */
export const MIN_SIZE = GRID_SIZE;
/** 拖出展厅演示“越界”时允许的最小上/左坐标。 */
export const DRAG_MIN_COORD = -4;

/** 结束原因，供上层决定是否提交/提示。 */
export type EndReason = 'pointerup' | 'cancel' | 'interrupted';

export interface InteractionHandlers {
  /** 画布元素边框盒（建议每次调用实时 getBoundingClientRect，滚动自动计入）。 */
  getRect(): { left: number; top: number };
  /** 当前视图（缩放/平移）实时值，必须来自 ref，不能是渲染期快照。 */
  getView(): ViewTransform;
  /** 拖动移动：world 为指针世界坐标；grab 为会话开始锁定的抓取偏移（米）。 */
  onDrag(boothId: string, world: Point, grab: Point): void;
  /** 手柄缩放移动。 */
  onResize(
    boothId: string,
    handle: HandleId,
    start: ResizeStart,
    world: Point,
  ): void;
  /** 画布平移（像素）。 */
  onPan(pan: Point): void;
  /** drag/resize 安全结束：把当前 live 状态固化为一条历史（无变化时由状态层去重）。 */
  onCommit(reason: EndReason): void;
  /** pan 结束：moved 表示是否超过点击阈值（用于区分“点空白取消选中”与平移）。 */
  onPanEnd(moved: boolean): void;
}

interface DragSession {
  kind: 'drag';
  pointerId: number;
  boothId: string;
  grab: Point;
  moved: boolean;
}
interface ResizeSession {
  kind: 'resize';
  pointerId: number;
  boothId: string;
  handle: HandleId;
  start: ResizeStart;
  moved: boolean;
}
interface PanSession {
  kind: 'pan';
  pointerId: number;
  startClient: Point;
  startPan: Point;
  moved: boolean;
}
type Session = DragSession | ResizeSession | PanSession;

/** pan 位移超过该像素阈值才视为平移而非点击。 */
const PAN_THRESHOLD_PX = 3;

export class CanvasInteraction {
  private session: Session | null = null;

  constructor(private readonly handlers: InteractionHandlers) {}

  get active(): boolean {
    return this.session !== null;
  }

  get kind(): SessionKind | null {
    return this.session?.kind ?? null;
  }

  get pointerId(): number | null {
    return this.session?.pointerId ?? null;
  }

  /**
   * 开始拖动展位。
   * @param grabWorld 可选，直接给抓取偏移（测试/特殊输入）；默认由当前指针世界坐标与展位左上计算。
   */
  startDrag(
    pointerId: number,
    clientX: number,
    clientY: number,
    booth: Booth,
    grabWorld?: Point,
  ): void {
    this.interrupt('interrupted');
    const world = this.toWorld(clientX, clientY);
    const grab =
      grabWorld ?? { x: world.x - booth.x, y: world.y - booth.y };
    this.session = {
      kind: 'drag',
      pointerId,
      boothId: booth.id,
      grab,
      moved: false,
    };
  }

  startResize(
    pointerId: number,
    _clientX: number,
    _clientY: number,
    booth: Booth,
    handle: HandleId,
  ): void {
    this.interrupt('interrupted');
    this.session = {
      kind: 'resize',
      pointerId,
      boothId: booth.id,
      handle,
      start: { x: booth.x, y: booth.y, w: booth.w, h: booth.h },
      moved: false,
    };
  }

  startPan(
    pointerId: number,
    clientX: number,
    clientY: number,
    startPan: Point,
  ): void {
    this.interrupt('interrupted');
    this.session = {
      kind: 'pan',
      pointerId,
      startClient: { x: clientX, y: clientY },
      startPan,
      moved: false,
    };
  }

  /** 指针移动；不属于本会话指针（多指情况）的事件被忽略。 */
  move(pointerId: number, clientX: number, clientY: number): void {
    const s = this.session;
    if (!s || s.pointerId !== pointerId) return;

    if (s.kind === 'pan') {
      const dx = clientX - s.startClient.x;
      const dy = clientY - s.startClient.y;
      if (Math.abs(dx) + Math.abs(dy) > PAN_THRESHOLD_PX) s.moved = true;
      this.handlers.onPan({ x: s.startPan.x + dx, y: s.startPan.y + dy });
      return;
    }

    // 关键：每次都以“当前 rect + 当前 view”做唯一一次边界转换，
    // 缩放/滚动/DPR 均不在多帧之间累积。
    const world = this.toWorld(clientX, clientY);
    s.moved = true;
    if (s.kind === 'drag') {
      this.handlers.onDrag(s.boothId, world, s.grab);
    } else {
      this.handlers.onResize(s.boothId, s.handle, s.start, world);
    }
  }

  /** 正常松手：drag/resize 提交，pan 回报 moved。 */
  end(pointerId: number): void {
    const s = this.session;
    if (!s || s.pointerId !== pointerId) return;
    this.finish(s, 'pointerup');
  }

  /**
   * 指针被浏览器取消（pointercancel）：按最近一次有效位置安全提交，
   * 而不是把展位留在“live 但无历史”的悬空状态。
   */
  cancel(pointerId: number): void {
    const s = this.session;
    if (!s || s.pointerId !== pointerId) return;
    this.finish(s, 'cancel');
  }

  /**
   * capture 丢失：后续指针事件不再派发给原元素，手势事实上已经结束。
   * 与 cancel 同样处理：固化当前位置为一条历史。
   */
  captureLost(pointerId: number): void {
    const s = this.session;
    if (!s || s.pointerId !== pointerId) return;
    this.finish(s, 'cancel');
  }

  /**
   * 外部状态即将变化（拖动中滚轮/按钮缩放、适应窗口、旋转、撤销重做、删除、
   * 方向键等）：旧会话依赖的 view 或 booth 几何马上失效，先安全结束它。
   * 无会话时为空操作。
   */
  interrupt(reason: EndReason = 'interrupted'): void {
    const s = this.session;
    if (!s) return;
    this.finish(s, reason);
  }

  private finish(s: Session, reason: EndReason): void {
    this.session = null;
    if (s.kind === 'pan') {
      this.handlers.onPanEnd(s.moved);
    } else {
      this.handlers.onCommit(reason);
    }
  }

  /** 唯一的 client→world 边界。 */
  private toWorld(clientX: number, clientY: number): Point {
    return clientToWorld(
      clientX,
      clientY,
      this.handlers.getRect(),
      this.handlers.getView(),
    );
  }
}

/* ---------------- 纯几何辅助（与控制器共享同一组世界坐标） ---------------- */

/**
 * 拖动中的展位左上角：指针世界坐标扣除抓取偏移 → 吸附 0.5 m → 钳制在
 * “略可越界演示告警、但保留在展厅附近可见”的范围内。
 * 输入输出全是世界米坐标，碰撞/净空/寻路直接消费结果。
 */
export function dragBoothPosition(world: Point, grab: Point): Point {
  return {
    x: Math.min(
      HALL_WIDTH - MIN_SIZE,
      Math.max(DRAG_MIN_COORD, snapToGrid(world.x - grab.x)),
    ),
    y: Math.min(
      HALL_HEIGHT - MIN_SIZE,
      Math.max(DRAG_MIN_COORD, snapToGrid(world.y - grab.y)),
    ),
  };
}

/** 八手柄缩放：由会话开始时的几何与当前指针世界坐标求吸附后的新矩形。 */
export function applyResizeHandle(
  start: ResizeStart,
  handle: HandleId,
  world: Point,
): Partial<Pick<Booth, 'x' | 'y' | 'w' | 'h'>> {
  const px = snapToGrid(world.x);
  const py = snapToGrid(world.y);
  let { x, y, w, h } = start;

  if (handle.includes('e')) {
    w = snapResize(px - start.x);
  }
  if (handle.includes('w')) {
    const left = Math.min(px, start.x + start.w - MIN_SIZE);
    w = snapResize(start.x + start.w - left);
    x = snapToGrid(start.x + start.w - w);
  }
  if (handle.includes('s')) {
    h = snapResize(py - start.y);
  }
  if (handle.includes('n')) {
    const top = Math.min(py, start.y + start.h - MIN_SIZE);
    h = snapResize(start.y + start.h - top);
    y = snapToGrid(start.y + start.h - h);
  }
  return { x, y, w, h };
}
