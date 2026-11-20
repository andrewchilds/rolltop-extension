// Pure view logic shared by the sidebar and the background script.
// Nothing here touches browser APIs, so it runs under `node --test`.

export const DAY = 86400000;
export const UNGROUPED = '__ungrouped';
export const MAX_DEPTH = 3; // levels of group nesting

// Context menu item ids. The background creates the items and handles clicks;
// the sidebar adjusts the group items when its menu opens.
export const MENU = {
  archiveTab: 'tidy-tab-archive',
  move: 'tidy-move',
  moveNew: 'tidy-move-new',
  moveSep: 'tidy-move-sep',
  moveTo: 'tidy-move:', // + group id
  rename: 'tidy-group-rename',
  pinGroup: 'tidy-group-pin',
  toggleGroup: 'tidy-group-toggle',
  archiveGroup: 'tidy-group-archive',
};

export function idleDays(tab, now) {
  if (tab.active) return 0;
  const last = tab.lastAccessed || now;
  return Math.max(0, Math.floor((now - last) / DAY));
}

// Tabs fade as they go untouched; pinned things never fade.
export function fadeOf(idle, auto) {
  if (!auto || idle < 2) return 1;
  return idle < 5 ? 0.8 : 0.62;
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

export function pathName(groups, id) {
  return chain(groups, id).map((x) => groups[x].name).join(' / ');
}

// A group's pin covers its own tabs only; sub-groups are pinned separately.
export function isHardPinned(groups, id) {
  return !!groups[id]?.pinned;
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

// Turns one window's tabs plus the shared group tree into flat render lists.
//   archiveCounts: { groupId: number of archived tabs filed directly in it }
//   archiveHits:   archived tabs matching `query`, fetched from the background
export function buildView({ tabs, groups, archiveCounts = {}, archiveHits = [], auto, query, now }) {
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
    };
  });

  const rows = [];
  const tabRow = (t, hue, depth, hard) => {
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
      idleLabel: auto && idle >= 2 && !hard ? idle + 'd' : '',
      fade: hard || t.active ? 1 : fadeOf(idle, auto),
      current: !!t.active,
    };
  };

  const walk = (g, depth) => {
    const sum = total(g.id);
    // Nothing to list: no open tabs, or all of them are pinned.
    if (!sum.listed) return;
    const hard = !!g.pinned;
    const soft = !hard && sum.pinnedTab;
    const isOpen = !g.collapsed;
    rows.push({
      kind: 'group',
      id: g.id,
      name: g.name,
      label: g.label,
      hue: g.hue,
      count: sum.count,
      depth,
      top: depth === 0 && rows.length > 0,
      hard,
      kept: hard || soft,
      fade: hard || soft ? 1 : fadeOf(sum.freshest, auto),
      open: isOpen,
      pinLabel: hard ? 'Unpin group' : soft ? 'Kept by a pinned tab. Pin group' : 'Pin group',
    });
    if (!isOpen) return;
    (own.get(g.id) || []).filter((t) => !t.pinned)
      .forEach((t) => rows.push(tabRow(t, g.hue, depth, hard)));
    (kids.get(g.id) || []).forEach((k) => walk(k, depth + 1));
  };
  (kids.get(null) || []).forEach((g) => walk(g, 0));

  if (loose.length) {
    rows.push({
      kind: 'group',
      id: UNGROUPED,
      neutral: true,
      name: 'Ungrouped',
      label: loose.some((t) => t.pending) ? 'Sorting' : 'Other',
      hue: null,
      count: loose.length,
      depth: 0,
      top: rows.length > 0,
      hard: false,
      kept: false,
      fade: 1,
      open: true,
      pinLabel: '',
    });
    loose.forEach((t) => rows.push(tabRow(t, null, 0, false)));
  }

  let groupResults = [];
  let tabResults = [];
  if (q) {
    groupResults = Object.values(groups)
      .filter((g) => g.name.toLowerCase().includes(q) || g.label.toLowerCase().includes(q))
      .sort((a, b) => a.order - b.order)
      .map((g) => {
        const { listed: live, archived: stored } = total(g.id);
        if (!live && !stored) return null;
        return {
          id: g.id,
          name: pathName(groups, g.id),
          label: g.label,
          hue: g.hue,
          gone: !live,
          sub: live ? plural(live) : 'Archived, ' + plural(stored),
          actLabel: live ? 'Show' : 'Reopen',
        };
      })
      .filter(Boolean);

    tabResults = [
      ...open.filter((t) => matchesQuery(searchText(t), t.url, q)).map((t) => ({
        tabId: t.id,
        title: shown(t),
        favIconUrl: t.favIconUrl || '',
        mono: monoOf(shown(t)),
        hue: hueOf(groupOf(t)),
        tag: groupOf(t) ? groups[groupOf(t)].name : 'Ungrouped',
      })),
      ...archiveHits.map((a) => ({
        archiveId: a.id,
        title: shown(a),
        favIconUrl: a.favIconUrl || '',
        mono: monoOf(shown(a)),
        hue: a.groupId && groups[a.groupId] ? groups[a.groupId].hue : null,
        tag: 'Archived',
      })),
    ];
  }

  return {
    pins,
    rows,
    searching: !!q,
    groupResults,
    tabResults,
    noResults: !!q && !groupResults.length && !tabResults.length,
  };
}
