/**
 * ax-yaml 的纯函数测试：contextual interactive 分组（协议 §4.3）与
 * 确定性 match 过滤（协议 §4.3）。不依赖 chrome。
 */
import { describe, expect, it } from 'vitest';
import {
  contextualInteractive,
  filterByMatch,
  renderYaml,
  type CompactNode,
  type MatchSpec,
} from './ax-yaml';

function render(nodes: CompactNode[]): string {
  return renderYaml(nodes, 240_000).yaml;
}

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
});
