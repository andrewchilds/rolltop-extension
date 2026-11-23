// A workspace file holds the open tabs and the groups they are filed in.
// Exporting one and importing it elsewhere moves a workspace between browsers.
// The archive and the settings stay behind. Nothing here touches browser APIs;
// the background script does the reading and opening.
//
// {
//   format: 'rolltop-workspace', version: 1, exportedAt,
//   groups:   [group]                       as stored, ids local to the file
//   tabs:     [{ url, title, groupId, pinned, pinRow?, name?, manual? }]  in tab order
// }

import { MAX_DEPTH, chain } from './model.js';
import { clean } from './plan.js';

export const FORMAT = 'rolltop-workspace';
export const VERSION = 1;

const isWeb = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);
const records = (x) => (Array.isArray(x) ? x.filter((v) => v && typeof v === 'object') : []);
const idOf = (x) => (typeof x === 'string' && x ? x : null);

// Checks a parsed file and returns it with every field in the shape the rest
// of the code expects. The file may have been edited by hand or come from
// someone else, so nothing in it is taken on trust. Throws with a message fit
// to show the user when the file is not a workspace at all.
export function readWorkspace(data) {
  if (!data || typeof data !== 'object' || data.format !== FORMAT) {
    throw new Error('This is not a Rolltop workspace file.');
  }
  if (!(data.version >= 1)) throw new Error('This workspace file has no version.');
  if (data.version > VERSION) {
    throw new Error('This workspace file was made by a newer version of Rolltop.');
  }

  const groups = records(data.groups)
    .filter((g) => idOf(g.id) && clean(g.name, 40))
    .map((g) => ({
      id: g.id,
      name: clean(g.name, 40),
      label: clean(g.label, 14) || 'Other',
      hue: Number.isFinite(g.hue) ? Math.round(((g.hue % 360) + 360) % 360) : 0,
      parentId: idOf(g.parentId),
      order: Number.isFinite(g.order) ? g.order : 0,
      pinned: !!g.pinned,
      collapsed: !!g.collapsed,
      ...(clean(g.site, 100) ? { site: clean(g.site, 100) } : {}),
      ...(g.manual ? { manual: true } : {}),
      ...(g.manualLabel ? { manualLabel: true } : {}),
    }));

  const tabs = records(data.tabs)
    .filter((t) => isWeb(t.url))
    .map((t) => ({
      url: t.url,
      title: String(t.title || '').slice(0, 300),
      groupId: idOf(t.groupId),
      pinned: !!t.pinned,
      pinRow: t.pinned && Number.isInteger(t.pinRow) && t.pinRow >= 0 ? t.pinRow : null,
      ...(clean(t.name, 80) ? { name: clean(t.name, 80) } : {}),
      ...(t.manual ? { manual: true } : {}),
    }));

  return { groups, tabs };
}

// Adds a file's groups to the groups already here. Each gets a fresh id; `ids`
// maps the file's ids to them. A group that matches one already here (same
// name, same parent, same side of the line) is merged into it, so importing
// into a workspace that has "Read later" does not make a second one, and
// importing the same file twice adds nothing. New groups go after the existing
// ones, keeping the order they had among themselves. `makeId` names each new
// group; without one, ids count up from the counters.
export function mergeGroups(groups, counters, incoming, makeId) {
  const next = {};
  Object.values(groups).forEach((g) => { next[g.id] = { ...g }; });
  const c = { ...counters };
  const ids = new Map();
  const byId = new Map(incoming.map((g) => [g.id, g]));
  const created = [];

  // `trail` holds the groups being placed further down the stack. A parent
  // found there is a loop in the file: the group goes to the top level.
  const place = (g, trail) => {
    if (ids.has(g.id)) return ids.get(g.id);
    const parent = g.parentId !== g.id && !trail.has(g.parentId) ? byId.get(g.parentId) : null;
    let parentId = parent ? place(parent, new Set(trail).add(g.id)) : null;
    while (parentId && chain(next, parentId).length >= MAX_DEPTH) {
      parentId = next[parentId].parentId || null;
    }
    // Only a top-level group can be pinned; nested ones follow their root.
    const pinned = !parentId && g.pinned;
    const twin = Object.values(next).find(
      (x) => (x.parentId || null) === parentId
        && x.name.toLowerCase() === g.name.toLowerCase()
        && (parentId || !!x.pinned === pinned),
    );
    if (twin) {
      ids.set(g.id, twin.id);
      return twin.id;
    }
    const id = makeId ? makeId() : 'g' + c.nextGroup;
    c.nextGroup += 1;
    if (!parentId) c.topLevel += 1;
    next[id] = { ...g, id, parentId, pinned };
    created.push([g.order, id]);
    ids.set(g.id, id);
    return id;
  };
  incoming.forEach((g) => place(g, new Set()));

  let order = Math.max(0, ...Object.values(groups).map((g) => g.order || 0));
  created.sort((a, b) => a[0] - b[0]).forEach(([, id]) => { next[id].order = ++order; });

  return { groups: next, counters: c, ids, added: created.length };
}
