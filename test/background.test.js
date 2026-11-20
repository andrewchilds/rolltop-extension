import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackground } from '../src/background/core.js';

const DAY = 86400000;
const NOW = 1_800_000_000_000;
const FAST = { classify: 0, push: 0, save: 0 };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    fire: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}

// The slice of the WebExtension API the background script uses.
function fakeBrowser(initialTabs = [], stored = {}) {
  let nextId = 100;
  const tabs = initialTabs.map((t, i) => ({
    windowId: 1, index: i, status: 'complete', pinned: false, active: false,
    lastAccessed: NOW, title: t.url, ...t,
  }));
  const tabValues = new Map();
  const storage = { ...stored };
  const api = {
    _tabs: tabs,
    _storage: storage,
    _tabValues: tabValues,
    tabs: {
      onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event(),
      onMoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
      query: async () => tabs.map((t) => ({ ...t })),
      get: async (id) => ({ ...tabs.find((t) => t.id === id) }),
      create: async (props) => {
        const tab = {
          id: nextId++, windowId: props.windowId ?? 1, index: tabs.length, status: 'complete',
          pinned: !!props.pinned, active: !!props.active, lastAccessed: NOW,
          url: props.url || 'about:newtab', title: props.url || 'New Tab',
        };
        tabs.push(tab);
        api.tabs.onCreated.fire({ ...tab });
        return { ...tab };
      },
      update: async (id, props) => {
        const tab = tabs.find((t) => t.id === id);
        if (props.active) tabs.forEach((t) => { if (t.windowId === tab.windowId) t.active = false; });
        Object.assign(tab, props);
        api.tabs.onUpdated.fire(id, props, { ...tab });
        return { ...tab };
      },
      move: async (id, { index }) => {
        const from = tabs.findIndex((t) => t.id === id);
        const [tab] = tabs.splice(from, 1);
        tabs.splice(index, 0, tab);
        tabs.forEach((t, i) => { t.index = i; });
        api.tabs.onMoved.fire(id, {});
        return { ...tab };
      },
      remove: async (ids) => {
        for (const id of [].concat(ids)) {
          const i = tabs.findIndex((t) => t.id === id);
          if (i < 0) continue;
          tabs.splice(i, 1);
          api.tabs.onRemoved.fire(id, {});
        }
      },
    },
    sessions: {
      setTabValue: async (id, key, value) => { tabValues.set(id + key, value); },
      getTabValue: async (id, key) => tabValues.get(id + key),
      removeTabValue: async (id, key) => { tabValues.delete(id + key); },
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in storage).map((k) => [k, storage[k]])),
        set: async (obj) => { Object.assign(storage, JSON.parse(JSON.stringify(obj))); },
      },
      onChanged: event(),
    },
    runtime: { onConnect: event(), onMessage: event() },
    alarms: { create: () => {}, onAlarm: event() },
  };
  return api;
}

async function boot(tabs, opts = {}) {
  const browser = fakeBrowser(tabs, opts.stored);
  const bg = createBackground({ browser, classifyWithAI: opts.ai, now: () => NOW, delay: FAST });
  await bg.start();
  await tick();
  await bg.runClassify();
  await tick();
  return { browser, bg };
}

const groupOf = (bg, tabId) => bg.state.groups[bg.assign.get(tabId)?.groupId];

test('without an API key, open tabs are grouped by site on startup', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://docs.example.com/a' },
    { id: 2, url: 'https://example.com/b' },
    { id: 3, url: 'https://other.org/' },
    { id: 4, url: 'about:newtab' },
  ]);
  assert.equal(groupOf(bg, 1).name, 'example.com');
  assert.equal(groupOf(bg, 1), groupOf(bg, 2));
  assert.equal(groupOf(bg, 3).name, 'other.org');
  assert.equal(bg.assign.has(4), false);
  assert.equal(browser._tabValues.get('1tidy').groupId, groupOf(bg, 1).id);
  assert.equal(Object.keys(browser._storage.groups).length, 2);
});

