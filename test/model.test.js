import test from 'node:test';
import assert from 'node:assert/strict';
import { alertOf, buildView, pinRowsOf, UNGROUPED } from '../extension/lib/model.js';
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

test('a pinned group does not pin its sub-groups', () => {
  const v = view();
  const work = group(v, 'Sidebar redesign');
  assert.equal(work.hard, true);
  assert.equal(work.pinLabel, 'Unpin group');
  const a11y = group(v, 'Accessibility');
  assert.equal(a11y.hard, false);
  assert.equal(a11y.pinLabel, 'Pin group');
  const row = tab(v, 'Tab strip accessibility');
  assert.ok(row.fade < 1);
  assert.equal(row.idleLabel, '3d');
});

test('a pinned tab shows the alert count from its title as a badge', () => {
  assert.deepEqual(alertOf('(3) Inbox'), { count: '3', title: 'Inbox' });
  assert.deepEqual(alertOf('[12] Team chat'), { count: '12', title: 'Team chat' });
  assert.deepEqual(alertOf('Inbox (1,204) - Mail'), { count: '1,204', title: 'Inbox - Mail' });
  assert.equal(alertOf('Blade Runner (1982) - Films').count, '');
  assert.equal(alertOf('Report (2).pdf').count, '');
  assert.equal(alertOf('(0) Inbox').count, '');

  const v = view({}, (snap) => {
    const [first, second, third] = snap.tabs.filter((t) => t.pinned);
    first.title = '(2) ' + first.title;
    first.name = 'Board';
    second.attention = true;
    third.title = '(5) ' + third.title;
  });
  assert.deepEqual([v.pins[0].title, v.pins[0].badge], ['Board', '2']);
  assert.equal(v.pins[1].badge, '');
  assert.deepEqual([v.pins[2].title, v.pins[2].badge], ['Five slow days in Kyoto: a walking route', '5']);
  assert.equal(v.pins[3].badge, null);
});

test('a renamed tab is listed under its new name and found by either', () => {
  const at = (query) => view({ query }, (snap) => {
    snap.tabs.find((x) => x.title === 'Design review notes, Nov 17').name = 'Review';
  });
  assert.ok(at('').rows.some((r) => r.kind === 'tab' && r.title === 'Review'));
  assert.deepEqual(at('design review').tabResults.map((r) => r.title), ['Review']);
  assert.deepEqual(at('review').tabResults.map((r) => r.title), ['Review']);
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
  assert.equal(last[0].sorting, false);
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

test('a group whose open tabs are all pinned is not listed', () => {
  const snap = mockSnapshot(NOW);
  // Leave the Kyoto subtree with only its two pinned tabs open.
  const kyoto = new Set(['trip', 'transit', 'stay']);
  snap.tabs = snap.tabs.filter((t) => !kyoto.has(t.groupId) || t.pinned);
  const v = buildView({ ...snap, auto: true, query: '', now: NOW });
  const listed = v.rows.filter((r) => r.kind === 'group').map((r) => r.id);
  assert.equal(listed.some((id) => kyoto.has(id)), false);
  assert.equal(v.pins.length, 4);

  const found = buildView({ ...snap, auto: true, query: 'kyoto', now: NOW });
  assert.deepEqual(found.groupResults, []);
});

test('pinned tiles fall into the rows they were laid out in', () => {
  const ids = (rows) => rows.map((row) => row.map((p) => p.id).join(''));
  const pins = (spec) => spec.map(([id, row]) => ({ id, row }));
  // Never laid out: pairs.
  assert.deepEqual(ids(pinRowsOf(pins([['a'], ['b'], ['c']]))), ['ab', 'c']);
  // Laid out: neighbours with the same row number share a row.
  assert.deepEqual(ids(pinRowsOf(pins([['a', 0], ['b', 0], ['c', 0], ['d', 1], ['e', 2], ['f', 2]]))), ['abc', 'd', 'ef']);
  // A tile closing shrinks its row and leaves the others alone.
  assert.deepEqual(ids(pinRowsOf(pins([['a', 0], ['b', 0], ['e', 2], ['f', 2]]))), ['ab', 'ef']);
  // A new pin fills a lone tile's row, or starts its own.
  assert.deepEqual(ids(pinRowsOf(pins([['a', 0], ['b', 0], ['c', 0], ['d', 1], ['e']]))), ['abc', 'de']);
  assert.deepEqual(ids(pinRowsOf(pins([['a', 0], ['b', 0], ['c', 0], ['d']]))), ['abc', 'd']);
  // No row holds more than six.
  assert.deepEqual(ids(pinRowsOf(pins('abcdefgh'.split('').map((id) => [id, 0])))), ['abcdef', 'gh']);

  const snap = mockSnapshot(NOW);
  snap.tabs.filter((t) => t.pinned).forEach((t, i) => { t.pinRow = i < 3 ? 0 : 1; });
  const v = buildView({ ...snap, auto: true, query: '', now: NOW });
  assert.deepEqual(v.pinRows.map((row) => row.length), [3, 1]);
});
