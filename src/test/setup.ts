/**
 * jsdom 测试环境补全：
 * - PointerEvent：jsdom 25 未提供构造器，用 MouseEvent 派生并补 pointerId/相关按键字段。
 * - WheelEvent：部分版本缺失，同样兜底。
 * - 打开 React 的 act 环境标志，使状态更新在 act() 内被正确刷新。
 * 仅在 DOM 环境下生效；纯函数测试仍跑在 node 环境。
 */
if (typeof window !== 'undefined') {
  if (typeof window.PointerEvent === 'undefined') {
    const PointerEventPoly = function (
      type: string,
      params: PointerEventInit = {},
    ) {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...params });
      Object.defineProperty(e, 'pointerId', {
        value: params.pointerId ?? 1,
      });
      Object.defineProperty(e, 'pointerType', {
        value: params.pointerType ?? 'mouse',
      });
      Object.defineProperty(e, 'isPrimary', {
        value: params.isPrimary ?? true,
      });
      return e;
    } as unknown as typeof PointerEvent;
    window.PointerEvent = PointerEventPoly;
    globalThis.PointerEvent = PointerEventPoly;
  }

  if (typeof window.WheelEvent === 'undefined') {
    const WheelEventPoly = function (
      type: string,
      params: WheelEventInit = {},
    ) {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...params });
      Object.defineProperty(e, 'deltaX', { value: params.deltaX ?? 0 });
      Object.defineProperty(e, 'deltaY', { value: params.deltaY ?? 0 });
      Object.defineProperty(e, 'deltaMode', { value: params.deltaMode ?? 0 });
      return e;
    } as unknown as typeof WheelEvent;
    window.WheelEvent = WheelEventPoly;
    globalThis.WheelEvent = WheelEventPoly;
  }

  // 让 react-dom/test-utils 的 act() 在异步事件派发后正确 flush。
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
}
