/**
 * send_keys (protocol §4.4): synthesize key events via
 * Input.dispatchKeyEvent. Supports modifiers (Alt/Ctrl/Cmd/Meta/Shift/Mod),
 * F1-F12, named keys, single letters/digits, space-separated segments and
 * repeat counts. Modifier bitmask: alt=1 ctrl=2 cmd=4 shift=8.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';

interface KeySpec {
  key: string;
  code: string;
  vkc: number;
  text?: string;
}

interface ModifierSpec extends KeySpec {
  bit: number;
}

const MODIFIERS: Record<string, ModifierSpec> = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', vkc: 18 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', vkc: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vkc: 17 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', vkc: 91 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', vkc: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vkc: 16 },
};

const SHIFT_BIT = MODIFIERS.shift!.bit;
const CTRL_BIT = MODIFIERS.ctrl!.bit;
const CMD_BIT = MODIFIERS.cmd!.bit;
const ALT_BIT = MODIFIERS.alt!.bit;

interface EditingMapping {
  commands: string[];
  /** Shift 同按时的替代映射；缺省沿用 commands。 */
  shift?: string[];
}

/**
 * 平台主修饰键 + 主键 → CDP editing command（协议 §4.4）。真实 Chrome 里全选、
 * 复制等编辑快捷键由 Chromium 内部 editing command 生效，不是 keyDown 事件
 * 本身；keyDown 必须附带 `commands` 参数，否则组合键在真实页面上是空操作。
 * 两张表各按平台真实语义：macOS 是行级/文档级，Windows/Linux 是词级/段落级。
 * Alt 同按不映射（Alt 组合不是编辑命令）；Shift+Z 在两平台都是 redo。
 * Shift+移动键必须用 ...AndModifySelection 变体：CDP commands 按名 verbatim
 * 执行，不会从 Shift 修饰位推导选区扩展，沿用基础移动命令会折叠已有选区。
 */
const EDITING_COMMANDS_MAC: Record<string, EditingMapping> = {
  a: { commands: ['selectAll'] },
  c: { commands: ['copy'] },
  x: { commands: ['cut'] },
  v: { commands: ['paste'] },
  z: { commands: ['undo'], shift: ['redo'] },
  Backspace: { commands: ['deleteToBeginningOfLine'] },
  Delete: { commands: ['deleteToEndOfLine'] },
  ArrowLeft: {
    commands: ['moveToBeginningOfLine'],
    shift: ['moveToBeginningOfLineAndModifySelection'],
  },
  ArrowRight: {
    commands: ['moveToEndOfLine'],
    shift: ['moveToEndOfLineAndModifySelection'],
  },
  ArrowUp: {
    commands: ['moveToBeginningOfDocument'],
    shift: ['moveToBeginningOfDocumentAndModifySelection'],
  },
  ArrowDown: {
    commands: ['moveToEndOfDocument'],
    shift: ['moveToEndOfDocumentAndModifySelection'],
  },
  Home: {
    commands: ['moveToBeginningOfDocument'],
    shift: ['moveToBeginningOfDocumentAndModifySelection'],
  },
  End: {
    commands: ['moveToEndOfDocument'],
    shift: ['moveToEndOfDocumentAndModifySelection'],
  },
};

const EDITING_COMMANDS_WIN: Record<string, EditingMapping> = {
  a: { commands: ['selectAll'] },
  c: { commands: ['copy'] },
  x: { commands: ['cut'] },
  v: { commands: ['paste'] },
  z: { commands: ['undo'], shift: ['redo'] },
  y: { commands: ['redo'] },
  Backspace: { commands: ['deleteWordBackward'] },
  Delete: { commands: ['deleteWordForward'] },
  ArrowLeft: {
    commands: ['moveWordLeft'],
    shift: ['moveWordLeftAndModifySelection'],
  },
  ArrowRight: {
    commands: ['moveWordRight'],
    shift: ['moveWordRightAndModifySelection'],
  },
  ArrowUp: {
    commands: ['moveToBeginningOfParagraph'],
    shift: ['moveToBeginningOfParagraphAndModifySelection'],
  },
  ArrowDown: {
    commands: ['moveToEndOfParagraph'],
    shift: ['moveToEndOfParagraphAndModifySelection'],
  },
  Home: {
    commands: ['moveToBeginningOfDocument'],
    shift: ['moveToBeginningOfDocumentAndModifySelection'],
  },
  End: {
    commands: ['moveToEndOfDocument'],
    shift: ['moveToEndOfDocumentAndModifySelection'],
  },
};

/** 按平台取主修饰键位与映射表：macOS = Cmd，Windows/Linux = Ctrl。 */
function editingTableFor(os: string): { primaryBit: number; table: Record<string, EditingMapping> } {
  return os === 'mac'
    ? { primaryBit: CMD_BIT, table: EDITING_COMMANDS_MAC }
    : { primaryBit: CTRL_BIT, table: EDITING_COMMANDS_WIN };
}

const NAMED_KEYS: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vkc: 27 },
  esc: { key: 'Escape', code: 'Escape', vkc: 27 },
  tab: { key: 'Tab', code: 'Tab', vkc: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vkc: 8 },
  delete: { key: 'Delete', code: 'Delete', vkc: 46 },
  space: { key: ' ', code: 'Space', vkc: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vkc: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vkc: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vkc: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vkc: 39 },
  home: { key: 'Home', code: 'Home', vkc: 36 },
  end: { key: 'End', code: 'End', vkc: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vkc: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vkc: 34 },
};

let cachedOs: string | null = null;

async function getPlatformOs(): Promise<string> {
  if (cachedOs === null) {
    cachedOs = (await chrome.runtime.getPlatformInfo()).os;
  }
  return cachedOs;
}

