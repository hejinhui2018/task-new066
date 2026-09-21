/**
 * CanvasInteraction 交互控制器测试：
 * 多轮缩放拖动、拖动中旋转、滚动画布、pointer capture 丢失/取消、高 DPR、
 * 撤销/重做历史完整性，以及“拖动产出的世界坐标 == 碰撞/净空/寻路输入”。
 */
import { describe, it, expect, vi } from 'vitest';
import { CanvasInteraction } from './interaction';
import {
  applyResizeHandle,
  dragBoothPosition,
  type InteractionHandlers,
} from './interaction';
import {
  clientToWorld,
  localToWorld,
  physicalToLocal,
  snapToGrid,
  worldToLocal,
  zoomAroundLocal,
} from './grid';
import type { ViewTransform } from './grid';
import { History } from './history';
import { analyzePlan } from './validation';
import { rotate90 } from './geometry';
import { GRID_SIZE } from '../constants';
import type { Booth, PlanState, Point } from '../types';

function booth(
  id: string,
  x: number,
  y: number,
  w = 3,
  h = 2,
): Booth {
  return {
    id,
    x,
    y,
    w,
    h,
    orientation: 'south',
    label: id,
    color: '#000',
    kind: 'booth',
  };
}

function planEquals(a: PlanState, b: PlanState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Harness {
  ci: CanvasInteraction;
  plan: () => PlanState;
  getBooth: (id: string) => Booth;
  view: () => ViewTransform;
  rect: () => { left: number; top: number };
  setRect: (r: { left: number; top: number }) => void;
  /** 完全按 FloorPlan 的方式：先安全结束会话，再以锚点缩放（不做 pan 钳制）。 */
  zoomAt: (factor: number, clientAnchor: Point) => void;
  undo: () => void;
  redo: () => void;
  rotate: (id: string) => void;
  commits: () => number;
  panEnds: () => boolean[];
}

/**
 * 搭一个与 usePlanner + FloorPlan 等价的最小环境：
 * live 更新只改 planRef，commit 推入 History；view/rect 可在手势中变化。
 */
function makeHarness(
  initial: PlanState,
  init: { view?: ViewTransform; rect?: { left: number; top: number } } = {},
): Harness {
  const history = new History<PlanState>(initial, 100, planEquals);
  let plan: PlanState = initial;
  let view: ViewTransform = init.view ?? {
    scale: 40,
    pan: { x: 40, y: 40 },
  };
  let rect = init.rect ?? { left: 0, top: 0 };
  let commitCount = 0;
  const panEndLog: boolean[] = [];

  const replaceBooth = (id: string, patch: Partial<Booth>) => {
    plan = {
      booths: plan.booths.map((b) =>
        b.id === id ? { ...b, ...patch } : b,
      ),
    };
  };

  const handlers: InteractionHandlers = {
    getRect: () => rect,
    getView: () => view,
    onDrag: (id, world, grab) =>
      replaceBooth(id, dragBoothPosition(world, grab)),
    onResize: (id, handle, start, world) =>
      replaceBooth(id, applyResizeHandle(start, handle, world)),
    onPan: (p) => {
      view = { scale: view.scale, pan: p };
    },
    onCommit: () => {
      plan = history.commit(plan);
      commitCount += 1;
    },
    onPanEnd: (moved) => panEndLog.push(moved),
  };
  const ci = new CanvasInteraction(handlers);

  return {
    ci,
    plan: () => plan,
    getBooth: (id) => plan.booths.find((b) => b.id === id)!,
    view: () => view,
    rect: () => rect,
    setRect: (r) => {
      rect = r;
    },
    zoomAt: (factor, anchor) => {
      ci.interrupt();
      view = zoomAroundLocal(anchor, view, factor);
    },
    undo: () => {
      plan = history.undo();
    },
    redo: () => {
      plan = history.redo();
    },
    rotate: (id) => {
      plan = history.commit({
        booths: plan.booths.map((b) => (b.id === id ? rotate90(b) : b)),
      });
    },
    commits: () => commitCount,
    panEnds: () => panEndLog,
  };
}

const onGrid = (v: number) => expect(v % 0.5).toBeCloseTo(0, 10);

describe('CanvasInteraction 多轮缩放拖动（125% → 80% 复现场景）', () => {
  it('跨缩放的连续拖动不漂移，每轮位置都在网格上，撤销可回原网格位置', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5)] });

    // 100%：在世界 (6,6) 处抓住 A（左上 (5,5)，grab=(1,1)），client=(280,280)
    h.ci.startDrag(1, 280, 280, h.getBooth('A'));
    h.ci.move(1, 480, 480); // 世界 (11,11) → 左上 (10,10)
    expect(h.getBooth('A').x).toBe(10);
    expect(h.getBooth('A').y).toBe(10);

    // 缩到 125%（scale 40→50，锚点 client(300,300)）：拖动会话安全提交结束
    h.zoomAt(1.25, { x: 300, y: 300 });
    expect(h.view().scale).toBeCloseTo(50, 10);
    expect(h.view().pan.x).toBeCloseTo(-25, 10);
    expect(h.commits()).toBe(1);

    // 物理松手后在展位中心（世界 (11.5,11)）重新按下：client=(550,525)，grab=(1.5,1)
    h.ci.end(1);
    h.ci.startDrag(1, 550, 525, h.getBooth('A'));
    // 移到世界 (14,11)：client=(675,525) → 左上 (12.5,10)
    h.ci.move(1, 675, 525);
    expect(h.getBooth('A').x).toBeCloseTo(12.5, 10);
    expect(h.getBooth('A').y).toBe(10);

    // 缩回 80%（相对 125% 即 0.64，50→32）后继续拖
    h.zoomAt(0.64, { x: 300, y: 300 });
    expect(h.view().scale).toBeCloseTo(32, 10);
    expect(h.view().pan.x).toBeCloseTo(92, 10);
    expect(h.commits()).toBe(2);
    h.ci.end(1);
    // 在展位中心世界 (14,11) 处重新按下（3m 宽 → grab(1.5,1)）：client = 14*32+92=540, 444
    h.ci.startDrag(1, 540, 444, h.getBooth('A'));
    // 移到世界 (3,11)：client = 3*32+92=188, 444 → grab(1.5,1) 得左上 (1.5,10)
    h.ci.move(1, 188, 444);
    expect(h.getBooth('A').x).toBeCloseTo(1.5, 10);
    expect(h.getBooth('A').y).toBe(10);
    h.ci.end(1);
    expect(h.commits()).toBe(3);

    // 所有中间/最终坐标都是 0.5 m 网格点
    for (const [x, y] of [
      [10, 10],
      [12.5, 10],
      [1.5, 10],
    ]) {
      onGrid(x);
      onGrid(y);
    }

    // 撤销按手势逐条回到原网格位置，最终精确回到起点 (5,5)
    h.undo();
    expect(h.getBooth('A').x).toBeCloseTo(12.5, 10);
    h.undo();
    expect(h.getBooth('A').x).toBe(10);
    h.undo();
    expect(h.getBooth('A').x).toBe(5);
    expect(h.getBooth('A').y).toBe(5);

    // 重做可精确前进
    h.redo();
    expect(h.getBooth('A').x).toBe(10);
    h.redo();
    expect(h.getBooth('A').x).toBeCloseTo(12.5, 10);
    h.redo();
    expect(h.getBooth('A').x).toBeCloseTo(1.5, 10);
  });

  it('重复缩放往返后视图本身无累积误差（125% 与 80% 互逆）', () => {
    const v0: ViewTransform = { scale: 40, pan: { x: 40, y: 40 } };
    let v = v0;
    for (let i = 0; i < 50; i++) v = zoomAroundLocal({ x: 317, y: 211 }, v, 1.12);
    for (let i = 0; i < 50; i++) v = zoomAroundLocal({ x: 317, y: 211 }, v, 1 / 1.12);
    expect(v.scale).toBeCloseTo(40, 9);
    expect(v.pan.x).toBeCloseTo(40, 9);
    expect(v.pan.y).toBeCloseTo(40, 9);
  });

  it('缩放时光标下的世界点在屏幕上保持不动（锚点不变式）', () => {
    const v0: ViewTransform = { scale: 40, pan: { x: 40, y: 40 } };
    const anchor = { x: 330, y: 190 };
    for (const f of [1.25, 0.8, 1.12, 1 / 1.12, 2.5, 0.4]) {
      const worldUnder = {
        x: (anchor.x - v0.pan.x) / v0.scale,
        y: (anchor.y - v0.pan.y) / v0.scale,
      };
      const v1 = zoomAroundLocal(anchor, v0, f);
      const back = worldToLocal(worldUnder.x, worldUnder.y, v1);
      expect(back.x).toBeCloseTo(anchor.x, 10);
      expect(back.y).toBeCloseTo(anchor.y, 10);
    }
  });
});

