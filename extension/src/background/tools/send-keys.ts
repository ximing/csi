/**
 * send_keys (protocol §4.10): synthesize key events via
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
        await sendCommand(target.tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          modifiers: modifierBits,
          key: resolved.key,
          code: resolved.code,
          windowsVirtualKeyCode: resolved.vkc,
          ...textParams,
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
