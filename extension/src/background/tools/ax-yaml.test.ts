/**
 * ax-yaml 的纯函数测试：contextual interactive 分组（协议 §4.3）、
 * 确定性 match 过滤（协议 §4.3）、compactFromAx 各节点形状的折叠规则、
 * renderYaml 的行格式化与截断。测试逻辑不碰 chrome；但模块图经 refs.ts
 * 的 onRemoved 兜底自清挂在 chrome 上，仍需先装 fake 再动态 import。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installChrome } from '../test-chrome';
import type { AxNode, CompactNode, IframeInfo, MatchSpec } from './ax-yaml';

installChrome();

const {
  compactFromAx,
  contextualInteractive,
  filterByMatch,
  matchesSpec,
  renderYaml,
} = await import('./ax-yaml');
const refs = await import('../refs');

function render(nodes: CompactNode[]): string {
  return renderYaml(nodes, 240_000).yaml;
}

/** compactFromAx 用的 AX 节点 fixture（default tabId=0 的 ref 表在 beforeEach 清空）。 */
function ax(nodeId: string, role: string | undefined, extra: Partial<AxNode> = {}): AxNode {
  return { nodeId, ...(role === undefined ? {} : { role: { value: role } }), ...extra };
}

beforeEach(() => {
  refs.deleteTargetState(0);
});

describe('contextualInteractive（协议 §4.3）', () => {
  it('共享祖先的交互节点按 YAML 分组', () => {
    const tree: CompactNode[] = [
      {
        role: 'dialog',
        name: 'Delete project',
        children: [
          { role: 'button', name: 'Cancel', ref: '@e1' },
          { role: 'button', name: 'Delete', ref: '@e2' },
        ],
      },
      { role: 'row', name: 'Alice', children: [{ role: 'button', name: 'Edit', ref: '@e3' }] },
    ];
    expect(render(contextualInteractive(tree))).toBe(
      [
        '- dialog "Delete project"',
        '  - button "Cancel" [ref=@e1]',
        '  - button "Delete" [ref=@e2]',
        '- row "Alice"',
        '  - button "Edit" [ref=@e3]',
        '',
      ].join('\n'),
    );
  });

  it('两个同名按钮输出不同祖先上下文', () => {
    const tree: CompactNode[] = [
      { role: 'dialog', name: 'A', children: [{ role: 'button', name: 'OK', ref: '@e1' }] },
      { role: 'dialog', name: 'B', children: [{ role: 'button', name: 'OK', ref: '@e2' }] },
    ];
    const yaml = render(contextualInteractive(tree));
    expect(yaml).toContain('- dialog "A"\n  - button "OK" [ref=@e1]');
    expect(yaml).toContain('- dialog "B"\n  - button "OK" [ref=@e2]');
  });

  it('最多保留两个最近的有名称候选祖先', () => {
    const tree: CompactNode[] = [
      {
        role: 'dialog',
        name: 'D',
        children: [
          {
            role: 'form',
            name: 'F',
            children: [
              { role: 'row', name: 'R', children: [{ role: 'button', name: 'Go', ref: '@e1' }] },
            ],
          },
        ],
      },
    ];
    // dialog 是最外层第三个候选，被丢掉；保留 form 与 row。
    expect(render(contextualInteractive(tree))).toBe(
      ['- form "F"', '  - row "R"', '    - button "Go" [ref=@e1]', ''].join('\n'),
    );
  });

  it('无有名称候选祖先时维持单行输出', () => {
    const tree: CompactNode[] = [
      {
        role: 'dialog', // 无 name，不算候选
        children: [
          {
            role: 'cell', // 非候选角色
            children: [{ role: 'button', name: 'Buy', ref: '@e1' }],
          },
        ],
      },
    ];
    expect(render(contextualInteractive(tree))).toBe('- button "Buy" [ref=@e1]\n');
  });

  it('非候选的中间节点不阻断链：row 隔着 cell 仍是祖先上下文', () => {
    const tree: CompactNode[] = [
      {
        role: 'row',
        name: 'Alice',
        children: [
          { role: 'cell', children: [{ role: 'button', name: 'Edit', ref: '@e1' }] },
        ],
      },
    ];
    expect(render(contextualInteractive(tree))).toBe(
      ['- row "Alice"', '  - button "Edit" [ref=@e1]', ''].join('\n'),
    );
  });
});

