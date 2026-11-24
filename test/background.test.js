import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackground } from '../src/background/core.js';
import { buildView } from '../extension/lib/model.js';

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
    windowId: 1, index: i, status: 'complete', pinned: false, active: false, hidden: false,
    lastAccessed: NOW, title: t.url, ...t,
  }));
  const tabValues = new Map();
  const windowValues = new Map();
  const storage = { ...stored };
  const counts = {};
  const api = {
    _tabs: tabs,
    _storage: storage,
    _tabValues: tabValues,
    // Ids count up per kind (g1, g2, t1, ...) and carry on across a restart.
    _newId: (prefix) => prefix + (counts[prefix] = (counts[prefix] || 0) + 1),
    tabs: {
      onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event(),
      onMoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
      query: async () => tabs.map((t) => ({ ...t })),
      get: async (id) => ({ ...tabs.find((t) => t.id === id) }),
      create: async (props) => {
        const tab = {
          id: nextId++, windowId: props.windowId ?? 1, index: tabs.length, status: 'complete',
          pinned: !!props.pinned, active: !!props.active, hidden: false, lastAccessed: NOW,
          url: props.url || 'about:newtab', title: props.url || 'New Tab',
        };
        if (tab.active) tabs.forEach((t) => { if (t.windowId === tab.windowId) t.active = false; });
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
      // Like Firefox, neither a pinned tab nor the selected one can be hidden.
      hide: async (ids) => [].concat(ids).filter((id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab || tab.pinned || tab.active) return false;
        tab.hidden = true;
        return true;
      }),
      show: async (ids) => { tabs.forEach((t) => { if ([].concat(ids).includes(t.id)) t.hidden = false; }); },
    },
    windows: { update: async () => {} },
    sessions: {
      setTabValue: async (id, key, value) => { tabValues.set(id + key, value); },
      getTabValue: async (id, key) => tabValues.get(id + key),
      removeTabValue: async (id, key) => { tabValues.delete(id + key); },
      setWindowValue: async (id, key, value) => { windowValues.set(id + key, value); },
      getWindowValue: async (id, key) => windowValues.get(id + key),
    },
    storage: {
      local: {
        get: async (keys) => JSON.parse(JSON.stringify(keys == null
          ? storage
          : Object.fromEntries([].concat(keys).filter((k) => k in storage).map((k) => [k, storage[k]])))),
        set: async (obj) => { Object.assign(storage, JSON.parse(JSON.stringify(obj))); },
        remove: async (keys) => { [].concat(keys).forEach((k) => { delete storage[k]; }); },
      },
      onChanged: event(),
    },
    runtime: { onConnect: event(), onMessage: event() },
    alarms: { create: () => {}, onAlarm: event() },
  };
  return api;
}

// A background on a fake that is already in use: the browser restarting.
async function restart(browser, opts = {}) {
  for (const name of Object.keys(browser.tabs)) {
    if (name.startsWith('on')) browser.tabs[name] = event();
  }
  browser.runtime = { onConnect: event(), onMessage: event() };
  const bg = createBackground({
    browser, classifyWithAI: opts.ai, now: opts.now || (() => NOW), delay: FAST, newId: browser._newId,
  });
  await bg.start();
  return bg;
}