test('a tab that navigates to another site is re-filed and the empty group removed', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://example.com/' }]);
  browser._tabs[0].url = 'https://other.org/';
  browser.tabs.onUpdated.fire(1, { url: 'https://other.org/', status: 'complete' }, { ...browser._tabs[0] });
  await tick();
  await bg.runClassify();
  assert.equal(groupOf(bg, 1).name, 'other.org');
  assert.deepEqual(Object.values(bg.state.groups).map((g) => g.name), ['other.org']);
});

test('the AI plan is applied, with site grouping for tabs it skips', async () => {
  const calls = [];
  const ai = async (req) => {
    calls.push(req);
    return {
      newGroups: [{ ref: 'n1', name: 'Kyoto in spring', label: 'Trip', parent: null }],
      assignments: [{ tabId: 1, group: 'n1' }, { tabId: 2, group: 'n1' }],
      renames: [],
    };
  };
  const { bg } = await boot([
    { id: 1, url: 'https://slowroutes.travel/kyoto', title: 'Kyoto route' },
    { id: 2, url: 'https://skycast.net/kyoto', title: 'Kyoto weather' },
    { id: 3, url: 'https://ledgerly.com/', title: 'Taxes' },
  ], { ai, stored: { settings: { apiKey: 'sk-test' } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tabs.length, 3);
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(groupOf(bg, 1).name, 'Kyoto in spring');
  assert.equal(groupOf(bg, 2), groupOf(bg, 1));
  assert.equal(groupOf(bg, 3).name, 'ledgerly.com');
});

test('an AI failure falls back to site grouping and surfaces the error', async () => {
  const ai = async () => { throw new Error('AI sorting is off: the API key was rejected.'); };
  const { bg } = await boot([{ id: 1, url: 'https://example.com/' }], {
    ai, stored: { settings: { apiKey: 'bad' } },
  });
  assert.equal(groupOf(bg, 1).name, 'example.com');
  assert.match((await bg.snapshot()).error, /API key was rejected/);
});

test('closing from the sidebar archives the tab; reopening restores its group', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a', title: 'A' },
    { id: 2, url: 'https://other.org/', title: 'B' },
  ]);
  const groupId = bg.assign.get(1).groupId;
  await bg.handle({ type: 'closeTab', tabId: 1 });
  assert.deepEqual(browser._tabs.map((t) => t.id), [2]);
  assert.equal(bg.state.archive[0].url, 'https://example.com/a');
  assert.ok(bg.state.groups[groupId], 'group survives while it has archived tabs');

  await bg.handle({ type: 'reopenTab', archiveId: bg.state.archive[0].id, windowId: 1 });
  await tick();
  await bg.runClassify();
  const reopened = browser._tabs.find((t) => t.url === 'https://example.com/a');
  assert.equal(bg.assign.get(reopened.id).groupId, groupId);
  assert.equal(bg.state.archive.length, 0);
});

test('archiving the last tabs in a window opens a blank tab first', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://example.com/' }]);
  await bg.handle({ type: 'archiveGroup', groupId: bg.assign.get(1).groupId });
  assert.equal(browser._tabs.length, 1);
  assert.equal(browser._tabs[0].url, 'about:newtab');
  assert.equal(bg.state.archive.length, 1);
});

test('auto-tidy archives stale tabs but spares pinned tabs and pinned groups', async () => {
  const old = NOW - 20 * DAY;
  const { bg, browser } = await boot([
    { id: 1, url: 'https://stale.com/', lastAccessed: old },
    { id: 2, url: 'https://pinnedtab.com/', lastAccessed: old, pinned: true },
    { id: 3, url: 'https://pinnedgroup.com/', lastAccessed: old },
    { id: 4, url: 'https://fresh.com/', lastAccessed: NOW - DAY },
    { id: 5, url: 'https://active.com/', lastAccessed: old, active: true },
  ], { stored: { settings: { auto: false } } });
  await bg.handle({ type: 'pinGroup', groupId: bg.assign.get(3).groupId });
  await bg.handle({ type: 'setAuto', auto: true });
  assert.deepEqual(browser._tabs.map((t) => t.id), [2, 3, 4, 5]);
  assert.deepEqual(bg.state.archive.map((a) => a.url), ['https://stale.com/']);
});