describe('拖动中旋转 / 改几何：先安全结束再执行，历史互不污染', () => {
  it('拖动中旋转：当前位置先提交，旋转独立成一条，撤销顺序正确', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5, 3, 2)] });

    h.ci.startDrag(1, 240, 240, h.getBooth('A')); // grab (0,0)
    h.ci.move(1, 440, 440); // → (10,10)

    // 按下 R：FloorPlan 在捕获阶段先 interrupt()，usePlanner 再提交旋转
    h.ci.interrupt();
    expect(h.commits()).toBe(1);
    expect(h.ci.active).toBe(false);
    h.rotate('A');

    const after = h.getBooth('A');
    expect(after.x).toBe(10);
    expect(after.y).toBe(10);
    expect(after.w).toBe(2); // 3×2 旋转为 2×3
    expect(after.h).toBe(3);

    h.undo(); // 撤销旋转
    expect(h.getBooth('A').w).toBe(3);
    expect(h.getBooth('A').h).toBe(2);
    expect(h.getBooth('A').x).toBe(10); // 拖动结果仍在
    h.undo(); // 撤销拖动
    expect(h.getBooth('A').x).toBe(5);
    expect(h.getBooth('A').y).toBe(5);
  });

  it('无会话时旋转 / interrupt 是空操作，不产生多余历史', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5)] });
    h.ci.interrupt();
    expect(h.commits()).toBe(0);
  });
});

