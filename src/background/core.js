// Background logic: keeps the stored document of workspaces, groups and tab
// records, binds open tabs to their records, runs the classifier, archives
// idle tabs and pushes snapshots to open sidebars.
// The browser API and the AI classifier are injected so this runs under Node.

import {
  DAY, MAX_DEPTH, MENU, canNest, chain, childMap, slotOf, subtree, pathName, isHardPinned, matchesQuery,
} from '../../extension/lib/model.js';
import { applyPlan, clean, gcGroups, heuristicPlan } from '../../extension/lib/plan.js';
import { FORMAT, VERSION, mergeGroups, readWorkspace } from '../../extension/lib/workspace.js';
import {
  LEGACY_KEY, LEGACY_KEYS, SNAP_BEFORE_RESTORE, SNAP_PREFIX, backupOf, backupSummary, dayOf, isDocKey,
  loadStore, newSpace, readBackup, snapKey, staleSnapshots, toKeys,
} from '../../extension/lib/store.js';

export const DEFAULTS = { auto: true, archiveDays: 14, collapseHours: 8, apiKey: '', model: 'claude-haiku-5-5' };
const ARCHIVE_CAP = 1000;
const BATCH = 40;
const SEARCH_LIMIT = 50;
const LOG_CAP = 20; // sorting runs kept for the options page
// Archived groups older than this stay searchable but are not shown to the AI.
const AI_RECENT = 30 * DAY;
// A group with this many tabs sitting directly in it is offered to the AI to
// split into sub-groups, and again each time it has grown by SPLIT_STEP since.
const SPLIT_AT = 8;
const SPLIT_STEP = 4;
const AI_RETRY_MAX = 15 * 60_000;
const UID_KEY = 'uid'; // session value on a tab: the uid of its record
const WS_KEY = 'ws'; // session value on a window: the workspace it shows
// Version 1 kept a tab's group, name and favorites row in these session values.
const V1_TAB = 'tidy';
const V1_NAME = 'tidy-name';
const V1_ROW = 'tidy-row';

const isWeb = (url) => /^https?:/.test(url || '');
const isSortable = (tab) => isWeb(tab.url) && !tab.incognito;
// Private tabs are shown but never recorded.
const tracked = (tab) => !tab.incognito;
const hostOf = (url) => {
  try { return new URL(url).hostname; } catch { return ''; }
};
// As sent to the classifier: no query string or fragment.
const logUrl = (url) => {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).slice(0, 140);
  } catch { return ''; }
};
const keepIcon = (url) => ((url || '').startsWith('data:') ? '' : url || '');
const randomId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const messageOf = (e) => (e && e.message) || String(e);