test('auto-tidy off archives nothing', async () => {
  const { bg, browser } = await boot(
    [{ id: 1, url: 'https://stale.com/', lastAccessed: NOW - 60 * DAY }, { id: 2, url: 'https://b.com/' }],
    { stored: { settings: { auto: false } } },
  );
  await bg.tidy();
  assert.equal(browser._tabs.length, 2);
});

test('groups are restored from the session after a restart', async () => {
  const first = await boot([{ id: 1, url: 'https://example.com/' }]);
  const browser = first.browser;
  const bg = createBackground({ browser, now: () => NOW, delay: FAST });
  // Reuse the same fake so storage and tab values carry over.
  browser.tabs.onCreated = event(); browser.tabs.onUpdated = event();
  browser.tabs.onRemoved = event(); browser.tabs.onActivated = event();
  await bg.start();
  assert.equal(bg.queue.size, 0);
  assert.equal(groupOf(bg, 1).name, 'example.com');
});

test('sidebars receive a snapshot on connect', async () => {
  const { browser } = await boot([{ id: 1, url: 'https://example.com/' }]);
  const received = [];
  browser.runtime.onConnect.fire({
    onDisconnect: event(), onMessage: event(), postMessage: (m) => received.push(m),
  });
  await tick();
  assert.equal(received[0].type, 'state');
  assert.equal(received[0].tabs[0].groupId, Object.keys(received[0].groups)[0]);
  assert.equal(received[0].ai, false);
});

test('snapshots carry archive counts, and archived tabs come back through search', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a', title: 'Alpha notes' },
    { id: 2, url: 'https://example.com/b', title: 'Beta notes' },
    { id: 3, url: 'https://other.org/', title: 'Other' },
  ]);
  const groupId = bg.assign.get(1).groupId;
  await bg.handle({ type: 'closeTab', tabId: 1 });
  await bg.handle({ type: 'closeTab', tabId: 2 });

  const received = [];
  const onMessage = event();
  browser.runtime.onConnect.fire({
    onDisconnect: event(), onMessage, postMessage: (m) => received.push(m),
  });
  await tick();
  const snap = received.find((m) => m.type === 'state');
  assert.equal('archive' in snap, false);
  assert.deepEqual(snap.archiveCounts, { [groupId]: 2 });

  onMessage.fire({ type: 'search', query: ' ALPHA ' });
  const hits = received.find((m) => m.type === 'archiveHits');
  assert.equal(hits.query, ' ALPHA ');
  assert.deepEqual(hits.tabs.map((t) => t.title), ['Alpha notes']);
  assert.equal(bg.searchArchive('example.com').length, 2);
  assert.equal(bg.searchArchive('').length, 0);
});

test('the AI sees groups in use and recently archived ones, not the old archive', async () => {
  const group = (id, name, extra = {}) => ({
    id, name, label: 'Topic', hue: 10, parentId: null, order: Number(id.slice(1)),
    pinned: false, collapsed: false, ...extra,
  });
  const archived = (id, groupId, days) => ({
    id, groupId, title: `Tab in ${groupId}`, url: `https://${groupId}.example/`, favIconUrl: '', at: NOW - days * DAY,
  });
  let seen = null;
  const ai = async (req) => {
    seen = req.groups;
    return { newGroups: [], assignments: [{ tabId: 1, group: 'g4' }], renames: [] };
  };
  await boot([{ id: 1, url: 'https://new.example/', title: 'New tab to file' }], {
    ai,
    stored: {
      settings: { apiKey: 'sk-test', auto: false },
      counters: { nextGroup: 10, topLevel: 5, nextArchive: 10 },
      groups: {
        g1: group('g1', 'Old trip'),
        g2: group('g2', 'Recent project'),
        g3: group('g3', 'Recent parent'),
        g4: group('g4', 'Recent child', { parentId: 'g3' }),
        g5: group('g5', 'old.example', { site: 'old.example' }),
      },
      archive: [
        archived('a1', 'g1', 45),
        archived('a2', 'g2', 3),
        archived('a3', 'g4', 10),
        archived('a4', 'g5', 1),
      ],
    },
  });
  assert.deepEqual(seen.map((g) => g.id).sort(), ['g2', 'g3', 'g4']);
  assert.deepEqual(seen.find((g) => g.id === 'g4').titles, ['Tab in g4']);
  assert.equal(seen.find((g) => g.id === 'g4').parentId, 'g3');
});

