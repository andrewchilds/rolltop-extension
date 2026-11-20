import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView, UNGROUPED } from '../extension/lib/model.js';
import { mockArchive, mockSnapshot } from './fixture.js';

const NOW = 1_800_000_000_000;

function view(overrides = {}, mutate) {
  const snap = mockSnapshot(NOW);
  if (mutate) mutate(snap);
  return buildView({
    tabs: snap.tabs, groups: snap.groups, archiveCounts: snap.archiveCounts,
    auto: true, query: '', now: NOW, ...overrides,
  });
}

const group = (v, name) => v.rows.find((r) => r.kind === 'group' && r.name === name);
const tab = (v, title) => v.rows.find((r) => r.kind === 'tab' && r.title.startsWith(title));

test('pinned tabs leave the list and show in the pin grid', () => {
  const v = view();
  assert.deepEqual(v.pins.map((p) => p.title.slice(0, 6)), ['Sprint', 'PR #31', 'Five s', 'Machiy']);
  assert.equal(tab(v, 'Sprint 42'), undefined);
  assert.equal(tab(v, 'Design review').current, true);
});

test('group counts cover the whole subtree, pinned tabs included', () => {
  const v = view();
  assert.equal(group(v, 'Sidebar redesign').count, 5);
  assert.equal(group(v, 'Kyoto in spring').count, 6);
  assert.equal(group(v, 'Getting there').depth, 1);
});

test('rows follow manual order with children after own tabs', () => {
  const names = view().rows.filter((r) => r.kind === 'group').map((r) => r.name);
  assert.deepEqual(names, [
    'Sidebar redesign', 'Accessibility', 'Read later', 'Kyoto in spring', 'Getting there',
    'Where to stay', 'Tax paperwork', 'Standing desk', 'Sourdough fixes', 'Bike commute',
  ]);
});

test('collapsed groups hide their tabs; archived-only groups are not listed', () => {
  const v = view();
  assert.equal(group(v, 'Tax paperwork').open, false);
  assert.equal(tab(v, 'Estimated payments'), undefined);
  assert.equal(group(v, 'Laptop sleeve'), undefined);
});

test('a pinned group keeps its subtree from fading or showing idle age', () => {
  const v = view();
  const a11y = group(v, 'Accessibility');
  assert.equal(a11y.hard, true);
  assert.equal(a11y.pinLabel, 'Pinned with its parent group');
  const row = tab(v, 'Tab strip accessibility');
  assert.equal(row.fade, 1);
  assert.equal(row.idleLabel, '');
});

test('a pinned tab keeps its group visible without exempting siblings', () => {
  const v = view();
  const trip = group(v, 'Kyoto in spring');
  assert.equal(trip.hard, false);
  assert.equal(trip.kept, true);
  assert.equal(trip.fade, 1);
  const weather = tab(v, 'Kyoto 10-day');
  assert.equal(weather.idleLabel, '6d');
  assert.equal(weather.fade, 0.62);
});

test('idle tabs fade in two steps and groups fade by their freshest tab', () => {
  const v = view();
  assert.equal(tab(v, 'How browsers').fade, 0.8);
  assert.equal(tab(v, 'How browsers').idleLabel, '2d');
  assert.equal(group(v, 'Sourdough fixes').fade, 0.62);
  assert.equal(group(v, 'Standing desk').fade, 1);
});

test('auto-tidy off removes fading and idle ages', () => {
  const v = view({ auto: false });
  assert.equal(tab(v, 'Kyoto 10-day').fade, 1);
  assert.equal(tab(v, 'Kyoto 10-day').idleLabel, '');
  assert.equal(group(v, 'Sourdough fixes').fade, 1);
});

test('tabs without a group land in Ungrouped', () => {
  const v = view({}, (snap) => {
    snap.tabs.push({
      id: 99, windowId: 1, index: 99, title: 'New Tab', url: 'about:newtab', favIconUrl: '',
      pinned: false, active: false, lastAccessed: NOW, groupId: null, pending: false,
    });
  });
  const last = v.rows.slice(-2);
  assert.equal(last[0].id, UNGROUPED);
  assert.equal(last[0].label, 'Other');
  assert.equal(last[1].title, 'New Tab');
});

test('search finds open and archived groups by name or label', () => {
  const v = view({ query: 'shopping' });
  assert.deepEqual(v.groupResults.map((g) => [g.name, g.sub, g.actLabel]), [
    ['Standing desk', '3 tabs', 'Show'],
    ['Laptop sleeve', 'Archived, 2 tabs', 'Reopen'],
  ]);
});

test('search shows nested group paths and archived tabs', () => {
  assert.equal(view({ query: 'getting' }).groupResults[0].name, 'Kyoto in spring / Getting there');
  const v = view({ query: 'sleeve', archiveHits: mockArchive(NOW) });
  assert.deepEqual(v.tabResults.map((t) => t.tag), ['Archived', 'Archived']);
  assert.equal(v.tabResults[0].archiveId, 'a1');
});

test('search matches domains and reports no results', () => {
  assert.equal(view({ query: 'railnotes' }).tabResults.length, 2);
  assert.equal(view({ query: 'zzzz' }).noResults, true);
});
