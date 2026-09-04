/**
 * scroll 工具测试（协议 §4）：selector/to/direction 三选一校验、to=top/bottom、
 * 四个 direction × amount（默认 page / 数字）、Runtime.evaluate 异常与形状不符、
 * selector 走 scrollIntoView 共享路径。sendCommand 局部按 expression 分发，
 * afterEach 恢复共享 fake。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, debuggerCalls, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { ScrollTool } = await import('./scroll');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

const POS = { x: 1.4, y: 2.6, maxX: 10.2, maxY: 20.7 };

let dispatch: (method: string, params: any) => any = () => ({});
const calls: { method: string; params: any }[] = [];
const origSendCommand = chrome.debugger.sendCommand;

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
  calls.length = 0;
  dispatch = () => ({});
  chrome.debugger.sendCommand = (async (debuggee: { tabId: number }, method: string, params?: object) => {
    debuggerCalls.push({ tabId: debuggee.tabId, method, t: Date.now() });
    calls.push({ method, params });
    return dispatch(method, params);
  }) as typeof chrome.debugger.sendCommand;
});

afterEach(() => {
  chrome.debugger.sendCommand = origSendCommand;
});

/** 默认分发：scroll 位置表达式返回 POS，querySelector 返回 objectId。 */
function posDispatch(overrides: Record<string, (params: any) => any> = {}): (m: string, p: any) => any {
  return (m, p) => {
    const override = overrides[m];
    if (override) return override(p);
    if (m === 'Runtime.evaluate') {
      const expr = String(p.expression ?? '');
      if (expr.includes('window.scrollX')) return { result: { value: POS } };
      if (expr.includes('document.querySelector')) return { result: { objectId: 'obj-1' } };
    }
    return {};
  };
}

function scrollExpression(): string {
  const evals = calls.filter((c) => c.method === 'Runtime.evaluate');
  return String(evals[evals.length - 1]?.params.expression ?? '');
}

describe('scroll 参数校验', () => {
  it('一个都不给 → 报错', async () => {
    await expect(new ScrollTool().execute({}, ctx)).rejects.toThrow(
      /exactly one of selector, to, direction/,
    );
  });

  it('同时给 selector 和 to → 报错', async () => {
    await expect(
      new ScrollTool().execute({ selector: '#a', to: 'top' }, ctx),
    ).rejects.toThrow(/exactly one of/);
  });

  it('to 只能是 top/bottom', async () => {
    await expect(new ScrollTool().execute({ to: 'middle' }, ctx)).rejects.toThrow(
      /to must be top or bottom/,
    );
  });

  it('direction 只能是 up/down/left/right', async () => {
    await expect(new ScrollTool().execute({ direction: 'sideways' }, ctx)).rejects.toThrow(
      /direction must be up, down, left, or right/,
    );
  });

  it('amount 必须是数字或 "page"', async () => {
    await expect(
      new ScrollTool().execute({ direction: 'down', amount: 'lots' }, ctx),
    ).rejects.toThrow(/amount must be a number or "page"/);
  });
});

describe('scroll to', () => {
  it('top：scrollTo(0,0)，位置四舍五入', async () => {
    dispatch = posDispatch();
    const res = (await new ScrollTool().execute({ to: 'top' }, ctx)) as Record<string, number | boolean>;
    expect(res).toEqual({ success: true, x: 1, y: 3, maxX: 10, maxY: 21 });
    expect(scrollExpression()).toContain('window.scrollTo(0, 0)');
  });

  it('bottom：scrollTo 到 scrollHeight', async () => {
    dispatch = posDispatch();
    await new ScrollTool().execute({ to: 'bottom' }, ctx);
    expect(scrollExpression()).toContain('window.scrollTo(0, document.documentElement.scrollHeight)');
  });
});

