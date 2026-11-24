// Pure view logic shared by the sidebar and the background script.
// Nothing here touches browser APIs, so it runs under `node --test`.

export const DAY = 86400000;
export const UNGROUPED = '__ungrouped';
export const MAX_DEPTH = 3; // levels of group nesting
export const PIN_MAX = 6; // pinned tiles in one row

// Context menu item ids. The background creates the items and handles clicks;
// the sidebar adjusts the group items when its menu opens.
export const MENU = {
  archiveTab: 'rolltop-tab-archive',
  groupTabs: 'rolltop-tab-group',
  move: 'rolltop-move',
  moveNew: 'rolltop-move-new',
  moveSep: 'rolltop-move-sep',
  moveTo: 'rolltop-move:', // + group id
  rename: 'rolltop-group-rename',
  pinGroup: 'rolltop-group-pin',
  toggleGroup: 'rolltop-group-toggle',
  archiveGroup: 'rolltop-group-archive',
};

export function idleDays(tab, now) {
  if (tab.active) return 0;
  const last = tab.lastAccessed || now;
  return Math.max(0, Math.floor((now - last) / DAY));
}

// A tab untouched this many days is folded away behind its group's
// "Show older" row.
export const OLDER_DAYS = 5;

// Tabs fade as they go untouched, on both sides of the line.
export function fadeOf(idle, auto) {
  if (!auto || idle < 2) return 1;
  return idle < OLDER_DAYS ? 0.8 : 0.62;
}

// parentId (or null for top level) -> children in manual order. Built once
// per pass so tree walks stay linear in the number of groups.
export function childMap(groups) {
  const map = new Map();
  for (const g of Object.values(groups)) {
    const key = g.parentId && groups[g.parentId] ? g.parentId : null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(g);
  }
  map.forEach((list) => list.sort((a, b) => a.order - b.order));
  return map;
}

export function subtree(groups, id, map = childMap(groups)) {
  const out = [];
  const seen = new Set();
  const stack = groups[id] ? [id] : [];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    (map.get(cur) || []).forEach((k) => stack.push(k.id));
  }
  return out;
}

// Root-first list of ids ending at `id`.
export function chain(groups, id) {
  const out = [];
  const seen = new Set();
  let cur = groups[id];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur.id);
    cur = cur.parentId ? groups[cur.parentId] : null;
  }
  return out;
}

// Whether group `id`, with everything nested in it, may move under `parentId`
// (null for the top level): not into itself, and within the nesting limit.
export function canNest(groups, id, parentId) {
  if (!groups[id]) return false;
  if (parentId == null) return true;
  if (!groups[parentId]) return false;
  const kids = childMap(groups);
  if (subtree(groups, id, kids).includes(parentId)) return false;
  const height = (gid) => 1 + Math.max(0, ...(kids.get(gid) || []).map((k) => height(k.id)));
  return chain(groups, parentId).length + height(id) <= MAX_DEPTH;
}

// A group lists its own tabs and its sub-groups in one sequence. The sub-groups
// are in manual order. A tab carries the `order` of the sub-group it comes
// after, or none to come before them all; tabs sharing a place keep tab order.
// Which place a tab with `order` takes among `subs`, a group's sub-groups in
// order: 0 is before the first, 1 after it, and so on.
export function slotOf(subs, order) {
  return order == null ? 0 : subs.filter((s) => s.order <= order).length;
}

export function pathName(groups, id) {
  return chain(groups, id).map((x) => groups[x].name).join(' / ');
}

// The list has one line across it. Top-level groups marked `pinned` sit above
// it with everything nested in them: kept by the user, never faded or archived,
// and closed to the classifier. Whether group `id` is above the line.
// What the two sides of the line are called. The grid of pinned tabs above
// them, Favorites, has no heading.
export const SECTIONS = { above: 'Pinned', below: 'Browsing' };

export function isHardPinned(groups, id) {
  return !!groups[chain(groups, id)[0]]?.pinned;
}

// The unread count a page puts in its title, as in "(3) Inbox", "[2] Chat" or
// "Inbox (1,204) - Mail". Returns the count as text and the title without it.
const ALERT_LEAD = /^\s*[([](\d{1,4}\+?)[)\]]\s*/;
const ALERT_MID = /\s*\((\d{1,3}(?:,\d{3})*\+?)\)(?=\s+[-–—|·]\s|\s*$)/;
export function alertOf(title) {
  const text = title || '';
  const m = ALERT_LEAD.exec(text) || ALERT_MID.exec(text);
  if (!m || /^0+$/.test(m[1])) return { count: '', title: text };
  return { count: m[1], title: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() };
}

// What a tab is called: the name the user gave it, else the page's title.
const shown = (t) => t.name || t.title || t.url;
const searchText = (t) => `${t.name || ''} ${t.title || ''}`;