function sidebarPort(browser) {
  const received = [];
  const onMessage = event();
  browser.runtime.onConnect.fire({
    onDisconnect: event(), onMessage, postMessage: (m) => received.push(m),
  });
  return { received, send: (msg) => onMessage.fire(msg) };
}

test('a renamed group keeps its name when the AI tries to rename it', async () => {
  let rename = false;
  const ai = async (req) => ({
    newGroups: rename ? [] : [{ ref: 'n', name: 'Kyoto in spring', label: 'Trip', parent: null }],
    assignments: req.tabs.map((t) => ({ tabId: t.id, group: rename ? 'g1' : 'n' })),
    renames: rename ? [{ groupId: 'g1', name: 'Kyoto trip', label: 'Travel' }] : [],
  });
  const { bg, browser } = await boot(
    [{ id: 1, url: 'https://slowroutes.travel/kyoto' }],
    { ai, stored: { settings: { apiKey: 'sk-test' } } },
  );
  await bg.handle({ type: 'renameGroup', groupId: 'g1', name: '  Japan   2027 ' });
  assert.equal(bg.state.groups.g1.name, 'Japan 2027');
  assert.equal(bg.state.groups.g1.manual, true);
  await bg.handle({ type: 'renameGroup', groupId: 'g1', name: '   ' });
  assert.equal(bg.state.groups.g1.name, 'Japan 2027');

  rename = true;
  await browser.tabs.create({ url: 'https://skycast.net/kyoto' });
  await tick();
  await bg.runClassify();
  assert.equal(bg.state.groups.g1.name, 'Japan 2027');
  assert.equal(groupOf(bg, 100).id, 'g1');
  await tick();
  assert.equal(browser._storage.groups.g1.manual, true);
});

test('a tag set by hand changes one group and survives an AI rename', async () => {
  let rename = false;
  const ai = async (req) => ({
    newGroups: rename ? [] : [
      { ref: 'a', name: 'Kyoto in spring', label: 'Trip', parent: null },
      { ref: 'b', name: 'Lisbon in fall', label: 'Trip', parent: null },
    ],
    assignments: req.tabs.map((t, i) => ({ tabId: t.id, group: rename ? 'g1' : i ? 'b' : 'a' })),
    renames: rename ? [{ groupId: 'g1', name: 'Kyoto trip', label: 'Travel' }] : [],
  });
  const { bg, browser } = await boot(
    [{ id: 1, url: 'https://slowroutes.travel/kyoto' }, { id: 2, url: 'https://slowroutes.travel/lisbon' }],
    { ai, stored: { settings: { apiKey: 'sk-test' } } },
  );
  await bg.handle({ type: 'setGroupLabel', groupId: 'g1', label: '  Spring   holiday in Japan ' });
  assert.equal(bg.state.groups.g1.label, 'Spring holiday');
  assert.equal(bg.state.groups.g2.label, 'Trip');
  await bg.handle({ type: 'setGroupLabel', groupId: 'g1', label: '   ' });
  assert.equal(bg.state.groups.g1.label, 'Spring holiday');

  rename = true;
  await browser.tabs.create({ url: 'https://skycast.net/kyoto' });
  await tick();
  await bg.runClassify();
  assert.equal(bg.state.groups.g1.name, 'Kyoto trip');
  assert.equal(bg.state.groups.g1.label, 'Spring holiday');
  await tick();
  assert.equal(browser._storage.groups.g1.manualLabel, true);
});

