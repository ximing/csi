/**
 * send_keys（协议 §4.4）单测：键序列解析（命名键/F 键/字母数字）、修饰键
 * 按下-累计-逆序释放的事件序列、repeat、错误分支；Mod 的平台解析
 * （mac→Cmd，其他→Ctrl）。Input.dispatchKeyEvent 序列按调用顺序断言。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTab, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { SendKeysTool } = await import('./send-keys');

const ctx = { tabId: 10, documentEpoch: 1 };

interface Recorded {
  method: string;
  params: any;
}

const calls: Recorded[] = [];
const originalSend = chrome.debugger.sendCommand;

// fake chrome 没有 runtime.getPlatformInfo，这里局部补上（默认 mac）。
const runtime = chrome.runtime as unknown as { getPlatformInfo?: () => Promise<{ os: string }> };
const originalPlatform = runtime.getPlatformInfo;

beforeAll(() => {
  runtime.getPlatformInfo = async () => ({ os: 'mac' });
});

afterAll(() => {
  runtime.getPlatformInfo = originalPlatform;
});

function record(): void {
  calls.length = 0;
  (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
    (async (_debuggee: { tabId: number }, method: string, params?: unknown) => {
      calls.push({ method, params });
      return {};
    }) as typeof chrome.debugger.sendCommand;
}

afterEach(() => {
  (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = originalSend;
});

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
});

function keyCalls(): any[] {
  return calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params);
}

/** 每条事件压成 [type, key, modifiers, text] 便于整序列断言。 */
function seq(): (string | number | undefined)[][] {
  return keyCalls().map((p) => [p.type, p.key, p.modifiers, p.text]);
}

describe('send_keys 参数校验', () => {
  it('keys 缺失 / 非字符串 / 空白抛错', async () => {
    await expect(new SendKeysTool().execute({}, ctx)).rejects.toThrow(/keys is required/);
    await expect(new SendKeysTool().execute({ keys: 5 }, ctx)).rejects.toThrow(/keys is required/);
    await expect(new SendKeysTool().execute({ keys: '   ' }, ctx)).rejects.toThrow(/keys is required/);
  });

  it('repeat 必须是 [1,100] 的整数', async () => {
    for (const bad of [0, -1, 1.5, 101, 'abc']) {
      await expect(new SendKeysTool().execute({ keys: 'Enter', repeat: bad }, ctx)).rejects.toThrow(
        /repeat must be an integer/,
      );
    }
  });
});

describe('send_keys 键解析', () => {
  it('命名键 Enter：keyDown 带 text \\r 再 keyUp', async () => {
    record();
    const res = (await new SendKeysTool().execute({ keys: 'Enter' }, ctx)) as any;
    expect(res).toEqual({ success: true, dispatched: 1, os: 'mac' });
    expect(seq()).toEqual([
      ['keyDown', 'Enter', 0, '\r'],
      ['keyUp', 'Enter', 0, undefined],
    ]);
    expect(keyCalls()[0]).toMatchObject({ code: 'Enter', windowsVirtualKeyCode: 13 });
  });

  it('别名映射：return→Enter，esc→Escape', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'return' }, ctx);
    expect(keyCalls()[0]).toMatchObject({ key: 'Enter', windowsVirtualKeyCode: 13 });

    record();
    await new SendKeysTool().execute({ keys: 'esc' }, ctx);
    expect(keyCalls()[0]).toMatchObject({ key: 'Escape', windowsVirtualKeyCode: 27 });
  });

  it('字母 / 数字 / Space', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'a' }, ctx);
    expect(keyCalls()[0]).toMatchObject({
      key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a',
    });

    record();
    await new SendKeysTool().execute({ keys: '5' }, ctx);
    expect(keyCalls()[0]).toMatchObject({
      key: '5', code: 'Digit5', windowsVirtualKeyCode: 53, text: '5',
    });

    record();
    await new SendKeysTool().execute({ keys: 'Space' }, ctx);
    expect(keyCalls()[0]).toMatchObject({ key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
  });

  it('F1-F12：vkc 111+n；越界（F0/F13）与未知键抛错', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'F1' }, ctx);
    expect(keyCalls()[0]).toMatchObject({ key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 });

    record();
    await new SendKeysTool().execute({ keys: 'f12' }, ctx);
    expect(keyCalls()[0]).toMatchObject({ key: 'F12', windowsVirtualKeyCode: 123 });

    for (const bad of ['F0', 'f13', 'Foo', '!']) {
      await expect(new SendKeysTool().execute({ keys: bad }, ctx)).rejects.toThrow(
        `send_keys: unknown key "${bad}"`,
      );
    }
  });
});

