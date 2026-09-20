// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { FloorPlan } from './FloorPlan';
import { usePlanner, type PlannerApi } from '../state/usePlanner';
import type { Point } from '../types';

/*
 * 端到端指针/坐标测试：真实渲染 FloorPlan + usePlanner，派发原生 Pointer/Wheel 事件，
 * 从 DOM 的世界 <g> 变换读回 scale/pan（不依赖内部实现），验证：
 * 多轮缩放拖动、旋转、滚动画布、撤销重做、拖动中缩放、pointer capture 丢失、高 DPR。
 */

const W = 1000;
const H = 700;
const GRID = 0.5;
const PID = 1;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let planner: PlannerApi;

function Harness() {
  planner = usePlanner();
  return (
    <div className="canvas-wrap" style={{ width: W, height: H }}>
      <FloorPlan
        planner={planner}
        showPaths
        activeAlertId={null}
        onActiveAlertChange={() => {}}
        onZoomChange={() => {}}
      />
    </div>
  );
}

function svg(): SVGSVGElement {
  return container.querySelector('svg')!;
}

/** 从世界根 <g> 的 transform 读回当前视口。 */
function view(): { scale: number; pan: Point } {
  const g = container.querySelector('[data-world-root]')!;
  const m = g
    .getAttribute('transform')!
    .match(/translate\((-?[\d.]+),(-?[\d.]+)\) scale\((-?[\d.]+)\)/)!;
  return { pan: { x: Number(m[1]), y: Number(m[2]) }, scale: Number(m[3]) };
}

/** 用当前视口把 client 像素换算为世界米（与组件同一公式，仅作断言参照）。 */
function worldOf(x: number, y: number): Point {
  const v = view();
  return { x: (x - v.pan.x) / v.scale, y: (y - v.pan.y) / v.scale };
}

function boothRectEl(id: string): SVGRectElement {
  return container.querySelector(`[data-booth-id="${id}"]`)!;
}
function firstBoothId(): string {
  return container
    .querySelectorAll('[data-booth-id]')[0]
    .getAttribute('data-booth-id')!;
}
function boothAt(id: string) {
  const b = planner.booths.find((x) => x.id === id)!;
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}) {
  const pointerTypes = new Set([
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'gotpointercapture',
    'lostpointercapture',
  ]);
  const Ctor = pointerTypes.has(type)
    ? PointerEvent
    : type === 'wheel'
      ? WheelEvent
      : MouseEvent;
  target.dispatchEvent(
    new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init }),
  );
}

const down = (el: Element, x: number, y: number, id = PID) =>
  act(() => fire(el, 'pointerdown', { clientX: x, clientY: y, pointerId: id }));
const move = (x: number, y: number, id = PID) =>
  act(() => fire(window, 'pointermove', { clientX: x, clientY: y, pointerId: id }));
const up = (x: number, y: number, id = PID) =>
  act(() => fire(window, 'pointerup', { clientX: x, clientY: y, pointerId: id }));
const cancel = (x: number, y: number, id = PID) =>
  act(() => fire(window, 'pointercancel', { clientX: x, clientY: y, pointerId: id }));
const lost = (x: number, y: number, id = PID) =>
  act(() => fire(svg(), 'lostpointercapture', { clientX: x, clientY: y, pointerId: id }));

function wheel(x: number, y: number, deltaY: number) {
  act(() => fire(svg(), 'wheel', { clientX: x, clientY: y, deltaY }));
}

function dragBooth(id: string, from: Point, to: Point) {
  down(boothRectEl(id), from.x, from.y);
  move(to.x, to.y);
  up(to.x, to.y);
}

/** 按住展位的同时滚轮到目标倍率附近（deltaY<0 放大，>0 缩小）。 */
function zoomWhileHeld(anchor: Point, target: number) {
  let guard = 0;
  if (target >= view().scale) {
    while (view().scale < target && guard++ < 40) wheel(anchor.x, anchor.y, -100);
  } else {
    while (view().scale > target && guard++ < 40) wheel(anchor.x, anchor.y, 100);
  }
}