describe('scroll direction × amount', () => {
  it('up + 默认 page：-0.9*innerHeight', async () => {
    dispatch = posDispatch();
    await new ScrollTool().execute({ direction: 'up' }, ctx);
    expect(scrollExpression()).toContain('window.scrollBy(0, -(0.9 * window.innerHeight))');
  });

  it('up + 显式 "page" 等价默认', async () => {
    dispatch = posDispatch();
    await new ScrollTool().execute({ direction: 'up', amount: 'page' }, ctx);
    expect(scrollExpression()).toContain('-(0.9 * window.innerHeight)');
  });

  it('amount null 也按 page 处理', async () => {
    dispatch = posDispatch();
    await new ScrollTool().execute({ direction: 'up', amount: null }, ctx);
    expect(scrollExpression()).toContain('-(0.9 * window.innerHeight)');
  });

  it('down + 数字：scrollBy(0, (300))', async () => {
    dispatch = posDispatch();
    await new ScrollTool().execute({ direction: 'down', amount: 300 }, ctx);
    expect(scrollExpression()).toContain('window.scrollBy(0, (300))');
  });

  it('left + 数字：水平负向', async () => {
    dispatch = posDispatch();
    await new ScrollTool().execute({ direction: 'left', amount: 250 }, ctx);
    expect(scrollExpression()).toContain('window.scrollBy(-((250)), 0)');
  });

  it('right + 默认 page：+0.9*innerWidth', async () => {
    dispatch = posDispatch();
    await new ScrollTool().execute({ direction: 'right' }, ctx);
    expect(scrollExpression()).toContain('window.scrollBy(0.9 * window.innerWidth, 0)');
  });
});

describe('scroll selector（scrollIntoView 共享路径）', () => {
  it('CSS selector：querySelector→callFunctionOn→读位置', async () => {
    dispatch = posDispatch();
    const res = (await new ScrollTool().execute({ selector: '#a' }, ctx)) as Record<string, number | boolean>;
    expect(res).toEqual({ success: true, x: 1, y: 3, maxX: 10, maxY: 21 });
    expect(calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(true);
    expect(scrollExpression()).toContain('window.scrollX');
  });

  it('@e ref selector 同样可用', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    dispatch = (m) => {
      if (m === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      if (m === 'Runtime.evaluate') return { result: { value: POS } };
      return {};
    };
    const res = (await new ScrollTool().execute({ selector: '@e1' }, ctx)) as Record<string, number | boolean>;
    expect(res).toEqual({ success: true, x: 1, y: 3, maxX: 10, maxY: 21 });
  });
});

describe('scroll evaluate 结果处理', () => {
  it('页面抛异常：优先用 exception.description', async () => {
    dispatch = posDispatch({
      'Runtime.evaluate': () => ({
        exceptionDetails: { text: 'short', exception: { description: 'TypeError: boom at line 1' } },
      }),
    });
    await expect(new ScrollTool().execute({ to: 'top' }, ctx)).rejects.toThrow(
      /scroll: TypeError: boom at line 1/,
    );
  });

  it('页面抛异常无 description：回退到 text', async () => {
    dispatch = posDispatch({
      'Runtime.evaluate': () => ({ exceptionDetails: { text: 'short' } }),
    });
    await expect(new ScrollTool().execute({ to: 'top' }, ctx)).rejects.toThrow(/scroll: short/);
  });

  it('返回形状不符（缺字段）→ failed to read', async () => {
    dispatch = posDispatch({ 'Runtime.evaluate': () => ({ result: { value: { x: 0, y: 0, maxX: 0 } } }) });
    await expect(new ScrollTool().execute({ to: 'top' }, ctx)).rejects.toThrow(
      /failed to read window scroll position/,
    );
  });

  it('返回没有 value → failed to read', async () => {
    dispatch = posDispatch({ 'Runtime.evaluate': () => ({ result: {} }) });
    await expect(new ScrollTool().execute({ to: 'top' }, ctx)).rejects.toThrow(
      /failed to read window scroll position/,
    );
  });

  it('字段类型不对（x 是字符串）→ failed to read', async () => {
    dispatch = posDispatch({
      'Runtime.evaluate': () => ({ result: { value: { x: '0', y: 0, maxX: 0, maxY: 0 } } }),
    });
    await expect(new ScrollTool().execute({ to: 'top' }, ctx)).rejects.toThrow(
      /failed to read window scroll position/,
    );
  });
});