describe('滚动画布：每帧实时 rect，滚动不产生坐标误差', () => {
  it('拖动中页面滚动 120/80 px，展位跟随内容、仍贴住指针', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5)] });

    // 在世界 (6,6) 抓住（grab 1,1）
    h.ci.startDrag(1, 280, 280, h.getBooth('A'));
    expect(h.getBooth('A').x).toBe(5);

    // 页面滚动：元素边框盒在视口中上移/左移；指针 client 坐标不变。
    // getBoundingClientRect 每次实时读取，(280,280) 现在对应世界 (9,8)。
    h.setRect({ left: -120, top: -80 });
    h.ci.move(1, 280, 280);
    expect(h.getBooth('A').x).toBe(8);
    expect(h.getBooth('A').y).toBe(7);

    // 继续拖到 client (320,200)：世界 ((320+120-40)/40,(200+80-40)/40)=(10,6)
    h.ci.move(1, 320, 200);
    expect(h.getBooth('A').x).toBe(9);
    expect(h.getBooth('A').y).toBe(5);

    h.ci.end(1);
    h.undo();
    expect(h.getBooth('A').x).toBe(5);
    expect(h.getBooth('A').y).toBe(5);
  });

  it('client↔世界 转换对任意非零滚动 rect 精确往返', () => {
    const view: ViewTransform = { scale: 32, pan: { x: 92, y: -17.5 } };
    const rect = { left: -313.4, top: 88.25 };
    for (const [cx, cy] of [
      [0, 0],
      [280.7, -40.2],
      [1240, 860],
    ]) {
      const w = clientToWorld(cx, cy, rect, view);
      const local = worldToLocal(w.x, w.y, view);
      expect(local.x + rect.left).toBeCloseTo(cx, 10);
      expect(local.y + rect.top).toBeCloseTo(cy, 10);
    }
  });
});