const snap = (v: number) => Math.round(v / GRID) * GRID;

beforeEach(async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => W,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => H,
  });
  Object.defineProperty(SVGElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0,
      toJSON() {},
    }),
  });
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('复现路径：125% 拖动 → 缩回 80% 继续拖，坐标不漂移', () => {
  it('两轮缩放间连续拖动，展位始终钉在指针下，落点为网格，撤销回原位', () => {
    const id = firstBoothId();
    const start = boothAt(id);
    const baseScale = view().scale;

    // 放大到约 125%
    zoomWhileHeld({ x: 400, y: 300 }, baseScale * 1.25);
    expect(view().scale / baseScale).toBeGreaterThan(1.2);

    // —— 第一轮拖动（高缩放区间）——
    const p0 = { x: 400, y: 300 };
    down(boothRectEl(id), p0.x, p0.y);
    const grab0 = { x: worldOf(p0.x, p0.y).x - start.x, y: worldOf(p0.x, p0.y).y - start.y };
    const p1 = { x: 460, y: 360 };
    move(p1.x, p1.y);
    expect(boothAt(id).x).toBeCloseTo(snap(worldOf(p1.x, p1.y).x - grab0.x), 8);
    expect(boothAt(id).y).toBeCloseTo(snap(worldOf(p1.x, p1.y).y - grab0.y), 8);

    // 按住不放，缩回约 80%（在 p1 处滚轮）；指针未动，展位不应跳变
    const posAtHigh = boothAt(id);
    zoomWhileHeld(p1, baseScale * 0.8);
    expect(view().scale / baseScale).toBeLessThan(0.9);
    expect(boothAt(id).x).toBeCloseTo(posAtHigh.x, 8);
    expect(boothAt(id).y).toBeCloseTo(posAtHigh.y, 8);

    // —— 第二轮拖动（低缩放区间）：按新视口重新锚定后 1:1 跟随 ——
    const grab1 = {
      x: worldOf(p1.x, p1.y).x - posAtHigh.x,
      y: worldOf(p1.x, p1.y).y - posAtHigh.y,
    };
    const p2 = { x: 300, y: 250 };
    move(p2.x, p2.y);
    expect(boothAt(id).x).toBeCloseTo(snap(worldOf(p2.x, p2.y).x - grab1.x), 8);
    expect(boothAt(id).y).toBeCloseTo(snap(worldOf(p2.x, p2.y).y - grab1.y), 8);
    expect(boothAt(id).x % GRID).toBeCloseTo(0, 8);
    expect(boothAt(id).y % GRID).toBeCloseTo(0, 8);
    up(p2.x, p2.y);

    // 渲染用的世界坐标与数据一致
    expect(Number(boothRectEl(id).getAttribute('x'))).toBeCloseTo(boothAt(id).x, 8);
    expect(Number(boothRectEl(id).getAttribute('y'))).toBeCloseTo(boothAt(id).y, 8);

    // 整个跨缩放手势只有一条历史，撤销精确回到原网格位置
    act(() => planner.undo());
    expect(boothAt(id)).toEqual(start);
    expect(Number(boothRectEl(id).getAttribute('x'))).toBe(start.x);
  });
});