describe('filterByMatch（协议 §4.3）', () => {
  const tree: CompactNode[] = [
    {
      role: 'dialog',
      name: 'Delete project',
      children: [
        { role: 'button', name: 'Cancel', ref: '@e1' },
        { role: 'button', name: 'Delete', ref: '@e2' },
      ],
    },
    { role: 'row', name: 'Alice', children: [{ role: 'button', name: 'Edit', ref: '@e3' }] },
  ];

  it('exact 默认完整匹配，命中节点保留、祖先变上下文行', () => {
    const { out, matches } = filterByMatch(tree, { name: 'Delete', exact: true });
    expect(matches).toBe(1);
    expect(render(out)).toBe(
      ['- dialog "Delete project"', '  - button "Delete" [ref=@e2]', ''].join('\n'),
    );
  });

  it('exact:true 不做子串匹配', () => {
    const { out, matches } = filterByMatch(tree, { name: 'Del', exact: true });
    expect(matches).toBe(0);
    expect(out).toEqual([]);
  });

  it('exact:false 显式开子串匹配；命中节点保留整棵子树、不再向子树计数', () => {
    const spec: MatchSpec = { name: 'Del', exact: false };
    const { out, matches } = filterByMatch(tree, spec);
    // dialog “Delete project” 命中后子树整体保留（含 Cancel/Delete 两行），不再向下计数。
    expect(matches).toBe(1);
    const yaml = render(out);
    expect(yaml).toContain('- button "Cancel" [ref=@e1]');
    expect(yaml).toContain('- button "Delete" [ref=@e2]');
  });

  it('role 可选过滤候选角色', () => {
    const hit = filterByMatch(tree, { role: 'button', name: 'Edit', exact: true });
    expect(hit.matches).toBe(1);
    const miss = filterByMatch(tree, { role: 'link', name: 'Edit', exact: true });
    expect(miss.matches).toBe(0);
  });

  it('多命中全部返回，共享祖先只出现一次', () => {
    const shared: CompactNode[] = [
      {
        role: 'form',
        name: 'Upload',
        children: [
          { role: 'button', name: 'Save', ref: '@e1' },
          { role: 'button', name: 'Save Draft', ref: '@e2' },
        ],
      },
    ];
    const { out, matches } = filterByMatch(shared, { name: 'Save', exact: false });
    expect(matches).toBe(2);
    expect(render(out)).toBe(
      ['- form "Upload"', '  - button "Save" [ref=@e1]', '  - button "Save Draft" [ref=@e2]', ''].join(
        '\n',
      ),
    );
  });

  it('零命中是 matches:0 的空结果，不是错误', () => {
    const { out, matches } = filterByMatch(tree, { name: 'NoSuchThing', exact: true });
    expect(matches).toBe(0);
    expect(out).toEqual([]);
  });

  it('大小写按 case-fold 比较', () => {
    expect(filterByMatch(tree, { name: 'delete', exact: true }).matches).toBe(1);
    expect(filterByMatch(tree, { name: 'DELETE', exact: true }).matches).toBe(1);
  });
});