describe('send_keys 修饰键序列（os=mac）', () => {
  it('Ctrl+A：按下 Ctrl → a（无 text）→ 松 a → 松 Ctrl', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Ctrl+A' }, ctx);
    expect(seq()).toEqual([
      ['keyDown', 'Control', 2, undefined],
      ['keyDown', 'a', 2, undefined],
      ['keyUp', 'a', 2, undefined],
      ['keyUp', 'Control', 0, undefined],
    ]);
  });

  it('Cmd/Meta 别名：bit 4，Meta 键', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Cmd+A' }, ctx);
    expect(keyCalls()[0]).toMatchObject({ key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 });
    expect(seq()[1]).toEqual(['keyDown', 'a', 4, undefined]);
  });

  it('Alt+Tab：alt bit 1，无 text', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Alt+Tab' }, ctx);
    expect(seq()).toEqual([
      ['keyDown', 'Alt', 1, undefined],
      ['keyDown', 'Tab', 1, undefined],
      ['keyUp', 'Tab', 1, undefined],
      ['keyUp', 'Alt', 0, undefined],
    ]);
  });

  it('Shift+A：字母大写并产生 text（shift 不抑制 text）', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Shift+A' }, ctx);
    expect(seq()).toEqual([
      ['keyDown', 'Shift', 8, undefined],
      ['keyDown', 'A', 8, 'A'],
      ['keyUp', 'A', 8, undefined],
      ['keyUp', 'Shift', 0, undefined],
    ]);
  });

  it('Shift+Enter：非字母不升大写，text 保留', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Shift+Enter' }, ctx);
    expect(seq()[1]).toEqual(['keyDown', 'Enter', 8, '\r']);
  });

  it('多修饰键：按下按位累计、释放逆序清位', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Ctrl+Shift+A' }, ctx);
    expect(seq()).toEqual([
      ['keyDown', 'Control', 2, undefined],
      ['keyDown', 'Shift', 10, undefined],
      ['keyDown', 'A', 10, undefined],
      ['keyUp', 'A', 10, undefined],
      ['keyUp', 'Shift', 2, undefined],
      ['keyUp', 'Control', 0, undefined],
    ]);
  });

  it('Mod+A：keyDown 附带 commands:["selectAll"]（协议 §4.4，否则真实页面全选不生效）', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Mod+A' }, ctx);
    expect(seq()).toEqual([
      ['keyDown', 'Meta', 4, undefined],
      ['keyDown', 'a', 4, undefined],
      ['keyUp', 'a', 4, undefined],
      ['keyUp', 'Meta', 0, undefined],
    ]);
    expect(keyCalls()[1]).toMatchObject({ commands: ['selectAll'] });
  });

  it('修饰键名不区分大小写（MOD / Control 别名）', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'MOD+a' }, ctx);
    expect(keyCalls()[0]).toMatchObject({ key: 'Meta', modifiers: 4 });

    record();
    await new SendKeysTool().execute({ keys: 'Control+A' }, ctx);
    expect(keyCalls()[0]).toMatchObject({ key: 'Control', modifiers: 2 });
  });

  it('非修饰键前缀抛错', async () => {
    await expect(new SendKeysTool().execute({ keys: 'Foo+Bar' }, ctx)).rejects.toThrow(
      /"Foo" is not a modifier/,
    );
  });

  it('editing commands 映射（协议 §4.4，os=mac）：Cmd/Mod 组合按 macOS 语义映射', async () => {
    const cases: [string, string[]][] = [
      ['Mod+A', ['selectAll']],
      ['Cmd+C', ['copy']],
      ['Mod+X', ['cut']],
      ['Cmd+V', ['paste']],
      ['Mod+Z', ['undo']],
      // macOS 语义是行级/文档级，不是 Windows 的词级/段落级
      ['Mod+Backspace', ['deleteToBeginningOfLine']],
      ['Cmd+Delete', ['deleteToEndOfLine']],
      ['Mod+ArrowLeft', ['moveToBeginningOfLine']],
      ['Cmd+ArrowRight', ['moveToEndOfLine']],
      ['Mod+ArrowUp', ['moveToBeginningOfDocument']],
      ['Cmd+ArrowDown', ['moveToEndOfDocument']],
      ['Mod+Home', ['moveToBeginningOfDocument']],
      ['Cmd+End', ['moveToEndOfDocument']],
    ];
    for (const [keys, commands] of cases) {
      record();
      await new SendKeysTool().execute({ keys }, ctx);
      const main = keyCalls().find((p) => p.type === 'keyDown' && !/Meta|Shift/.test(p.key))!;
      expect(main.commands, keys).toEqual(commands);
    }
  });

  it('Cmd+Shift+Z → redo：Shift 同按用 shift 映射，applyShift 大写后不丢', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Cmd+Shift+Z' }, ctx);
    const main = keyCalls().find((p) => p.type === 'keyDown' && p.key === 'Z')!;
    expect(main.modifiers).toBe(12);
    expect(main.commands).toEqual(['redo']);
  });

  it('Cmd+Shift+移动键 → AndModifySelection 变体（协议 §4.4）：真实语义是扩展选区', async () => {
    // CDP commands 按名 verbatim 执行，不会从 Shift 修饰位推导选区扩展变体；
    // 沿用基础移动命令会把已有选区折叠掉。
    const cases: [string, string[]][] = [
      ['Cmd+Shift+ArrowLeft', ['moveToBeginningOfLineAndModifySelection']],
      ['Mod+Shift+ArrowRight', ['moveToEndOfLineAndModifySelection']],
      ['Cmd+Shift+ArrowUp', ['moveToBeginningOfDocumentAndModifySelection']],
      ['Mod+Shift+ArrowDown', ['moveToEndOfDocumentAndModifySelection']],
      ['Cmd+Shift+Home', ['moveToBeginningOfDocumentAndModifySelection']],
      ['Cmd+Shift+End', ['moveToEndOfDocumentAndModifySelection']],
    ];
    for (const [keys, commands] of cases) {
      record();
      await new SendKeysTool().execute({ keys }, ctx);
      const main = keyCalls().find((p) => p.type === 'keyDown' && !/Meta|Shift/.test(p.key))!;
      expect(main.modifiers, keys).toBe(12);
      expect(main.commands, keys).toEqual(commands);
    }
  });

  it('Alt 同按不附带 commands（协议 §4.4）：Ctrl+Alt+Delete 不得真删词', async () => {
    record();
    await new SendKeysTool().execute({ keys: 'Ctrl+Alt+Delete' }, ctx);
    const main = keyCalls().find((p) => p.type === 'keyDown' && p.key === 'Delete')!;
    expect(main.modifiers).toBe(3);
    expect(main).not.toHaveProperty('commands');
  });

  it('非平台主修饰键不附带：mac 上显式 Ctrl 组合不是 macOS 编辑语义', async () => {
    for (const keys of ['Ctrl+A', 'Ctrl+Backspace', 'Ctrl+ArrowLeft']) {
      record();
      await new SendKeysTool().execute({ keys }, ctx);
      const main = keyCalls().find((p) => p.type === 'keyDown' && !/Control|Meta|Shift/.test(p.key))!;
      expect(main, keys).not.toHaveProperty('commands');
    }
  });

  it('Shift/Alt 不产生 commands；无映射的组合也不附带', async () => {
    for (const keys of ['Shift+A', 'Alt+Tab', 'Ctrl+Q', 'Ctrl+F5']) {
      record();
      await new SendKeysTool().execute({ keys }, ctx);
      const main = keyCalls().find((p) => p.type === 'keyDown' && !/Alt|Control|Meta|Shift/.test(p.key))!;
      expect(main, keys).not.toHaveProperty('commands');
    }
  });

  it('空段（只有 +）抛错', async () => {
    await expect(new SendKeysTool().execute({ keys: '+' }, ctx)).rejects.toThrow(/empty segment/);
  });
});