describe('pointer capture 丢失 / pointercancel：安全结束', () => {
  it('lostpointercapture 时按当前位置提交，后续事件全部忽略', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5)] });
    h.ci.startDrag(1, 280, 280, h.getBooth('A'));
    h.ci.move(1, 480, 480);
    expect(h.getBooth('A').x).toBe(10);
    expect(h.commits()).toBe(0); // 还在 live

    h.ci.captureLost(1);
    expect(h.ci.active).toBe(false);
    expect(h.commits()).toBe(1); // 位置固化成历史

    // 捕获丢失后指针继续移动 / 松手都不再改动任何东西
    h.ci.move(1, 40, 40);
    h.ci.end(1);
    expect(h.commits()).toBe(1);
    expect(h.getBooth('A').x).toBe(10);

    h.undo();
    expect(h.getBooth('A').x).toBe(5);
  });

  it('pointercancel 与 capture 丢失同样安全提交', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5)] });
    h.ci.startDrag(1, 280, 280, h.getBooth('A'));
    h.ci.move(1, 320, 320); // → (6,6)
    h.ci.cancel(1);
    expect(h.ci.active).toBe(false);
    expect(h.commits()).toBe(1);
    expect(h.getBooth('A').x).toBe(6);
  });

  it('缩放手柄会话在缩放/取消时同样安全结束', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5, 3, 2)] });
    h.ci.startResize(1, 0, 0, h.getBooth('A'), 'e');
    // 世界 x=9（client 400）→ 宽吸附 4
    h.ci.move(1, 400, 240);
    expect(h.getBooth('A').w).toBe(4);

    h.zoomAt(1.25, { x: 300, y: 300 });
    expect(h.commits()).toBe(1);
    expect(h.ci.active).toBe(false);
    h.undo();
    expect(h.getBooth('A').w).toBe(3);
  });

  it('多指：忽略非活动指针的 move/up，只有捕获指针能结束会话', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5)] });
    h.ci.startDrag(1, 280, 280, h.getBooth('A'));
    h.ci.move(2, 40, 40); // 第二根指针的移动被忽略
    expect(h.getBooth('A').x).toBe(5);
    h.ci.end(2); // 第二根松手不结束会话
    expect(h.ci.active).toBe(true);
    expect(h.commits()).toBe(0);
    h.ci.end(1);
    expect(h.ci.active).toBe(false);
    expect(h.commits()).toBe(1);
  });
});

describe('高 DPR：dpr 只在物理像素边界处理一次', () => {
  const view: ViewTransform = { scale: 50, pan: { x: -25, y: -25 } };
  const rect = { left: 12.5, top: -8 };

  it.each([1, 1.5, 2, 2.75, 3])(
    '物理像素经 dpr=%s 还原后与 CSS 指针路径得到同一世界点',
    (dpr) => {
      for (const [cssX, cssY] of [
        [280, 280],
        [605, 480],
        [17.3, 901.2],
      ]) {
        const viaCss = clientToWorld(cssX, cssY, rect, view);
        const local = physicalToLocal(cssX * dpr, cssY * dpr, rect, dpr);
        const viaDevice = localToWorld(local.x, local.y, view);
        expect(viaDevice.x).toBeCloseTo(viaCss.x, 10);
        expect(viaDevice.y).toBeCloseTo(viaCss.y, 10);
      }
    },
  );

  it('浏览器 PointerEvent 始终是 CSS 像素：手势中 dpr 变化不影响换算', () => {
    // clientToWorld 不含 dpr 项，dpr 只在物理像素源（physicalToLocal）处除一次，
    // 因此显示器 dpr 切换不会给进行中的手势带来任何坐标跳变。
    const w1 = clientToWorld(480, 480, { left: 0, top: 0 }, view);
    const w2 = clientToWorld(480, 480, { left: 0, top: 0 }, view);
    expect(w2).toEqual(w1);

    // 物理像素源在 dpr=2 与 dpr=3 下描述同一 CSS 点时，世界坐标一致
    const fromDpr2 = physicalToLocal(960, 960, { left: 0, top: 0 }, 2);
    const fromDpr3 = physicalToLocal(1440, 1440, { left: 0, top: 0 }, 3);
    expect(fromDpr3).toEqual(fromDpr2);
  });
});

