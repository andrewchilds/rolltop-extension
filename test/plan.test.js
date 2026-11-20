import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan, gcGroups, heuristicPlan, siteOf } from '../extension/lib/plan.js';
import { buildPayload, toPlan } from '../src/background/classify-ai.js';

const counters = () => ({ nextGroup: 1, topLevel: 0, nextArchive: 1 });

test('siteOf keeps subdomains of one site together', () => {
  assert.equal(siteOf('https://www.example.com/a'), 'example.com');
  assert.equal(siteOf('https://docs.example.com/a'), 'example.com');
  assert.equal(siteOf('https://news.bbc.co.uk/'), 'bbc.co.uk');
  assert.equal(siteOf('http://localhost:3000/'), 'localhost');
  assert.equal(siteOf('http://192.168.1.4/'), '192.168.1.4');
  assert.equal(siteOf('about:newtab'), '');
});

test('heuristic plan groups by site and reuses existing site groups', () => {
  const tabs = [
    { id: 1, url: 'https://a.example.com/x' },
    { id: 2, url: 'https://b.example.com/y' },
    { id: 3, url: 'https://other.org/' },
  ];
  const first = applyPlan({}, counters(), heuristicPlan(tabs, {}), new Set([1, 2, 3]));
  assert.equal(Object.keys(first.groups).length, 2);
  assert.equal(first.assign[1], first.assign[2]);
  assert.notEqual(first.assign[1], first.assign[3]);

  const again = heuristicPlan([{ id: 4, url: 'https://example.com/z' }], first.groups);
  assert.equal(again.newGroups.length, 0);
  assert.equal(again.assignments[0].group, first.assign[1]);
});

test('applyPlan resolves nested new groups given in any order', () => {
  const plan = {
    newGroups: [
      { ref: 'stay', name: 'Where to stay', label: 'Lodging', parent: 'trip' },
      { ref: 'trip', name: 'Kyoto in spring', label: 'Trip', parent: null },
    ],
    assignments: [{ tabId: 1, group: 'trip' }, { tabId: 2, group: 'stay' }],
    renames: [],
  };
  const res = applyPlan({}, counters(), plan, new Set([1, 2]));
  const trip = res.groups[res.assign[1]];
  const stay = res.groups[res.assign[2]];
  assert.equal(trip.parentId, null);
  assert.equal(stay.parentId, trip.id);
  assert.notEqual(stay.hue, trip.hue);
  assert.equal(res.counters.nextGroup, 3);
});

test('applyPlan ignores unknown tabs and groups, and reuses same-named groups', () => {
  const base = applyPlan({}, counters(), {
    newGroups: [{ ref: 'n', name: 'Tax paperwork', label: 'Admin', parent: null }],
    assignments: [{ tabId: 1, group: 'n' }],
  }, new Set([1]));
  const res = applyPlan(base.groups, base.counters, {
    newGroups: [{ ref: 'dup', name: 'tax paperwork', label: 'Admin', parent: null }],
    assignments: [
      { tabId: 2, group: 'dup' },
      { tabId: 3, group: 'nope' },
      { tabId: 404, group: 'dup' },
    ],
  }, new Set([2, 3]));
  assert.equal(Object.keys(res.groups).length, 1);
  assert.deepEqual(res.assign, { 2: base.assign[1] });
});

test('applyPlan caps nesting depth and applies renames', () => {
  const plan = {
    newGroups: [
      { ref: 'a', name: 'A', label: 'L', parent: null },
      { ref: 'b', name: 'B', label: 'L', parent: 'a' },
      { ref: 'c', name: 'C', label: 'L', parent: 'b' },
      { ref: 'd', name: 'D', label: 'L', parent: 'c' },
    ],
    assignments: [{ tabId: 1, group: 'd' }],
  };
  const res = applyPlan({}, counters(), plan, new Set([1]));
  const d = res.groups[res.assign[1]];
  const depth = (g) => (g.parentId ? 1 + depth(res.groups[g.parentId]) : 1);
  assert.equal(depth(d), 3);

  const renamed = applyPlan(res.groups, res.counters, {
    renames: [{ groupId: d.id, name: 'Renamed', label: 'New' }],
  }, new Set());
  assert.equal(renamed.groups[d.id].name, 'Renamed');
  assert.equal(renamed.groups[d.id].label, 'New');
});