test('a manually moved tab stays put through navigation, re-sort and restart', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a' },
    { id: 2, url: 'https://other.org/' },
  ]);
  const target = bg.assign.get(2).groupId;
  await bg.handle({ type: 'moveTab', tabId: 1, groupId: target });
  assert.equal(bg.assign.get(1).groupId, target);
  assert.deepEqual(browser._tabValues.get('1tidy'), { groupId: target, host: 'example.com', manual: true });
  assert.deepEqual(Object.values(bg.state.groups).map((g) => g.name), ['other.org']);

  browser._tabs[0].url = 'https://third.net/';
  browser.tabs.onUpdated.fire(1, { url: 'https://third.net/', status: 'complete' }, { ...browser._tabs[0] });
  await tick();
  await bg.runClassify();
  assert.equal(bg.queue.size, 0);
  assert.equal(bg.assign.get(1).groupId, target);

  await bg.handle({ type: 'resort' });
  assert.equal(bg.assign.get(1).groupId, target);

  const again = createBackground({ browser, now: () => NOW, delay: FAST });
  browser.tabs.onCreated = event(); browser.tabs.onUpdated = event();
  browser.tabs.onRemoved = event(); browser.tabs.onActivated = event();
  await again.start();
  assert.equal(again.queue.size, 0);
  assert.equal(again.assign.get(1).manual, true);
});

test('a tab moved while the classifier is running is not re-filed by its plan', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const ai = async (req) => {
    calls += 1;
    if (calls > 1) await gate;
    return {
      newGroups: [{ ref: 'n', name: `Topic ${calls}`, label: 'Work', parent: null }],
      assignments: req.tabs.map((t) => ({ tabId: t.id, group: 'n' })),
      renames: [],
    };
  };
  const { bg, browser } = await boot(
    [{ id: 1, url: 'https://example.com/' }],
    { ai, stored: { settings: { apiKey: 'sk-test' } } },
  );
  const target = bg.assign.get(1).groupId;
  await browser.tabs.create({ url: 'https://other.org/' });
  await tick();
  assert.equal(calls, 2);
  await bg.handle({ type: 'moveTab', tabId: 100, groupId: target });
  release();
  await bg.runClassify();
  assert.equal(bg.assign.get(100).groupId, target);
  assert.deepEqual(Object.keys(bg.state.groups), [target]);
});

test('menu clicks on a tab row: archive, move to a group, move to a new group', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a', title: 'A' },
    { id: 2, url: 'https://other.org/', title: 'B' },
    { id: 3, url: 'https://third.net/', title: 'C' },
  ]);
  const port = sidebarPort(browser);
  const other = bg.assign.get(2).groupId;
  assert.deepEqual(bg.moveTargets(1).map((t) => t.title), ['other.org', 'third.net']);

  await bg.menuClick('tidy-move:' + other, 1);
  assert.equal(bg.assign.get(1).groupId, other);
  assert.deepEqual(bg.moveTargets(1).map((t) => t.title), ['third.net']);

  // The browser did not name the tab: fall back to the row the sidebar reported.
  port.send({ type: 'menuTarget', tabId: 3 });
  await bg.menuClick('tidy-move-new');
  const made = groupOf(bg, 3);
  assert.equal(made.name, 'New group');
  assert.equal(made.manual, true);
  assert.equal(bg.assign.get(3).manual, true);
  assert.deepEqual(port.received.filter((m) => m.type === 'editGroup'), [{ type: 'editGroup', groupId: made.id }]);

  await bg.menuClick('tidy-tab-archive', 2);
  assert.deepEqual(browser._tabs.map((t) => t.id), [1, 3]);
  assert.equal(bg.state.archive[0].url, 'https://other.org/');
});

