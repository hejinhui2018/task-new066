import { describe, it, expect } from 'vitest';
import {
  clientToLocal,
  clientToWorld,
  localToClient,
  localToWorld,
  physicalToWorld,
  screenDeltaToWorld,
  screenToWorld,
  snapDragPosition,
  snapResize,
  snapToGrid,
  worldToClient,
  worldToLocal,
  worldToScreen,
  zoomAroundClient,
  zoomAroundLocal,
} from './grid';
import type { ViewTransform } from './grid';
import { GRID_SIZE } from '../constants';

describe('snapToGrid 0.5m 吸附', () => {
  it('网格点保持不变', () => {
    for (const v of [0, 0.5, 1, 2.5, 19.5, 14]) {
      expect(snapToGrid(v)).toBe(v);
    }
  });

  it('向最近网格点四舍五入', () => {
    expect(snapToGrid(0.2)).toBe(0);
    expect(snapToGrid(0.3)).toBe(0.5);
    expect(snapToGrid(1.74)).toBe(1.5);
    expect(snapToGrid(1.76)).toBe(2);
    expect(snapToGrid(-0.3)).toBe(-0.5);
    // 等距（-0.25）时按 Math.round 向 +∞ 方向取 0
    expect(Object.is(snapToGrid(-0.25), 0)).toBe(true);
  });

  it('支持自定义步长', () => {
    expect(snapToGrid(0.31, 1)).toBe(0);
    expect(snapToGrid(0.6, 1)).toBe(1);
  });

  it('不产生浮点尾巴', () => {
    expect(snapToGrid(10.3)).toBe(10.5);
    expect(Number.isFinite(snapToGrid(3.14159))).toBe(true);
  });
});

describe('屏幕 ↔ 世界坐标换算（缩放下保持准确）', () => {
  it('scale=1 且无平移时恒等', () => {
    expect(screenToWorld(120, 40, 1, { x: 0, y: 0 })).toEqual({
      x: 120,
      y: 40,
    });
  });

  it('scale=40 像素/米时正确换算', () => {
    // 画布 pan(40,40)：像素 (240,240) -> 米 (5,5)
    expect(screenToWorld(240, 240, 40, { x: 40, y: 40 })).toEqual({
      x: 5,
      y: 5,
    });
  });

  it('两个方向互逆（任意缩放/平移）', () => {
    const cases: Array<[number, number, number, { x: number; y: number }]> = [
      [0, 0, 40, { x: 40, y: 40 }],
      [537.25, 218.5, 12.5, { x: 13.25, y: -7.5 }],
      [999, 1, 200, { x: 0, y: 0 }],
      [10, 10, 0.3, { x: 100, y: 200 }],
    ];
    for (const [px, py, scale, pan] of cases) {
      const w = screenToWorld(px, py, scale, pan);
      const back = worldToScreen(w.x, w.y, scale, pan);
      expect(back.x).toBeCloseTo(px, 10);
      expect(back.y).toBeCloseTo(py, 10);
    }
  });

  it('缩放后同样的屏幕位移对应不同的米位移', () => {
    // 40 像素在 scale=40 时是 1 米，在 scale=10 时是 4 米
    expect(screenDeltaToWorld(40, 0, 40)).toEqual({ x: 1, y: 0 });
    expect(screenDeltaToWorld(40, 0, 10)).toEqual({ x: 4, y: 0 });
    expect(screenDeltaToWorld(0, -20, 5)).toEqual({ x: 0, y: -4 });
  });
});

describe('拖拽吸附与尺寸吸附', () => {
  it('拖拽位置扣除抓取偏移并吸附网格', () => {
    // 抓取点在展位内 (0.7, 0.3)；指针世界坐标 (4.2, 6.2)
    // 左上角 ≈ (3.5, 5.9) -> 吸附 (3.5, 6.0)
    const p = snapDragPosition(4.2, 6.2, { x: 0.7, y: 0.3 });
    expect(p).toEqual({ x: 3.5, y: 6 });
  });

  it('任意缩放下换算后再拖拽都落在 0.5m 网格', () => {
    // 模拟 scale=80：指针移动到像素 (243,200)，pan(40,40)，抓取偏移 (1,1)
    const pan = { x: 40, y: 40 };
    const grab = { x: 1, y: 1 };
    const scale = 80;
    const w = screenToWorld(243, 200, scale, pan);
    const next = snapDragPosition(w.x, w.y, grab);
    expect(next.x % GRID_SIZE).toBeCloseTo(0, 10);
    expect(next.y % GRID_SIZE).toBeCloseTo(0, 10);
  });

  it('尺寸吸附且不小于最小值', () => {
    expect(snapResize(2.9)).toBe(3);
    expect(snapResize(0.1)).toBe(GRID_SIZE);
    expect(snapResize(0.6)).toBe(0.5);
    expect(snapResize(0)).toBe(GRID_SIZE);
  });
});

