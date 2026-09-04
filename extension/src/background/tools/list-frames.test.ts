/**
 * list_frames 测试（协议 §4）：当前 tab 的全部帧透传——顶层、同域子帧、
 * isolated 条目（DOM 行补齐 + OOPIF），字段原样映射。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState } from '../test-chrome';

installChrome();

// frames.ts 走 chrome.debugger.sendCommand / getTargets 发现帧，这里按需喂结果。
let commandResults: Record<string, unknown> = {};
let debuggerTargets: { type: string; tabId?: number; url?: string }[] = [];

chrome.debugger.sendCommand = (async (
  _debuggee: { tabId: number },
  method: string,
) => {
  if (method in commandResults) return commandResults[method];
  return {};
}) as typeof chrome.debugger.sendCommand;
chrome.debugger.getTargets = (async () =>
  debuggerTargets) as typeof chrome.debugger.getTargets;

const { ListFramesTool } = await import('./list-frames');

const tool = new ListFramesTool();
const ctx = { tabId: 10, documentEpoch: 1 };

interface FrameRow {
  frameId: string;
  parentId: string;
  url: string;
  name: string;
  isolated: boolean;
}

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  commandResults = {};
  debuggerTargets = [];
});

describe('list_frames', () => {
  it('返回当前 tab 的全部帧，含顶层（parentId 空串）', async () => {
    commandResults = {
      'Page.getFrameTree': {
        frameTree: {
          frame: { id: 'top', url: 'https://a.example/page', securityOrigin: 'https://a.example' },
          childFrames: [
            {
              frame: {
                id: 'c1',
                parentId: 'top',
                url: 'https://a.example/embed',
                securityOrigin: 'https://a.example',
              },
            },
          ],
        },
      },
      'Runtime.evaluate': { result: { value: [] } },
    };
    const result = (await tool.execute({}, ctx)) as { success: boolean; frames: FrameRow[] };
    expect(result.success).toBe(true);
    expect(result.frames).toEqual([
      {
        frameId: 'top',
        parentId: '',
        url: 'https://a.example/page',
        name: '',
        isolated: false,
      },
      {
        frameId: 'c1',
        parentId: 'top',
        url: 'https://a.example/embed',
        name: '',
        isolated: false,
      },
    ]);
  });

  it('isolated 帧（DOM 行补齐与 OOPIF）带 isolated 标记', async () => {
    commandResults = {
      'Page.getFrameTree': {
        frameTree: {
          frame: { id: 'top', url: 'https://a.example/page', securityOrigin: 'https://a.example' },
          childFrames: [
            {
              frame: {
                id: 'cross',
                parentId: 'top',
                url: 'https://b.example/x',
                securityOrigin: 'https://b.example',
              },
            },
          ],
        },
      },
      'Runtime.evaluate': {
        result: {
          value: [
            { src: 'https://b.example/x', name: 'b-iframe', sandbox: null, sameDoc: true },
            { src: 'https://lazy.example/l', name: 'lazy', sandbox: null, sameDoc: false }, // CDP 里没有
          ],
        },
      },
    };
    debuggerTargets = [{ type: 'iframe', tabId: 10, url: 'https://oop.example/f' }];
    const result = (await tool.execute({}, ctx)) as { frames: FrameRow[] };
    expect(result.frames).toEqual([
      { frameId: 'top', parentId: '', url: 'https://a.example/page', name: '', isolated: false },
      { frameId: 'cross', parentId: 'top', url: 'https://b.example/x', name: 'b-iframe', isolated: true },
      {
        frameId: 'isolated:https://lazy.example/l',
        parentId: 'top',
        url: 'https://lazy.example/l',
        name: 'lazy',
        isolated: true,
      },
      {
        frameId: 'isolated:https://oop.example/f',
        parentId: 'top',
        url: 'https://oop.example/f',
        name: '',
        isolated: true,
      },
    ]);
  });
});