test('menu clicks on a group row act on the group the sidebar reported', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a' },
    { id: 2, url: 'https://other.org/' },
  ]);
  const port = sidebarPort(browser);
  const groupId = bg.assign.get(1).groupId;
  port.send({ type: 'menuTarget', groupId });

  await bg.menuClick('tidy-group-pin');
  assert.equal(bg.state.groups[groupId].pinned, true);
  await bg.menuClick('tidy-group-toggle');
  assert.equal(bg.state.groups[groupId].collapsed, true);
  await bg.menuClick('tidy-group-rename');
  assert.deepEqual(port.received.filter((m) => m.type === 'editGroup'), [{ type: 'editGroup', groupId }]);
  await bg.menuClick('tidy-group-archive');
  assert.deepEqual(browser._tabs.map((t) => t.id), [2]);
  assert.equal(bg.state.archive.length, 1);
});

test('a natively closed tab is archived like any other', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a', title: 'Alpha notes' },
    { id: 2, url: 'https://example.com/b', title: 'Beta notes' },
    { id: 3, url: 'https://other.org/', title: 'Other' },
    { id: 4, url: 'about:newtab', title: 'New Tab' },
  ]);
  const groupId = bg.assign.get(1).groupId;
  const otherId = bg.assign.get(3).groupId;
  await browser.tabs.remove([1, 3, 4]);
  await tick();

  assert.deepEqual(bg.state.archive.map((a) => a.title), ['Other', 'Alpha notes']);
  assert.deepEqual(bg.searchArchive('alpha').map((a) => a.url), ['https://example.com/a']);
  assert.deepEqual((await bg.snapshot()).archiveCounts, { [groupId]: 1, [otherId]: 1 });
  assert.ok(bg.state.groups[otherId], 'the group lives on through its archived tab');
  assert.equal(browser._storage.archive.length, 2);

  await bg.handle({ type: 'reopenGroup', groupId: otherId, windowId: 1 });
  const reopened = browser._tabs.find((t) => t.url === 'https://other.org/');
  assert.equal(bg.assign.get(reopened.id).groupId, otherId);
  assert.deepEqual(bg.state.archive.map((a) => a.title), ['Alpha notes']);
});

test('closing the same page twice keeps one record, hidden from search while it is open', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a', title: 'Alpha' },
    { id: 2, url: 'https://other.org/', title: 'Other' },
  ]);
  await browser.tabs.remove(1);
  const again = await browser.tabs.create({ url: 'https://example.com/a' });
  await tick();
  await bg.runClassify();
  assert.equal(bg.searchArchive('example').length, 0);
  await bg.handle({ type: 'closeTab', tabId: again.id });
  assert.equal(bg.state.archive.length, 1);
  assert.equal(bg.searchArchive('example').length, 1);
});

test('switching auto-tidy on in settings archives stale tabs right away', async () => {
  const { bg, browser } = await boot(
    [{ id: 1, url: 'https://stale.com/', lastAccessed: NOW - 20 * DAY }, { id: 2, url: 'https://b.com/' }],
    { stored: { settings: { auto: false } } },
  );
  assert.equal(browser._tabs.length, 2);
  browser.storage.onChanged.fire({ settings: { newValue: { auto: true } } }, 'local');
  await tick();
  assert.deepEqual(browser._tabs.map((t) => t.id), [2]);
  assert.equal((await bg.snapshot()).auto, true);
});

test('a tab dropped beside another joins its group and takes that place in the strip', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://a.com/' },
    { id: 2, url: 'https://b.com/x' },
    { id: 3, url: 'https://b.com/y' },
    { id: 4, url: 'https://c.com/' },
  ]);
  const b = bg.assign.get(2).groupId;
  const order = () => browser._tabs.map((t) => t.id);

  await bg.handle({ type: 'moveTab', tabId: 1, groupId: b, nearTabId: 3, after: false });
  assert.deepEqual(order(), [2, 1, 3, 4]);
  assert.deepEqual(bg.assign.get(1), { groupId: b, host: 'a.com', manual: true });

  await bg.handle({ type: 'moveTab', tabId: 4, groupId: b, nearTabId: 2, after: true });
  assert.deepEqual(order(), [2, 4, 1, 3]);
  await bg.handle({ type: 'moveTab', tabId: 2, groupId: b, nearTabId: 3, after: true });
  assert.deepEqual(order(), [4, 1, 3, 2]);
  await bg.handle({ type: 'moveTab', tabId: 3, groupId: b, nearTabId: 4, after: false });
  assert.deepEqual(order(), [3, 4, 1, 2]);
  assert.deepEqual(Object.keys(bg.state.groups), [b]);
});

