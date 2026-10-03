import { FieldDef } from '../../core/models/logs.model';
import { buildFieldTree, fieldsUnder, FieldGroup, groupKeys, visibleRows } from './logs-field-tree';

function f(path: string, index = 0): FieldDef {
  return {
    index, path, label: path.split('.').pop()!, type: 'STRING', typeSource: 'AUTO', format: '', matchRate: 1, invalidCount: 0,
    suggestBoolean: false, searchMode: 'EXACT', role: null, sensitive: false, duplicateOf: null, firstSeenLine: 0, sample: null, roleRank: 0,
  };
}

describe('logs-field-tree', () => {
  const fields = [
    f('message', 0),
    f('message.context.timeTaken', 1),
    f('message.context.externalService', 2),
    f('message.body.supplier', 3),
    f('message.body.operation', 4),
    f('message.response.bean.option.fare.type', 5),
    f('message.response.bean.option.fare.code', 6),
    f('_index', 7),
  ];
  const tree = buildFieldTree(fields);

  it('groups fields by path, groups before fields', () => {
    expect(tree.map((n) => [n.kind, n.name])).toEqual([
      ['group', 'message'],
      ['field', '_index'],
      ['field', 'message'],
    ]);
    const message = tree[0] as FieldGroup;
    expect(message.count).toBe(6);
    expect(message.children.map((n) => n.name)).toEqual(['body', 'context', 'response.bean.option.fare']);
  });

  it('merges a chain of single groups into one row', () => {
    const message = tree[0] as FieldGroup;
    const chain = message.children[2] as FieldGroup;
    expect(chain.key).toBe('message.response.bean.option.fare');
    expect(chain.children.map((n) => n.name)).toEqual(['code', 'type']);
  });

  it('shows children of open groups only, and every match while filtering', () => {
    expect(visibleRows(tree, new Set()).map((r) => r.node.name)).toEqual(['message', '_index', 'message']);
    const open = visibleRows(tree, new Set(['message', 'message.body']));
    expect(open.map((r) => `${r.depth}:${r.node.name}`)).toContain('2:supplier');
    expect(open.find((r) => r.node.name === 'supplier')!.prefix).toBe('message.body.');
    const found = visibleRows(tree, new Set(), 'fare.co', (x) => x.label);
    expect(found.map((r) => r.node.name)).toEqual(['message', 'response.bean.option.fare', 'code']);
  });

  it('lists every field and group below a node', () => {
    expect(fieldsUnder(tree[0]).length).toBe(6);
    expect(groupKeys(tree)).toEqual(['message', 'message.body', 'message.context', 'message.response.bean.option.fare']);
  });
});