async function boot(tabs, opts = {}) {
  const browser = fakeBrowser(tabs, opts.stored);
  const bg = createBackground({
    browser, classifyWithAI: opts.ai, now: opts.now || (() => NOW), delay: FAST, newId: browser._newId,
  });
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
  // The tab carries only its record's uid; the record, in storage, has the group.
  assert.equal(browser._tabValues.get('1uid'), bg.assign.get(1).uid);
  const stored = browser._storage['ws:w1'];
  assert.equal(Object.keys(stored.groups).length, 2);
  assert.equal(stored.tabs.find((r) => r.uid === bg.assign.get(1).uid).groupId, groupOf(bg, 1).id);
  assert.deepEqual(browser._storage.meta, { version: 2, order: ['w1'], current: 'w1' });
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
  assert.equal(calls[0].model, 'claude-haiku-5-5');
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

for (const apiKey of ['sk-test', '']) {
  test(`private tabs are never sorted, recorded or sent to the AI (${apiKey ? 'with' : 'without'} a key)`, async () => {
    const calls = [];
    const ai = async (req) => {
      calls.push(req);
      return { newGroups: [], assignments: [], renames: [] };
    };
    const { bg, browser } = await boot([
      { id: 1, url: 'https://example.com/', title: 'Public' },
      { id: 2, url: 'https://secret.example.net/', title: 'Hidden plans', incognito: true },
    ], { ai, stored: { settings: { apiKey } } });
    browser._tabs[1].url = 'https://secret.example.net/more';
    browser.tabs.onUpdated.fire(2, { url: browser._tabs[1].url, status: 'complete' }, { ...browser._tabs[1] });
    await tick();
    await bg.runClassify();
    await bg.handle({ type: 'resort' });
    await bg.handle({ type: 'closeTab', tabId: 2 });
    await bg.flush();
    await tick();
    assert.equal(calls.length > 0, !!apiKey);
    assert.equal(bg.assign.has(2), false);
    assert.equal(groupOf(bg, 1).name, 'example.com');
    assert.deepEqual(Object.values(bg.state.groups).map((g) => g.name), ['example.com']);
    for (const seen of [calls, browser._storage, bg.state.log, bg.state.archive]) {
      assert.doesNotMatch(JSON.stringify(seen), /secret|Hidden plans/);
    }
  });
}

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

test('a group left alone for hours collapses once, until it is visited again', async () => {
  const HOUR = DAY / 24;
  const { bg, browser } = await boot([
    { id: 1, url: 'https://idle.com/', lastAccessed: NOW - 9 * HOUR },
    { id: 2, url: 'https://recent.com/', lastAccessed: NOW - 7 * HOUR },
    { id: 3, url: 'https://active.com/', lastAccessed: NOW - 9 * HOUR, active: true },
  ]);
  await bg.tidy();
  assert.equal(groupOf(bg, 1).collapsed, true);
  assert.ok(!groupOf(bg, 2).collapsed);
  assert.ok(!groupOf(bg, 3).collapsed);

  // Opened by hand, it stays open while nothing in it is visited.
  await bg.handle({ type: 'toggleGroup', groupId: groupOf(bg, 1).id });
  await bg.tidy();
  assert.equal(groupOf(bg, 1).collapsed, false);

  // A visit starts the clock again.
  groupOf(bg, 1).idleCollapsedAt = NOW - 12 * HOUR;
  browser._tabs[0].lastAccessed = NOW - 10 * HOUR;
  await bg.tidy();
  assert.equal(groupOf(bg, 1).collapsed, true);
});

test('the classifier leaves groups above the line alone', async () => {
  const seen = [];
  const ai = async (req) => {
    seen.push(req);
    return {
      newGroups: req.groups.length ? [] : [{ ref: 'n', name: 'Kyoto in spring', label: 'Trip', parent: null }],
      assignments: req.tabs.map((t) => ({ tabId: t.id, group: req.groups.length ? 'g1' : 'n' })),
      renames: seen.length > 1 ? [{ groupId: 'g1', name: 'Japan', label: 'Trip' }] : [],
    };
  };
  const { bg, browser } = await boot(
    [{ id: 1, url: 'https://slowroutes.travel/kyoto' }],
    { ai, stored: { settings: { apiKey: 'sk-test' } } },
  );
  await bg.handle({ type: 'pinGroup', groupId: 'g1' });

  // A tab opened from it: the group is not offered, and naming it anyway fails.
  await browser.tabs.create({ url: 'https://skycast.net/kyoto', openerTabId: 1 });
  await tick();
  await bg.runClassify();
  const last = seen[seen.length - 1];
  assert.deepEqual(last.groups, []);
  assert.equal(last.tabs[0].openerGroupId, null);
  assert.notEqual(groupOf(bg, 100).id, 'g1');
  assert.equal(bg.state.groups.g1.name, 'Kyoto in spring');

  // Its own tab stays when it navigates to another site.
  browser._tabs[0].url = 'https://other.org/';
  browser.tabs.onUpdated.fire(1, { url: 'https://other.org/', status: 'complete' }, { ...browser._tabs[0] });
  await tick();
  await bg.runClassify();
  assert.equal(groupOf(bg, 1).id, 'g1');
});

test('a group crosses the line by pin or by drag, taking its sub-groups', async () => {
  const { bg } = await boot([
    { id: 1, url: 'https://a.com/' }, { id: 2, url: 'https://b.com/' }, { id: 3, url: 'https://c.com/' },
  ]);
  const [a, b, c] = [1, 2, 3].map((id) => bg.assign.get(id).groupId);
  const g = bg.state.groups;
  const move = (groupId, targetId, where) => bg.handle({ type: 'moveGroup', groupId, targetId, where });
  await bg.handle({ type: 'pinGroup', groupId: a });
  await move(b, a, 'after');
  assert.equal(g[b].pinned, true, 'dropped beside a pinned group');
  await move(b, c, 'before');
  assert.equal(g[b].pinned, false, 'and back below');
  await move(b, a, 'into');
  assert.equal(g[b].pinned, false);
  await bg.handle({ type: 'pinGroup', groupId: b });
  assert.equal(g[b].pinned, false, 'a sub-group has no pin of its own');
  await bg.tidy();
  assert.equal(bg.state.archive.length, 0);
});

test('a sub-group pinned before the line existed takes its top-level group above it', async () => {
  const groups = {
    g1: { id: 'g1', name: 'a.com', label: 'Site', hue: 1, parentId: null, order: 1, site: 'a.com' },
    g2: { id: 'g2', name: 'Sub', label: 'Other', hue: 2, parentId: 'g1', order: 2, pinned: true },
  };
  const browser = fakeBrowser([{ id: 1, url: 'https://a.com/' }], {
    groups, counters: { nextGroup: 3, topLevel: 1, nextArchive: 1 },
  });
  browser._tabValues.set('1tidy', { groupId: 'g2', host: 'a.com' });
  const bg = createBackground({ browser, now: () => NOW, delay: FAST, newId: browser._newId });
  await bg.start();
  assert.equal(bg.state.groups.g1.pinned, true);
  assert.equal(bg.state.groups.g2.pinned, false);
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
  // Reuse the same fake so storage and tab values carry over.
  const bg = await restart(first.browser);
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
  assert.equal(received[0].tabs[0].groupId, Object.keys(received[0].spaces[0].groups)[0]);
  assert.deepEqual(received[0].active, { 1: received[0].spaces[0].id });
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
  assert.deepEqual(snap.spaces[0].archiveCounts, { [groupId]: 2 });

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
  assert.equal(browser._storage['ws:w1'].groups.g1.manual, true);
});

test('a manually moved tab stays put through navigation, re-sort and restart', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://example.com/a' },
    { id: 2, url: 'https://other.org/' },
  ]);
  const target = bg.assign.get(2).groupId;
  await bg.handle({ type: 'moveTab', tabId: 1, groupId: target });
  assert.equal(bg.assign.get(1).groupId, target);
  assert.equal(bg.assign.get(1).host, 'example.com');
  assert.equal(bg.assign.get(1).manual, true);
  assert.deepEqual(Object.values(bg.state.groups).map((g) => g.name), ['other.org']);

  browser._tabs[0].url = 'https://third.net/';
  browser.tabs.onUpdated.fire(1, { url: 'https://third.net/', status: 'complete' }, { ...browser._tabs[0] });
  await tick();
  await bg.runClassify();
  assert.equal(bg.queue.size, 0);
  assert.equal(bg.assign.get(1).groupId, target);

  await bg.handle({ type: 'resort' });
  assert.equal(bg.assign.get(1).groupId, target);

  const again = await restart(browser);
  assert.equal(again.queue.size, 0);
  assert.equal(again.assign.get(1).groupId, target);
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

  await bg.menuClick('rolltop-move:' + other, 1);
  assert.equal(bg.assign.get(1).groupId, other);
  assert.deepEqual(bg.moveTargets(1).map((t) => t.title), ['third.net']);

  // The browser did not name the tab: fall back to the row the sidebar reported.
  port.send({ type: 'menuTarget', tabId: 3 });
  await bg.menuClick('rolltop-move-new');
  const made = groupOf(bg, 3);
  assert.equal(made.name, 'New group');
  assert.equal(made.manual, true);
  assert.equal(bg.assign.get(3).manual, true);
  assert.deepEqual(port.received.filter((m) => m.type === 'editGroup'), [{ type: 'editGroup', groupId: made.id }]);

  await bg.menuClick('rolltop-tab-archive', 2);
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

  await bg.menuClick('rolltop-group-pin');
  assert.equal(bg.state.groups[groupId].pinned, true);
  await bg.menuClick('rolltop-group-toggle');
  assert.equal(bg.state.groups[groupId].collapsed, true);
  await bg.menuClick('rolltop-group-rename');
  assert.deepEqual(port.received.filter((m) => m.type === 'editGroup'), [{ type: 'editGroup', groupId }]);
  await bg.menuClick('rolltop-group-archive');
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
  assert.deepEqual((await bg.snapshot()).spaces[0].archiveCounts, { [groupId]: 1, [otherId]: 1 });
  assert.ok(bg.state.groups[otherId], 'the group lives on through its archived tab');
  assert.equal(browser._storage['archive:w1'].length, 2);

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
  assert.deepEqual([bg.assign.get(1).groupId, bg.assign.get(1).host, bg.assign.get(1).manual], [b, 'a.com', true]);

  await bg.handle({ type: 'moveTab', tabId: 4, groupId: b, nearTabId: 2, after: true });
  assert.deepEqual(order(), [2, 4, 1, 3]);
  await bg.handle({ type: 'moveTab', tabId: 2, groupId: b, nearTabId: 3, after: true });
  assert.deepEqual(order(), [4, 1, 3, 2]);
  await bg.handle({ type: 'moveTab', tabId: 3, groupId: b, nearTabId: 4, after: false });
  assert.deepEqual(order(), [3, 4, 1, 2]);
  assert.deepEqual(Object.keys(bg.state.groups), [b]);
});