test('groups can be reordered, nested and un-nested, within the depth limit', async () => {
  const { bg } = await boot([
    { id: 1, url: 'https://a.com/' },
    { id: 2, url: 'https://b.com/' },
    { id: 3, url: 'https://c.com/' },
    { id: 4, url: 'https://d.com/' },
  ]);
  const [a, b, c, d] = [1, 2, 3, 4].map((id) => bg.assign.get(id).groupId);
  const g = bg.state.groups;
  const top = () => Object.values(g).filter((x) => !x.parentId).sort((x, y) => x.order - y.order).map((x) => x.id);
  const move = (groupId, targetId, where) => bg.handle({ type: 'moveGroup', groupId, targetId, where });

  await move(d, a, 'before');
  assert.deepEqual(top(), [d, a, b, c]);
  await move(d, b, 'after');
  assert.deepEqual(top(), [a, b, d, c]);
  await move(a, c, 'after');
  assert.deepEqual(top(), [b, d, c, a]);

  g[b].collapsed = true;
  await move(a, b, 'into');
  assert.equal(g[a].parentId, b);
  assert.equal(g[b].collapsed, false);
  await move(c, a, 'into');
  assert.equal(g[c].parentId, a);
  await move(d, c, 'into');
  assert.equal(g[d].parentId, null, 'a fourth level is refused');
  await move(b, c, 'into');
  assert.equal(g[b].parentId, null, 'a group cannot move into its own descendant');
  await move(b, d, 'into');
  assert.equal(g[b].parentId, null, 'a three-level subtree cannot be nested');

  await move(d, c, 'before');
  assert.equal(g[d].parentId, a);
  await move(c, b, 'before');
  assert.equal(g[c].parentId, null);
  assert.deepEqual(top(), [c, b]);
  await tick();
  assert.equal((await bg.snapshot()).groups[d].parentId, a);
});

test('a pinned tab can be placed before or after another without changing groups', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://a.com/', pinned: true },
    { id: 2, url: 'https://b.com/', pinned: true },
    { id: 3, url: 'https://c.com/', pinned: true },
  ]);
  const before = bg.assign.get(3);
  await bg.handle({ type: 'placeTab', tabId: 3, nearTabId: 1, after: false });
  assert.deepEqual(browser._tabs.map((t) => t.id), [3, 1, 2]);
  await bg.handle({ type: 'placeTab', tabId: 3, nearTabId: 2, after: true });
  assert.deepEqual(browser._tabs.map((t) => t.id), [1, 2, 3]);
  await bg.handle({ type: 'placeTab', tabId: 3, nearTabId: 3, after: true });
  assert.deepEqual(browser._tabs.map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(bg.assign.get(3), before);
});

test('a tab dropped on a pinned tile is pinned beside it', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://a.com/', pinned: true },
    { id: 2, url: 'https://b.com/', pinned: true },
    { id: 3, url: 'https://c.com/' },
    { id: 4, url: 'https://d.com/' },
  ]);
  await bg.handle({ type: 'pinTab', tabId: 4, pinned: true, nearTabId: 2, after: false });
  assert.deepEqual(browser._tabs.map((t) => t.id), [1, 4, 2, 3]);
  assert.equal(browser._tabs[1].pinned, true);
  await bg.handle({ type: 'pinTab', tabId: 3, pinned: true });
  assert.deepEqual(browser._tabs.filter((t) => t.pinned).map((t) => t.id), [1, 4, 2, 3]);
});

