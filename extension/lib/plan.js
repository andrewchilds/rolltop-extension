// A "plan" is what a classifier returns: new groups, tab assignments and renames.
// The AI classifier and the site-based fallback both produce the same shape,
// and applyPlan is the only code that turns one into group state.
//
// plan = {
//   newGroups:   [{ ref, name, label, parent, site? }]  parent: group id | ref | null
//   assignments: [{ tabId, group }]                      group: group id | ref
//   renames:     [{ groupId, name, label }]
// }
//
// A group with `manual: true` was named by the user; classifier renames skip it.
// One with `manualLabel: true` had its label set by the user; renames keep it.
// Groups above the line (see isHardPinned) are out of a plan's reach: it cannot
// file tabs into them, nest groups in them, rename them or reuse their names.

import { MAX_DEPTH, chain, childMap, isHardPinned } from './model.js';

const CHILD_HUE_STEPS = [25, -25, 50, -50, 75, -75];
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

// Registrable-domain guess without a public-suffix list: good enough to keep
// mail.example.com and docs.example.com together.
export function siteOf(url) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    host = u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const keep = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

export function heuristicPlan(tabs, groups) {
  const bySite = new Map();
  Object.values(groups).forEach((g) => {
    if (g.site && !isHardPinned(groups, g.id)) bySite.set(g.site, g.id);
  });
  const newGroups = [];
  const assignments = [];
  for (const t of tabs) {
    const site = siteOf(t.url);
    if (!site) continue;
    let target = bySite.get(site);
    if (!target) {
      target = 'site:' + site;
      bySite.set(site, target);
      newGroups.push({ ref: target, name: site, label: 'Site', parent: null, site });
    }
    assignments.push({ tabId: t.id, group: target });
  }
  return { newGroups, assignments, renames: [] };
}

export const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// `makeId` names each new group; without one, ids count up from the counters.
export function applyPlan(groups, counters, plan, validTabIds, makeId) {
  const next = {};
  Object.values(groups).forEach((g) => { next[g.id] = { ...g }; });
  const c = { ...counters };
  const refs = new Map();
  const resolve = (x) => (x && next[x] ? (isHardPinned(next, x) ? null : x) : refs.get(x) || null);

  // New groups may name another new group as parent, in any order.
  let pending = (plan.newGroups || []).filter((g) => g && g.ref && clean(g.name, 40));
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    const later = [];
    for (const g of pending) {
      const wantsParent = g.parent != null && g.parent !== '';
      let parentId = wantsParent ? resolve(g.parent) : null;
      if (wantsParent && !parentId && pending.some((p) => p !== g && p.ref === g.parent)) {
        later.push(g);
        continue;
      }
      progressed = true;
      while (parentId && chain(next, parentId).length >= MAX_DEPTH) {
        parentId = next[parentId].parentId || null;
      }
      const name = clean(g.name, 40);
      const twin = Object.values(next).find(
        (x) => (x.parentId || null) === parentId && x.name.toLowerCase() === name.toLowerCase()
          && !isHardPinned(next, x.id),
      );
      if (twin) {
        refs.set(g.ref, twin.id);
        continue;
      }
      const id = makeId ? makeId() : 'g' + c.nextGroup;
      let hue;
      if (parentId) {
        const siblings = Object.values(next).filter((x) => x.parentId === parentId).length;
        hue = next[parentId].hue + CHILD_HUE_STEPS[siblings % CHILD_HUE_STEPS.length];
      } else {
        hue = 255 + c.topLevel * 137.508;
        c.topLevel += 1;
      }
      next[id] = {
        id,
        name,
        label: clean(g.label, 14) || 'Other',
        hue: Math.round(((hue % 360) + 360) % 360),
        parentId,
        order: c.nextGroup,
        pinned: false,
        collapsed: false,
        ...(g.site ? { site: g.site } : {}),
      };
      c.nextGroup += 1;
      refs.set(g.ref, id);
    }
    pending = later;
  }

  for (const r of plan.renames || []) {
    const g = r && next[r.groupId];
    if (!g || g.site || g.manual || isHardPinned(next, g.id)) continue;
    const name = clean(r.name, 40);
    if (name) g.name = name;
    const label = clean(r.label, 14);
    if (label && !g.manualLabel) g.label = label;
  }

  const assign = {};
  for (const a of plan.assignments || []) {
    if (!a || !validTabIds.has(a.tabId)) continue;
    const gid = resolve(a.group);
    if (gid) assign[a.tabId] = gid;
  }

  return { groups: next, counters: c, assign };
}

// Drops groups with nothing left in their subtree. `used` holds every group id
// still referenced by an open tab, an archived tab, or a just-made assignment.
export function gcGroups(groups, used) {
  const kids = childMap(groups);
  const keep = new Set();
  const visit = (id) => {
    let live = used.has(id);
    for (const k of kids.get(id) || []) {
      if (visit(k.id)) live = true;
    }
    if (live) keep.add(id);
    return live;
  };
  (kids.get(null) || []).forEach((g) => visit(g.id));
  const next = {};
  for (const g of Object.values(groups)) {
    if (keep.has(g.id)) next[g.id] = g;
  }
  return next;
}