test('tabs and sub-groups take any place among each other in a group', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://a.com/1' },
    { id: 2, url: 'https://a.com/2' },
    { id: 3, url: 'https://b.com/' },
    { id: 4, url: 'https://c.com/' },
    { id: 5, url: 'https://d.com/' },
  ]);
  const [a, b, c] = [1, 3, 4].map((id) => bg.assign.get(id).groupId);
  // The group's rows as the sidebar lists them: tab ids and sub-group ids.
  const listed = async () => {
    const snap = await bg.snapshot();
    const rows = buildView({ tabs: snap.tabs, groups: snap.spaces[0].groups, auto: false, query: '', now: NOW }).rows;
    return rows.filter((r) => r.id !== a && r.kind !== 'section').map((r) => (r.kind === 'group' ? r.id : r.tabId));
  };
  const strip = () => browser._tabs.map((t) => t.id);
  await bg.handle({ type: 'moveGroup', groupId: b, targetId: a, where: 'into' });
  await bg.handle({ type: 'moveGroup', groupId: c, targetId: a, where: 'into' });
  assert.deepEqual((await listed()).slice(0, 6), [1, 2, b, 3, c, 4]);

  await bg.handle({ type: 'moveTab', tabId: 2, groupId: a, nearGroupId: b, after: true });
  assert.deepEqual(await listed(), [1, b, 3, 2, c, 4, bg.assign.get(5).groupId, 5]);
  await bg.handle({ type: 'moveTab', tabId: 5, groupId: a, nearGroupId: c, after: true });
  assert.deepEqual(await listed(), [1, b, 3, 2, c, 4, 5], 'a tab from another group lands below the last sub-group');
  await bg.handle({ type: 'moveTab', tabId: 1, groupId: a, nearGroupId: c, after: false });
  assert.deepEqual(await listed(), [b, 3, 2, 1, c, 4, 5]);
  assert.deepEqual(strip(), [2, 1, 3, 4, 5], 'last of the tabs before that sub-group, in the strip too');
  await bg.handle({ type: 'moveTab', tabId: 5, groupId: a, nearTabId: 2, after: false });
  assert.deepEqual(await listed(), [b, 3, 5, 2, 1, c, 4], 'beside a tab it shares that tab\'s place');
  await bg.handle({ type: 'moveTab', tabId: 5, groupId: a, nearGroupId: b, after: false });
  assert.deepEqual(await listed(), [5, b, 3, 2, 1, c, 4]);

  // A group dropped beside a tab splits the tabs around it.
  await bg.handle({ type: 'moveGroup', groupId: c, nearTabId: 1, after: false });
  assert.deepEqual(await listed(), [5, b, 3, 2, c, 4, 1]);
  await bg.handle({ type: 'moveGroup', groupId: b, nearTabId: 1, after: true });
  assert.deepEqual(await listed(), [5, 2, c, 4, 1, b, 3]);
  // Beside a group it goes right next to it, on the near side of the tabs there.
  await bg.handle({ type: 'moveGroup', groupId: b, targetId: c, where: 'after' });
  assert.deepEqual(await listed(), [5, 2, c, 4, b, 3, 1]);
  await bg.handle({ type: 'moveGroup', groupId: b, targetId: c, where: 'before' });
  assert.deepEqual(await listed(), [5, 2, b, 3, c, 4, 1]);
  await bg.handle({ type: 'moveGroup', groupId: b, targetId: a, where: 'into' });
  assert.deepEqual(await listed(), [5, 2, c, 4, 1, b, 3], 'into a group is last in it');

  // Filed elsewhere, a tab forgets the place it had.
  await bg.handle({ type: 'moveTab', tabId: 1, groupId: c });
  await bg.handle({ type: 'moveTab', tabId: 1, groupId: a });
  assert.deepEqual(await listed(), [5, 2, 1, c, 4, b, 3]);
  // Out of the group, a sub-group leaves the tabs in the order they had.
  await bg.handle({ type: 'moveGroup', groupId: b, where: 'into' });
  assert.equal(bg.state.groups[b].parentId, null);
  assert.deepEqual((await listed()).slice(0, 5), [5, 2, 1, c, 4]);
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
  assert.equal((await bg.snapshot()).spaces[0].groups[d].parentId, a);
});

