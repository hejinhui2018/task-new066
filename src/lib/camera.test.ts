import { describe, it, expect } from 'vitest';
import {
  clientToLocal,
  clientToWorld,
  localToWorld,
  worldToLocal,
  zoomAt,
  zoomCentered,
  fitViewport,
  clampPan,
  clampDragPosition,
  zoomRatio,
  ZOOM_RATIO_MIN,
  ZOOM_RATIO_MAX,
  type Viewport,
} from './camera';
import { HALL_HEIGHT, HALL_WIDTH } from '../constants';

const SIZE = { w: 1000, h: 700 };

describe('client→local→world 唯一坐标边界', () => {
  it('client 先减画布偏移得 local（与 DPR 无关）', () => {
    // 即使 DPR=2，getBoundingClientRect/clientX 仍是 CSS 像素；这里只做减法。
    expect(clientToLocal(240, 180, { left: 100, top: 50 })).toEqual({
      x: 140,
      y: 130,
    });
  });

  it('local 经平移+缩放一次换算为世界米', () => {
    const vp: Viewport = { scale: 40, pan: { x: 40, y: 40 } };
    expect(localToWorld({ x: 240, y: 240 }, vp)).toEqual({ x: 5, y: 5 });
  });

  it('clientToWorld = clientToLocal → localToWorld 一条路径', () => {
    const vp: Viewport = { scale: 12.5, pan: { x: -13.25, y: 7.5 } };
    const w = clientToWorld(537.25, 218.5, { left: 0, top: 0 }, vp);
    expect(w.x).toBeCloseTo((537.25 + 13.25) / 12.5, 10);
    expect(w.y).toBeCloseTo((218.5 - 7.5) / 12.5, 10);
  });

  it('world→local→world 往返恒等，任意缩放/平移/高 DPR 下不累积误差', () => {
    const cases: Array<[Viewport, { x: number; y: number }]> = [
      [{ scale: 40, pan: { x: 40, y: 40 } }, { x: 0, y: 0 }],
      [{ scale: 80, pan: { x: -17.3, y: 9.8 } }, { x: 12.345, y: 6.789 }],
      // 模拟 125%（scale×1.25）与 80%（scale×0.8）
      [{ scale: 50, pan: { x: 200, y: 100 } }, { x: 3.14159, y: 2.71828 }],
      [{ scale: 32, pan: { x: 200, y: 100 } }, { x: 3.14159, y: 2.71828 }],
      [{ scale: 0.3, pan: { x: 10, y: 10 } }, { x: 19.5, y: 13.5 }],
      [{ scale: 240, pan: { x: -500, y: -300 } }, { x: 7.5, y: 7 }],
    ];
    for (const [vp, world] of cases) {
      const local = worldToLocal(world, vp);
      const back = localToWorld(local, vp);
      expect(back.x).toBeCloseTo(world.x, 10);
      expect(back.y).toBeCloseTo(world.y, 10);
    }
  });
});

describe('光标锚点缩放：连续多轮不漂移', () => {
  const base = 50;
  const vp0: Viewport = { scale: base, pan: { x: 60, y: 30 } };

  it('锚点正下方的世界点缩放前后屏幕位置不变', () => {
    const anchor = { x: 300, y: 200 };
    const before = localToWorld(anchor, vp0);
    const vp1 = zoomAt(vp0, 1.25, anchor, base, SIZE);
    const after = localToWorld(anchor, vp1);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it('125%→拖→80% 多轮乘法缩放，锚点世界坐标始终钉住', () => {
    const anchor = { x: 512.5, y: 287.25 };
    let vp = vp0;
    // 连续放大 5 次、缩小 7 次（混合非整除因子），模拟来回滚轮。
    for (let i = 0; i < 5; i++) vp = zoomAt(vp, 1.12, anchor, base, SIZE);
    const worldAtHigh = localToWorld(anchor, vp);
    for (let i = 0; i < 7; i++) vp = zoomAt(vp, 1 / 1.12, anchor, base, SIZE);
    const worldAtLow = localToWorld(anchor, vp);
    expect(worldAtLow.x).toBeCloseTo(worldAtHigh.x, 9);
    expect(worldAtLow.y).toBeCloseTo(worldAtHigh.y, 9);
  });

  it('zoomAt 与 zoomCentered 在画布中心锚点时等价', () => {
    const a = zoomAt(vp0, 1.2, { x: 500, y: 350 }, base, SIZE);
    const b = zoomCentered(vp0, 1.2, base, SIZE);
    expect(a.scale).toBeCloseTo(b.scale, 10);
    expect(a.pan.x).toBeCloseTo(b.pan.x, 10);
    expect(a.pan.y).toBeCloseTo(b.pan.y, 10);
  });

  it('缩放在倍率上下限钳制，不在视口外累积', () => {
    const inMax = zoomAt(vp0, 100, { x: 0, y: 0 }, base, SIZE);
    expect(inMax.scale).toBeCloseTo(base * ZOOM_RATIO_MAX, 10);
    const atMin = zoomAt(vp0, 0.0001, { x: 999, y: 699 }, base, SIZE);
    expect(atMin.scale).toBeCloseTo(base * ZOOM_RATIO_MIN, 10);
  });

  it('zoomRatio 百分比与 fit 基准一致', () => {
    expect(zoomRatio({ scale: base * 1.25, pan: { x: 0, y: 0 } }, base)).toBeCloseTo(1.25, 10);
    expect(zoomRatio({ scale: base * 0.8, pan: { x: 0, y: 0 } }, base)).toBeCloseTo(0.8, 10);
  });
});

describe('fit / pan 钳制', () => {
  it('fitViewport 让整个展厅居中且比例正确', () => {
    const f = fitViewport(SIZE);
    // 世界四角映射后应在画布内并大致居中
    const tl = worldToLocal({ x: 0, y: 0 }, f);
    const br = worldToLocal({ x: HALL_WIDTH, y: HALL_HEIGHT }, f);
    expect(tl.x).toBeGreaterThan(20);
    expect(tl.y).toBeGreaterThan(10);
    expect(br.x).toBeLessThan(SIZE.w - 20);
    expect(br.y).toBeLessThan(SIZE.h - 20);
    // 比例即 100% 基准
    expect(f.scale).toBe(f.baseScale);
  });

  it('clampPan 把展厅保留在画布边缘附近', () => {
    const clamped = clampPan({ x: 99999, y: 99999 }, 40, SIZE);
    expect(clamped.x).toBeLessThanOrEqual(SIZE.w - 24);
    expect(clamped.y).toBeLessThanOrEqual(SIZE.h - 24);
    const clamped2 = clampPan({ x: -99999, y: -99999 }, 40, SIZE);
    // 至少保留 24px 可见
    expect(clamped2.x).toBeGreaterThanOrEqual(-HALL_WIDTH * 40 + 24 - 1e-9);
  });
});

describe('拖动边界钳制使用世界坐标', () => {
  it('允许越过展厅 4m 但保留可见部分', () => {
    expect(clampDragPosition(-3, -3, 0.5)).toEqual({ x: -3, y: -3 });
    expect(clampDragPosition(-5, 0, 0.5)).toEqual({ x: -4, y: 0 });
    expect(clampDragPosition(100, 100, 0.5)).toEqual({
      x: HALL_WIDTH - 0.5,
      y: HALL_HEIGHT - 0.5,
    });
  });
});