describe('拖动跟随与网格吸附', () => {
  it('左上角 = 吸附(世界指针 - 抓取点)', () => {
    const id = firstBoothId();
    const start = boothAt(id);
    const from = { x: 300, y: 300 };
    const to = { x: 381, y: 257 };
    const grab = {
      x: worldOf(from.x, from.y).x - start.x,
      y: worldOf(from.x, from.y).y - start.y,
    };
    dragBooth(id, from, to);
    expect(boothAt(id).x).toBe(snap(worldOf(to.x, to.y).x - grab.x));
    expect(boothAt(id).y).toBe(snap(worldOf(to.x, to.y).y - grab.y));
  });

  it('一次拖动一条历史；撤销/重做往返一致', () => {
    const id = firstBoothId();
    const start = boothAt(id);
    expect(planner.canUndo).toBe(false);
    dragBooth(id, { x: 300, y: 300 }, { x: 500, y: 420 });
    expect(planner.canUndo).toBe(true);
    const moved = boothAt(id);
    act(() => planner.undo());
    expect(boothAt(id)).toEqual(start);
    act(() => planner.redo());
    expect(boothAt(id)).toEqual(moved);
  });

  it('手势进行中的 undo/redo 被忽略，基线不错位', () => {
    const id = firstBoothId();
    down(boothRectEl(id), 300, 300);
    move(420, 360);
    const live = boothAt(id);
    act(() => planner.undo());
    act(() => planner.redo());
    expect(boothAt(id)).toEqual(live);
    up(420, 360);
    expect(planner.canUndo).toBe(true);
  });
});

describe('拖动中改变缩放：安全续拖不跳变', () => {
  it('指针不动时缩放不移动展位；之后按新视口精确跟随，合并为一条历史', () => {
    const id = firstBoothId();
    const start = boothAt(id);
    const p0 = { x: 400, y: 300 };
    down(boothRectEl(id), p0.x, p0.y);
    move(p0.x, p0.y);

    wheel(p0.x, p0.y, -100);
    wheel(p0.x, p0.y, -100);
    wheel(p0.x, p0.y, 100);
    wheel(p0.x, p0.y, 100);
    expect(boothAt(id).x).toBeCloseTo(start.x, 8);
    expect(boothAt(id).y).toBeCloseTo(start.y, 8);

    const grab = {
      x: worldOf(p0.x, p0.y).x - start.x,
      y: worldOf(p0.x, p0.y).y - start.y,
    };
    const p1 = { x: 470, y: 330 };
    move(p1.x, p1.y);
    expect(boothAt(id).x).toBeCloseTo(snap(worldOf(p1.x, p1.y).x - grab.x), 8);
    expect(boothAt(id).y).toBeCloseTo(snap(worldOf(p1.x, p1.y).y - grab.y), 8);
    up(p1.x, p1.y);
    act(() => planner.undo());
    expect(boothAt(id)).toEqual(start);
  });
});

describe('旋转展位', () => {
  it('点旋转钮交换宽高、左上角不变、可撤销', () => {
    const id = firstBoothId();
    // 先选中（pointerdown+up 触发选择且不产生改动）
    down(boothRectEl(id), 300, 300);
    up(300, 300);
    const before = boothAt(id);
    const btn = container.querySelector('[data-testid="rotate-btn"]')!;
    act(() => fire(btn, 'click'));
    const after = boothAt(id);
    expect(after.w).toBe(before.h);
    expect(after.h).toBe(before.w);
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    act(() => planner.undo());
    expect(boothAt(id)).toEqual(before);
  });

  it('拖动中旋转并入同一手势：一次撤销同时回退移动与旋转', () => {
    const id = firstBoothId();
    const before = boothAt(id);
    down(boothRectEl(id), 300, 300);
    move(400, 350);
    act(() => planner.rotateBooth(id));
    expect(boothAt(id).w).toBe(before.h);
    up(400, 350);
    act(() => planner.undo());
    expect(planner.canUndo).toBe(false);
    expect(boothAt(id)).toEqual(before);
  });
});

describe('滚动画布（平移）', () => {
  it('拖空白平移视口：pan 变、scale 不变、世界数据不变', () => {
    const id = firstBoothId();
    const before = boothAt(id);
    const v0 = view();
    const hall = container.querySelector('[data-testid="hall"]')!;
    act(() => fire(hall, 'pointerdown', { clientX: 500, clientY: 500, pointerId: PID }));
    act(() => fire(window, 'pointermove', { clientX: 520, clientY: 490, pointerId: PID }));
    act(() => fire(window, 'pointerup', { clientX: 520, clientY: 490, pointerId: PID }));
    const v1 = view();
    expect(v1.pan.x).toBe(v0.pan.x + 20);
    expect(v1.pan.y).toBe(v0.pan.y - 10);
    expect(v1.scale).toBe(v0.scale);
    expect(boothAt(id)).toEqual(before);
  });

  it('平移手势中滚轮不缩放', () => {
    const hall = container.querySelector('[data-testid="hall"]')!;
    const s0 = view().scale;
    act(() => fire(hall, 'pointerdown', { clientX: 500, clientY: 500, pointerId: PID }));
    wheel(500, 500, -100);
    expect(view().scale).toBe(s0);
    act(() => fire(window, 'pointerup', { clientX: 500, clientY: 500, pointerId: PID }));
  });
});