test('a pin grid layout orders the pinned tabs and records their rows', async () => {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://a.com/', pinned: true },
    { id: 2, url: 'https://b.com/', pinned: true },
    { id: 3, url: 'https://c.com/', pinned: true },
    { id: 4, url: 'https://d.com/', pinned: true },
    { id: 5, url: 'https://e.com/' },
  ]);
  const before = bg.assign.get(3).groupId;
  const rowsOf = async () => (await bg.snapshot()).tabs.map((t) => t.pinRow);
  assert.deepEqual(await rowsOf(), [null, null, null, null, null]);

  // Tab 3 moves between 1 and 2, leaving 4 on a row of its own.
  await bg.handle({ type: 'layoutPins', windowId: 1, rows: [[1, 3, 2], [4]] });
  assert.deepEqual(browser._tabs.map((t) => t.id), [1, 3, 2, 4, 5]);
  assert.deepEqual(await rowsOf(), [0, 0, 0, 1, null]);
  assert.equal(bg.assign.get(3).groupId, before);

  // A tab that was not pinned is pinned where it was dropped.
  await bg.handle({ type: 'layoutPins', windowId: 1, rows: [[5], [1, 3, 2], [4]] });
  assert.deepEqual(browser._tabs.map((t) => [t.id, t.pinned]), [[5, true], [1, true], [3, true], [2, true], [4, true]]);
  assert.deepEqual(await rowsOf(), [0, 1, 1, 1, 2]);

  // Unpinning forgets the row; the rest keep theirs.
  await bg.handle({ type: 'pinTab', tabId: 3, pinned: false });
  assert.deepEqual(await rowsOf(), [0, 1, null, 1, 2]);
});

test('pin grid rows survive a restart', async () => {
  const tabs = [
    { id: 1, url: 'https://a.com/', pinned: true },
    { id: 2, url: 'https://b.com/', pinned: true },
  ];
  const { bg, browser } = await boot(tabs);
  await bg.handle({ type: 'layoutPins', windowId: 1, rows: [[1], [2]] });
  await bg.flush();
  const again = await restart(browser);
  assert.deepEqual((await again.snapshot()).tabs.map((t) => t.pinRow), [0, 1]);
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
  assert.equal(entry.model, 'claude-haiku-5-5');
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

// ---- workspace export and import -----------------------------------------

async function exported() {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://news.example.com/a', title: 'Story', pinned: true },
    { id: 2, url: 'https://shop.example.org/desk', title: 'Desk' },
    { id: 3, url: 'https://shop.example.org/lamp', title: 'Lamp' },
    { id: 4, url: 'about:newtab' },
    { id: 5, url: 'https://secret.example.net/', incognito: true },
    { id: 6, url: 'https://old.example.dev/', title: 'Old' },
  ], { stored: { settings: { archiveDays: 30 } } });
  await bg.handle({ type: 'layoutPins', windowId: 1, rows: [[1]] });
  await bg.handle({ type: 'renameGroup', groupId: bg.assign.get(2).groupId, name: 'Desk setup' });
  await bg.handle({ type: 'pinGroup', groupId: bg.assign.get(2).groupId });
  await bg.handle({ type: 'renameTab', tabId: 2, name: 'The desk' });
  await bg.handle({ type: 'closeTab', tabId: 3 });
  await bg.handle({ type: 'closeTab', tabId: 6 });
  return { bg, browser };
}