test('gcGroups keeps empty parents of used groups and drops the rest', () => {
  const groups = {
    p: { id: 'p', parentId: null, order: 1 },
    c: { id: 'c', parentId: 'p', order: 2 },
    x: { id: 'x', parentId: null, order: 3 },
  };
  assert.deepEqual(Object.keys(gcGroups(groups, new Set(['c']))), ['p', 'c']);
});

test('AI payload strips query strings and maps tab keys back to ids', () => {
  const { payload, keys } = buildPayload(
    [{ id: 41, title: 'Inbox', url: 'https://mail.example.com/u/0/?token=secret#frag', openerGroupId: 'g2' }],
    [{ id: 'g2', name: 'Mail', label: 'Work', parentId: null, titles: ['Inbox'] }],
  );
  assert.deepEqual(payload.tabs, [
    { tab: 't1', title: 'Inbox', url: 'mail.example.com/u/0/', opened_from: 'g2' },
  ]);
  const plan = toPlan({
    new_groups: [],
    assignments: [{ tab: 't1', group: 'g2', reason: 'Mail belongs with mail.' }, { tab: 't9', group: 'g2', reason: '' }],
    renames: [],
  }, keys);
  assert.deepEqual(plan.assignments, [{ tabId: 41, group: 'g2', reason: 'Mail belongs with mail.' }]);
});

test('applyPlan leaves a manually renamed group alone but still files tabs into it', () => {
  const base = applyPlan({}, counters(), {
    newGroups: [{ ref: 'n', name: 'Kyoto in spring', label: 'Trip', parent: null }],
    assignments: [{ tabId: 1, group: 'n' }],
  }, new Set([1]));
  const gid = base.assign[1];
  base.groups[gid] = { ...base.groups[gid], name: 'Japan', manual: true };
  const res = applyPlan(base.groups, base.counters, {
    renames: [{ groupId: gid, name: 'Kyoto trip', label: 'Travel' }],
    assignments: [{ tabId: 2, group: gid }],
  }, new Set([2]));
  assert.equal(res.groups[gid].name, 'Japan');
  assert.equal(res.groups[gid].label, 'Trip');
  assert.equal(res.assign[2], gid);
});

test('a plan cannot reach groups above the line', () => {
  const groups = {
    g1: { id: 'g1', name: 'Work', label: 'Work', hue: 1, parentId: null, order: 1, pinned: true },
    g2: { id: 'g2', name: 'Docs', label: 'Work', hue: 2, parentId: 'g1', order: 2 },
    g3: { id: 'g3', name: 'example.com', label: 'Site', hue: 3, parentId: null, order: 3, pinned: true, site: 'example.com' },
  };
  const res = applyPlan(groups, { nextGroup: 4, topLevel: 3, nextArchive: 1 }, {
    newGroups: [
      { ref: 'n', name: 'Specs', label: 'Work', parent: 'g1' },
      { ref: 'w', name: 'work', label: 'Work', parent: null },
    ],
    assignments: [{ tabId: 1, group: 'g1' }, { tabId: 2, group: 'g2' }, { tabId: 3, group: 'n' }, { tabId: 4, group: 'w' }],
    renames: [{ groupId: 'g2', name: 'Documents', label: 'Reading' }],
  }, new Set([1, 2, 3, 4]));
  assert.deepEqual(Object.keys(res.assign), ['3', '4']);
  assert.equal(res.groups[res.assign[3]].parentId, null, 'a new group is not nested above the line');
  assert.notEqual(res.assign[4], 'g1', 'a name above the line is not reused');
  assert.equal(res.groups.g2.name, 'Docs');

  const bySite = heuristicPlan([{ id: 5, url: 'https://example.com/a' }], groups);
  assert.equal(bySite.newGroups.length, 1);
});