/** `Mod` resolves to Cmd on macOS, Ctrl elsewhere. */
function modForOs(os: string): ModifierSpec {
  return os === 'mac' ? MODIFIERS.cmd! : MODIFIERS.ctrl!;
}

function resolveKeySpec(token: string): KeySpec {
  const lower = token.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return named;

  const fnMatch = lower.match(/^f(\d{1,2})$/);
  if (fnMatch) {
    const n = parseInt(fnMatch[1]!, 10);
    if (n >= 1 && n <= 12) return { key: `F${n}`, code: `F${n}`, vkc: 111 + n };
  }

  if (token.length === 1) {
    if (/^[a-zA-Z]$/.test(token)) {
      const key = token.toLowerCase();
      const upper = token.toUpperCase();
      return { key, code: `Key${upper}`, vkc: upper.charCodeAt(0), text: key };
    }
    if (/^[0-9]$/.test(token)) {
      return { key: token, code: `Digit${token}`, vkc: token.charCodeAt(0), text: token };
    }
  }

  throw new Error(
    `send_keys: unknown key "${token}". Supported: ${Object.keys(NAMED_KEYS).join(', ')}, F1-F12, single letters/digits.`,
  );
}

interface ParsedSegment {
  modifierBits: number;
  modifierKeys: ModifierSpec[];
  spec: KeySpec;
}

function parseSegment(segment: string, mod: ModifierSpec): ParsedSegment {
  const parts = segment
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('send_keys: empty segment');

  let modifierBits = 0;
  const modifierKeys: ModifierSpec[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i]!.toLowerCase();
    const spec = name === 'mod' ? mod : MODIFIERS[name];
    if (spec === undefined) {
      throw new Error(
        `send_keys: "${parts[i]}" is not a modifier. Use Alt/Ctrl/Cmd/Meta/Shift, or Mod (auto-resolves to Cmd on Mac, Ctrl on Win/Linux).`,
      );
    }
    modifierBits |= spec.bit;
    modifierKeys.push(spec);
  }

  return { modifierBits, modifierKeys, spec: resolveKeySpec(parts[parts.length - 1]!) };
}

/** With Shift held, letters produce uppercase text. */
function applyShift(spec: KeySpec, shiftHeld: boolean): KeySpec {
  if (!shiftHeld || spec.key.length !== 1 || !/^[a-z]$/.test(spec.key)) return spec;
  const upper = spec.key.toUpperCase();
  return { ...spec, key: upper, text: upper };
}

export class SendKeysTool implements Tool {
  readonly name = 'send_keys';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const keys = args.keys;
    if (typeof keys !== 'string' || !keys.trim()) {
      throw new Error(
        'send_keys: keys is required (string), e.g. "Enter" or "Mod+A" or "Shift+Tab" or "Enter Escape"',
      );
    }
    const repeatArg = args.repeat;
    const repeat = repeatArg === undefined ? 1 : Number(repeatArg);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
      throw new Error('send_keys: repeat must be an integer in [1, 100]');
    }

    const os = await getPlatformOs();
    const mod = modForOs(os);
    const segments = keys
      .trim()
      .split(/\s+/)
      .map((segment) => parseSegment(segment, mod));

    let dispatched = 0;
    for (let round = 0; round < repeat; round++) {
      for (const { modifierBits, modifierKeys, spec } of segments) {
        const resolved = applyShift(spec, (modifierBits & SHIFT_BIT) !== 0);

        // Press modifiers in order, accumulating the bitmask.
        let heldBits = 0;
        for (const modifier of modifierKeys) {
          heldBits |= modifier.bit;
          await sendCommand(target.tabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: heldBits,
            key: modifier.key,
            code: modifier.code,
            windowsVirtualKeyCode: modifier.vkc,
          });
        }

        // Text is only produced when no "command" modifier (ctrl/cmd) is held.
        const textParams =
          (modifierBits & ~SHIFT_BIT) === 0 && resolved.text !== undefined
            ? { text: resolved.text }
            : {};
        // 平台主修饰键（mac=Cmd，其他=Ctrl；Mod 已解析）+ 主键映射 editing
        // command（协议 §4.4）。Alt 同按不映射；查表用未升大写的 spec.key，
        // 否则 Shift+字母组合（Cmd+Shift+Z 重做）会因大写键查空而丢失。
        const { primaryBit, table } = editingTableFor(os);
        const shiftHeld = (modifierBits & SHIFT_BIT) !== 0;
        const mapping =
          (modifierBits & primaryBit) !== 0 && (modifierBits & ALT_BIT) === 0
            ? table[spec.key]
            : undefined;
        const commandParams = mapping
          ? shiftHeld && mapping.shift
            ? mapping.shift
            : mapping.commands
          : undefined;
        await sendCommand(target.tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          modifiers: modifierBits,
          key: resolved.key,
          code: resolved.code,
          windowsVirtualKeyCode: resolved.vkc,
          ...textParams,
          ...(commandParams ? { commands: commandParams } : {}),
        });
        await sendCommand(target.tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          modifiers: modifierBits,
          key: resolved.key,
          code: resolved.code,
          windowsVirtualKeyCode: resolved.vkc,
        });

        // Release modifiers in reverse order.
        for (let i = modifierKeys.length - 1; i >= 0; i--) {
          const modifier = modifierKeys[i]!;
          heldBits &= ~modifier.bit;
          await sendCommand(target.tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: heldBits,
            key: modifier.key,
            code: modifier.code,
            windowsVirtualKeyCode: modifier.vkc,
          });
        }
        dispatched++;
      }
    }

    return { success: true, dispatched, os };
  }
}