test('an export holds the open web tabs and their groups, not the archive or settings', async () => {
  const { bg } = await exported();
  const data = await bg.exportWorkspace();
  assert.equal(data.format, 'rolltop-workspace');
  assert.deepEqual(data.tabs.map((t) => t.url), ['https://news.example.com/a', 'https://shop.example.org/desk']);
  assert.deepEqual(data.tabs[0].pinRow, 0);
  assert.equal(data.tabs[1].name, 'The desk');
  // The group holding only an archived tab is still here, but not in the file.
  assert.equal(Object.values(bg.state.groups).some((g) => g.name === 'example.dev'), true);
  assert.deepEqual(data.groups.map((g) => g.name).sort(), ['Desk setup', 'example.com']);
  assert.deepEqual(Object.keys(data).sort(), ['exportedAt', 'format', 'groups', 'tabs', 'version']);
  assert.doesNotThrow(() => JSON.stringify(data));
});

test('importing into another browser rebuilds the groups and tabs', async () => {
  const data = JSON.parse(JSON.stringify(await (await exported()).bg.exportWorkspace()));
  const { bg, browser } = await boot([
    { id: 1, url: 'https://local.example.io/', pinned: true },
    { id: 2, url: 'https://local.example.io/two' },
  ]);
  await bg.handle({ type: 'layoutPins', windowId: 1, rows: [[1]] });
  const created = [];
  const create = browser.tabs.create;
  browser.tabs.create = (props) => { created.push(props); return create(props); };

  const result = await bg.importWorkspace(data, 1);
  await tick();
  await bg.runClassify();
  assert.deepEqual(result, { groups: 2, tabs: 2, skipped: 0, failed: 0 });

  // Pinned tabs load; the rest are opened unloaded with their titles.
  assert.deepEqual(created, [
    { url: 'https://news.example.com/a', windowId: 1, pinned: true, active: false },
    { url: 'https://shop.example.org/desk', windowId: 1, active: false, discarded: true, title: 'Desk' },
  ]);
  const snap = await bg.snapshot();
  const tab = (url) => snap.tabs.find((t) => t.url === url);
  const desk = tab('https://shop.example.org/desk');
  const { groups } = snap.spaces[0];
  assert.equal(groups[desk.groupId].name, 'Desk setup');
  assert.equal(groups[desk.groupId].pinned, true);
  assert.equal(desk.name, 'The desk');
  assert.equal(desk.pending, false);
  assert.equal(groups[tab('https://news.example.com/a').groupId].name, 'example.com');
  // The imported pin row sits below the one already here.
  assert.equal(tab('https://local.example.io/').pinRow, 0);
  assert.equal(tab('https://news.example.com/a').pinRow, 1);
  // The tabs that were here keep their group.
  assert.equal(groupOf(bg, 2).name, 'example.io');
  // Neither the archive nor the settings came along.
  assert.deepEqual(bg.searchArchive('lamp'), []);
  assert.equal(bg.state.settings.archiveDays, 14);
  // Each tab carries its record's uid, so its place survives a restart.
  assert.equal(browser._tabValues.get(desk.id + 'uid'), bg.assign.get(desk.id).uid);
  const again = await restart(browser);
  assert.equal(again.assign.get(desk.id).groupId, desk.groupId);
});

test('importing the same file twice adds nothing the second time', async () => {
  const data = await (await exported()).bg.exportWorkspace();
  const { bg, browser } = await boot([{ id: 1, url: 'https://local.example.io/' }]);
  await bg.importWorkspace(data, 1);
  const groups = Object.keys(bg.state.groups).length;
  const again = await bg.importWorkspace(data, 1);
  assert.deepEqual(again, { groups: 0, tabs: 0, skipped: 2, failed: 0 });
  assert.equal(Object.keys(bg.state.groups).length, groups);
  assert.equal(browser._tabs.length, 3);
});

test('a tab that cannot be opened is counted, and one with no group is sorted after the import', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://local.example.io/' }]);
  const create = browser.tabs.create;
  browser.tabs.create = (props) => (props.url.includes('broken') ? Promise.reject(new Error('no')) : create(props));
  const result = await bg.importWorkspace({
    format: 'rolltop-workspace',
    version: 1,
    groups: [{ id: 'g1', name: 'Only broken', order: 1 }],
    tabs: [
      { url: 'https://broken.example.com/', groupId: 'g1' },
      { url: 'https://loose.example.org/', groupId: null },
    ],
  }, 1);
  await tick();
  await bg.runClassify();
  assert.deepEqual(result, { groups: 1, tabs: 1, skipped: 0, failed: 1 });
  // The group whose only tab failed is not left behind empty.
  assert.deepEqual(Object.values(bg.state.groups).map((g) => g.name).sort(), ['example.io', 'example.org']);
});

test('a file that is not a workspace changes nothing', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://local.example.io/' }]);
  await assert.rejects(bg.importWorkspace({ tabs: [{ url: 'https://x.example.com/' }] }, 1), /not a Rolltop workspace/);
  assert.equal(browser._tabs.length, 1);
  // A tab closed afterwards still cleans up its group: the import is not left "in progress".
  await bg.handle({ type: 'closeTab', tabId: 1 });
  await tick();
  assert.equal(bg.searchArchive('local').length, 1);
});

// ---- the stored document ---------------------------------------------------

