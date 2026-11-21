import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT, VERSION, mergeGroups, readWorkspace } from '../extension/lib/workspace.js';

const file = (extra = {}) => ({ format: FORMAT, version: VERSION, ...extra });
const group = (id, name, extra = {}) => ({
  id, name, label: 'Other', hue: 10, parentId: null, order: 1, pinned: false, collapsed: false, ...extra,
});
const COUNTERS = { nextGroup: 1, topLevel: 0, nextArchive: 1 };

test('a file that is not a workspace, or is from a newer version, is refused', () => {
  assert.throws(() => readWorkspace(null), /not a Rolltop workspace/);
  assert.throws(() => readWorkspace({ groups: [] }), /not a Rolltop workspace/);
  assert.throws(() => readWorkspace(file({ version: VERSION + 1 })), /newer version/);
  assert.deepEqual(readWorkspace(file()), { groups: [], tabs: [] });
});

test('reading a file drops what cannot be used and bounds the rest', () => {
  const ws = readWorkspace(file({
    groups: [
      { id: 'a', name: '  Trip   notes ', hue: 725, order: 2, pinned: 1, junk: true, idleCollapsedAt: 5 },
      { id: 'b', name: '' },
      { name: 'No id' },
      'nonsense',
    ],
    tabs: [
      { url: 'https://a.com/', title: 'A', groupId: 'a', pinned: true, pinRow: 2, name: ' Mine ', manual: true },
      { url: 'https://b.com/', pinRow: 3 },
      { url: 'about:config' },
      { url: 'javascript:alert(1)' },
      { url: 'file:///etc/passwd' },
    ],
    archive: [{ url: 'https://c.com/' }],
    settings: { archiveDays: 7 },
  }));
  assert.deepEqual(Object.keys(ws), ['groups', 'tabs']);
  assert.deepEqual(ws.groups, [{
    id: 'a', name: 'Trip notes', label: 'Other', hue: 5, parentId: null, order: 2, pinned: true, collapsed: false,
  }]);
  assert.deepEqual(ws.tabs, [
    { url: 'https://a.com/', title: 'A', groupId: 'a', pinned: true, pinRow: 2, name: 'Mine', manual: true },
    { url: 'https://b.com/', title: '', groupId: null, pinned: false, pinRow: null },
  ]);
});

test('imported groups get fresh ids after the existing ones, keeping their own order and nesting', () => {
  const existing = { g1: group('g1', 'Here', { order: 4 }) };
  const res = mergeGroups(existing, { ...COUNTERS, nextGroup: 2, topLevel: 1 }, [
    group('g2', 'Child', { parentId: 'g1', order: 9 }),
    group('g1', 'Second', { order: 2, pinned: true }),
    group('g7', 'First', { order: 1 }),
  ]);
  const byName = (name) => Object.values(res.groups).find((g) => g.name === name);
  assert.equal(res.added, 3);
  assert.equal(res.groups.g1.name, 'Here');
  assert.equal(byName('Child').parentId, byName('Second').id);
  assert.equal(res.ids.get('g1'), byName('Second').id);
  assert.equal(byName('Second').pinned, true);
  assert.deepEqual(
    Object.values(res.groups).sort((a, b) => a.order - b.order).map((g) => g.name),
    ['Here', 'First', 'Second', 'Child'],
  );
  assert.equal(new Set(Object.keys(res.groups)).size, 4);
  assert.deepEqual(res.counters, { nextGroup: 5, topLevel: 3, nextArchive: 1 });
});

test('a group matching one already here is merged into it, on its own side of the line', () => {
  const existing = {
    g1: group('g1', 'Read later'),
    g2: group('g2', 'Articles', { parentId: 'g1' }),
    g3: group('g3', 'Work', { pinned: true }),
  };
  const res = mergeGroups(existing, { ...COUNTERS, nextGroup: 4 }, [
    group('x', 'read LATER'),
    group('y', 'Articles', { parentId: 'x' }),
    group('z', 'Work'),
  ]);
  assert.equal(res.ids.get('x'), 'g1');
  assert.equal(res.ids.get('y'), 'g2');
  // An unpinned "Work" is a different group from the pinned one.
  assert.equal(res.ids.get('z'), 'g4');
  assert.equal(res.added, 1);
});

test('a loop or over-deep nesting in the file cannot break the tree', () => {
  const res = mergeGroups({}, COUNTERS, [
    group('a', 'A', { parentId: 'b' }),
    group('b', 'B', { parentId: 'a' }),
    group('s', 'Self', { parentId: 's' }),
    group('d1', 'D1'),
    group('d2', 'D2', { parentId: 'd1' }),
    group('d3', 'D3', { parentId: 'd2', pinned: true }),
    group('d4', 'D4', { parentId: 'd3' }),
    group('o', 'Orphan', { parentId: 'missing' }),
  ]);
  const g = (id) => res.groups[res.ids.get(id)];
  assert.equal(g('b').parentId, null);
  assert.equal(g('a').parentId, g('b').id);
  assert.equal(g('s').parentId, null);
  assert.equal(g('o').parentId, null);
  assert.equal(g('d4').parentId, g('d2').id);
  assert.equal(g('d3').pinned, false);
});