export function createBackground({
  browser,
  classifyWithAI,
  splitWithAI,
  now = () => Date.now(),
  delay = {},
  // (prefix) -> a new id: 'w' workspace, 'g' group, 't' tab record, 'a' archive record.
  newId = randomId,
}) {
  const wait = { classify: 1200, push: 50, save: 400, retry: 5000, aiRetry: 60_000, ...delay };
  const doc = { meta: { version: 2, order: [], current: null }, spaces: {}, archives: {}, log: [] };
  let settings = { ...DEFAULTS };
  const byTab = new Map(); // tabId -> { ws, rec }: the open tab's workspace id and record
  const open = new Map(); // record uid -> tabId
  const active = new Map(); // windowId -> the workspace it shows
  const queue = new Set(); // tabIds waiting for a classifier run
  // tabIds filed by site that are owed a sort by the AI: its call failed, or
  // the tab was a favorite until now.
  const missed = new Set();
  let aiRetry = null;
  let aiFails = 0; // failures in a row that are worth retrying
  const archiving = new Set(); // tabIds being closed by archiveTabs
  // tabIds whose removal was announced while the browser still lists them: a
  // tab stays in tabs.query until its close animation ends.
  const closed = new Set();
  const ports = new Set();
  const status = { sorting: false, error: '', saveError: '' };
  let running = null;
  let importing = 0; // workspace imports in progress
  let snapDay = ''; // the day the last daily snapshot was taken or found
  // The row a sidebar last opened a context menu on, and the sidebar's port.
  let menu = { port: null, tabId: null, groupId: null, tabIds: [] };

  const debounce = (fn, ms) => {
    let timer = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(); }, ms);
    };
  };

  const space = (id) => doc.spaces[id];
  const spaces = () => doc.meta.order.map(space);
  const archiveOf = (id) => doc.archives[id] || (doc.archives[id] = []);
  const groupsOfTab = (tabId) => space(byTab.get(tabId)?.ws)?.groups || {};
  const homeOfGroup = (groupId) => spaces().find((s) => s.groups[groupId]) || null;
  const groupIdOfTab = (tabId) => {
    const e = byTab.get(tabId);
    return e && e.rec.groupId && space(e.ws).groups[e.rec.groupId] ? e.rec.groupId : null;
  };
  const makeGroupId = () => newId('g');
  // The workspace a window shows: the one last chosen there, else the one last
  // chosen anywhere.
  function activeOf(windowId) {
    const id = active.get(windowId);
    if (space(id)) return id;
    return space(doc.meta.current) ? doc.meta.current : doc.meta.order[0];
  }

  // ---- persistence -------------------------------------------------------

  const written = new Map(); // storage key -> the JSON last stored under it
  let saving = Promise.resolve();
  let retry = null;

  // Writes the keys whose content changed since they were last stored, and
  // removes those of deleted workspaces. One set() call, so the keys of a
  // change land together. A failure is shown in the sidebar and tried again.
  function flush() {
    saving = saving.then(async () => {
      const keys = toKeys(doc);
      const set = {};
      const texts = new Map();
      for (const [key, value] of Object.entries(keys)) {
        const text = JSON.stringify(value);
        if (written.get(key) === text) continue;
        set[key] = JSON.parse(text);
        texts.set(key, text);
      }
      const gone = [...written.keys()].filter((key) => !(key in keys));
      try {
        if (texts.size) await browser.storage.local.set(set);
        if (gone.length) await browser.storage.local.remove(gone);
      } catch (e) {
        status.saveError = 'Rolltop could not save your tabs: ' + messageOf(e);
        push();
        if (!retry) retry = setTimeout(() => { retry = null; flush(); }, wait.retry);
        return;
      }
      texts.forEach((text, key) => written.set(key, text));
      gone.forEach((key) => written.delete(key));
      if (status.saveError) {
        status.saveError = '';
        push();
      }
    });
    return saving;
  }

  const save = debounce(flush, wait.save);

  // One backup of the document per day it is in use, the last few kept.
  async function dailySnapshot(data) {
    const day = dayOf(now());
    if (day === snapDay) return;
    const all = Object.keys(await browser.storage.local.get(null));
    if (!all.includes(snapKey(day))) {
      await browser.storage.local.set({ [snapKey(day)]: data || backupOf(doc, now()) });
      all.push(snapKey(day));
    }
    snapDay = day;
    const stale = staleSnapshots(all);
    if (stale.length) await browser.storage.local.remove(stale);
  }

  // ---- tabs and their records --------------------------------------------

  function bind(tabId, wsId, rec) {
    byTab.set(tabId, { ws: wsId, rec });
    open.set(rec.uid, tabId);
  }

  function unbind(tabId) {
    const e = byTab.get(tabId);
    if (!e) return null;
    byTab.delete(tabId);
    if (open.get(e.rec.uid) === tabId) open.delete(e.rec.uid);
    return e;
  }

  // Stored with the tab in the session, so its record is found after a restart.
  function stamp(tabId, uid) {
    browser.sessions.setTabValue(tabId, UID_KEY, uid).catch(() => {});
  }

  function makeRec(tab, extra = {}) {
    return {
      uid: newId('t'),
      url: tab.url || '',
      title: tab.title || '',
      favIconUrl: keepIcon(tab.favIconUrl),
      groupId: null,
      favorite: !!tab.pinned,
      ...extra,
    };
  }

  // Brings a record up to date with its tab. Returns whether its address
  // changed; a new title alone is stored with the next save.
  function sync(rec, tab) {
    const moved = !!tab.url && tab.url !== rec.url;
    if (tab.url) rec.url = tab.url;
    if (tab.title) rec.title = tab.title;
    if (tab.favIconUrl) rec.favIconUrl = keepIcon(tab.favIconUrl);
    return moved;
  }

  function file(tabId, groupId, host, manual = false) {
    const e = byTab.get(tabId);
    if (!e) return;
    if (e.rec.groupId !== groupId) delete e.rec.order; // its place among the old group's sub-groups
    e.rec.groupId = groupId;
    e.rec.host = host;
    if (manual) e.rec.manual = true;
    else delete e.rec.manual;
  }

  function unfile(rec) {
    rec.groupId = null;
    delete rec.order;
    delete rec.host;
    delete rec.manual;
  }

  function setFavorite(rec, favorite, home) {
    rec.favorite = favorite;
    if (!favorite) {
      delete rec.row;
      delete rec.slot;
    } else if (rec.slot == null) {
      rec.slot = 1 + Math.max(-1, ...home.tabs.map((r) => r.slot ?? -1));
    }
  }

  // Adds an archive record for a tab that is gone, however it went. The record
  // keeps the tab's uid and everything the user set on it, so a tab the
  // browser brings back (undo close, a restored window) gets it all again.
  function shelve(wsId, rec) {
    if (!isWeb(rec.url)) return;
    const groupId = rec.groupId || null;
    doc.archives[wsId] = [
      {
        id: newId('a'),
        uid: rec.uid,
        url: rec.url,
        title: rec.title || rec.url,
        favIconUrl: rec.favIconUrl || '',
        groupId,
        at: now(),
        ...(rec.manual ? { manual: true } : {}),
        ...(rec.name ? { name: rec.name } : {}),
        ...(rec.favorite ? { favorite: true } : {}),
        ...(rec.row != null ? { row: rec.row } : {}),
      },
      ...archiveOf(wsId).filter((a) => !(a.url === rec.url && a.groupId === groupId)),
    ].slice(0, ARCHIVE_CAP);
  }

  // Takes the archive record made for the tab with this uid, if there is one.
  function takeArchived(uid) {
    for (const s of spaces()) {
      const a = archiveOf(s.id).find((x) => x.uid === uid);
      if (!a) continue;
      doc.archives[s.id] = archiveOf(s.id).filter((x) => x !== a);
      return { home: s, a };
    }
    return null;
  }

  // What an archive record gives back to the record of a tab that returned.
  function revive(rec, a, home) {
    rec.uid = a.uid;
    if (a.groupId && home.groups[a.groupId]) {
      rec.groupId = a.groupId;
      rec.host = hostOf(a.url);
      if (a.manual) rec.manual = true;
    }
    if (a.name) rec.name = a.name;
    if (a.favorite) setFavorite(rec, true, home);
    if (a.row != null) rec.row = a.row;
  }

  // Gives a tab that just appeared a record in its window's workspace, at
  // once, then asks the session whether it is a tab that was here before.
  function track(tab) {
    if (!tracked(tab) || tab.id == null || byTab.has(tab.id) || closed.has(tab.id)) return;
    const home = space(activeOf(tab.windowId));
    const rec = makeRec(tab);
    home.tabs.push(rec);
    bind(tab.id, home.id, rec);
    claim(tab, rec).catch(reportError);
  }

  async function claim(tab, rec) {
    const uid = await browser.sessions.getTabValue(tab.id, UID_KEY).catch(() => null);
    const e = byTab.get(tab.id);
    if (!e || e.rec !== rec) return; // closed in the meantime
    if (uid && uid !== rec.uid) {
      const twin = open.has(uid) ? byTab.get(open.get(uid)) : null;
      const back = twin ? null : takeArchived(uid);
      if (twin && twin.ws === e.ws) {
        // A duplicated tab carries its original's uid. It keeps its own, and
        // starts out filed where the original is.
        const { groupId, host, manual, name } = twin.rec;
        Object.assign(rec, { groupId, ...(host ? { host } : {}), ...(manual ? { manual } : {}), ...(name ? { name } : {}) });
      } else if (back) {
        // Closed earlier and brought back by the browser.
        if (back.home.id !== e.ws) {
          space(e.ws).tabs = space(e.ws).tabs.filter((r) => r !== rec);
          back.home.tabs.push(rec);
          e.ws = back.home.id;
        }
        open.delete(rec.uid);
        revive(rec, back.a, back.home);
        open.set(rec.uid, tab.id);
        await arrange(tab.windowId);
      }
    }
    stamp(tab.id, rec.uid);
    gc();
    changed();
  }

  // Binds every open tab to its record: by the uid the tab carries, else to the
  // record of the same page, else to a new one. `legacy` reads what version 1
  // stored on the tab. Records whose tabs are not open are archived, not
  // dropped: their groups stay, and a tab that turns up later takes its record
  // back by uid.
  async function reconcile(tabs, legacy) {
    byTab.clear();
    open.clear();
    queue.clear();
    const known = new Map();
    for (const s of spaces()) s.tabs.forEach((rec) => known.set(rec.uid, { home: s, rec }));
    const rest = [];
    for (const t of tabs.filter(tracked)) {
      const uid = await browser.sessions.getTabValue(t.id, UID_KEY).catch(() => null);
      const hit = uid ? known.get(uid) : null;
      if (hit && !open.has(uid)) {
        bind(t.id, hit.home.id, hit.rec);
        sync(hit.rec, t);
      } else {
        rest.push([t, uid]);
      }
    }
    for (const [t, uid] of rest) {
      let home = space(activeOf(t.windowId));
      const free = (s) => (isWeb(t.url) ? s.tabs.find((r) => !open.has(r.uid) && r.url === t.url) : null);
      let rec = free(home);
      for (const s of rec ? [] : spaces()) {
        rec = free(s);
        if (rec) {
          home = s;
          break;
        }
      }
      if (!rec) {
        const back = uid ? takeArchived(uid) : null;
        if (back) home = back.home;
        rec = makeRec(t, legacy ? await legacyValues(t, home) : {});
        if (back) revive(rec, back.a, home);
        home.tabs.push(rec);
      }
      bind(t.id, home.id, rec);
      sync(rec, t);
      stamp(t.id, rec.uid);
    }
    for (const s of spaces()) {
      const missing = s.tabs.filter((r) => !open.has(r.uid));
      if (!missing.length) continue;
      s.tabs = s.tabs.filter((r) => open.has(r.uid));
      missing.reverse().forEach((r) => shelve(s.id, r));
    }
  }

  async function legacyValues(tab, home) {
    const value = (key) => browser.sessions.getTabValue(tab.id, key).catch(() => null);
    const v = await value(V1_TAB);
    const name = await value(V1_NAME);
    const row = await value(V1_ROW);
    return {
      ...(v && home.groups[v.groupId] ? { groupId: v.groupId, host: v.host || '', ...(v.manual ? { manual: true } : {}) } : {}),
      ...(name ? { name } : {}),
      ...(tab.pinned && Number.isInteger(row) ? { row } : {}),
    };
  }

  function gc() {
    // An import adds its groups first and their tabs after; until it is done,
    // a group with nothing in it yet is not an empty one.
    if (importing) return;
    // A group goes when no record in the document, open or archived, is filed
    // in its subtree. What the browser reports as open plays no part.
    for (const s of spaces()) {
      const used = new Set();
      s.tabs.forEach((r) => r.groupId && used.add(r.groupId));
      archiveOf(s.id).forEach((a) => a.groupId && used.add(a.groupId));
      s.groups = gcGroups(s.groups, used);
    }
  }

  // ---- workspaces --------------------------------------------------------

  const windowsOf = (tabs) => [...new Set(tabs.map((t) => t.windowId))];

  // Makes a window show its workspace: that workspace's tabs are shown, with
  // its favorites pinned, and every other workspace's tabs are hidden. Firefox
  // hides neither a pinned tab nor the selected one, so the others' favorites
  // are unpinned first (their records remember them) and a tab of this
  // workspace is selected, `preferTabId` if given.
  async function arrange(windowId, preferTabId) {
    const wsId = activeOf(windowId);
    const tabs = (await browser.tabs.query({})).filter((t) => t.windowId === windowId);
    const mine = tabs.filter((t) => byTab.get(t.id)?.ws === wsId);
    const others = tabs.filter((t) => byTab.has(t.id) && byTab.get(t.id).ws !== wsId);
    const quiet = (p) => Promise.resolve(p).catch(() => {});

    const hidden = mine.filter((t) => t.hidden).map((t) => t.id);
    if (hidden.length) await quiet(browser.tabs.show(hidden));
    const slot = (t) => byTab.get(t.id).rec.slot ?? Infinity;
    for (const t of mine.filter((x) => byTab.get(x.id).rec.favorite && !x.pinned).sort((a, b) => slot(a) - slot(b))) {
      await quiet(browser.tabs.update(t.id, { pinned: true }));
    }

    const current = tabs.find((t) => t.active);
    const prefer = mine.find((t) => t.id === preferTabId);
    if (prefer && !prefer.active) {
      await quiet(browser.tabs.update(prefer.id, { active: true }));
    } else if (!prefer && current && others.includes(current)) {
      const last = [...mine].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      if (last) await quiet(browser.tabs.update(last.id, { active: true }));
      else track(await browser.tabs.create({ windowId, active: true }));
    }

    for (const t of others.filter((x) => x.pinned)) await quiet(browser.tabs.update(t.id, { pinned: false }));
    const hide = others.filter((t) => !t.hidden).map((t) => t.id);
    if (hide.length) await quiet(browser.tabs.hide(hide));
  }

  async function arrangeAll() {
    for (const windowId of windowsOf(await browser.tabs.query({}))) await arrange(windowId);
  }

  // Stored with the window in the session, so it shows the same workspace
  // after a restart.
  function remember(windowId) {
    browser.sessions.setWindowValue(windowId, WS_KEY, active.get(windowId)).catch(() => {});
  }

  async function switchWorkspace(windowId, wsId, tabId) {
    if (!space(wsId)) return;
    active.set(windowId, wsId);
    doc.meta.current = wsId;
    remember(windowId);
    await arrange(windowId, tabId);
  }

  // A window seen for the first time shows the workspace it was last showing,
  // when the browser restored it, else the one last chosen anywhere.
  async function learnWindow(windowId) {
    if (windowId == null || active.has(windowId)) return;
    active.set(windowId, activeOf(windowId));
    const saved = await browser.sessions.getWindowValue(windowId, WS_KEY).catch(() => null);
    if (saved && space(saved) && saved !== active.get(windowId)) {
      active.set(windowId, saved);
      await arrange(windowId);
      push();
    } else if (!saved) {
      remember(windowId);
    }
  }

  // Moves groups, with the tabs and archived tabs filed in them, from one
  // workspace to another; `only` limits it to those group ids, and without it
  // everything goes, unfiled tabs included. A group meeting one of the same
  // name is merged into it.
  function transfer(from, to, only) {
    const goes = (groupId) => (only ? only.has(groupId) : true);
    const moving = Object.values(from.groups)
      .filter((g) => goes(g.id))
      .map((g) => ({ ...g, parentId: g.parentId && goes(g.parentId) ? g.parentId : null }));
    const merged = mergeGroups(to.groups, to.counters, moving, makeGroupId);
    to.groups = merged.groups;
    to.counters = merged.counters;
    const mapped = (groupId) => (groupId ? merged.ids.get(groupId) || null : null);

    const stay = [];
    for (const rec of from.tabs) {
      if (!goes(rec.groupId)) {
        stay.push(rec);
        continue;
      }
      rec.groupId = mapped(rec.groupId);
      delete rec.order; // the groups it was placed among are renumbered over there
      to.tabs.push(rec);
      const e = byTab.get(open.get(rec.uid));
      if (e) e.ws = to.id;
    }
    from.tabs = stay;
    const kept = [];
    const sent = [];
    for (const a of archiveOf(from.id)) {
      if (goes(a.groupId)) sent.push({ ...a, groupId: mapped(a.groupId) });
      else kept.push(a);
    }
    doc.archives[from.id] = kept;
    doc.archives[to.id] = [...archiveOf(to.id), ...sent].sort((a, b) => b.at - a.at).slice(0, ARCHIVE_CAP);
    for (const g of moving) delete from.groups[g.id];
  }

  // ---- snapshots ---------------------------------------------------------

  async function snapshot() {
    const listed = await browser.tabs.query({});
    for (const id of [...closed]) {
      if (!listed.some((t) => t.id === id)) closed.delete(id);
    }
    const tabs = listed.filter((t) => !closed.has(t.id));
    const activeMap = {};
    windowsOf(tabs).forEach((windowId) => { activeMap[windowId] = activeOf(windowId); });
    return {
      type: 'state',
      tabs: tabs.map((t) => {
        const e = byTab.get(t.id);
        const rec = e ? e.rec : null;
        const groupId = groupIdOfTab(t.id);
        // What the user made a favorite is one, whether or not it is pinned in
        // the tab strip right now: a hidden workspace's favorites are not.
        const pinned = rec ? !!rec.favorite : !!t.pinned;
        return {
          id: t.id,
          windowId: t.windowId,
          // A private tab has no record; it shows in whichever workspace is open.
          ws: e ? e.ws : null,
          index: t.index,
          order: rec ? rec.order ?? null : null,
          title: t.title || '',
          name: (rec && rec.name) || '',
          url: t.url || '',
          favIconUrl: t.favIconUrl || '',
          pinned,
          pinRow: pinned && rec ? rec.row ?? null : null,
          active: !!t.active,
          attention: !!t.attention,
          lastAccessed: t.lastAccessed || now(),
          groupId,
          pending: !groupId && isSortable(t),
        };
      }),
      // Sidebars get per-group counts; archived tabs themselves are fetched by search.
      spaces: spaces().map((s) => {
        const archiveCounts = {};
        for (const a of archiveOf(s.id)) {
          if (a.groupId) archiveCounts[a.groupId] = (archiveCounts[a.groupId] || 0) + 1;
        }
        return { id: s.id, name: s.name, groups: s.groups, archiveCounts };
      }),
      active: activeMap,
      auto: settings.auto,
      ai: !!settings.apiKey,
      sorting: status.sorting,
      error: status.saveError || status.error,
    };
  }

  const push = debounce(async () => {
    if (!ports.size) return;
    const snap = await snapshot();
    ports.forEach((p) => {
      try { p.postMessage(snap); } catch { ports.delete(p); }
    });
  }, wait.push);

  const changed = () => { save(); push(); };

  // ---- classification ----------------------------------------------------

  const scheduleClassify = debounce(() => { runClassify(); }, wait.classify);

  function isFiled(tab) {
    const e = byTab.get(tab.id);
    const groupId = groupIdOfTab(tab.id);
    if (!groupId) return false;
    // Above the line a tab stays where it is, wherever it navigates.
    return !!e.rec.manual || e.rec.host === hostOf(tab.url) || isHardPinned(space(e.ws).groups, groupId);
  }

  // Queue a tab if it has no group yet or has navigated to a different site.
  function consider(tab) {
    // An import files its own tabs; the ones it leaves unfiled are considered
    // when it finishes.
    if (importing) return;
    if (!byTab.has(tab.id) || !isSortable(tab) || tab.status === 'loading' || isFiled(tab)) return;
    queue.add(tab.id);
    scheduleClassify();
  }

  // Whether a classifier run should place this tab.
  function unsorted(tab) {
    const e = byTab.get(tab.id);
    if (!e || !isSortable(tab)) return false;
    if (!isFiled(tab)) return true;
    // Filed by site but owed a sort by the AI; it waits for the retry.
    return missed.has(tab.id) && !e.rec.manual && !isHardPinned(space(e.ws).groups, e.rec.groupId);
  }

  function retryMissed() {
    for (const id of [...missed]) {
      if (byTab.has(id)) queue.add(id);
      else missed.delete(id);
    }
    if (queue.size) runClassify();
  }

  // Waits longer after each failure in a row, up to AI_RETRY_MAX.
  function scheduleRetry() {
    if (aiRetry) return;
    aiRetry = setTimeout(() => {
      aiRetry = null;
      retryMissed();
    }, Math.min(wait.aiRetry * 2 ** Math.max(0, aiFails - 1), AI_RETRY_MAX));
    aiRetry.unref?.();
  }

  // What the AI sees of a workspace's tree: groups with open tabs, groups
  // archived recently, and their ancestors. Older archived groups are left out
  // so request size tracks what is in use, not the size of the archive. Site
  // groups from the fallback are left out so it builds topic groups instead,
  // unless the user renamed one: that makes it a group they mean to keep.
  // Groups above the line are left out: the classifier has no say there.
  // Favorites are left out too, open or archived: they sit in their own grid,
  // are not part of what is being browsed, and are only ever filed by site.
  function contextFor(home) {
    const groups = home.groups;
    const titles = new Map();
    const relevant = new Set();
    const add = (gid, title) => {
      if (!groups[gid]) return;
      chain(groups, gid).forEach((id) => relevant.add(id));
      if (!title) return;
      if (!titles.has(gid)) titles.set(gid, []);
      if (titles.get(gid).length < 6) titles.get(gid).push(title);
    };
    home.tabs.forEach((rec) => {
      if (!rec.favorite) add(rec.groupId, rec.title);
    });
    const cutoff = now() - AI_RECENT;
    archiveOf(home.id).forEach((a) => {
      if (a.at >= cutoff && !a.favorite) add(a.groupId, a.title);
    });
    const hidden = (g) => !!g.site && !g.manual;
    return Object.values(groups)
      .filter((g) => relevant.has(g.id) && !hidden(g) && !isHardPinned(groups, g.id))
      .map((g) => ({
        id: g.id,
        name: g.name,
        label: g.label,
        parentId: g.parentId && !hidden(groups[g.parentId]) ? g.parentId : null,
        titles: titles.get(g.id) || [],
      }));
  }

  function apply(home, plan, batch, liveIds) {
    const res = applyPlan(home.groups, home.counters, plan, liveIds, makeGroupId);
    home.groups = res.groups;
    home.counters = res.counters;
    const done = new Set();
    for (const t of batch) {
      const gid = res.assign[t.id];
      const e = byTab.get(t.id);
      // Skip tabs the user moved by hand, or to another workspace, while the
      // classifier was running.
      if (!gid || !e || e.ws !== home.id || e.rec.manual) continue;
      file(t.id, gid, hostOf(t.url));
      done.add(t.id);
    }
    return done;
  }

  // One workspace at a time: a tab is only ever filed in its own workspace's groups.
  async function classifyLoop() {
    while (queue.size) {
      for (const id of [...queue]) {
        if (!byTab.has(id)) queue.delete(id);
      }
      if (!queue.size) break;
      const wsId = byTab.get([...queue][0]).ws;
      const ids = [...queue].filter((id) => byTab.get(id).ws === wsId).slice(0, BATCH);
      ids.forEach((id) => queue.delete(id));
      const all = await browser.tabs.query({});
      const inWs = (t) => byTab.get(t.id)?.ws === wsId;
      const batch = all.filter((t) => ids.includes(t.id) && inWs(t) && unsorted(t));
      if (!batch.length || !space(wsId)) continue;
      status.sorting = true;
      push();

      // Favorites are never sent; the site fallback below files them.
      const sendable = batch.filter((t) => !byTab.get(t.id).rec.favorite);
      const useAI = !!(settings.apiKey && classifyWithAI && sendable.length);
      const model = settings.model || DEFAULTS.model;
      const context = useAI ? contextFor(space(wsId)) : [];
      const nameOf = (gid) => {
        const groups = space(wsId)?.groups || {};
        return groups[gid] ? pathName(groups, gid) : '';
      };
      const fromOf = (t) => {
        const from = byTab.get(t.openerTabId);
        return from && from.ws === wsId && !from.rec.favorite ? groupIdOfTab(t.openerTabId) : null;
      };
      // One log entry per run: what the classifier was shown and what it did.
      const before = new Map(Object.values(space(wsId).groups).map((g) => [g.id, g.name]));
      const entry = {
        at: now(),
        workspace: space(wsId).name,
        model: useAI ? model : '',
        error: '',
        groups: context.map((g) => ({ name: nameOf(g.id), label: g.label, titles: g.titles })),
        tabs: batch.map((t) => ({
          title: t.title || '',
          url: logUrl(t.url),
          openedFrom: nameOf(fromOf(t)),
        })),
        renames: [],
      };

      let plan = null;
      let failed = false;
      let retry = false;
      if (useAI) {
        try {
          plan = await classifyWithAI({
            apiKey: settings.apiKey,
            model,
            groups: context,
            tabs: sendable.map((t) => {
              const from = fromOf(t);
              return {
                id: t.id,
                title: t.title || '',
                url: t.url,
                openerGroupId: from && !isHardPinned(space(wsId).groups, from) ? from : null,
              };
            }),
          });
          status.error = '';
          aiFails = 0;
          if (plan.usage) entry.usage = plan.usage;
        } catch (e) {
          status.error = messageOf(e);
          entry.error = status.error;
          failed = true;
          retry = !!(e && e.retry);
        }
      }

      // Tabs may have closed, or the workspace been deleted, while the classifier ran.
      const home = space(wsId);
      if (!home) continue;
      const live = new Set((await browser.tabs.query({})).map((t) => t.id));
      const liveIds = new Set(batch.map((t) => t.id).filter((id) => live.has(id) && inWs({ id })));
      const done = plan ? apply(home, plan, batch, liveIds) : new Set();
      // Anything the AI skipped, or everything when it is off or failed.
      const rest = batch.filter((t) => liveIds.has(t.id) && !done.has(t.id));
      const bySite = rest.length ? apply(home, heuristicPlan(rest, home.groups), rest, liveIds) : new Set();
      if (!failed) {
        batch.forEach((t) => missed.delete(t.id));
      } else {
        // Sorted by site so they are not left loose, and remembered: the AI
        // gets them again when the retry fires or the settings change.
        sendable.forEach((t) => { if (bySite.has(t.id)) missed.add(t.id); });
        if (retry) {
          aiFails += 1;
          scheduleRetry();
        }
      }

      const reasons = new Map(((plan && plan.assignments) || []).map((a) => [a.tabId, a.reason || '']));
      batch.forEach((t, i) => {
        const by = done.has(t.id) ? 'ai' : bySite.has(t.id) ? 'site' : '';
        const gid = by ? groupIdOfTab(t.id) : null;
        Object.assign(entry.tabs[i], {
          by,
          group: nameOf(gid),
          created: !!gid && !before.has(gid),
          reason: by === 'ai' ? reasons.get(t.id) || '' : '',
        });
      });
      before.forEach((name, id) => {
        const g = home.groups[id];
        if (g && g.name !== name) entry.renames.push({ from: name, to: g.name });
      });
      doc.log = [entry, ...doc.log].slice(0, LOG_CAP);

      if (plan && splitWithAI) {
        const touched = new Set([...done].map(groupIdOfTab).filter(Boolean));
        await splitLarge(wsId, touched, model);
      }
    }
  }

  // The open tabs sitting directly in a group that the classifier may move.
  const looseIn = (home, groupId) => home.tabs.filter(
    (r) => r.groupId === groupId && !r.manual && !r.favorite && open.has(r.uid),
  );

  // A group that has collected many tabs is shown to the AI on its own, to
  // move those that form sub-topics into sub-groups. `splitAt` on the group is
  // how many tabs it was left with at the last look, so it is not asked about
  // again until it has grown.
  async function splitLarge(wsId, groupIds, model) {
    for (const gid of groupIds) {
      const home = space(wsId);
      const g = home && home.groups[gid];
      if (!g || (g.site && !g.manual) || isHardPinned(home.groups, gid)) continue;
      if (chain(home.groups, gid).length >= MAX_DEPTH) continue;
      const recs = looseIn(home, gid);
      if (recs.length < Math.max(SPLIT_AT, (g.splitAt || 0) + SPLIT_STEP)) continue;

      const tabs = recs.map((r) => ({ id: open.get(r.uid), title: r.title || '', url: r.url }));
      const subgroups = Object.values(home.groups)
        .filter((x) => x.parentId === gid)
        .map((x) => ({
          id: x.id,
          name: x.name,
          label: x.label,
          titles: home.tabs.filter((r) => r.groupId === x.id && !r.favorite).slice(0, 6).map((r) => r.title || ''),
        }));
      const entry = {
        at: now(),
        workspace: home.name,
        model,
        error: '',
        split: pathName(home.groups, gid),
        considered: tabs.length,
        groups: subgroups.map((x) => ({ name: x.name, label: x.label, titles: x.titles })),
        tabs: [],
        renames: [],
      };

      let plan = null;
      try {
        plan = await splitWithAI({
          apiKey: settings.apiKey,
          model,
          group: { id: g.id, name: g.name, label: g.label },
          subgroups,
          tabs,
        });
        if (plan.usage) entry.usage = plan.usage;
      } catch (e) {
        entry.error = messageOf(e);
      }

      // The group, or any of its tabs, may have gone or been moved meanwhile.
      const after = space(wsId);
      if (plan && after && after.groups[gid]) {
        const still = (id) => {
          const e = byTab.get(id);
          return !!e && e.ws === wsId && e.rec.groupId === gid && !e.rec.manual && !e.rec.favorite;
        };
        const before = new Set(Object.keys(after.groups));
        const res = applyPlan(after.groups, after.counters, plan, new Set(tabs.map((t) => t.id).filter(still)), makeGroupId);
        after.groups = res.groups;
        after.counters = res.counters;
        const moves = tabs
          .map((t) => ({ t, to: res.assign[t.id] }))
          .filter((m) => m.to && res.groups[m.to].parentId === gid);
        const size = new Map();
        moves.forEach((m) => size.set(m.to, (size.get(m.to) || 0) + 1));
        for (const { t, to } of moves) {
          // A sub-group made for one tab is no easier to read than no sub-group.
          if (!before.has(to) && size.get(to) < 2) continue;
          file(t.id, to, byTab.get(t.id).rec.host);
          entry.tabs.push({
            title: t.title,
            url: logUrl(t.url),
            openedFrom: '',
            by: 'ai',
            group: pathName(after.groups, to),
            created: !before.has(to),
            reason: '',
          });
        }
        after.groups[gid].splitAt = looseIn(after, gid).length;
      }
      doc.log = [entry, ...doc.log].slice(0, LOG_CAP);
    }
  }

  function runClassify() {
    if (!running) {
      running = classifyLoop()
        .catch((e) => { status.error = messageOf(e); })
        .finally(() => {
          running = null;
          status.sorting = false;
          gc();
          changed();
        });
    }
    return running;
  }

  async function resortAll() {
    const tabs = await browser.tabs.query({});
    tabs.filter(isSortable).forEach((t) => {
      const e = byTab.get(t.id);
      if (!e || e.rec.manual) return;
      // Above the line a tab stays where it is.
      if (e.rec.groupId && isHardPinned(space(e.ws).groups, e.rec.groupId)) return;
      unfile(e.rec);
      queue.add(t.id);
    });
    Object.values(doc.spaces).forEach((s) => {
      Object.values(s.groups).forEach((g) => { delete g.splitAt; });
    });
    await runClassify();
    // Tabs queued while that run was finishing.
    if (queue.size) await runClassify();
  }

  // ---- archive -----------------------------------------------------------

  function expand(home, groupId) {
    chain(home.groups, groupId).forEach((id) => { home.groups[id].collapsed = false; });
  }

  // Closes tabs, keeping a searchable record of the ones that can be reopened.
  async function archiveTabs(tabs) {
    if (!tabs.length) return;
    const all = await browser.tabs.query({});
    const closing = new Set(tabs.map((t) => t.id));
    // Never empty a window of the tabs it is showing: that would close it, or
    // leave it on a hidden tab of another workspace.
    for (const windowId of windowsOf(tabs)) {
      const wsId = activeOf(windowId);
      const shown = (t) => t.windowId === windowId && (!byTab.has(t.id) || byTab.get(t.id).ws === wsId);
      if (!all.some((t) => shown(t) && !closing.has(t.id))) {
        track(await browser.tabs.create({ windowId }));
      }
    }
    for (const t of tabs) {
      archiving.add(t.id);
      const e = byTab.get(t.id);
      if (e) shelve(e.ws, e.rec);
    }
    await browser.tabs.remove(tabs.map((t) => t.id));
  }

  // Opens archived tabs again, in their own workspace.
  async function reopen(home, records, windowId) {
    const ids = new Set(records.map((r) => r.id));
    doc.archives[home.id] = archiveOf(home.id).filter((a) => !ids.has(a.id));
    if (windowId != null && activeOf(windowId) !== home.id) await switchWorkspace(windowId, home.id);
    let first = true;
    for (const r of records) {
      const tab = await browser.tabs.create({ url: r.url, windowId, active: first });
      first = false;
      track(tab);
      const e = byTab.get(tab.id);
      if (!e) continue;
      if (r.name) e.rec.name = r.name;
      if (r.groupId && space(e.ws).groups[r.groupId]) {
        file(tab.id, r.groupId, hostOf(r.url), !!r.manual);
        expand(space(e.ws), r.groupId);
      }
    }
  }

  // Archived tabs matching a query, across every workspace.
  function searchArchive(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    // A page that is open again would only duplicate the open result.
    const openUrls = new Set([...byTab.values()].map((e) => e.rec.url));
    for (const s of spaces()) {
      for (const a of archiveOf(s.id)) {
        if (openUrls.has(a.url)) continue;
        if (!matchesQuery(`${a.name || ''} ${a.title}`, a.url, q)) continue;
        out.push({ ...a, ws: s.id });
        if (out.length >= SEARCH_LIMIT) return out;
      }
    }
    return out;
  }

  // Collapses each open group none of whose tabs, nested ones included, has
  // been visited for `collapseHours`. Once per idle spell: a group opened by
  // hand afterwards stays open until it is visited and goes idle again.
  function collapseIdle(tabs) {
    const cutoff = now() - settings.collapseHours * DAY / 24;
    const fresh = new Map(); // group -> when it was last visited
    for (const t of tabs) {
      const groupId = groupIdOfTab(t.id);
      if (!groupId) continue;
      const groups = groupsOfTab(t.id);
      const seen = t.active || t.audible ? now() : t.lastAccessed || now();
      for (const id of chain(groups, groupId)) fresh.set(groups[id], Math.max(fresh.get(groups[id]) || 0, seen));
    }
    for (const [g, seen] of fresh) {
      if (g.collapsed || seen > cutoff || (g.idleCollapsedAt || 0) >= seen) continue;
      g.collapsed = true;
      g.idleCollapsedAt = now();
    }
  }

  // Auto-tidy: collapse groups left alone for `collapseHours`, and archive
  // tabs nobody has looked at for `archiveDays`.
  async function tidy() {
    if (!settings.auto) return;
    const cutoff = now() - settings.archiveDays * DAY;
    const tabs = await browser.tabs.query({});
    collapseIdle(tabs);
    const stale = tabs.filter((t) => {
      const e = byTab.get(t.id);
      if (!e || e.rec.favorite || t.pinned || t.active || t.audible || !isSortable(t)) return false;
      if ((t.lastAccessed || now()) > cutoff) return false;
      const groupId = groupIdOfTab(t.id);
      return !(groupId && isHardPinned(space(e.ws).groups, groupId));
    });
    await archiveTabs(stale);
    gc();
    changed();
  }

  // ---- workspace files and backups ---------------------------------------

  // One workspace's open web tabs and the groups they are filed in: enough to
  // rebuild it in another browser. Its archive and the settings are not included.
  async function exportWorkspace(windowId) {
    const home = space(activeOf(windowId));
    const tabs = (await browser.tabs.query({}))
      .filter((t) => isSortable(t) && byTab.get(t.id)?.ws === home.id)
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    const used = new Set();
    const out = tabs.map((t) => {
      const { rec } = byTab.get(t.id);
      const groupId = groupIdOfTab(t.id);
      if (groupId) chain(home.groups, groupId).forEach((id) => used.add(id));
      return {
        url: t.url,
        title: t.title || '',
        groupId,
        pinned: !!rec.favorite,
        ...(rec.favorite && rec.row != null ? { pinRow: rec.row } : {}),
        ...(rec.name ? { name: rec.name } : {}),
        ...(groupId && rec.manual ? { manual: true } : {}),
      };
    });
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: now(),
      // Groups kept alive only by archived tabs are left out.
      groups: Object.values(home.groups)
        .filter((g) => used.has(g.id))
        .map(({ idleCollapsedAt, ...g }) => g),
      tabs: out,
    };
  }

  // Adds a workspace file to the workspace `windowId` shows: its groups
  // (merged with any of the same name) and its tabs, opened in that window.
  // Tabs are opened unloaded, so a large file costs nothing until its tabs are
  // visited; pinned tabs cannot be, and load. A tab already open in the same
  // group is skipped, so a repeated import adds nothing.
  async function importWorkspace(data, windowId) {
    const ws = readWorkspace(data);
    const result = { groups: 0, tabs: 0, skipped: 0, failed: 0 };
    const key = (url, groupId) => url + '\n' + (groupId || '');
    const home = space(activeOf(windowId));
    importing += 1;
    try {
      const merged = mergeGroups(home.groups, home.counters, ws.groups, makeGroupId);
      home.groups = merged.groups;
      home.counters = merged.counters;
      result.groups = merged.added;
      const groupFor = (id) => merged.ids.get(id) || null;

      const have = new Set(home.tabs.map((r) => key(r.url, r.groupId)));
      // Imported pin rows go below the rows already there.
      const rowBase = 1 + Math.max(-1, ...home.tabs.filter((r) => r.favorite).map((r) => r.row ?? -1));
      for (const t of ws.tabs) {
        const groupId = groupFor(t.groupId);
        if (have.has(key(t.url, groupId))) {
          result.skipped += 1;
          continue;
        }
        let tab;
        try {
          tab = await browser.tabs.create(t.pinned
            ? { url: t.url, windowId, pinned: true, active: false }
            : { url: t.url, windowId, active: false, discarded: true, ...(t.title ? { title: t.title } : {}) });
        } catch {
          result.failed += 1;
          continue;
        }
        have.add(key(t.url, groupId));
        track(tab);
        const e = byTab.get(tab.id);
        if (e) {
          // The page has not loaded, so the record takes the file's word for it.
          Object.assign(e.rec, { url: t.url, title: t.title || e.rec.title });
          if (groupId) file(tab.id, groupId, hostOf(t.url), !!t.manual);
          if (t.name) e.rec.name = t.name;
          if (t.pinned) setFavorite(e.rec, true, home);
          if (t.pinRow != null) e.rec.row = rowBase + t.pinRow;
        }
        result.tabs += 1;
      }
    } finally {
      importing -= 1;
    }
    gc();
    changed();
    (await browser.tabs.query({})).forEach(consider);
    return result;
  }

  const exportBackup = () => backupOf(doc, now());

  // Replaces the document with a backup's. No tab is closed or opened: open
  // tabs take their records in the backup, tabs it does not know get new ones,
  // and its tabs that are not open go to the archive, where they can be
  // reopened. The document being replaced is kept so this can be undone.
  async function restoreBackup(data) {
    const next = readBackup(data, newId);
    await flush();
    await browser.storage.local.set({ [SNAP_BEFORE_RESTORE]: backupOf(doc, now()) });
    Object.assign(doc, next);
    const tabs = await browser.tabs.query({});
    await reconcile(tabs, false);
    await arrangeAll();
    gc();
    push();
    await flush();
    tabs.forEach(consider);
    return backupSummary(data);
  }

  async function listSnapshots() {
    const all = await browser.storage.local.get(null);
    return Object.keys(all)
      .filter((key) => key.startsWith(SNAP_PREFIX))
      .sort()
      .reverse()
      .map((key) => ({ key, ...backupSummary(all[key]) }));
  }

  async function restoreSnapshot(key) {
    const found = await browser.storage.local.get(key);
    if (!String(key).startsWith(SNAP_PREFIX) || !found[key]) throw new Error('That snapshot is no longer kept.');
    return restoreBackup(found[key]);
  }

  // ---- actions from the sidebar and options page -------------------------

  // Moves a tab to sit just before or after another in the same window.
  async function placeBeside(tab, nearTabId, after) {
    const near = await browser.tabs.get(nearTabId);
    if (near.windowId !== tab.windowId || near.id === tab.id) return;
    let index = near.index + (after ? 1 : 0);
    if (tab.index < near.index) index -= 1;
    if (index !== tab.index) await browser.tabs.move(tab.id, { index });
  }

  // A tab's place among its group's sub-groups (see slotOf in model.js).
  function setOrder(rec, order) {
    if (order == null) delete rec.order;
    else rec.order = order;
  }

  // The tabs filed directly in a group that one window lists, in tab order.
  async function listedTabs(home, groupId, windowId) {
    return (await browser.tabs.query({}))
      .filter((t) => {
        const own = byTab.get(t.id);
        return t.windowId === windowId && own && own.ws === home.id && own.rec.groupId === groupId && !own.rec.favorite;
      })
      .sort((a, b) => a.index - b.index);
  }

  // Files tabs in a new top-level group and returns its id. Tabs of another
  // workspace than the first one's are left alone.
  async function groupTabs(tabIds) {
    const picked = [...new Set(tabIds)].filter((id) => byTab.has(id));
    if (!picked.length) return null;
    const { ws } = byTab.get(picked[0]);
    const ids = picked.filter((id) => byTab.get(id).ws === ws);
    const own = space(ws);
    const res = applyPlan(own.groups, own.counters, {
      newGroups: [{ ref: 'new', name: 'New group', label: 'Custom', parent: null }],
      assignments: ids.map((tabId) => ({ tabId, group: 'new' })),
    }, new Set(ids), makeGroupId);
    const groupId = res.assign[ids[0]];
    if (!groupId) return null;
    own.groups = res.groups;
    own.counters = res.counters;
    own.groups[groupId].manual = true;
    for (const id of ids) {
      const tab = await browser.tabs.get(id);
      file(id, groupId, hostOf(tab.url), true);
      queue.delete(id);
    }
    return groupId;
  }

  async function handle(msg) {
    const home = msg.groupId ? homeOfGroup(msg.groupId) : null;
    const g = home ? home.groups[msg.groupId] : null;
    const e = msg.tabId != null ? byTab.get(msg.tabId) : null;
    let made = null; // id of the group a message made
    switch (msg.type) {
      case 'activate': {
        const tab = await browser.tabs.get(msg.tabId);
        // A tab in another workspace brings its workspace with it.
        if (e && activeOf(tab.windowId) !== e.ws) await switchWorkspace(tab.windowId, e.ws, tab.id);
        else await browser.tabs.update(msg.tabId, { active: true });
        if (msg.windowId != null && tab.windowId !== msg.windowId) {
          await browser.windows.update(tab.windowId, { focused: true });
        }
        break;
      }
      case 'closeTab': {
        const tab = await browser.tabs.get(msg.tabId);
        await archiveTabs([tab]);
        break;
      }
      case 'pinTab':
        if (e) {
          setFavorite(e.rec, !!msg.pinned, space(e.ws));
          delete e.rec.row;
        }
        await browser.tabs.update(msg.tabId, { pinned: !!msg.pinned });
        break;
      // The pin grid as arranged by a drop: rows of tab ids. Tabs not pinned
      // yet are pinned, and the tab strip takes the same order.
      case 'layoutPins': {
        const rows = (Array.isArray(msg.rows) ? msg.rows : []).filter(Array.isArray);
        let index = 0;
        for (const [r, row] of rows.entries()) {
          for (const tabId of row) {
            const tab = await browser.tabs.get(tabId).catch(() => null);
            if (!tab || tab.id == null || tab.windowId !== msg.windowId) continue;
            const rec = byTab.get(tabId)?.rec;
            if (rec) Object.assign(rec, { favorite: true, row: r, slot: index });
            if (!tab.pinned) await browser.tabs.update(tabId, { pinned: true });
            await browser.tabs.move(tabId, { index });
            index += 1;
          }
        }
        break;
      }
      case 'newTab':
        track(await browser.tabs.create({ windowId: msg.windowId, pinned: !!msg.pinned }));
        break;
      case 'toggleGroup':
        if (g) g.collapsed = !g.collapsed;
        break;
      case 'showGroup':
        if (!g) break;
        expand(home, g.id);
        if (msg.windowId != null && activeOf(msg.windowId) !== home.id) await switchWorkspace(msg.windowId, home.id);
        break;
      // Moves a top-level group across the line, with everything nested in it.
      case 'pinGroup':
        if (g && chain(home.groups, g.id).length === 1) g.pinned = !g.pinned;
        break;
      case 'renameGroup': {
        const name = clean(msg.name, 40);
        if (!g || !name) break;
        g.name = name;
        g.manual = true;
        break;
      }
      // An empty name goes back to the page's own title.
      case 'renameTab': {
        if (!e) break;
        const name = clean(msg.name, 80);
        if (name) e.rec.name = name;
        else delete e.rec.name;
        break;
      }
      // Drag and drop of a tab: into a group, and there beside one of its tabs
      // (`nearTabId`) or one of its sub-groups (`nearGroupId`).
      case 'moveTab': {
        if (!g || !e || e.ws !== home.id) break;
        const tab = await browser.tabs.get(msg.tabId);
        const nearTab = msg.nearTabId != null && msg.nearTabId !== tab.id ? byTab.get(msg.nearTabId) : null;
        const subs = childMap(home.groups).get(g.id) || [];
        const at = subs.indexOf(home.groups[msg.nearGroupId]);
        file(tab.id, g.id, hostOf(tab.url), true);
        queue.delete(tab.id);
        expand(home, g.id);
        if (nearTab && nearTab.ws === home.id && nearTab.rec.groupId === g.id) {
          // Beside another tab: among the sub-groups it sits where that tab
          // does, and it takes that place in the tab strip too.
          setOrder(e.rec, nearTab.rec.order);
          await placeBeside(tab, msg.nearTabId, msg.after);
        } else if (at >= 0) {
          // Beside a sub-group: last of the tabs before it, or first of those after.
          const slot = at + (msg.after ? 1 : 0);
          setOrder(e.rec, slot ? subs[slot - 1].order : null);
          const there = (await listedTabs(home, g.id, tab.windowId))
            .filter((t) => t.id !== tab.id && slotOf(subs, byTab.get(t.id).rec.order) === slot);
          const near = msg.after ? there[0] : there[there.length - 1];
          if (near) await placeBeside(tab, near.id, !msg.after);
        }
        break;
      }
      // Several tabs dragged together: the first lands where a single tab
      // would, and the rest follow it in the order given.
      case 'moveTabs': {
        let prev = null;
        for (const tabId of new Set(Array.isArray(msg.tabIds) ? msg.tabIds : [])) {
          if (!byTab.has(tabId)) continue;
          const { tabIds, ...first } = msg;
          await handle(prev == null ? { ...first, type: 'moveTab', tabId }
            : { type: 'moveTab', windowId: msg.windowId, groupId: msg.groupId, tabId, nearTabId: prev, after: true });
          if (groupIdOfTab(tabId) === msg.groupId) prev = tabId;
        }
        break;
      }
      // Drag and drop of a group: beside another group (`targetId`, `where`
      // before or after), last in one (`where` into; no `targetId` for the top
      // level), or beside a tab of the group it joins (`nearTabId`, `after`).
      case 'moveGroup': {
        if (!g) break;
        const target = msg.targetId != null ? home.groups[msg.targetId] : null;
        const nearTab = msg.nearTabId != null ? byTab.get(msg.nearTabId) : null;
        const into = msg.where === 'into';
        let parentId = null;
        if (nearTab) {
          if (nearTab.ws !== home.id || !home.groups[nearTab.rec.groupId]) break;
          parentId = nearTab.rec.groupId;
        } else if (msg.targetId != null) {
          if (!target || g === target) break;
          parentId = into ? target.id : target.parentId || null;
        } else if (!into) {
          break;
        }
        if (!canNest(home.groups, g.id, parentId)) break;
        const sibs = (childMap(home.groups).get(parentId) || []).filter((s) => s !== g);
        // The tabs sharing the place it takes among its siblings, split into
        // those that end up before it and those after.
        let slot = sibs.length;
        let split = 0;
        let shown = [];
        if (nearTab) {
          slot = slotOf(sibs, nearTab.rec.order);
          const near = await browser.tabs.get(msg.nearTabId);
          shown = (await listedTabs(home, parentId, near.windowId)).map((t) => byTab.get(t.id).rec);
          split = shown.indexOf(nearTab.rec) + (msg.after ? 1 : 0);
        } else if (!into) {
          slot = sibs.indexOf(target) + (msg.where === 'after' ? 1 : 0);
        }
        const sharing = parentId == null ? []
          : home.tabs.filter((r) => r.groupId === parentId && slotOf(sibs, r.order) === slot);
        const prev = sibs[slot - 1];
        const next = sibs[slot];
        g.order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1 : next ? next.order - 1 : 1;
        g.parentId = parentId;
        for (const rec of sharing) {
          // Tabs this window does not list (another window's, favorites) stay before it.
          const at = shown.indexOf(rec);
          const before = nearTab ? at < 0 || at < split : msg.where !== 'after';
          setOrder(rec, before ? (prev ? prev.order : null) : g.order);
        }
        // At the top level it lands on its neighbour's side of the line;
        // nested, it is on its parent's.
        g.pinned = parentId == null && !!target && !!target.pinned;
        if (parentId != null) expand(home, parentId);
        break;
      }
      // Several groups dragged together: the first lands where a single group
      // would, and the rest follow it in the order given.
      case 'moveGroups': {
        const { groupIds, ...first } = msg;
        let prev = null;
        for (const groupId of new Set(Array.isArray(groupIds) ? groupIds : [])) {
          if (!homeOfGroup(groupId)) continue;
          await handle(prev == null ? { ...first, type: 'moveGroup', groupId }
            : { type: 'moveGroup', windowId: msg.windowId, groupId, targetId: prev, where: 'after' });
          prev = groupId;
        }
        break;
      }
      case 'newGroupForTab':
        made = await groupTabs([msg.tabId]);
        break;
      case 'groupTabs':
        made = await groupTabs(Array.isArray(msg.tabIds) ? msg.tabIds : []);
        break;
      case 'archiveGroup': {
        if (!g) break;
        const ids = subtree(home.groups, g.id);
        ids.forEach((id) => { home.groups[id].pinned = false; });
        const tabs = await browser.tabs.query({});
        // Favorites stay: they live in the pin grid, not in the group's rows.
        await archiveTabs(tabs.filter((t) => {
          const own = byTab.get(t.id);
          return own && own.ws === home.id && !own.rec.favorite && ids.includes(own.rec.groupId);
        }));
        break;
      }
      case 'reopenGroup': {
        if (!g) break;
        const ids = subtree(home.groups, g.id);
        await reopen(home, archiveOf(home.id).filter((a) => ids.includes(a.groupId)).reverse(), msg.windowId);
        break;
      }
      case 'reopenTab': {
        const from = spaces().find((s) => archiveOf(s.id).some((a) => a.id === msg.archiveId));
        if (from) await reopen(from, [archiveOf(from.id).find((a) => a.id === msg.archiveId)], msg.windowId);
        break;
      }
      case 'switchWorkspace':
        await switchWorkspace(msg.windowId, msg.wsId);
        break;
      case 'newWorkspace': {
        const id = newId('w');
        const taken = new Set(spaces().map((s) => s.name));
        let n = doc.meta.order.length + 1;
        while (taken.has('Workspace ' + n)) n += 1;
        doc.spaces[id] = newSpace(id, clean(msg.name, 30) || 'Workspace ' + n);
        doc.archives[id] = [];
        doc.meta.order.push(id);
        await switchWorkspace(msg.windowId, id);
        break;
      }
      case 'renameWorkspace': {
        const name = clean(msg.name, 30);
        if (space(msg.wsId) && name) space(msg.wsId).name = name;
        break;
      }
      // Nothing in a deleted workspace is lost: its groups, tabs and archive
      // join the workspace next to it.
      case 'deleteWorkspace': {
        const from = space(msg.wsId);
        const at = doc.meta.order.indexOf(msg.wsId);
        if (!from || doc.meta.order.length < 2) break;
        const to = space(doc.meta.order[at + 1] ?? doc.meta.order[at - 1]);
        transfer(from, to);
        doc.meta.order.splice(at, 1);
        delete doc.spaces[from.id];
        delete doc.archives[from.id];
        if (doc.meta.current === from.id) doc.meta.current = to.id;
        active.forEach((wsId, windowId) => {
          if (wsId !== from.id) return;
          active.set(windowId, to.id);
          remember(windowId);
        });
        await arrangeAll();
        break;
      }
      // The tab leaves its group behind: groups belong to one workspace.
      case 'moveTabToWorkspace': {
        const to = space(msg.wsId);
        if (!e || !to || e.ws === to.id) break;
        const tab = await browser.tabs.get(msg.tabId);
        space(e.ws).tabs = space(e.ws).tabs.filter((r) => r !== e.rec);
        unfile(e.rec);
        delete e.rec.row;
        delete e.rec.slot;
        if (e.rec.favorite) setFavorite(e.rec, true, to);
        to.tabs.push(e.rec);
        e.ws = to.id;
        queue.delete(tab.id);
        await arrange(tab.windowId);
        consider(tab);
        break;
      }
      case 'moveGroupToWorkspace': {
        const to = space(msg.wsId);
        if (!g || !to || to === home) break;
        transfer(home, to, new Set(subtree(home.groups, g.id)));
        await arrangeAll();
        break;
      }
      case 'setAuto':
        settings.auto = !!msg.auto;
        await browser.storage.local.set({ settings });
        if (settings.auto) await tidy();
        break;
      case 'resort':
        await resortAll();
        break;
      case 'clearLog':
        doc.log = [];
        break;
      default:
        return;
    }
    gc();
    changed();
    return made;
  }

  // ---- context menu ------------------------------------------------------

  // Groups a tab can be moved to: the ones in its workspace holding open tabs,
  // in sidebar order.
  function moveTargets(tabId) {
    const e = byTab.get(tabId);
    if (!e) return [];
    const { groups, tabs } = space(e.ws);
    const current = groupIdOfTab(tabId);
    const live = new Set();
    tabs.forEach((r) => chain(groups, r.groupId).forEach((id) => live.add(id)));
    const kids = childMap(groups);
    const out = [];
    const walk = (g) => {
      if (!live.has(g.id)) return;
      if (g.id !== current) out.push({ id: g.id, title: pathName(groups, g.id) });
      (kids.get(g.id) || []).forEach(walk);
    };
    (kids.get(null) || []).forEach(walk);
    return out;
  }

  // `tabId` is the tab the browser says the menu was opened on, when it says so.
  async function menuClick(itemId, tabId = menu.tabId) {
    const { groupId, port } = menu;
    const edit = (id) => {
      if (!homeOfGroup(id) || !port) return;
      try { port.postMessage({ type: 'editGroup', groupId: id }); } catch { /* sidebar closed */ }
    };
    const id = String(itemId);
    if (id === MENU.archiveTab) return handle({ type: 'closeTab', tabId });
    if (id === MENU.moveNew) return edit(await handle({ type: 'newGroupForTab', tabId }));
    if (id === MENU.groupTabs) return edit(await handle({ type: 'groupTabs', tabIds: menu.tabIds }));
    if (id.startsWith(MENU.moveTo)) {
      return handle({ type: 'moveTab', tabId, groupId: id.slice(MENU.moveTo.length) });
    }
    if (id === MENU.rename) return edit(groupId);
    const type = {
      [MENU.pinGroup]: 'pinGroup',
      [MENU.toggleGroup]: 'toggleGroup',
      [MENU.archiveGroup]: 'archiveGroup',
    }[id];
    if (type) return handle({ type, groupId });
  }

  // ---- wiring ------------------------------------------------------------

  async function start() {
    const stored = await browser.storage.local.get(null);
    settings = { ...DEFAULTS, ...(stored.settings || {}) };
    // Throws, before anything is written, for data from a newer build.
    const { legacy, ...loaded } = loadStore(stored, newId);
    Object.assign(doc, loaded);
    for (const [key, value] of Object.entries(stored)) {
      if (isDocKey(key)) written.set(key, JSON.stringify(value));
    }
    // Taken from what was stored, before this run changes anything.
    if (!legacy) await dailySnapshot(backupOf(doc, now())).catch(reportError);

    const tabs = await browser.tabs.query({});
    for (const windowId of windowsOf(tabs)) {
      const saved = await browser.sessions.getWindowValue(windowId, WS_KEY).catch(() => null);
      active.set(windowId, space(saved) ? saved : activeOf(windowId));
      if (!space(saved)) remember(windowId);
    }
    await reconcile(tabs, legacy);

    browser.tabs.onCreated.addListener((tab) => {
      learnWindow(tab.windowId).catch(reportError);
      track(tab);
      consider(tab);
      push();
    });
    browser.tabs.onUpdated.addListener((tabId, change, tab) => {
      track(tab);
      const e = byTab.get(tabId);
      if (e) {
        // Pinned or unpinned in the browser's own interface. Our own unpinning
        // of a hidden workspace's favorites is not a change of mind.
        if ('pinned' in change && activeOf(tab.windowId) === e.ws && !!change.pinned !== !!e.rec.favorite) {
          setFavorite(e.rec, !!change.pinned, space(e.ws));
          save();
        }
        if (sync(e.rec, tab)) save();
      }
      if (change.url || change.status === 'complete' || change.title) consider(tab);
      // Unpinned, a favorite is an ordinary tab again: the AI gets to file it.
      if ('pinned' in change && e && !e.rec.favorite && settings.apiKey && groupIdOfTab(tabId)) {
        missed.add(tabId);
        queue.add(tabId);
        scheduleClassify();
      }
      push();
    });
    browser.tabs.onRemoved.addListener((tabId) => {
      const e = unbind(tabId);
      closed.add(tabId);
      queue.delete(tabId);
      missed.delete(tabId);
      if (e) {
        space(e.ws).tabs = space(e.ws).tabs.filter((r) => r !== e.rec);
        // Closed by the browser rather than from the sidebar: archived all the same.
        if (!archiving.delete(tabId)) shelve(e.ws, e.rec);
      }
      gc();
      changed();
    });
    browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
      const e = byTab.get(tabId);
      if (e) {
        // However a hidden workspace's tab came to be selected, the window
        // follows it there.
        if (windowId != null && activeOf(windowId) !== e.ws) {
          switchWorkspace(windowId, e.ws, tabId).then(changed, reportError);
        }
        const groupId = groupIdOfTab(tabId);
        if (groupId) {
          expand(space(e.ws), groupId);
          save();
        }
      }
      push();
    });
    browser.tabs.onMoved.addListener(push);
    browser.tabs.onAttached.addListener((tabId, info) => {
      // Dragged to another window: it joins the workspace that window shows.
      const e = byTab.get(tabId);
      const wsId = info ? activeOf(info.newWindowId) : null;
      if (e && wsId && wsId !== e.ws) handle({ type: 'moveTabToWorkspace', tabId, wsId }).catch(reportError);
      push();
    });
    browser.tabs.onDetached.addListener(push);
    browser.tabs.onReplaced.addListener((added, removed) => {
      const e = unbind(removed);
      if (e) {
        bind(added, e.ws, e.rec);
        stamp(added, e.rec.uid);
      }
      if (queue.delete(removed)) queue.add(added);
      if (missed.delete(removed)) missed.add(added);
      push();
    });

    browser.runtime.onConnect.addListener((port) => {
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
      port.onMessage.addListener((msg) => {
        if (msg.type === 'search') {
          port.postMessage({ type: 'archiveHits', query: msg.query, tabs: searchArchive(msg.query) });
          return;
        }
        if (msg.type === 'menuTarget') {
          menu = { port, tabId: msg.tabId ?? null, groupId: msg.groupId ?? null, tabIds: msg.tabIds ?? [] };
          return;
        }
        handle(msg).then((made) => {
          // A new workspace or group opens with its name ready to type over.
          const edit = msg.type === 'newWorkspace' ? { type: 'editWorkspace', wsId: activeOf(msg.windowId) }
            : msg.type === 'groupTabs' && made ? { type: 'editGroup', groupId: made } : null;
          if (!edit) return;
          try { port.postMessage(edit); } catch { /* sidebar closed */ }
        }).catch(reportError);
      });
      push();
    });
    // The options page. These answer with a result, and one that fails rejects
    // so the page can say why.
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'exportWorkspace') return exportWorkspace(msg.windowId);
      if (msg.type === 'importWorkspace') return importWorkspace(msg.data, msg.windowId);
      if (msg.type === 'exportBackup') return Promise.resolve(exportBackup());
      if (msg.type === 'restoreBackup') return restoreBackup(msg.data);
      if (msg.type === 'listSnapshots') return listSnapshots();
      if (msg.type === 'restoreSnapshot') return restoreSnapshot(msg.key);
      return handle(msg).catch(reportError);
    });

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const was = settings;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      push();
      // A new key or model may be the fix for what failed before.
      if (settings.apiKey && (settings.apiKey !== was.apiKey || settings.model !== was.model)) retryMissed();
      // Auto-tidy may have just been switched on, or its age shortened.
      tidy().catch(reportError);
    });

    browser.alarms.create('tidy', { periodInMinutes: 30 });
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== 'tidy') return;
      dailySnapshot().catch(reportError);
      tidy().catch(reportError);
    });

    // Version 1's keys are copied aside, then removed once the document that
    // replaces them is stored.
    const old = LEGACY_KEYS.filter((key) => key in stored);
    if (old.length) {
      await browser.storage.local.set({ [LEGACY_KEY]: Object.fromEntries(old.map((key) => [key, stored[key]])) });
    }
    await flush();
    if (old.length && !status.saveError) await browser.storage.local.remove(old);

    await arrangeAll();
    tabs.forEach(consider);
    await tidy();
  }

  function reportError(e) {
    status.error = messageOf(e);
    push();
  }

  const current = () => space(activeOf());
  return {
    start, handle, snapshot, runClassify, tidy, searchArchive, moveTargets,
    exportWorkspace, importWorkspace, exportBackup, restoreBackup, listSnapshots, restoreSnapshot,
    flush,
    menuClick: (itemId, tabId) => menuClick(itemId, tabId).catch(reportError),
    queue,
    doc,
    // The workspace last chosen, and the open tabs' records by tab id.
    state: {
      get groups() { return current().groups; },
      get archive() { return archiveOf(current().id); },
      get log() { return doc.log; },
      get settings() { return settings; },
    },
    assign: {
      get: (tabId) => byTab.get(tabId)?.rec,
      has: (tabId) => !!groupIdOfTab(tabId),
    },
    workspaceOf: (tabId) => byTab.get(tabId)?.ws,
  };
}