test('version 1 data becomes the first workspace, and its keys are kept aside', async () => {
  const groups = {
    g1: { id: 'g1', name: 'Trip', label: 'Travel', hue: 1, parentId: null, order: 1 },
    g2: { id: 'g2', name: 'Stay', label: 'Lodging', hue: 2, parentId: 'g1', order: 2 },
  };
  const archive = [{ id: 'a1', groupId: 'g1', title: 'Old', url: 'https://old.example/', favIconUrl: '', at: NOW - DAY }];
  const browser = fakeBrowser([
    { id: 1, url: 'https://stay.example/', pinned: true },
    { id: 2, url: 'https://trip.example/' },
  ], { groups, archive, counters: { nextGroup: 3, topLevel: 1, nextArchive: 2 }, settings: { auto: false } });
  browser._tabValues.set('1tidy', { groupId: 'g2', host: 'stay.example', manual: true });
  browser._tabValues.set('1tidy-name', 'The inn');
  browser._tabValues.set('1tidy-row', 2);
  browser._tabValues.set('2tidy', { groupId: 'g1', host: 'trip.example' });
  const bg = await restart(browser);

  assert.deepEqual([bg.assign.get(1).groupId, bg.assign.get(1).manual, bg.assign.get(1).name, bg.assign.get(1).row], ['g2', true, 'The inn', 2]);
  assert.equal(bg.assign.get(2).groupId, 'g1');
  assert.equal(bg.queue.size, 0);
  const s = browser._storage;
  assert.deepEqual(Object.keys(s).sort(), ['archive:w1', 'legacy-v1', 'log', 'meta', 'settings', 'ws:w1']);
  assert.equal(s['ws:w1'].name, 'Home');
  assert.equal(s['ws:w1'].groups.g2.parentId, 'g1');
  assert.equal(s['archive:w1'][0].url, 'https://old.example/');
  assert.deepEqual(s['legacy-v1'].groups, groups);
  assert.deepEqual(s['legacy-v1'].archive, archive);
});

test('data from a newer version is left untouched', async () => {
  const stored = { meta: { version: 3, order: ['x'], current: 'x' }, 'ws:x': { id: 'x', name: 'Future' } };
  const browser = fakeBrowser([{ id: 1, url: 'https://a.com/' }], stored);
  await assert.rejects(restart(browser), /newer version/);
  assert.deepEqual(browser._storage, stored);
});

test('groups outlive a start with no tabs, and a tab that returns takes its place back', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://a.com/x', title: 'A' }, { id: 2, url: 'https://b.com/', title: 'B' }]);
  await bg.handle({ type: 'renameTab', tabId: 1, name: 'Mine' });
  const { uid, groupId } = bg.assign.get(1);
  await bg.flush();

  // The browser comes up before the session is restored: only a blank tab.
  browser._tabs.splice(0, 2, { id: 9, windowId: 1, index: 0, status: 'complete', url: 'about:newtab', title: 'New Tab', lastAccessed: NOW });
  const again = await restart(browser);
  assert.deepEqual(Object.values(again.state.groups).map((g) => g.name).sort(), ['a.com', 'b.com']);
  assert.equal(again.state.archive.length, 2);

  // Then the session's tab arrives, carrying its uid.
  browser._tabValues.set('100uid', uid);
  await browser.tabs.create({ url: 'https://a.com/x' });
  await tick();
  assert.deepEqual([again.assign.get(100).uid, again.assign.get(100).groupId, again.assign.get(100).name], [uid, groupId, 'Mine']);
  assert.deepEqual(again.state.archive.map((a) => a.url), ['https://b.com/']);
  await again.runClassify();
  assert.equal(again.assign.get(100).groupId, groupId);
});

test('a tab that lost its uid is matched to its record by address', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://a.com/x' }, { id: 2, url: 'https://b.com/' }]);
  await bg.handle({ type: 'moveTab', tabId: 1, groupId: bg.assign.get(2).groupId });
  const before = { ...bg.assign.get(1) };
  await bg.flush();
  browser._tabValues.clear();
  const again = await restart(browser);
  assert.deepEqual(again.assign.get(1), before);
  assert.equal(browser._tabValues.get('1uid'), before.uid);
  assert.equal(again.state.archive.length, 0);
});

test('a duplicated tab gets its own record in the same group', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://a.com/x' }]);
  browser._tabValues.set('100uid', bg.assign.get(1).uid);
  await browser.tabs.create({ url: 'https://a.com/x' });
  await tick();
  assert.notEqual(bg.assign.get(100).uid, bg.assign.get(1).uid);
  assert.equal(bg.assign.get(100).groupId, bg.assign.get(1).groupId);
  assert.equal(browser._tabValues.get('100uid'), bg.assign.get(100).uid);
});

test('a save writes only the keys that changed, and a failed one is reported and retried', async () => {
  const { bg, browser } = await boot([{ id: 1, url: 'https://a.com/' }]);
  await bg.flush();
  const sets = [];
  const set = browser.storage.local.set;
  let fail = true;
  browser.storage.local.set = async (obj) => {
    sets.push(Object.keys(obj));
    if (fail) throw new Error('disk full');
    return set(obj);
  };
  await bg.handle({ type: 'toggleGroup', groupId: bg.assign.get(1).groupId });
  await bg.flush();
  assert.deepEqual(sets, [['ws:w1']]);
  assert.match((await bg.snapshot()).error, /could not save.*disk full/);
  assert.equal(browser._storage['ws:w1'].groups.g1.collapsed, false);

  fail = false;
  await bg.flush();
  assert.equal(browser._storage['ws:w1'].groups.g1.collapsed, true);
  assert.equal((await bg.snapshot()).error, '');
  await bg.flush();
  assert.equal(sets.length, 2, 'nothing changed, nothing written');
});

