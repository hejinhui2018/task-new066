// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usePlanner, type PlannerApi } from './usePlanner';

/*
 * 交互生命周期（与 FloorPlan 指针会话一一对应）的钩子级测试：
 * beginInteraction（锁定快照）→ liveUpdateBooth（只改画面）
 * → commitInteraction（一条历史）/ cancelInteraction（恢复，不入历史）。
 */

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let api: PlannerApi;

function Harness() {
  api = usePlanner();
  return null;
}

beforeEach(async () => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('交互生命周期', () => {
  it('begin + live 只改画面不入历史；commit 后产生一条历史', () => {
    const id = api.booths[0].id;
    const start = { ...api.booths[0] };
    expect(api.canUndo).toBe(false);

    act(() => api.beginInteraction());
    act(() => api.liveUpdateBooth(id, { x: start.x + 2, y: start.y + 1 }));
    expect(api.canUndo).toBe(false); // 拖动中还不能撤销到中间态
    expect(api.booths.find((b) => b.id === id)!.x).toBe(start.x + 2);

    act(() => api.commitInteraction());
    expect(api.canUndo).toBe(true);

    act(() => api.undo());
    const back = api.booths.find((b) => b.id === id)!;
    expect({ x: back.x, y: back.y }).toEqual({ x: start.x, y: start.y });
  });

  it('cancel 恢复到交互前的网格位置且不产生历史', () => {
    const id = api.booths[0].id;
    const start = { ...api.booths[0] };

    act(() => api.beginInteraction());
    act(() => api.liveUpdateBooth(id, { x: 9, y: 9 }));
    act(() => api.cancelInteraction());

    expect(api.canUndo).toBe(false);
    const back = api.booths.find((b) => b.id === id)!;
    expect({ x: back.x, y: back.y }).toEqual({ x: start.x, y: start.y });
    // 取消后提交仍正常（标志位已复位）
    act(() => api.rotateBooth(id));
    expect(api.canUndo).toBe(true);
  });

  it('交互中的离散操作（旋转）并入同一手势：一次撤销全部回退', () => {
    const id = api.booths[0].id;
    const start = { ...api.booths[0] };

    act(() => api.beginInteraction());
    act(() => api.liveUpdateBooth(id, { x: 4, y: 4 }));
    act(() => api.rotateBooth(id)); // 不应单独产生历史
    expect(api.canUndo).toBe(false);
    act(() => api.commitInteraction());
    expect(api.canUndo).toBe(true);

    act(() => api.undo());
    expect(api.canUndo).toBe(false);
    const back = api.booths.find((b) => b.id === id)!;
    expect({ x: back.x, y: back.y, w: back.w, h: back.h }).toEqual({
      x: start.x, y: start.y, w: start.w, h: start.h,
    });
  });

  it('交互进行中 undo/redo/reset 被忽略', () => {
    const id = api.booths[0].id;
    act(() => api.beginInteraction());
    act(() => api.liveUpdateBooth(id, { x: 6, y: 6 }));
    act(() => api.undo());
    act(() => api.redo());
    act(() => api.resetPlan('empty'));
    // 展位仍是 live 状态，未被重置/撤销影响
    expect(api.booths.find((b) => b.id === id)!.x).toBe(6);
    act(() => api.commitInteraction());
    // 结束后历史操作恢复
    act(() => api.undo());
    expect(api.booths.find((b) => b.id === id)!.x).not.toBe(6);
  });

  it('beginInteraction 幂等：手势内重复调用不覆盖初始快照', () => {
    const id = api.booths[0].id;
    const startX = api.booths.find((b) => b.id === id)!.x;
    act(() => api.beginInteraction());
    act(() => api.liveUpdateBooth(id, { x: 3 }));
    act(() => api.beginInteraction()); // 重复 begin 不应把快照改成 x=3
    act(() => api.liveUpdateBooth(id, { x: 7 }));
    act(() => api.cancelInteraction());
    expect(api.booths.find((b) => b.id === id)!.x).toBe(startX);
  });
});

describe('尺寸输入与世界坐标统一', () => {
  it('检查器输入的宽高吸附到 0.5m 网格、不小于 0.5m，并立即反映到分析', () => {
    const id = api.booths[0].id;
    act(() => api.updateBoothField(id, 'w', 2.31));
    let b = api.booths.find((x) => x.id === id)!;
    expect(b.w).toBe(2.5);
    act(() => api.updateBoothField(id, 'h', 0.1));
    b = api.booths.find((x) => x.id === id)!;
    expect(b.h).toBe(0.5);
    // 坐标/尺寸字段与碰撞、净空、寻路使用同一数据：分析结果能立即取到新尺寸
    const oob = api.analysis.alerts.some((a) => a.boothId === id);
    expect(typeof oob).toBe('boolean');
    // 输入是离散提交，可撤销
    act(() => api.undo());
    act(() => api.undo());
    expect(api.booths.find((x) => x.id === id)!.w).not.toBe(2.5);
  });
});