describe('画布平移会话', () => {
  it('小位移视为点击，大位移才平移；结束只回报 moved 不提交历史', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5)] });
    h.ci.startPan(1, 100, 100, { x: 40, y: 40 });
    h.ci.move(1, 102, 100); // 2px < 阈值
    expect(h.view().pan.x).toBe(42);
    h.ci.end(1);
    expect(h.panEnds()).toEqual([false]);
    expect(h.commits()).toBe(0);

    h.ci.startPan(1, 100, 100, h.view().pan);
    h.ci.move(1, 150, 100); // 50px
    h.ci.end(1);
    expect(h.view().pan.x).toBe(92);
    expect(h.panEnds()).toEqual([false, true]);
  });

  it('平移中滚轮缩放：平移安全结束且不产生展位历史', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5)] });
    h.ci.startPan(1, 100, 100, { x: 40, y: 40 });
    h.ci.move(1, 160, 100);
    h.zoomAt(1.25, { x: 300, y: 300 });
    expect(h.ci.active).toBe(false);
    expect(h.commits()).toBe(0);
    expect(h.panEnds()).toEqual([true]);
  });
});

describe('拖动产出的世界坐标 == 碰撞 / 净空 / 寻路 / 渲染输入', () => {
  it('拖到相邻 1.0 m：净空告警使用同一坐标', () => {
    const h = makeHarness({
      booths: [booth('A', 2, 2, 2, 2), booth('B', 5.5, 2, 2, 2)],
    });
    // B 左上 (5.5,2) 对应 client (260,120)；抓住 grab(0,0) 拖到 client (240,120) → (5,2)
    h.ci.startDrag(1, 260, 120, h.getBooth('B'));
    h.ci.move(1, 240, 120);
    expect(h.getBooth('B').x).toBe(5);
    h.ci.end(1);

    const result = analyzePlan(h.plan().booths);
    const clearance = result.alerts.filter((a) => a.kind === 'clearance');
    expect(clearance.length).toBe(1);
    expect(clearance[0].message).toContain('1 m');
    // 渲染用的就是同一对象的 x/y
    expect(h.getBooth('B').x).toBe(5);
  });

  it('拖到重叠：碰撞告警坐标与展位坐标一致', () => {
    const h = makeHarness({
      booths: [booth('A', 2, 2, 2, 2), booth('B', 5.5, 2, 2, 2)],
    });
    h.ci.startDrag(1, 260, 120, h.getBooth('B'));
    h.ci.move(1, 180, 120); // 世界 (3.5,2) → 与 A(2..4) 重叠
    expect(h.getBooth('B').x).toBe(3.5);
    h.ci.end(1);

    const result = analyzePlan(h.plan().booths);
    expect(result.alerts.some((a) => a.kind === 'overlap')).toBe(true);
  });

  it('拖到封住南出口：寻路/封堵计算与画面坐标一致，撤销后恢复可达', () => {
    const h = makeHarness({ booths: [booth('A', 5, 5, 3, 2)] });
    h.ci.startDrag(1, 240, 240, h.getBooth('A')); // grab (0,0)
    h.ci.move(1, 160, 520); // 世界 (3,12)：3×2 盖住南出口 x∈[3,5]
    expect(h.getBooth('A').x).toBe(3);
    expect(h.getBooth('A').y).toBe(12);
    h.ci.end(1);

    const blocked = analyzePlan(h.plan().booths);
    expect(blocked.blockedExitIds).toContain('exit-south');

    h.undo();
    const restored = analyzePlan(h.plan().booths);
    expect(restored.blockedExitIds).not.toContain('exit-south');
    expect(restored.paths['A'].length).toBeGreaterThan(1);
  });
});