// ---- workspaces ----------------------------------------------------------------

async function twoSpaces() {
  const { bg, browser } = await boot([
    { id: 1, url: 'https://fav.example/', pinned: true },
    { id: 2, url: 'https://a.com/', active: true },
    { id: 3, url: 'https://b.com/' },
  ]);
  await bg.handle({ type: 'layoutPins', windowId: 1, rows: [[1]] });
  await bg.handle({ type: 'newWorkspace', windowId: 1, name: 'Side project' });
  await tick();
  return { bg, browser, tab: (id) => browser._tabs.find((t) => t.id === id) };
}

test('a new workspace hides the other one\'s tabs and keeps its favorites', async () => {
  const { bg, browser, tab } = await twoSpaces();
  assert.deepEqual(browser._storage.meta, { version: 2, order: ['w1', 'w2'], current: 'w2' });
  assert.deepEqual(browser._tabs.map((t) => [t.id, t.hidden, t.pinned]), [
    [1, true, false], [2, true, false], [3, true, false], [100, false, false],
  ]);
  assert.equal(tab(100).active, true);
  assert.equal(bg.workspaceOf(100), 'w2');
  let snap = await bg.snapshot();
  assert.deepEqual(snap.active, { 1: 'w2' });
  assert.deepEqual(snap.spaces.map((s) => s.name), ['Home', 'Side project']);
  // Unpinned in the tab strip so it could be hidden, and a favorite all the same.
  assert.deepEqual([snap.tabs[0].ws, snap.tabs[0].pinned, snap.tabs[0].pinRow], ['w1', true, 0]);

  await bg.handle({ type: 'switchWorkspace', windowId: 1, wsId: 'w1' });
  assert.deepEqual(browser._tabs.map((t) => [t.id, t.hidden, t.pinned]), [
    [1, false, true], [2, false, false], [3, false, false], [100, true, false],
  ]);
  assert.equal(tab(100).active, false);
  snap = await bg.snapshot();
  assert.deepEqual(snap.active, { 1: 'w1' });

  // The window shows the same workspace after a restart.
  await bg.flush();
  const again = await restart(browser);
  assert.deepEqual((await again.snapshot()).active, { 1: 'w1' });
  assert.equal(again.workspaceOf(100), 'w2');
  assert.equal(tab(100).hidden, true);
});

test('each workspace has its own groups, archive and storage keys', async () => {
  const { bg, browser } = await twoSpaces();
  await browser.tabs.create({ url: 'https://a.com/other' });
  await tick();
  await bg.runClassify();
  const here = bg.assign.get(101).groupId;
  assert.notEqual(here, bg.assign.get(2).groupId, 'not filed in the other workspace\'s a.com group');
  assert.deepEqual(Object.values(bg.state.groups).map((g) => g.name), ['a.com']);
  assert.deepEqual(bg.moveTargets(100).map((t) => t.id), [here]);

  await bg.handle({ type: 'closeTab', tabId: 101 });
  await bg.flush();
  assert.equal(browser._storage['archive:w2'].length, 1);
  assert.equal(browser._storage['archive:w1'].length, 0);
  assert.deepEqual(Object.keys(browser._storage['ws:w1'].groups).length, 3);
  assert.deepEqual(bg.searchArchive('a.com').map((a) => [a.ws, a.url]), [['w2', 'https://a.com/other']]);

  // A tab moved into a group of another workspace is refused.
  await bg.handle({ type: 'moveTab', tabId: 100, groupId: bg.assign.get(2).groupId });
  assert.equal(bg.assign.get(100).groupId, null);
});

test('activating a tab in another workspace, or reopening one from its archive, switches to it', async () => {
  const { bg, browser, tab } = await twoSpaces();
  await bg.handle({ type: 'activate', tabId: 3, windowId: 1 });
  assert.deepEqual((await bg.snapshot()).active, { 1: 'w1' });
  assert.deepEqual([tab(3).active, tab(3).hidden, tab(1).pinned, tab(100).hidden], [true, false, true, true]);

  await bg.handle({ type: 'closeTab', tabId: 3 });
  await bg.handle({ type: 'switchWorkspace', windowId: 1, wsId: 'w2' });
  const [hit] = bg.searchArchive('b.com');
  await bg.handle({ type: 'reopenTab', archiveId: hit.id, windowId: 1 });
  const back = browser._tabs.find((t) => t.url === 'https://b.com/');
  assert.equal(bg.workspaceOf(back.id), 'w1');
  assert.deepEqual((await bg.snapshot()).active, { 1: 'w1' });
  assert.equal(groupOf(bg, back.id).name, 'b.com');

  // The browser selects a hidden tab by itself: the window follows it.
  tab(100).active = true;
  browser.tabs.onActivated.fire({ tabId: 100, windowId: 1 });
  await tick();
  assert.deepEqual((await bg.snapshot()).active, { 1: 'w2' });
});

