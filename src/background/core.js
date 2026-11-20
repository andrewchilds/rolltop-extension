// Background logic: tracks which group each tab belongs to, runs the
// classifier, archives idle tabs and pushes snapshots to open sidebars.
// The browser API and the AI classifier are injected so this runs under Node.

import {
  DAY, MENU, canNest, chain, childMap, subtree, pathName, isHardPinned, matchesQuery,
} from '../../extension/lib/model.js';
import { applyPlan, clean, gcGroups, heuristicPlan } from '../../extension/lib/plan.js';

export const DEFAULTS = { auto: true, archiveDays: 14, apiKey: '', model: 'claude-opus-5-5' };
const ARCHIVE_CAP = 1000;
const BATCH = 40;
const SEARCH_LIMIT = 50;
const LOG_CAP = 20; // sorting runs kept for the options page
// Archived groups older than this stay searchable but are not shown to the AI.
const AI_RECENT = 30 * DAY;
const TAB_KEY = 'tidy';
const NAME_KEY = 'tidy-name';

const isSortable = (tab) => /^https?:/.test(tab.url || '') && !tab.incognito;
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

export function createBackground({
  browser,
  classifyWithAI,
  now = () => Date.now(),
  delay = { classify: 1200, push: 50, save: 400 },
}) {
  const state = {
    groups: {},
    archive: [],
    log: [],
    settings: { ...DEFAULTS },
    counters: { nextGroup: 1, topLevel: 0, nextArchive: 1 },
  };
  // tabId -> { groupId, host, manual? }. `manual` marks a tab the user filed by
  // hand; the classifier leaves it where it is, even after it navigates.
  const assign = new Map();
  const names = new Map(); // tabId -> the title the user gave the tab, shown in place of the page's
  const queue = new Set(); // tabIds waiting for a classifier run
  const seen = new Map(); // tabId -> last known tab, since onRemoved only gives an id
  const archiving = new Set(); // tabIds being closed by archiveTabs
  const ports = new Set();
  const status = { sorting: false, error: '' };
  let running = null;
  // The row a sidebar last opened a context menu on, and the sidebar's port.
  let menu = { port: null, tabId: null, groupId: null };

  const debounce = (fn, ms) => {
    let timer = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(); }, ms);
    };
  };

  // ---- persistence -------------------------------------------------------

  const save = debounce(() => {
    browser.storage.local.set({
      groups: state.groups,
      archive: state.archive,
      counters: state.counters,
      log: state.log,
    });
  }, delay.save);

  function setAssign(tabId, groupId, host, manual = false) {
    const value = manual ? { groupId, host, manual: true } : { groupId, host };
    assign.set(tabId, value);
    // Stored with the tab in the session, so groups survive a restart.
    browser.sessions.setTabValue(tabId, TAB_KEY, value).catch(() => {});
  }

  function setName(tabId, name) {
    if (name) {
      names.set(tabId, name);
      browser.sessions.setTabValue(tabId, NAME_KEY, name).catch(() => {});
    } else {
      names.delete(tabId);
      browser.sessions.removeTabValue(tabId, NAME_KEY).catch(() => {});
    }
  }

  function gc() {
    const used = new Set();
    assign.forEach((a) => used.add(a.groupId));
    state.archive.forEach((a) => a.groupId && used.add(a.groupId));
    state.groups = gcGroups(state.groups, used);
  }

  // ---- snapshots ---------------------------------------------------------

  async function snapshot() {
    const tabs = await browser.tabs.query({});
    // Sidebars get per-group counts; archived tabs themselves are fetched by search.
    const archiveCounts = {};
    for (const a of state.archive) {
      if (a.groupId) archiveCounts[a.groupId] = (archiveCounts[a.groupId] || 0) + 1;
    }
    return {
      type: 'state',
      tabs: tabs.map((t) => {
        const a = assign.get(t.id);
        const groupId = a && state.groups[a.groupId] ? a.groupId : null;
        return {
          id: t.id,
          windowId: t.windowId,
          index: t.index,
          title: t.title || '',
          name: names.get(t.id) || '',
          url: t.url || '',
          favIconUrl: t.favIconUrl || '',
          pinned: !!t.pinned,
          active: !!t.active,
          attention: !!t.attention,
          lastAccessed: t.lastAccessed || now(),
          groupId,
          pending: !groupId && isSortable(t),
        };
      }),
      groups: state.groups,
      archiveCounts,
      auto: state.settings.auto,
      ai: !!state.settings.apiKey,
      sorting: status.sorting,
      error: status.error,
    };
  }

  const push = debounce(async () => {
    if (!ports.size) return;
    const snap = await snapshot();
    ports.forEach((p) => {
      try { p.postMessage(snap); } catch { ports.delete(p); }
    });
  }, delay.push);

  const changed = () => { save(); push(); };

  // ---- classification ----------------------------------------------------

  const scheduleClassify = debounce(() => { runClassify(); }, delay.classify);

  function isFiled(tab) {
    const a = assign.get(tab.id);
    return !!a && !!state.groups[a.groupId] && (!!a.manual || a.host === hostOf(tab.url));
  }

  // Queue a tab if it has no group yet or has navigated to a different site.
  function consider(tab) {
    if (!isSortable(tab) || tab.status === 'loading' || isFiled(tab)) return;
    queue.add(tab.id);
    scheduleClassify();
  }

  // What the AI sees of the current tree: groups with open tabs, groups
  // archived recently, and their ancestors. Older archived groups are left out
  // so request size tracks what is in use, not the size of the archive. Site
  // groups from the fallback are left out so it builds topic groups instead,
  // unless the user renamed one: that makes it a group they mean to keep.
  function contextFor(allTabs) {
    const titles = new Map();
    const relevant = new Set();
    const add = (gid, title) => {
      if (!state.groups[gid]) return;
      chain(state.groups, gid).forEach((id) => relevant.add(id));
      if (!title) return;
      if (!titles.has(gid)) titles.set(gid, []);
      if (titles.get(gid).length < 6) titles.get(gid).push(title);
    };
    allTabs.forEach((t) => {
      const a = assign.get(t.id);
      if (a) add(a.groupId, t.title);
    });
    const cutoff = now() - AI_RECENT;
    state.archive.forEach((a) => {
      if (a.at >= cutoff) add(a.groupId, a.title);
    });
    const hidden = (g) => !!g.site && !g.manual;
    return Object.values(state.groups)
      .filter((g) => relevant.has(g.id) && !hidden(g))
      .map((g) => ({
        id: g.id,
        name: g.name,
        label: g.label,
        parentId: g.parentId && !hidden(state.groups[g.parentId]) ? g.parentId : null,
        titles: titles.get(g.id) || [],
      }));
  }

  function apply(plan, batch, liveIds) {
    const res = applyPlan(state.groups, state.counters, plan, liveIds);
    state.groups = res.groups;
    state.counters = res.counters;
    const done = new Set();
    for (const t of batch) {
      const gid = res.assign[t.id];
      // Skip tabs the user moved by hand while the classifier was running.
      if (!gid || assign.get(t.id)?.manual) continue;
      setAssign(t.id, gid, hostOf(t.url));
      done.add(t.id);
    }
    return done;
  }

  async function classifyLoop() {
    while (queue.size) {
      const ids = [...queue].slice(0, BATCH);
      ids.forEach((id) => queue.delete(id));
      const all = await browser.tabs.query({});
      const batch = all.filter((t) => ids.includes(t.id) && isSortable(t) && !isFiled(t));
      if (!batch.length) continue;
      status.sorting = true;
      push();

      const useAI = !!(state.settings.apiKey && classifyWithAI);
      const model = state.settings.model || DEFAULTS.model;
      const context = useAI ? contextFor(all) : [];
      const nameOf = (gid) => (state.groups[gid] ? pathName(state.groups, gid) : '');
      // One log entry per run: what the classifier was shown and what it did.
      const before = new Map(Object.values(state.groups).map((g) => [g.id, g.name]));
      const entry = {
        at: now(),
        model: useAI ? model : '',
        error: '',
        groups: context.map((g) => ({ name: nameOf(g.id), label: g.label, titles: g.titles })),
        tabs: batch.map((t) => ({
          title: t.title || '',
          url: logUrl(t.url),
          openedFrom: nameOf(assign.get(t.openerTabId)?.groupId),
        })),
        renames: [],
      };

      let plan = null;
      if (useAI) {
        try {
          plan = await classifyWithAI({
            apiKey: state.settings.apiKey,
            model,
            groups: context,
            tabs: batch.map((t) => ({
              id: t.id,
              title: t.title || '',
              url: t.url,
              openerGroupId: assign.get(t.openerTabId)?.groupId || null,
            })),
          });
          status.error = '';
        } catch (e) {
          status.error = (e && e.message) || String(e);
          entry.error = status.error;
        }
      }

      // Tabs may have closed while the classifier ran.
      const live = new Set((await browser.tabs.query({})).map((t) => t.id));
      const liveIds = new Set(batch.map((t) => t.id).filter((id) => live.has(id)));
      const done = plan ? apply(plan, batch, liveIds) : new Set();
      // Anything the AI skipped, or everything when it is off or failed.
      const rest = batch.filter((t) => liveIds.has(t.id) && !done.has(t.id));
      const bySite = rest.length ? apply(heuristicPlan(rest, state.groups), rest, liveIds) : new Set();

      const reasons = new Map(((plan && plan.assignments) || []).map((a) => [a.tabId, a.reason || '']));
      batch.forEach((t, i) => {
        const by = done.has(t.id) ? 'ai' : bySite.has(t.id) ? 'site' : '';
        const gid = by ? assign.get(t.id)?.groupId : null;
        Object.assign(entry.tabs[i], {
          by,
          group: nameOf(gid),
          created: !!gid && !before.has(gid),
          reason: by === 'ai' ? reasons.get(t.id) || '' : '',
        });
      });
      before.forEach((name, id) => {
        const g = state.groups[id];
        if (g && g.name !== name) entry.renames.push({ from: name, to: g.name });
      });
      state.log = [entry, ...state.log].slice(0, LOG_CAP);
    }
  }

  function runClassify() {
    if (!running) {
      running = classifyLoop()
        .catch((e) => { status.error = (e && e.message) || String(e); })
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
      if (assign.get(t.id)?.manual) return;
      assign.delete(t.id);
      queue.add(t.id);
    });
    await runClassify();
    // Tabs queued while that run was finishing.
    if (queue.size) await runClassify();
  }

  // ---- archive -----------------------------------------------------------

  function expand(groupId) {
    chain(state.groups, groupId).forEach((id) => { state.groups[id].collapsed = false; });
  }

  // Adds an archive record for a tab that is going away, however it was closed.
  function record(t) {
    const filed = assign.get(t.id);
    const groupId = filed?.groupId || null;
    state.archive = state.archive.filter((a) => !(a.url === t.url && a.groupId === groupId));
    state.archive.unshift({
      id: 'a' + state.counters.nextArchive++,
      url: t.url,
      title: t.title || t.url,
      favIconUrl: (t.favIconUrl || '').startsWith('data:') ? '' : t.favIconUrl || '',
      groupId,
      at: now(),
      ...(filed?.manual ? { manual: true } : {}),
      ...(names.has(t.id) ? { name: names.get(t.id) } : {}),
    });
    state.archive = state.archive.slice(0, ARCHIVE_CAP);
  }

  // Closes tabs, keeping a searchable record of the ones that can be reopened.
  async function archiveTabs(tabs) {
    if (!tabs.length) return;
    const all = await browser.tabs.query({});
    const closing = new Set(tabs.map((t) => t.id));
    // Never close a window by emptying it.
    const windows = new Set(tabs.map((t) => t.windowId));
    for (const windowId of windows) {
      if (!all.some((t) => t.windowId === windowId && !closing.has(t.id))) {
        await browser.tabs.create({ windowId });
      }
    }
    for (const t of tabs) {
      archiving.add(t.id);
      if (isSortable(t)) record(t);
    }
    // Keep the groups alive through the tabs.onRemoved cleanup.
    save();
    await browser.tabs.remove(tabs.map((t) => t.id));
  }

  async function reopen(records, windowId) {
    const ids = new Set(records.map((r) => r.id));
    state.archive = state.archive.filter((a) => !ids.has(a.id));
    let first = true;
    for (const r of records) {
      const tab = await browser.tabs.create({ url: r.url, windowId, active: first });
      first = false;
      if (r.name) setName(tab.id, r.name);
      if (r.groupId && state.groups[r.groupId]) {
        setAssign(tab.id, r.groupId, hostOf(r.url), !!r.manual);
        expand(r.groupId);
      }
    }
  }

  function searchArchive(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const openUrls = new Set([...seen.values()].map((t) => t.url));
    for (const a of state.archive) {
      // A page that is open again would only duplicate the open result.
      if (openUrls.has(a.url)) continue;
      if (!matchesQuery(`${a.name || ''} ${a.title}`, a.url, q)) continue;
      out.push(a);
      if (out.length >= SEARCH_LIMIT) break;
    }
    return out;
  }

  // Auto-tidy: archive tabs nobody has looked at for `archiveDays`.
  async function tidy() {
    if (!state.settings.auto) return;
    const cutoff = now() - state.settings.archiveDays * DAY;
    const tabs = await browser.tabs.query({});
    const stale = tabs.filter((t) => {
      if (t.pinned || t.active || t.audible || !isSortable(t)) return false;
      if ((t.lastAccessed || now()) > cutoff) return false;
      const a = assign.get(t.id);
      return !(a && isHardPinned(state.groups, a.groupId));
    });
    await archiveTabs(stale);
    gc();
    changed();
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

  async function handle(msg) {
    const g = msg.groupId ? state.groups[msg.groupId] : null;
    switch (msg.type) {
      case 'activate':
        await browser.tabs.update(msg.tabId, { active: true });
        break;
      case 'closeTab': {
        const tab = await browser.tabs.get(msg.tabId);
        await archiveTabs([tab]);
        break;
      }
      case 'pinTab':
        await browser.tabs.update(msg.tabId, { pinned: !!msg.pinned });
        // Dropped on a pinned tile: take the place beside it. Pinning moved the
        // tab, so read where it is now.
        if (msg.nearTabId != null) await placeBeside(await browser.tabs.get(msg.tabId), msg.nearTabId, msg.after);
        break;
      case 'newTab':
        await browser.tabs.create({ windowId: msg.windowId, pinned: !!msg.pinned });
        break;
      case 'toggleGroup':
        if (g) g.collapsed = !g.collapsed;
        break;
      case 'showGroup':
        if (g) expand(g.id);
        break;
      case 'pinGroup':
        if (g) g.pinned = !g.pinned;
        break;
      case 'renameGroup': {
        const name = clean(msg.name, 40);
        if (!g || !name) break;
        g.name = name;
        g.manual = true;
        break;
      }
      // An empty name goes back to the page's own title.
      case 'renameTab':
        setName(msg.tabId, clean(msg.name, 80));
        break;
      case 'moveTab': {
        if (!g) break;
        const tab = await browser.tabs.get(msg.tabId);
        setAssign(tab.id, g.id, hostOf(tab.url), true);
        queue.delete(tab.id);
        expand(g.id);
        // Dropped beside another tab: take that place in the tab strip too.
        if (msg.nearTabId != null) await placeBeside(tab, msg.nearTabId, msg.after);
        break;
      }
      // Reordering only, as when a pinned tile is dragged within the pin grid.
      case 'placeTab':
        await placeBeside(await browser.tabs.get(msg.tabId), msg.nearTabId, msg.after);
        break;
      // Drag and drop of a group: beside another group, or into it.
      case 'moveGroup': {
        const target = state.groups[msg.targetId];
        if (!g || !target || g === target) break;
        const into = msg.where === 'into';
        const parentId = into ? target.id : target.parentId || null;
        if (!canNest(state.groups, g.id, parentId)) break;
        const sibs = (childMap(state.groups).get(parentId) || []).filter((s) => s !== g);
        let prev = sibs[sibs.length - 1];
        let next;
        if (!into) {
          const i = sibs.indexOf(target) + (msg.where === 'after' ? 1 : 0);
          prev = sibs[i - 1];
          next = sibs[i];
        }
        g.order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1 : next ? next.order - 1 : 1;
        g.parentId = parentId;
        if (into) expand(target.id);
        break;
      }
      case 'newGroupForTab': {
        const tab = await browser.tabs.get(msg.tabId);
        const res = applyPlan(state.groups, state.counters, {
          newGroups: [{ ref: 'new', name: 'New group', label: 'Custom', parent: null }],
          assignments: [{ tabId: tab.id, group: 'new' }],
        }, new Set([tab.id]));
        state.groups = res.groups;
        state.counters = res.counters;
        state.groups[res.assign[tab.id]].manual = true;
        setAssign(tab.id, res.assign[tab.id], hostOf(tab.url), true);
        queue.delete(tab.id);
        break;
      }
      case 'archiveGroup': {
        if (!g) break;
        const ids = subtree(state.groups, g.id);
        ids.forEach((id) => { state.groups[id].pinned = false; });
        const tabs = await browser.tabs.query({});
        // Pinned tabs stay: they live in the pin grid, not in the group's rows.
        await archiveTabs(tabs.filter((t) => !t.pinned && ids.includes(assign.get(t.id)?.groupId)));
        break;
      }
      case 'reopenGroup': {
        if (!g) break;
        const ids = subtree(state.groups, g.id);
        await reopen(state.archive.filter((a) => ids.includes(a.groupId)).reverse(), msg.windowId);
        break;
      }
      case 'reopenTab': {
        const rec = state.archive.find((a) => a.id === msg.archiveId);
        if (rec) await reopen([rec], msg.windowId);
        break;
      }
      case 'setAuto':
        state.settings.auto = !!msg.auto;
        await browser.storage.local.set({ settings: state.settings });
        if (state.settings.auto) await tidy();
        break;
      case 'resort':
        await resortAll();
        break;
      case 'clearLog':
        state.log = [];
        break;
      default:
        return;
    }
    gc();
    changed();
  }

  // ---- context menu ------------------------------------------------------

  // Groups a tab can be moved to: the ones holding open tabs, in sidebar order.
  function moveTargets(tabId) {
    const current = assign.get(tabId)?.groupId;
    const live = new Set();
    assign.forEach((a) => chain(state.groups, a.groupId).forEach((id) => live.add(id)));
    const kids = childMap(state.groups);
    const out = [];
    const walk = (g) => {
      if (!live.has(g.id)) return;
      if (g.id !== current) out.push({ id: g.id, title: pathName(state.groups, g.id) });
      (kids.get(g.id) || []).forEach(walk);
    };
    (kids.get(null) || []).forEach(walk);
    return out;
  }

  // `tabId` is the tab the browser says the menu was opened on, when it says so.
  async function menuClick(itemId, tabId = menu.tabId) {
    const { groupId, port } = menu;
    const edit = (id) => {
      if (!state.groups[id] || !port) return;
      try { port.postMessage({ type: 'editGroup', groupId: id }); } catch { /* sidebar closed */ }
    };
    const id = String(itemId);
    if (id === MENU.archiveTab) return handle({ type: 'closeTab', tabId });
    if (id === MENU.moveNew) {
      await handle({ type: 'newGroupForTab', tabId });
      return edit(assign.get(tabId)?.groupId);
    }
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
    const stored = await browser.storage.local.get(['groups', 'archive', 'settings', 'counters', 'log']);
    state.groups = stored.groups || {};
    state.archive = stored.archive || [];
    state.log = stored.log || [];
    state.settings = { ...DEFAULTS, ...(stored.settings || {}) };
    state.counters = { ...state.counters, ...(stored.counters || {}) };

    const tabs = await browser.tabs.query({});
    for (const t of tabs) {
      seen.set(t.id, t);
      const v = await browser.sessions.getTabValue(t.id, TAB_KEY).catch(() => null);
      if (v && state.groups[v.groupId]) assign.set(t.id, v);
      const name = await browser.sessions.getTabValue(t.id, NAME_KEY).catch(() => null);
      if (name) names.set(t.id, name);
    }
    gc();

    browser.tabs.onCreated.addListener((tab) => { seen.set(tab.id, tab); consider(tab); push(); });
    browser.tabs.onUpdated.addListener((tabId, change, tab) => {
      seen.set(tabId, tab);
      if (change.url || change.status === 'complete' || change.title) consider(tab);
      push();
    });
    browser.tabs.onRemoved.addListener((tabId) => {
      const tab = seen.get(tabId);
      seen.delete(tabId);
      // Closed by the browser rather than from the sidebar: archived all the same.
      if (!archiving.delete(tabId) && tab && isSortable(tab)) record(tab);
      assign.delete(tabId);
      names.delete(tabId);
      queue.delete(tabId);
      gc();
      changed();
    });
    browser.tabs.onActivated.addListener(({ tabId }) => {
      const a = assign.get(tabId);
      if (a && state.groups[a.groupId]) {
        expand(a.groupId);
        save();
      }
      push();
    });
    browser.tabs.onMoved.addListener(push);
    browser.tabs.onAttached.addListener(push);
    browser.tabs.onDetached.addListener(push);
    browser.tabs.onReplaced.addListener((added, removed) => {
      if (seen.has(removed)) seen.set(added, { ...seen.get(removed), id: added });
      seen.delete(removed);
      const a = assign.get(removed);
      if (a) {
        assign.delete(removed);
        setAssign(added, a.groupId, a.host, a.manual);
      }
      if (names.has(removed)) {
        setName(added, names.get(removed));
        names.delete(removed);
      }
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
          menu = { port, tabId: msg.tabId ?? null, groupId: msg.groupId ?? null };
          return;
        }
        handle(msg).catch(reportError);
      });
      push();
    });
    browser.runtime.onMessage.addListener((msg) => handle(msg).catch(reportError));

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      state.settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      push();
      // Auto-tidy may have just been switched on, or its age shortened.
      tidy().catch(reportError);
    });

    browser.alarms.create('tidy', { periodInMinutes: 30 });
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'tidy') tidy().catch(reportError);
    });

    tabs.forEach(consider);
    await tidy();
  }

  function reportError(e) {
    status.error = (e && e.message) || String(e);
    push();
  }

  return {
    start, handle, snapshot, runClassify, tidy, searchArchive, moveTargets,
    menuClick: (itemId, tabId) => menuClick(itemId, tabId).catch(reportError),
    state, assign, queue,
  };
}