describe('尺寸输入与拖动使用同一组世界坐标（Inspector.updateBoothField 等价逻辑）', () => {
  // usePlanner.updateBoothField：num = snapToGrid(max(GRID_SIZE, Number(raw)))
  const commitField = (
    b: Booth,
    field: 'x' | 'y' | 'w' | 'h',
    raw: string,
  ): Booth => ({
    ...b,
    [field]: snapToGrid(Math.max(GRID_SIZE, Number(raw) || 0)),
  });

  it('输入的 x/y/w/h 与拖动产出落在同一 0.5m 网格，且分析结果一致', () => {
    // 拖动路径产出 (5,2) 的展位
    const h = makeHarness({
      booths: [booth('A', 2, 2, 2, 2), booth('B', 5.5, 2, 2, 2)],
    });
    h.ci.startDrag(1, 260, 120, h.getBooth('B'));
    h.ci.move(1, 240, 120);
    h.ci.end(1);
    const dragged = h.getBooth('B');

    // 检查器输入 X=5：相同坐标、相同净空告警
    const typed = commitField(booth('B', 5.5, 2, 2, 2), 'x', '5');
    expect(typed.x).toBe(dragged.x);
    const a1 = analyzePlan(h.plan().booths);
    const a2 = analyzePlan(
      h.plan().booths.map((b) => (b.id === 'B' ? typed : b)),
    );
    expect(a1.alerts).toEqual(a2.alerts);

    // 非网格输入 2.3 吸附 2.5，最小尺寸 0.5（与手柄缩放同一网格）
    expect(commitField(dragged, 'w', '2.3').w).toBe(2.5);
    expect(commitField(dragged, 'h', '0.1').h).toBe(0.5);
  });
});

describe('纯几何辅助（世界坐标，网格吸附）', () => {
  it('dragBoothPosition 吸附并钳制越界范围', () => {
    expect(dragBoothPosition({ x: 3.1, y: 7.6 }, { x: 0, y: 0 })).toEqual({
      x: 3,
      y: 7.5,
    });
    expect(dragBoothPosition({ x: -10, y: -10 }, { x: 0, y: 0 })).toEqual({
      x: -4,
      y: -4,
    });
    expect(dragBoothPosition({ x: 100, y: 100 }, { x: 0, y: 0 })).toEqual({
      x: 19.5,
      y: 13.5,
    });
  });

  it('applyResizeHandle 西/北手柄翻转原点且尺寸吸附', () => {
    const start = { x: 5, y: 5, w: 3, h: 2 };
    const west = applyResizeHandle(start, 'w', { x: 4, y: 6 });
    expect(west).toEqual({ x: 4, y: 5, w: 4, h: 2 });
    const north = applyResizeHandle(start, 'n', { x: 6, y: 4 });
    expect(north).toEqual({ x: 5, y: 4, w: 3, h: 3 });
    // 最小尺寸钳制：越过右边沿时不再翻转
    const crowded = applyResizeHandle(start, 'w', { x: 7.9, y: 5 });
    expect(crowded.w).toBe(0.5);
    expect(crowded.x).toBe(7.5);
  });
});

describe('onCommit 原因回调（cancel/pointerup 可区分）', () => {
  it('松手与取消上报不同原因', () => {
    const onCommit = vi.fn();
    const ci = new CanvasInteraction({
      getRect: () => ({ left: 0, top: 0 }),
      getView: () => ({ scale: 40, pan: { x: 0, y: 0 } }),
      onDrag: () => {},
      onResize: () => {},
      onPan: () => {},
      onCommit,
      onPanEnd: () => {},
    });
    const b = booth('A', 0, 0);
    ci.startDrag(1, 0, 0, b, { x: 0, y: 0 });
    ci.end(1);
    expect(onCommit).toHaveBeenLastCalledWith('pointerup');
    ci.startDrag(2, 0, 0, b, { x: 0, y: 0 });
    ci.cancel(2);
    expect(onCommit).toHaveBeenLastCalledWith('cancel');
    ci.startDrag(3, 0, 0, b, { x: 0, y: 0 });
    ci.interrupt();
    expect(onCommit).toHaveBeenLastCalledWith('interrupted');
  });
});
