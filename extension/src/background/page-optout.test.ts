// @vitest-environment jsdom
/**
 * 页面 opt-out（协议 §4.7）单测：meta 匹配语义、同一 documentEpoch 只评估
 * 一次、epoch 提升后重新评估、loading/失败探针不缓存、tab 关闭回收缓存、
 * 命中抛 page_opt_out。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addTab,
  fireRemoved,
  installChrome,
  resetChromeState,
  stubSendCommand,
} from './test-chrome';

installChrome();

const {
  assertPageAllowed,
  forgetPageOptOut,
  isPageOptOutError,
  pageOptOut,
  pageOptOutError,
  PAGE_OPT_OUT_PROBE,
} = await import('./page-optout');
const refs = await import('./refs');

function isMetaProbe(params: { expression?: string }): boolean {
  return params.expression === PAGE_OPT_OUT_PROBE;
}

function cdpProbe(
  optOut: boolean,
  extra?: { ready?: boolean; exception?: boolean; raw?: unknown },
): unknown {
  if (extra?.exception) return { exceptionDetails: { text: 'boom' } };
  if (extra && 'raw' in extra) return extra.raw;
  return { result: { value: { ready: extra?.ready ?? true, optOut } } };
}

function runProbe(): { ready: boolean; optOut: boolean } {
  return new Function(`return ${PAGE_OPT_OUT_PROBE}`)() as { ready: boolean; optOut: boolean };
}

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example', status: 'complete' });
  refs.deleteTargetState(10);
  forgetPageOptOut(10);
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('meta 匹配语义（探针表达式）', () => {
  it('name 大小写不敏感', () => {
    document.head.innerHTML = '<meta name="CSI" content="disallow">';
    expect(runProbe().optOut).toBe(true);
  });

  it('content 去空白后小写等于 disallow', () => {
    document.head.innerHTML = '<meta name="csi" content="  Disallow  ">';
    expect(runProbe().optOut).toBe(true);
  });

  it('其他 content（含缺省）忽略', () => {
    document.head.innerHTML = '<meta name="csi" content="allow">';
    expect(runProbe().optOut).toBe(false);
    document.head.innerHTML = '<meta name="csi">';
    expect(runProbe().optOut).toBe(false);
    document.head.innerHTML = '';
    expect(runProbe().optOut).toBe(false);
  });

  it('多个 name=csi 时任一 disallow 即命中', () => {
    document.head.innerHTML =
      '<meta name="csi" content="allow"><meta name="csi" content="disallow">';
    expect(runProbe().optOut).toBe(true);
  });

  it('iframe 内的声明不传染顶层', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.contentDocument!.head.innerHTML = '<meta name="csi" content="disallow">';
    expect(runProbe().optOut).toBe(false);
  });

  it('ready 跟随 document.readyState', () => {
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
    expect(runProbe().ready).toBe(false);
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
    expect(runProbe().ready).toBe(true);
  });
});

describe('page opt-out 判定', () => {
  it('meta 命中 disallow → assertPageAllowed 抛 page_opt_out，文案含工具名与 meta 提示', async () => {
    const stub = stubSendCommand({
      'Runtime.evaluate': () => cdpProbe(true),
    });
    await expect(assertPageAllowed(10, 'click')).rejects.toMatchObject({
      name: 'ToolError',
      code: 'page_opt_out',
      message: expect.stringContaining('click: this page opted out of agent operation'),
    });
    expect(stub.calls.some((c) => isMetaProbe(c.params))).toBe(true);
    stub.restore();
  });

  it('未声明（evaluate 返回 false）→ 放行，不抛', async () => {
    const stub = stubSendCommand({
      'Runtime.evaluate': () => cdpProbe(false),
    });
    await expect(assertPageAllowed(10, 'snapshot')).resolves.toBeUndefined();
    stub.restore();
  });

  it('pageOptOutError 是 ToolError 且带 code；isPageOptOutError 只认该 code', () => {
    const err = pageOptOutError('navigate');
    expect(err.code).toBe('page_opt_out');
    expect(err.message).toContain('CSI will not act on this site');
    expect(isPageOptOutError(err)).toBe(true);
    expect(isPageOptOutError(new Error('nope'))).toBe(false);
  });
});

describe('epoch 缓存', () => {
  it('同一 documentEpoch 只发一次 Runtime.evaluate', async () => {
    let probes = 0;
    const stub = stubSendCommand({
      'Runtime.evaluate': () => {
        probes += 1;
        return cdpProbe(false);
      },
    });
    await pageOptOut(10);
    await pageOptOut(10);
    await assertPageAllowed(10, 'click');
    expect(probes).toBe(1);
    stub.restore();
  });

  it('bumpEpoch（导航/reload）后重新评估', async () => {
    let optOut = false;
    const stub = stubSendCommand({
      'Runtime.evaluate': () => cdpProbe(optOut),
    });
    await expect(pageOptOut(10)).resolves.toBe(false);
    refs.bumpEpoch(10, 'navigate');
    optOut = true;
    await expect(pageOptOut(10)).resolves.toBe(true);
    expect(stub.calls.filter((c) => isMetaProbe(c.params))).toHaveLength(2);
    stub.restore();
  });

  it('缓存命中的 opt-out 不再发 evaluate（对齐「只评估一次」）', async () => {
    let probes = 0;
    const stub = stubSendCommand({
      'Runtime.evaluate': () => {
        probes += 1;
        return cdpProbe(true);
      },
    });
    await expect(pageOptOut(10)).resolves.toBe(true);
    await expect(pageOptOut(10)).resolves.toBe(true);
    expect(probes).toBe(1);
    stub.restore();
  });

  it('loading 中的否定不缓存；下次再探可命中', async () => {
    let probes = 0;
    const stub = stubSendCommand({
      'Runtime.evaluate': () => {
        probes += 1;
        if (probes === 1) return cdpProbe(false, { ready: false });
        return cdpProbe(true);
      },
    });
    await expect(pageOptOut(10)).resolves.toBe(false);
    await expect(pageOptOut(10)).resolves.toBe(true);
    expect(probes).toBe(2);
    stub.restore();
  });

  it('loading 中的肯定命中可缓存', async () => {
    let probes = 0;
    const stub = stubSendCommand({
      'Runtime.evaluate': () => {
        probes += 1;
        return cdpProbe(true, { ready: false });
      },
    });
    await expect(pageOptOut(10)).resolves.toBe(true);
    await expect(pageOptOut(10)).resolves.toBe(true);
    expect(probes).toBe(1);
    stub.restore();
  });

  it('exceptionDetails 不写缓存，下次再探', async () => {
    let probes = 0;
    const stub = stubSendCommand({
      'Runtime.evaluate': () => {
        probes += 1;
        if (probes === 1) return cdpProbe(false, { exception: true });
        return cdpProbe(true);
      },
    });
    await expect(pageOptOut(10)).resolves.toBe(false);
    await expect(pageOptOut(10)).resolves.toBe(true);
    expect(probes).toBe(2);
    stub.restore();
  });

  it('非法返回形状不写缓存', async () => {
    let probes = 0;
    const stub = stubSendCommand({
      'Runtime.evaluate': () => {
        probes += 1;
        if (probes === 1) return cdpProbe(false, { raw: { result: { value: true } } });
        return cdpProbe(true);
      },
    });
    await expect(pageOptOut(10)).resolves.toBe(false);
    await expect(pageOptOut(10)).resolves.toBe(true);
    expect(probes).toBe(2);
    stub.restore();
  });

  it('tab 关闭 → onRemoved 回收缓存，同 id 重建后重新评估', async () => {
    let optOut = false;
    const stub = stubSendCommand({
      'Runtime.evaluate': () => cdpProbe(optOut),
    });
    await pageOptOut(10);
    fireRemoved(10);
    optOut = true;
    await expect(pageOptOut(10)).resolves.toBe(true);
    expect(stub.calls.filter((c) => isMetaProbe(c.params))).toHaveLength(2);
    stub.restore();
  });
});