// Splits pinned tiles, in tab order, into the rows of the pin grid. Each tile
// carries the row number it was last laid out in; neighbours sharing one share
// a row. A tile that was never laid out fills a row up to a pair.
export function pinRowsOf(pins) {
  const rows = [];
  for (const p of pins) {
    const last = rows[rows.length - 1];
    const joins = last && last.length < PIN_MAX
      && (p.row == null ? last.length < 2 : last[0].row === p.row);
    if (joins) last.push(p);
    else rows.push([p]);
  }
  return rows;
}

export function monoOf(title) {
  const ch = (title || '').trim().charAt(0);
  return ch ? ch.toUpperCase() : '•';
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// `q` is already trimmed and lowercased.
export function matchesQuery(title, url, q) {
  return (title || '').toLowerCase().includes(q) || hostOf(url).toLowerCase().includes(q);
}

function plural(n) {
  return n + (n === 1 ? ' tab' : ' tabs');
}

// Turns the tabs one window shows, plus their workspace's group tree, into
// flat render lists.
//   archiveCounts: { groupId: number of archived tabs filed directly in it }
//   archiveHits:   archived tabs matching `query`, fetched from the background
//   older:         ids of the groups whose older tabs are being shown
//   ws:            the id of the workspace being shown
//   spaces:        every workspace, as { id, name, groups, archiveCounts }
//   allTabs:       the tabs of every workspace and window, each with its `ws`
// The last two are what a search looks through; without them it looks through
// `tabs` and `groups`.
export function buildView({
  tabs, groups, archiveCounts = {}, archiveHits = [], older = [], auto, query, now,
  ws = null, spaces = null, allTabs = null,
}) {
  const open = [...tabs].sort((a, b) => a.index - b.index);
  const groupOf = (t) => (t.groupId && groups[t.groupId] ? t.groupId : null);
  const hueOf = (gid) => (gid ? groups[gid].hue : null);
  const q = (query || '').trim().toLowerCase();
  const kids = childMap(groups);

  const own = new Map(); // groupId -> its own open tabs, in tab order
  const loose = [];
  for (const t of open) {
    const gid = groupOf(t);
    if (!gid) {
      if (!t.pinned) loose.push(t);
    } else {
      if (!own.has(gid)) own.set(gid, []);
      own.get(gid).push(t);
    }
  }

  // Per-group totals over its whole subtree, each computed once.
  const totals = new Map();
  const total = (id) => {
    if (totals.has(id)) return totals.get(id);
    // `listed` leaves out pinned tabs, which show in the pin grid instead.
    const sum = { count: 0, listed: 0, freshest: Infinity, pinnedTab: false, archived: archiveCounts[id] || 0 };
    totals.set(id, sum);
    for (const t of own.get(id) || []) {
      sum.count += 1;
      sum.freshest = Math.min(sum.freshest, idleDays(t, now));
      if (t.pinned) sum.pinnedTab = true;
      else sum.listed += 1;
    }
    for (const k of kids.get(id) || []) {
      const sub = total(k.id);
      sum.count += sub.count;
      sum.listed += sub.listed;
      sum.freshest = Math.min(sum.freshest, sub.freshest);
      sum.pinnedTab = sum.pinnedTab || sub.pinnedTab;
      sum.archived += sub.archived;
    }
    return sum;
  };

  const pins = open.filter((t) => t.pinned).map((t) => {
    // The count moves from the title to a badge. A tab asking for attention
    // without a count gets a bare badge ('').
    const alert = alertOf(t.title);
    const title = t.name || alert.title || t.url;
    return {
      tabId: t.id,
      title,
      favIconUrl: t.favIconUrl || '',
      mono: monoOf(title),
      hue: hueOf(groupOf(t)),
      current: !!t.active,
      badge: alert.count || (t.attention ? '' : null),
      row: t.pinRow ?? null,
    };
  });

  const rows = [];
  const tabRow = (t, hue, depth) => {
    const idle = idleDays(t, now);
    return {
      kind: 'tab',
      tabId: t.id,
      groupId: groupOf(t),
      title: shown(t),
      favIconUrl: t.favIconUrl || '',
      mono: monoOf(shown(t)),
      hue,
      depth,
      idleLabel: auto && idle >= 2 ? idle + 'd' : '',
      fade: t.active ? 1 : fadeOf(idle, auto),
      current: !!t.active,
    };
  };

  const walk = (g, depth, hard) => {
    const sum = total(g.id);
    // Nothing to list: no open tabs, or all of them are pinned.
    if (!sum.listed) return;
    const soft = !hard && sum.pinnedTab;
    const isOpen = !g.collapsed;
    rows.push({
      kind: 'group',
      id: g.id,
      name: g.name,
      hue: g.hue,
      count: sum.count,
      depth,
      top: depth === 0 && rows.length > 0,
      hard,
      fade: hard || soft ? 1 : fadeOf(sum.freshest, auto),
      open: isOpen,
    });
    if (!isOpen) return;
    // Tabs left alone for OLDER_DAYS are folded behind a row that shows them.
    const mine = (own.get(g.id) || []).filter((t) => !t.pinned);
    const old = auto ? mine.filter((t) => idleDays(t, now) >= OLDER_DAYS) : [];
    const showing = older.includes(g.id);
    // Own tabs and sub-groups share one sequence (see slotOf). The row for the
    // older tabs closes the tabs that come before every sub-group.
    const subs = kids.get(g.id) || [];
    const slots = subs.map(() => []);
    slots.push([]);
    mine.filter((t) => showing || !old.includes(t)).forEach((t) => slots[slotOf(subs, t.order)].push(t));
    slots.forEach((list, i) => {
      list.forEach((t) => rows.push(tabRow(t, g.hue, depth)));
      if (i === 0 && old.length) rows.push({ kind: 'older', groupId: g.id, count: old.length, open: showing, depth });
      if (subs[i]) walk(subs[i], depth + 1, hard);
    });
  };
  const roots = kids.get(null) || [];
  roots.filter((g) => g.pinned).forEach((g) => walk(g, 0, true));
  const above = rows.length;
  roots.filter((g) => !g.pinned).forEach((g) => walk(g, 0, false));
  // Each side of the line is headed by its name when it has rows. The line
  // itself is drawn only with something above it.
  if (rows.length > above || loose.length) {
    rows.splice(above, 0, { kind: 'section', id: 'below', name: SECTIONS.below, line: above > 0 });
  }
  if (above) rows.unshift({ kind: 'section', id: 'above', name: SECTIONS.above });

  if (loose.length) {
    rows.push({
      kind: 'group',
      id: UNGROUPED,
      neutral: true,
      name: 'Ungrouped',
      sorting: loose.some((t) => t.pending),
      hue: null,
      count: loose.length,
      depth: 0,
      top: rows.length > 0,
      hard: false,
      fade: 1,
      open: true,
    });
    loose.forEach((t) => rows.push(tabRow(t, null, 0)));
  }

  // Search looks in every workspace and every window, not only what is listed.
  let groupResults = [];
  let tabResults = [];
  if (q) {
    const everywhere = spaces || [{ id: ws, name: '', groups, archiveCounts }];
    const pool = allTabs || tabs;
    // Results from another workspace say which.
    const where = (s) => (s.id !== ws && s.name ? s.name + ' · ' : '');
    for (const s of everywhere) {
      // A tab with no workspace of its own (a private one) counts as being here.
      const mine = pool.filter((t) => (t.ws ?? ws) === s.id).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
      const filed = (t) => (t.groupId && s.groups[t.groupId] ? t.groupId : null);
      const below = childMap(s.groups);
      const count = (id) => {
        const sum = { live: mine.filter((t) => !t.pinned && filed(t) === id).length, stored: (s.archiveCounts || {})[id] || 0 };
        for (const k of below.get(id) || []) {
          const sub = count(k.id);
          sum.live += sub.live;
          sum.stored += sub.stored;
        }
        return sum;
      };
      for (const g of Object.values(s.groups).sort((a, b) => a.order - b.order)) {
        if (!g.name.toLowerCase().includes(q) && !g.label.toLowerCase().includes(q)) continue;
        const { live, stored } = count(g.id);
        if (!live && !stored) continue;
        groupResults.push({
          id: g.id,
          name: pathName(s.groups, g.id),
          label: g.label,
          hue: g.hue,
          gone: !live,
          sub: where(s) + (live ? plural(live) : 'Archived, ' + plural(stored)),
          actLabel: live ? 'Show' : 'Reopen',
        });
      }
      for (const t of mine) {
        if (!matchesQuery(searchText(t), t.url, q)) continue;
        tabResults.push({
          tabId: t.id,
          title: shown(t),
          favIconUrl: t.favIconUrl || '',
          mono: monoOf(shown(t)),
          hue: filed(t) ? s.groups[filed(t)].hue : null,
          tag: where(s) + (filed(t) ? s.groups[filed(t)].name : 'Ungrouped'),
        });
      }
    }
    for (const a of archiveHits) {
      const s = everywhere.find((x) => x.id === a.ws) || everywhere.find((x) => x.id === ws) || everywhere[0];
      tabResults.push({
        archiveId: a.id,
        title: shown(a),
        favIconUrl: a.favIconUrl || '',
        mono: monoOf(shown(a)),
        hue: a.groupId && s.groups[a.groupId] ? s.groups[a.groupId].hue : null,
        tag: where(s) + 'Archived',
      });
    }
  }

  return {
    pins,
    pinRows: pinRowsOf(pins),
    rows,
    searching: !!q,
    groupResults,
    tabResults,
    noResults: !!q && !groupResults.length && !tabResults.length,
  };
}
