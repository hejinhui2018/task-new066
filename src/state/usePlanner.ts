/**
 * 排展工作台应用状态：展位列表 + 选中 + 撤销/重做 + 本地持久化。
 * 拖拽过程中用 liveUpdateBooth 实时刷新画面（不入历史），松手时 commit 一次，
 * 保证一次拖动 = 一条撤销记录。
 *
 * 交互生命周期（与 FloorPlan 指针会话严格对应）：
 *   beginInteraction（pointerdown，锁定交互前快照）
 *     -> liveUpdateBooth（移动中，只改画面）
 *     -> commitInteraction（pointerup，提交一条历史）
 *     或 cancelInteraction（pointercancel / lostpointercapture，恢复快照且不入历史）
 *
 * 注意：所有对外部可变 History 的读写都在事件处理中基于 planRef 完成，
 * 不放进 setState 的 updater 内（StrictMode 会双调用 updater）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Booth, PlanState } from '../types';
import { History } from '../lib/history';
import { analyzePlan } from '../lib/validation';
import { blockedExitScenario, emptyPlan, newBoothAt } from '../lib/scenarios';
import { loadPlan, savePlan } from '../lib/persistence';
import { GRID_SIZE } from '../constants';
import { snapToGrid } from '../lib/grid';
import { rotate90 } from '../lib/geometry';

function planEquals(a: PlanState, b: PlanState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function initialPlan(): PlanState {
  return loadPlan() ?? blockedExitScenario();
}

export function usePlanner() {
  const [plan, setPlanState] = useState<PlanState>(initialPlan);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const planRef = useRef(plan);
  const historyRef = useRef<History<PlanState> | null>(null);
  if (historyRef.current === null) {
    historyRef.current = new History<PlanState>(plan, 100, planEquals);
  }
  const history = historyRef.current;

  /**
   * 交互进行中标志 + 交互开始时的快照。
   * 标志为 true 时拒绝 undo/redo（避免在一次拖动中途把历史指针挪走，
   * 导致松手 commit 到错误的基线、撤销无法回到原网格位置）。
   */
  const interactingRef = useRef(false);
  const interactionBaseRef = useRef<PlanState | null>(null);

  // 历史能力标志（undo/redo 后刷新）
  const [, setHistoryVersion] = useState(0);
  const bumpHistory = () => setHistoryVersion((v) => v + 1);

  /** 统一的状态写入：同步更新 ref，供事件处理中立即读到最新值。 */
  const applyPlan = useCallback((next: PlanState) => {
    planRef.current = next;
    setPlanState(next);
  }, []);

  // 持久化
  useEffect(() => {
    savePlan(plan);
  }, [plan]);

  const analysis = useMemo(() => analyzePlan(plan.booths), [plan.booths]);

  const replaceBooth = useCallback(
    (id: string, patch: Partial<Booth>) => {
      const next: PlanState = {
        booths: planRef.current.booths.map((b) =>
          b.id === id ? { ...b, ...patch } : b,
        ),
      };
      planRef.current = next;
      setPlanState(next);
    },
    [],
  );

  /** 拖拽/缩放过程中调用：只更新画面，不入历史。 */
  const liveUpdateBooth = replaceBooth;

  /**
   * 交互开始（pointerdown 起拖/起缩放）：记录交互前快照。
   * 幂等：同一次手势重复调用不会覆盖最初的快照。
   */
  const beginInteraction = useCallback(() => {
    if (interactingRef.current) return;
    interactingRef.current = true;
    interactionBaseRef.current = planRef.current;
  }, []);

  /** 交互结束：把最终状态作为一条历史提交。 */
  const commitInteraction = useCallback(() => {
    if (!interactingRef.current) return;
    interactingRef.current = false;
    interactionBaseRef.current = null;
    applyPlan(history.commit(planRef.current));
    bumpHistory();
  }, [history, applyPlan]);

  /**
   * 安全结束：pointercancel / lostpointercapture 时把展位恢复到交互前的网格位置，
   * 不产生历史记录，撤销栈保持交互发生前的状态。
   */
  const cancelInteraction = useCallback(() => {
    if (!interactingRef.current) return;
    const base = interactionBaseRef.current;
    interactingRef.current = false;
    interactionBaseRef.current = null;
    if (base) applyPlan(base);
  }, [applyPlan]);

  /**
   * 离散操作（旋转、删除、改参数）立即提交一条历史。
   * 若调用时正处于拖拽手势中（例如按住展位时按 R），不单独产生历史，
   * 而是并入当前手势——松手时随拖动结果一起提交一条记录，保证历史线性。
   */
  const commitNow = useCallback(
    (updater: (prev: PlanState) => PlanState) => {
      const next = updater(planRef.current);
      planRef.current = next;
      setPlanState(next);
      if (interactingRef.current) return;
      applyPlan(history.commit(next));
      bumpHistory();
    },
    [history, applyPlan],
  );

  const addBooth = useCallback(() => {
    const prev = planRef.current;
    const index = prev.booths.length;
    // 阶梯偏移，避免新展位完全叠在一起；全部落在网格上。
    const booth = newBoothAt(
      snapToGrid(1 + (index % 8) * GRID_SIZE),
      snapToGrid(1 + (index % 8) * GRID_SIZE),
      index,
    );
    commitNow(() => ({ booths: [...prev.booths, booth] }));
    setSelectedId(booth.id);
  }, [commitNow]);

  /** 在指定米坐标处添加（双击画布），坐标已吸附。 */
  const addBoothAt = useCallback(
    (x: number, y: number) => {
      const prev = planRef.current;
      const index = prev.booths.length;
      const booth = newBoothAt(
        snapToGrid(x - 1.5, GRID_SIZE),
        snapToGrid(y - 1, GRID_SIZE),
        index,
      );
      commitNow(() => ({ booths: [...prev.booths, booth] }));
      setSelectedId(booth.id);
    },
    [commitNow],
  );

  const rotateBooth = useCallback(
    (id: string) => {
      commitNow((prev) => ({
        booths: prev.booths.map((b) => (b.id === id ? rotate90(b) : b)),
      }));
    },
    [commitNow],
  );

  const rotateSelected = useCallback(() => {
    if (selectedId) rotateBooth(selectedId);
  }, [rotateBooth, selectedId]);

  /** 检查器：修改朝向（不交换宽高）。 */
  const setOrientation = useCallback(
    (id: string, orientation: Booth['orientation']) => {
      commitNow((prev) => ({
        booths: prev.booths.map((b) =>
          b.id === id ? { ...b, orientation } : b,
        ),
      }));
    },
    [commitNow],
  );

  /** 检查器：修改标签/数值字段（数值吸附到网格）。 */
  const updateBoothField = useCallback(
    (
      id: string,
      field: 'label' | 'x' | 'y' | 'w' | 'h',
      value: string | number,
    ) => {
      commitNow((prev) => ({
        booths: prev.booths.map((b) => {
          if (b.id !== id) return b;
          if (field === 'label') return { ...b, label: String(value) };
          const num = snapToGrid(Math.max(GRID_SIZE, Number(value) || 0));
          return { ...b, [field]: num };
        }),
      }));
    },
    [commitNow],
  );

  const deleteBooth = useCallback(
    (id: string) => {
      commitNow((prev) => ({
        booths: prev.booths.filter((b) => b.id !== id),
      }));
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [commitNow],
  );

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteBooth(selectedId);
  }, [deleteBooth, selectedId]);

  const undo = useCallback(() => {
    // 拖动/缩放手势未结束时禁止撤销，否则历史基线与正在 live 编辑的状态错位。
    if (interactingRef.current) return;
    applyPlan(history.undo());
    bumpHistory();
  }, [history, applyPlan]);

  const redo = useCallback(() => {
    if (interactingRef.current) return;
    applyPlan(history.redo());
    bumpHistory();
  }, [history, applyPlan]);

  const resetPlan = useCallback(
    (target: 'empty' | 'blocked-exit' = 'empty') => {
      if (interactingRef.current) return;
      const next = target === 'empty' ? emptyPlan() : blockedExitScenario();
      // 作为一条历史提交，重置/载入示例后可用 Ctrl+Z 恢复原方案
      applyPlan(history.commit(next));
      setSelectedId(null);
      bumpHistory();
    },
    [history, applyPlan],
  );

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (
        (mod && e.key.toLowerCase() === 'y') ||
        (mod && e.shiftKey && e.key.toLowerCase() === 'z')
      ) {
        e.preventDefault();
        redo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
      } else if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        rotateSelected();
      } else if (e.key.startsWith('Arrow') && selectedId) {
        e.preventDefault();
        const id = selectedId;
        const dx =
          e.key === 'ArrowRight'
            ? GRID_SIZE
            : e.key === 'ArrowLeft'
              ? -GRID_SIZE
              : 0;
        const dy =
          e.key === 'ArrowDown'
            ? GRID_SIZE
            : e.key === 'ArrowUp'
              ? -GRID_SIZE
              : 0;
        if (dx || dy) {
          commitNow((prev) => ({
            booths: prev.booths.map((b) =>
              b.id === id
                ? {
                    ...b,
                    x: snapToGrid(b.x + dx),
                    y: snapToGrid(b.y + dy),
                  }
                : b,
            ),
          }));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, deleteSelected, rotateSelected, selectedId, commitNow]);

  return {
    booths: plan.booths,
    selectedId,
    analysis,
    selectBooth: setSelectedId,
    addBooth,
    addBoothAt,
    replaceBooth,
    liveUpdateBooth,
    beginInteraction,
    commitInteraction,
    cancelInteraction,
    commitNow,
    rotateSelected,
    rotateBooth,
    setOrientation,
    updateBoothField,
    deleteBooth,
    deleteSelected,
    undo,
    redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    resetPlan,
  };
}

export type PlannerApi = ReturnType<typeof usePlanner>;