describe('send_keys 序列与 repeat', () => {
  it('空格分段多段依次派发', async () => {
    record();
    const res = (await new SendKeysTool().execute({ keys: '  Enter   Escape ' }, ctx)) as any;
    expect(res.dispatched).toBe(2);
    expect(seq()).toEqual([
      ['keyDown', 'Enter', 0, '\r'],
      ['keyUp', 'Enter', 0, undefined],
      ['keyDown', 'Escape', 0, undefined],
      ['keyUp', 'Escape', 0, undefined],
    ]);
  });

  it('repeat 重复整段（含修饰键完整序列）', async () => {
    record();
    const res = (await new SendKeysTool().execute({ keys: 'Ctrl+A', repeat: 3 }, ctx)) as any;
    expect(res.dispatched).toBe(3);
    expect(keyCalls()).toHaveLength(3 * 4);
    // 每轮都完整按下/释放修饰键。
    expect(seq().slice(0, 4)).toEqual(seq().slice(4, 8));
  });

  it('repeat 接受数字字符串（边界 1 与 100）', async () => {
    record();
    const r1 = (await new SendKeysTool().execute({ keys: 'Enter', repeat: '1' }, ctx)) as any;
    expect(r1.dispatched).toBe(1);

    const r100 = (await new SendKeysTool().execute({ keys: 'Enter', repeat: 100 }, ctx)) as any;
    expect(r100.dispatched).toBe(100);
  });
});