test('a renamed tab shows its new title until the name is cleared, and keeps it through the archive', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://a.com/', title: 'Page A' },
    { id: 2, url: 'https://b.com/', title: 'Page B' },
  ]);
  const nameOf = async (id) => (await bg.snapshot()).tabs.find((t) => t.id === id).name;
  await bg.handle({ type: 'renameTab', tabId: 1, name: '  My   notes ' });
  assert.equal(await nameOf(1), 'My notes');
  assert.equal((await bg.snapshot()).tabs[0].title, 'Page A');
  assert.equal(await nameOf(2), '');

  await bg.handle({ type: 'closeTab', tabId: 1 });
  const rec = bg.state.archive[0];
  assert.equal(rec.title, 'Page A');
  await bg.handle({ type: 'reopenTab', archiveId: rec.id, windowId: 1 });
  const reopened = browser._tabs.find((t) => t.url === 'https://a.com/');
  assert.equal(await nameOf(reopened.id), 'My notes');

  await bg.handle({ type: 'renameTab', tabId: reopened.id, name: ' ' });
  assert.equal(await nameOf(reopened.id), '');
});

test('each sorting run is logged with where tabs went and why', async () => {
  const ai = async ({ tabs }) => ({
    newGroups: [{ ref: 'n', name: 'Kyoto in spring', label: 'Trip', parent: null }],
    assignments: [{ tabId: tabs[0].id, group: 'n', reason: 'A trip plan; nothing existing fits.' }],
    renames: [],
  });
  const { bg, browser } = await boot(
    [{ id: 1, url: 'https://slowroutes.travel/kyoto?x=1', title: 'Kyoto route' }, { id: 2, url: 'https://b.com/', title: 'B' }],
    { ai, stored: { settings: { apiKey: 'sk-test' } } },
  );
  const [entry] = bg.state.log;
  assert.equal(entry.model, 'claude-opus-5-5');
  assert.deepEqual(entry.tabs.map((t) => [t.url, t.by, t.group, t.created, t.reason]), [
    ['slowroutes.travel/kyoto', 'ai', 'Kyoto in spring', true, 'A trip plan; nothing existing fits.'],
    ['b.com/', 'site', 'b.com', true, ''],
  ]);
  await tick();
  assert.equal(browser._storage.log.length, 1);
  await bg.handle({ type: 'clearLog' });
  assert.deepEqual(bg.state.log, []);
});

test('a site group the user renamed is shown to the AI; an untouched one is not', async () => {
  let shown = [];
  let on = false;
  const ai = async ({ groups, tabs }) => {
    if (!on) throw new Error('offline');
    shown = groups;
    return { newGroups: [], assignments: tabs.map((t) => ({ tabId: t.id, group: groups[0].id, reason: '' })), renames: [] };
  };
  const { bg, browser } = await boot(
    [{ id: 1, url: 'https://pennant.cards/a', title: 'A' }, { id: 2, url: 'https://other.org/', title: 'O' }],
    { ai, stored: { settings: { apiKey: 'sk-test' } } },
  );
  const pennant = bg.assign.get(1).groupId;
  assert.equal(bg.state.groups[pennant].site, 'pennant.cards');
  assert.equal(bg.state.log[0].error, 'offline');
  await bg.handle({ type: 'renameGroup', groupId: pennant, name: 'Pennant' });

  on = true;
  await browser.tabs.create({ url: 'https://pennant.cards/schedule' });
  await tick();
  await bg.runClassify();
  assert.deepEqual(shown.map((g) => g.name), ['Pennant']);
  assert.equal(bg.assign.get(100).groupId, pennant);
  assert.equal(bg.state.log[0].tabs[0].created, false);
});

test('a new tab can be opened pinned', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://a.com/', pinned: true }]);
  await bg.handle({ type: 'newTab', windowId: 1, pinned: true });
  assert.deepEqual(browser._tabs.map((t) => t.pinned), [true, true]);
});

test('archiving a group leaves its pinned tabs open', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a', pinned: true },
    { id: 2, url: 'https://example.com/b' },
    { id: 3, url: 'https://other.org/' },
  ]);
  const groupId = bg.assign.get(1).groupId;
  await bg.handle({ type: 'archiveGroup', groupId });
  assert.deepEqual(browser._tabs.map((t) => t.id), [1, 3]);
  assert.deepEqual(bg.state.archive.map((a) => a.url), ['https://example.com/b']);
  assert.equal(bg.assign.get(1).groupId, groupId);
});