describe('renderYaml sourceChars（协议 §4.3）', () => {
  it('截断时 sourceChars 是裁剪前规模，chars 是实际返回长度', () => {
    const nodes: CompactNode[] = Array.from({ length: 50 }, (_, i) => ({
      role: 'button',
      name: `Button number ${i} with a fairly long accessible name`,
      ref: `@e${i + 1}`,
    }));
    const full = renderYaml(nodes, 240_000);
    expect(full.truncated).toBe(false);
    expect(full.sourceChars).toBe(full.chars);

    const cut = renderYaml(nodes, 1000);
    expect(cut.truncated).toBe(true);
    expect(cut.sourceChars).toBe(full.chars);
    expect(cut.chars).toBe(cut.yaml.length);
    expect(cut.yaml.length).toBeGreaterThan(1000); // 含截断标记行
  });

  it('空节点列表渲染为空串', () => {
    const out = renderYaml([], 1000);
    expect(out.yaml).toBe('');
    expect(out.chars).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it('maxChars 小于首行长度时按字符硬切（找不到换行）', () => {
    const nodes: CompactNode[] = [{ role: 'text', name: 'x'.repeat(200) }];
    const out = renderYaml(nodes, 50);
    expect(out.truncated).toBe(true);
    expect(out.yaml.startsWith('- text "xxxx')).toBe(true);
    expect(out.yaml).toContain('chars omitted');
    expect(out.sourceChars).toBe(200 + '- text ""'.length + 1);
  });
});

describe('formatLine 行格式化（renderYaml 直测）', () => {
  it('全部属性旗标按固定顺序输出，value 以冒号结尾', () => {
    const node: CompactNode = {
      role: 'heading',
      name: 'H',
      level: 2,
      checked: true,
      selected: true,
      expanded: true,
      disabled: true,
      invalid: true,
      isolated: true,
      src: 'https://s.example/x',
      ref: '@e1',
      value: 'v',
    };
    expect(render([node])).toBe(
      '- heading "H" [level=2] [checked] [selected] [expanded] [disabled] ' +
        '[invalid] [isolated] [src=https://s.example/x] [ref=@e1]: "v"\n',
    );
  });

  it('checked:false 输出 [unchecked]（其他 falsy 旗标不输出）', () => {
    const node: CompactNode = { role: 'checkbox', checked: false };
    expect(render([node])).toBe('- checkbox [unchecked]\n');
  });

  it('只有 role 时输出裸角色行', () => {
    expect(render([{ role: 'separator' }])).toBe('- separator\n');
  });
});

describe('compactFromAx（协议 §4.3 compact 折叠规则）', () => {
  it('空 nodes 返回空数组', () => {
    expect(compactFromAx([], 'compact')).toEqual([]);
  });

  it('includeRoot=true 时根节点自身参与格式化（selector 子树入口）', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { name: { value: 'P' }, childIds: ['h1'] }),
      ax('h1', 'heading', { name: { value: 'Title' } }),
    ];
    expect(render(compactFromAx(nodes, 'compact', true))).toBe('- heading "Title"\n');
  });

  it('mode=interactive 时在 compactFromAx 内部直接上下文化', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['d1'] }),
      ax('d1', 'dialog', { name: { value: 'D' }, childIds: ['b1'] }),
      ax('b1', 'button', { name: { value: 'OK' }, backendDOMNodeId: 1 }),
    ];
    expect(render(compactFromAx(nodes, 'interactive'))).toBe(
      ['- dialog "D"', '  - button "OK" [ref=@e1]', ''].join('\n'),
    );
  });

  it('祖先名里已有的 StaticText 被丢弃（文件头示例 2）', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['b1'] }),
      ax('b1', 'button', { name: { value: 'Submit' }, backendDOMNodeId: 1, childIds: ['t1'] }),
      ax('t1', 'StaticText', { name: { value: 'Submit' } }),
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe('- button "Submit" [ref=@e1]\n');
  });

  it('与祖先名不同的 StaticText 保留为 text 行；StaticText 角色归一为 text', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['b1'] }),
      ax('b1', 'button', { name: { value: 'Submit' }, backendDOMNodeId: 1, childIds: ['t1'] }),
      ax('t1', 'StaticText', { name: { value: 'processing…' } }),
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe(
      ['- button "Submit" [ref=@e1]', '  - text "processing…"', ''].join('\n'),
    );
  });

  it('无名的 StaticText 不进 nearestName，也不单独成行', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['b1'] }),
      ax('b1', 'button', { name: { value: 'Go' }, backendDOMNodeId: 1, childIds: ['t1'] }),
      ax('t1', 'StaticText'), // 无 name：isStructural 命中但 result 无任何字段 → null
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe('- button "Go" [ref=@e1]\n');
  });

  it('generic/无 role 包装层透传子节点（非交互非结构角色）', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['g1', 'g2'] }),
      ax('g1', 'generic', { childIds: ['h1', 'h2'] }),
      ax('h1', 'heading', { name: { value: 'A' } }),
      ax('h2', 'heading', { name: { value: 'B' } }),
      ax('g2', undefined, { childIds: ['h3'] }), // role 缺失同样透传
      ax('h3', 'heading', { name: { value: 'C' } }),
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe(
      ['- heading "A"', '- heading "B"', '- heading "C"', ''].join('\n'),
    );
  });

  it('value / level / 布尔属性 / img src 全部落到行内', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', {
        childIds: ['tb', 'h1', 'h2', 'h3', 'cb', 'op', 'tr', 'bt', 'in', 'im'],
      }),
      ax('tb', 'textbox', { name: { value: 'Email' }, value: { value: 'a@b' }, backendDOMNodeId: 1 }),
      ax('h1', 'heading', { name: { value: 'N1' }, properties: [{ name: 'level', value: { value: 2 } }] }),
      ax('h2', 'heading', { name: { value: 'N2' }, properties: [{ name: 'level', value: { value: '3' } }] }),
      // level 是非数字字符串 → 忽略
      ax('h3', 'heading', { name: { value: 'N3' }, properties: [{ name: 'level', value: { value: 'x' } }] }),
      ax('cb', 'checkbox', {
        name: { value: 'Opt' },
        backendDOMNodeId: 2,
        properties: [{ name: 'checked', value: { value: true } }],
      }),
      ax('op', 'option', {
        name: { value: 'One' },
        backendDOMNodeId: 3,
        properties: [{ name: 'selected', value: { value: true } }],
      }),
      ax('tr', 'treeitem', {
        name: { value: 'Node' },
        backendDOMNodeId: 4,
        properties: [{ name: 'expanded', value: { value: true } }],
      }),
      ax('bt', 'button', {
        name: { value: 'Save' },
        backendDOMNodeId: 5,
        properties: [{ name: 'disabled', value: { value: 'true' } }],
      }),
      ax('in', 'textbox', {
        name: { value: 'Mail' },
        backendDOMNodeId: 6,
        properties: [{ name: 'invalid', value: { value: 1 } }],
      }),
      ax('im', 'img', {
        name: { value: 'Logo' },
        properties: [{ name: 'url', value: { value: 'https://cdn.example/logo.png' } }],
      }),
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe(
      [
        '- textbox "Email" [ref=@e1]: "a@b"',
        '- heading "N1" [level=2]',
        '- heading "N2" [level=3]',
        '- heading "N3"',
        '- checkbox "Opt" [checked] [ref=@e2]',
        '- option "One" [selected] [ref=@e3]',
        '- treeitem "Node" [expanded] [ref=@e4]',
        '- button "Save" [disabled] [ref=@e5]',
        '- textbox "Mail" [invalid] [ref=@e6]',
        '- img "Logo" [src=https://cdn.example/logo.png]',
        '',
      ].join('\n'),
    );
  });

  it('checked 为 "false" 字符串 → [unchecked]', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['cb'] }),
      ax('cb', 'checkbox', {
        name: { value: 'Opt' },
        backendDOMNodeId: 1,
        properties: [{ name: 'checked', value: { value: 'false' } }],
      }),
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe('- checkbox "Opt" [unchecked] [ref=@e1]\n');
  });

  it('超长 name 裁到 120 字符（119 + 省略号），超长 img url 裁到 80', () => {
    const longName = 'N'.repeat(200);
    const longUrl = 'https://cdn.example/' + 'p'.repeat(120);
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['h1', 'im'] }),
      ax('h1', 'heading', { name: { value: longName } }),
      ax('im', 'img', { properties: [{ name: 'url', value: { value: longUrl } }] }),
    ];
    const yaml = render(compactFromAx(nodes, 'compact'));
    const [line1, line2] = yaml.split('\n');
    expect(line1).toBe(`- heading "${'N'.repeat(119)}…"`);
    expect(line2).toBe(`- img [src=${longUrl.slice(0, 80)}]`);
  });

  it('iframe：ref 来自帧角色、src/isolated 查帧 owner 表、子树不下钻', () => {
    const frameInfoByNodeId = new Map<number, IframeInfo>([
      [11, { url: 'https://embed.example/a', isolated: false }],
      [12, { url: 'https://other.example/' + 'x'.repeat(100), isolated: true }],
    ]);
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['f1', 'f2'] }),
      ax('f1', 'iframe', { name: { value: 'Ad' }, backendDOMNodeId: 11, childIds: ['b1'] }),
      // iframe 内的按钮不得出现
      ax('b1', 'button', { name: { value: 'Inside' }, backendDOMNodeId: 99 }),
      ax('f2', 'frame', { backendDOMNodeId: 12 }),
    ];
    const longSrc = 'https://other.example/' + 'x'.repeat(100);
    expect(render(compactFromAx(nodes, 'compact', false, undefined, frameInfoByNodeId, 0))).toBe(
      [
        '- iframe "Ad" [src=https://embed.example/a] [ref=@e1]',
        `- frame [isolated] [src=${longSrc.slice(0, 80)}] [ref=@e2]`,
        '',
      ].join('\n'),
    );
  });

  it('iframe 无帧 owner 信息时只有 ref，无 src/isolated', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['f1'] }),
      ax('f1', 'iframe', { name: { value: 'Ad' }, backendDOMNodeId: 11 }),
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe('- iframe "Ad" [ref=@e1]\n');
  });

  it('无任何可输出字段的节点被丢弃（216 兜底）', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['h1', 'sep'] }),
      ax('h1', 'heading'), // 无 name/children → null
      ax('sep', 'separator'), // 结构角色但无内容 → null
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe('');
  });

  it('childIds 指向不存在的 nodeId 时跳过；全部子节点无效时父节点也丢弃', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['g1', 'ghost'] }),
      ax('g1', 'generic', { childIds: ['h1', 'ghost2'] }),
      ax('h1', 'heading'), // 无 name → null
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe('');
  });

  it('value/refs/src 各自单独撑起一行（215 分支组合）', () => {
    const nodes: AxNode[] = [
      ax('r', 'RootWebArea', { childIds: ['t0', 'b1', 'im', 'im2', 'h1'] }),
      // 只有 value（text 无 name 有 value；数字 value 转 String）
      ax('t0', 'StaticText', { value: { value: 42 } }),
      // 只有 ref（无 name）
      ax('b1', 'button', { backendDOMNodeId: 1 }),
      // 只有 src（img 无 name 有 url 属性）
      ax('im', 'img', { properties: [{ name: 'url', value: { value: 'https://x/i.png' } }] }),
      // img 无 url 属性 → 无 src 也无 name → 整行丢弃
      ax('im2', 'img'),
      // 只有 children（heading 无 name 带文本子节点）
      ax('h1', 'heading', { childIds: ['t1'] }),
      ax('t1', 'StaticText', { name: { value: 'leaf' } }),
    ];
    expect(render(compactFromAx(nodes, 'compact'))).toBe(
      [
        '- text: "42"',
        '- button [ref=@e1]',
        '- img [src=https://x/i.png]',
        '- heading',
        '  - text "leaf"',
        '',
      ].join('\n'),
    );
  });
});

describe('matchesSpec（协议 §4.3）', () => {
  it('无 name 的节点永不命中', () => {
    expect(matchesSpec({ role: 'button' }, { name: 'Go', exact: false })).toBe(false);
    expect(matchesSpec({ role: 'button', name: '' }, { name: 'Go', exact: false })).toBe(false);
  });

  it('role 大小写不敏感、name case-fold 比较', () => {
    // spec.role 做 case-fold；node.role 原样比较（compact 输出的 role 已是小写）
    expect(matchesSpec({ role: 'button', name: 'GO' }, { role: 'BUTTON', name: 'go', exact: true })).toBe(
      true,
    );
    expect(matchesSpec({ role: 'Button', name: 'go' }, { role: 'button', name: 'go', exact: true })).toBe(
      false,
    );
  });

  it('exact:false 子串匹配', () => {
    expect(matchesSpec({ role: 'button', name: 'Delete project' }, { name: 'lete', exact: false })).toBe(
      true,
    );
    expect(matchesSpec({ role: 'button', name: 'Delete' }, { name: 'nope', exact: false })).toBe(false);
  });
});