describe('send_keys Mod 的平台解析', () => {
  it('非 mac 平台 Mod 解析为 Ctrl', async () => {
    // 换一份新模块：cachedOs 是模块级缓存，只有新实例才会重新取平台信息。
    vi.resetModules();
    runtime.getPlatformInfo = async () => ({ os: 'win' });
    try {
      const fresh = await import('./send-keys');
      record();
      const res = (await new fresh.SendKeysTool().execute({ keys: 'Mod+A' }, ctx)) as any;
      expect(res.os).toBe('win');
      expect(keyCalls()[0]).toMatchObject({ key: 'Control', modifiers: 2 });
    } finally {
      runtime.getPlatformInfo = async () => ({ os: 'mac' });
    }
  });

  it('win：Mod 用 Windows 语义（词级移动/删除，Shift+Z 与 Y 都是 redo）', async () => {
    vi.resetModules();
    runtime.getPlatformInfo = async () => ({ os: 'win' });
    try {
      const fresh = await import('./send-keys');
      const cases: [string, string[]][] = [
        ['Mod+A', ['selectAll']],
        ['Mod+Z', ['undo']],
        ['Mod+Shift+Z', ['redo']],
        ['Mod+Y', ['redo']],
        ['Mod+Backspace', ['deleteWordBackward']],
        ['Mod+Delete', ['deleteWordForward']],
        ['Mod+ArrowLeft', ['moveWordLeft']],
        ['Mod+ArrowRight', ['moveWordRight']],
        ['Mod+ArrowUp', ['moveToBeginningOfParagraph']],
        ['Mod+ArrowDown', ['moveToEndOfParagraph']],
        ['Mod+Home', ['moveToBeginningOfDocument']],
        ['Mod+End', ['moveToEndOfDocument']],
        // Shift 同按：移动类用 AndModifySelection 变体（扩展选区，协议 §4.4）
        ['Mod+Shift+ArrowLeft', ['moveWordLeftAndModifySelection']],
        ['Mod+Shift+ArrowRight', ['moveWordRightAndModifySelection']],
        ['Mod+Shift+ArrowUp', ['moveToBeginningOfParagraphAndModifySelection']],
        ['Mod+Shift+ArrowDown', ['moveToEndOfParagraphAndModifySelection']],
        ['Mod+Shift+Home', ['moveToBeginningOfDocumentAndModifySelection']],
        ['Mod+Shift+End', ['moveToEndOfDocumentAndModifySelection']],
      ];
      for (const [keys, commands] of cases) {
        record();
        await new fresh.SendKeysTool().execute({ keys }, ctx);
        const main = keyCalls().find((p) => p.type === 'keyDown' && !/Control|Meta|Shift/.test(p.key))!;
        expect(main.commands, keys).toEqual(commands);
      }
    } finally {
      runtime.getPlatformInfo = async () => ({ os: 'mac' });
    }
  });

  it('win：显式 Cmd（Meta）不是主修饰键，不附带 commands', async () => {
    vi.resetModules();
    runtime.getPlatformInfo = async () => ({ os: 'win' });
    try {
      const fresh = await import('./send-keys');
      record();
      await new fresh.SendKeysTool().execute({ keys: 'Cmd+A' }, ctx);
      const main = keyCalls().find((p) => p.type === 'keyDown' && p.key === 'a')!;
      expect(main).not.toHaveProperty('commands');
    } finally {
      runtime.getPlatformInfo = async () => ({ os: 'mac' });
    }
  });
});