describe('pointer capture 丢失 / pointercancel：安全结束', () => {
  it('pointercancel 恢复拖动前网格位置且不产生历史', () => {
    const id = firstBoothId();
    const start = boothAt(id);
    down(boothRectEl(id), 300, 300);
    move(520, 460);
    expect(boothAt(id).x).not.toBe(start.x);
    cancel(520, 460);
    expect(boothAt(id)).toEqual(start);
    expect(planner.canUndo).toBe(false);
  });

  it('lostpointercapture（未收到 pointerup）按取消恢复，重复事件为空操作', () => {
    const id = firstBoothId();
    const start = boothAt(id);
    down(boothRectEl(id), 300, 300);
    move(200, 200);
    lost(200, 200);
    expect(boothAt(id)).toEqual(start);
    expect(planner.canUndo).toBe(false);
    lost(200, 200);
    expect(boothAt(id)).toEqual(start);
  });
});

describe('高 DPR：坐标只认 CSS 像素', () => {
  it('devicePixelRatio=1 与 =3 下相同 client 坐标得到相同世界落点', async () => {
    const run = async (dpr: number) => {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value: dpr,
      });
      // 每个实例都从内置示例开始，避免上一次运行的自动保存串扰。
      localStorage.clear();
      const c = document.createElement('div');
      document.body.appendChild(c);
      const r = createRoot(c);
      let api!: PlannerApi;
      const H2 = () => {
        api = usePlanner();
        return (
          <div className="canvas-wrap" style={{ width: W, height: H }}>
            <FloorPlan
              planner={api}
              showPaths
              activeAlertId={null}
              onActiveAlertChange={() => {}}
              onZoomChange={() => {}}
            />
          </div>
        );
      };
      await act(async () => {
        r.render(<H2 />);
      });
      const id2 = c
        .querySelectorAll('[data-booth-id]')[0]
        .getAttribute('data-booth-id')!;
      const rect = c.querySelector(`[data-booth-id="${id2}"]`)!;
      await act(async () => {
        rect.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true, clientX: 300, clientY: 300, pointerId: 9,
          }),
        );
      });
      await act(async () => {
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true, clientX: 410, clientY: 265, pointerId: 9,
          }),
        );
      });
      await act(async () => {
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true, clientX: 410, clientY: 265, pointerId: 9,
          }),
        );
      });
      const b = api.booths.find((x) => x.id === id2)!;
      const result = { x: b.x, y: b.y };
      await act(async () => {
        r.unmount();
      });
      c.remove();
      return result;
    };

    const a = await run(1);
    const b = await run(3);
    expect(b).toEqual(a);
    expect(a.x % GRID).toBeCloseTo(0, 10);
    expect(a.y % GRID).toBeCloseTo(0, 10);
  });
});

describe('世界坐标：渲染与分析共用同一组数据', () => {
  it('厅内网格点无越界告警，且渲染坐标等于数据坐标', () => {
    const id = firstBoothId();
    dragBooth(id, { x: 320, y: 320 }, { x: 320, y: 320 });
    const b = boothAt(id);
    const oob = planner.analysis.alerts.some(
      (a) => a.kind === 'out-of-bounds' && a.boothId === id,
    );
    expect(oob).toBe(false);
    expect(Number(boothRectEl(id).getAttribute('x'))).toBeCloseTo(b.x, 10);
    expect(Number(boothRectEl(id).getAttribute('y'))).toBeCloseTo(b.y, 10);
  });
});