describe('统一坐标边界 client → local → world（滚动 / DPR / 渲染逆变换）', () => {
  const view: ViewTransform = { scale: 40, pan: { x: 40, y: 40 } };
  const rect0 = { left: 0, top: 0 };

  it('client→local 就是减实时边框盒（含页面滚动），并与 local→client 互逆', () => {
    const rect = { left: -300, top: 200 };
    expect(clientToLocal(280, 280, rect)).toEqual({ x: 580, y: 80 });
    expect(localToClient(580, 80, rect)).toEqual({ x: 280, y: 280 });
  });

  it('client→world 只转一次且可精确往返（渲染命中点走同一条边界）', () => {
    for (const [cx, cy, rx, ry] of [
      [240, 240, 0, 0],
      [240, 240, -150.5, 90.25],
      [1240.8, 860.4, 313.7, -42.1],
    ] as const) {
      const rect = { left: rx, top: ry };
      const w = clientToWorld(cx, cy, rect, view);
      const back = worldToClient(w.x, w.y, rect, view);
      expect(back.x).toBeCloseTo(cx, 10);
      expect(back.y).toBeCloseTo(cy, 10);
    }
  });

  it('同一 CSS 指针位置在不同滚动位置映射不同世界点——滚动偏移只在边界计入一次', () => {
    const wBefore = clientToWorld(280, 280, rect0, view);
    const wAfter = clientToWorld(280, 280, { left: -120, top: -80 }, view);
    expect(wAfter.x).toBeCloseTo(wBefore.x + 3, 10);
    expect(wAfter.y).toBeCloseTo(wBefore.y + 2, 10);
  });

  it('local↔world 在任意缩放/平移下精确互逆', () => {
    const cases: Array<[number, number, number]> = [
      [0.3, 100, 200],
      [12.5, 13.25, -7.5],
      [200, 0, 0],
      [50, -25, -25],
    ];
    for (const [scale, panX, panY] of cases) {
      const vt: ViewTransform = { scale, pan: { x: panX, y: panY } };
      const world = localToWorld(537.25, 218.5, vt);
      const back = worldToLocal(world.x, world.y, vt);
      expect(back.x).toBeCloseTo(537.25, 10);
      expect(back.y).toBeCloseTo(218.5, 10);
    }
  });

  it('物理像素只在边界除一次 dpr，之后不再出现 dpr 项', () => {
    const rect = { left: 10, top: 20 };
    for (const dpr of [1, 1.5, 2, 3]) {
      const w = physicalToWorld(580 * dpr, 420 * dpr, rect, dpr, {
        scale: 40,
        pan: { x: 40, y: 40 },
      });
      expect(w.x).toBeCloseTo(13.25, 10);
      expect(w.y).toBeCloseTo(9, 10);
    }
  });

  it('旧 screenToWorld/worldToScreen 与新边界结果一致（兼容）', () => {
    expect(screenToWorld(240, 240, 40, { x: 40, y: 40 })).toEqual(
      localToWorld(240, 240, view),
    );
    expect(worldToScreen(5, 5, 40, { x: 40, y: 40 })).toEqual(
      worldToLocal(5, 5, view),
    );
  });
});

describe('光标锚点缩放 zoomAroundLocal：多轮复合不累积误差', () => {
  const v0: ViewTransform = { scale: 40, pan: { x: 40, y: 40 } };

  it('锚点下的世界点缩放前后屏幕位置不变', () => {
    const anchor = { x: 330, y: 190 };
    for (const factor of [0.3, 0.8, 1.12, 1.25, 2.5, 6]) {
      const world = localToWorld(anchor.x, anchor.y, v0);
      const v1 = zoomAroundLocal(anchor, v0, factor);
      const screen = worldToLocal(world.x, world.y, v1);
      expect(screen.x).toBeCloseTo(anchor.x, 10);
      expect(screen.y).toBeCloseTo(anchor.y, 10);
    }
  });

  it('分两次缩放与一次复合缩放结果相同（125% 后缩回 80%）', () => {
    const anchor = { x: 412, y: 288 };
    const twoStep = zoomAroundLocal(
      anchor,
      zoomAroundLocal(anchor, v0, 1.25),
      0.8 / 1.25,
    );
    const oneStep = zoomAroundLocal(anchor, v0, 0.8);
    expect(twoStep.scale).toBeCloseTo(oneStep.scale, 10);
    expect(twoStep.pan.x).toBeCloseTo(oneStep.pan.x, 10);
    expect(twoStep.pan.y).toBeCloseTo(oneStep.pan.y, 10);
  });

  it('50 轮放大再 50 轮缩回后视图回到原值（无漂移）', () => {
    let v = v0;
    for (let i = 0; i < 50; i++) v = zoomAroundLocal({ x: 317, y: 211 }, v, 1.12);
    for (let i = 0; i < 50; i++) v = zoomAroundLocal({ x: 317, y: 211 }, v, 1 / 1.12);
    expect(v.scale).toBeCloseTo(40, 9);
    expect(v.pan.x).toBeCloseTo(40, 9);
    expect(v.pan.y).toBeCloseTo(40, 9);
  });

  it('clampScale 触顶时 factor 被钳制，clampPan 可限制平移范围', () => {
    const clamped = zoomAroundLocal({ x: 0, y: 0 }, v0, 10, {
      clampScale: (s) => Math.min(50, s),
    });
    expect(clamped.scale).toBe(50);
    const panned = zoomAroundLocal({ x: 999, y: 999 }, v0, 2, {
      clampPan: (p) => ({ x: Math.min(100, p.x), y: Math.min(100, p.y) }),
    });
    expect(panned.pan.x).toBeLessThanOrEqual(100);
    expect(panned.pan.y).toBeLessThanOrEqual(100);
  });

  it('zoomAroundClient 内部先做 client→local 边界转换', () => {
    const rect = { left: -120, top: -80 };
    // client 280 → local 400；锚点世界点保持不动
    const v1 = zoomAroundClient(280, 280, rect, v0, 1.25);
    const world = clientToWorld(280, 280, rect, v0);
    const screen = worldToLocal(world.x, world.y, v1);
    expect(screen.x).toBeCloseTo(400, 10);
    expect(screen.y).toBeCloseTo(360, 10);
  });
});