test('tabs and groups move between workspaces; a deleted workspace joins its neighbour', async () => {
  const { bg, browser, tab } = await twoSpaces();
  const a = bg.assign.get(2).groupId;
  await bg.handle({ type: 'renameGroup', groupId: a, name: 'Reading' });

  // A tab leaves its group behind and is sorted again where it lands.
  await bg.handle({ type: 'moveTabToWorkspace', tabId: 3, wsId: 'w2' });
  await tick();
  await bg.runClassify();
  assert.equal(bg.workspaceOf(3), 'w2');
  assert.equal(tab(3).hidden, false);
  assert.equal(groupOf(bg, 3).name, 'b.com');
  assert.equal(browser._storage['ws:w1'].tabs.length, 2);

  // A group takes its tabs and archived tabs with it.
  await bg.handle({ type: 'moveGroupToWorkspace', groupId: a, wsId: 'w2' });
  assert.equal(bg.workspaceOf(2), 'w2');
  assert.equal(groupOf(bg, 2).name, 'Reading');
  assert.equal(groupOf(bg, 2).manual, true);
  assert.equal(tab(2).hidden, false);

  // Deleting the workspace on show: everything in it joins the other one.
  await bg.handle({ type: 'deleteWorkspace', wsId: 'w2', windowId: 1 });
  await bg.flush();
  assert.deepEqual(browser._storage.meta, { version: 2, order: ['w1'], current: 'w1' });
  assert.equal('ws:w2' in browser._storage, false);
  assert.equal('archive:w2' in browser._storage, false);
  assert.deepEqual([1, 2, 3, 100].map((id) => bg.workspaceOf(id)), ['w1', 'w1', 'w1', 'w1']);
  assert.deepEqual(browser._tabs.map((t) => t.hidden), [false, false, false, false]);
  assert.equal(tab(1).pinned, true);
  assert.deepEqual(Object.values(bg.state.groups).map((g) => g.name).sort(), ['Reading', 'b.com', 'fav.example']);

  // The last workspace cannot be deleted.
  await bg.handle({ type: 'deleteWorkspace', wsId: 'w1', windowId: 1 });
  assert.deepEqual(bg.doc.meta.order, ['w1']);
});

test('a workspace export holds only the workspace on show', async () => {
  const { bg } = await twoSpaces();
  await bg.handle({ type: 'renameWorkspace', wsId: 'w2', name: '  Errands ' });
  assert.equal((await bg.snapshot()).spaces[1].name, 'Errands');
  assert.deepEqual((await bg.exportWorkspace(1)).tabs, []);
  await bg.handle({ type: 'switchWorkspace', windowId: 1, wsId: 'w1' });
  assert.deepEqual((await bg.exportWorkspace(1)).tabs.map((t) => [t.url, t.pinned]), [
    ['https://fav.example/', true], ['https://a.com/', false], ['https://b.com/', false],
  ]);
});

// ---- backups -------------------------------------------------------------------

test('a backup restores every workspace without closing or opening a tab', async () => {
  const { bg, browser } = await twoSpaces();
  const backup = JSON.parse(JSON.stringify(bg.exportBackup()));
  assert.deepEqual(Object.keys(backup).sort(), ['archives', 'exportedAt', 'format', 'meta', 'spaces', 'version']);
  const filed = bg.assign.get(2).groupId;

  await bg.handle({ type: 'deleteWorkspace', wsId: 'w2', windowId: 1 });
  await bg.handle({ type: 'closeTab', tabId: 3 });
  await browser.tabs.create({ url: 'https://new.example/' });
  await tick();
  await bg.runClassify();

  const result = await bg.restoreBackup(backup);
  assert.deepEqual(result, { at: NOW, workspaces: 2, tabs: 4 });
  assert.deepEqual(bg.doc.meta.order, ['w1', 'w2']);
  assert.deepEqual([1, 2, 100].map((id) => bg.workspaceOf(id)), ['w1', 'w1', 'w2']);
  assert.equal(bg.assign.get(2).groupId, filed);
  assert.deepEqual(browser._tabs.map((t) => t.id), [1, 2, 100, 101]);
  // The tab the backup held but is closed now can be reopened; the one it never saw is kept.
  assert.deepEqual(bg.searchArchive('b.com').map((a) => a.ws), ['w1']);
  assert.ok(bg.workspaceOf(101));
  assert.equal(browser._storage['snap:before-restore'].meta.order.length, 1);
  assert.equal(browser._storage['ws:w2'].name, 'Side project');

  await assert.rejects(bg.restoreBackup({ format: 'rolltop-workspace', version: 1 }), /not a Rolltop backup/);
});

test('one snapshot is kept per day of use, the last seven of them', async () => {
  let at = NOW;
  const { bg, browser } = await boot([{ id: 1, url: 'https://a.com/' }], { now: () => at });
  await bg.flush();
  const snaps = () => Object.keys(browser._storage).filter((k) => k.startsWith('snap:')).sort();
  assert.deepEqual(snaps(), [], 'nothing to snapshot on the first run');
  let last = bg;
  for (let day = 1; day <= 9; day += 1) {
    at = NOW + day * DAY;
    last = await restart(browser, { now: () => at });
    await last.flush();
  }
  assert.equal(snaps().length, 7);
  await restart(browser, { now: () => at });
  assert.equal(snaps().length, 7, 'one per day');

  const listed = await last.listSnapshots();
  assert.deepEqual(listed.map((s) => s.key), snaps().reverse());
  assert.deepEqual([listed[0].workspaces, listed[0].tabs], [1, 1]);
  await last.handle({ type: 'renameWorkspace', wsId: 'w1', name: 'Renamed' });
  await last.restoreSnapshot(listed[0].key);
  assert.equal(last.doc.spaces.w1.name, 'Home');
  await assert.rejects(last.restoreSnapshot('snap:1999-01-01'), /no longer kept/);
});
