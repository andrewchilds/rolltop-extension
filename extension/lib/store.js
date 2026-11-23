// The stored document: every workspace with its groups, tab records and
// archive. It is the only record of where a tab is filed; an open tab carries
// just its record's uid. Nothing here touches browser APIs.
//
// storage.local keys:
//   meta           { version, order: [workspace id], current: workspace id }
//   ws:<id>        { id, name, groups: { id: group }, tabs: [record], counters }
//   archive:<id>   [archived record], newest first
//   log            [sorting run]
//   snap:<day>     a backup of the document, one per day it was in use
//
// record = { uid, url, title, favIconUrl, groupId, favorite,
//            host?, manual?, name?, row?, slot? }
//   host: the site the tab was on when it was filed; manual: filed by the user;
//   name: the user's title for it; row, slot: its place in the favorites grid.

import { chain } from './model.js';

export const STORE_VERSION = 2;
export const BACKUP_FORMAT = 'rolltop-backup';
export const SNAPSHOT_DAYS = 7;
export const SNAP_PREFIX = 'snap:';
// The document as it was before the last restore, so a restore can be undone.
export const SNAP_BEFORE_RESTORE = SNAP_PREFIX + 'before-restore';
// What version 1 kept under `groups`, `archive` and `counters`, left in place
// when the document was first written.
export const LEGACY_KEY = 'legacy-v1';
export const LEGACY_KEYS = ['groups', 'archive', 'counters'];

export const wsKey = (id) => 'ws:' + id;
export const archiveKey = (id) => 'archive:' + id;
export const snapKey = (day) => SNAP_PREFIX + day;

export function dayOf(ms) {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
}

export function newSpace(id, name) {
  return { id, name, groups: {}, tabs: [], counters: { nextGroup: 1, topLevel: 0 } };
}

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const list = (x) => (Array.isArray(x) ? x.filter(isObject) : []);
const text = (x) => (typeof x === 'string' ? x : '');

// Returns the document with every part in the shape the rest of the code
// expects. Stored data may be from an older build or a hand-edited backup, so
// a part that is malformed is repaired or left out rather than trusted, and
// nothing that can be read is dropped: a workspace missing from `order` is
// added to it.
function normalize({ meta, spaces, archives, log }, makeId) {
  const out = { meta: { version: STORE_VERSION, order: [], current: null }, spaces: {}, archives: {}, log: list(log) };
  const wanted = Array.isArray(meta?.order) ? meta.order.filter((id) => typeof id === 'string') : [];
  const given = isObject(spaces) ? spaces : {};
  const ids = [...new Set([...wanted, ...Object.keys(given)])];
  for (const id of ids) {
    const s = given[id];
    if (!isObject(s)) continue;
    const groups = {};
    for (const g of Object.values(isObject(s.groups) ? s.groups : {})) {
      if (isObject(g) && text(g.id) && text(g.name)) groups[g.id] = { label: 'Other', hue: 0, order: 0, ...g, parentId: text(g.parentId) || null };
    }
    const seen = new Set();
    const tabs = list(s.tabs).filter((r) => text(r.uid) && !seen.has(r.uid) && seen.add(r.uid)).map((r) => ({
      ...r, url: text(r.url), title: text(r.title), favIconUrl: text(r.favIconUrl),
      groupId: groups[r.groupId] ? r.groupId : null, favorite: !!r.favorite,
    }));
    out.spaces[id] = {
      id,
      name: text(s.name).trim() || 'Workspace',
      groups,
      tabs,
      counters: { nextGroup: 1, topLevel: 0, ...(isObject(s.counters) ? s.counters : {}) },
    };
    out.archives[id] = list(isObject(archives) ? archives[id] : null)
      .filter((a) => text(a.id) && text(a.url))
      .map((a) => ({ ...a, groupId: text(a.groupId) || null }));
    out.meta.order.push(id);
  }
  if (!out.meta.order.length) {
    const id = makeId('w');
    out.spaces[id] = newSpace(id, 'Home');
    out.archives[id] = [];
    out.meta.order.push(id);
  }
  out.meta.current = out.spaces[meta?.current] ? meta.current : out.meta.order[0];
  return out;
}

// Builds the document from everything storage.local returned. A profile last
// used by version 1 has one flat set of groups and an archive, which become
// the first workspace; `legacy` then says the tabs still carry version 1's
// values. Throws for a document written by a newer build, so that an older
// one never rewrites it.
export function loadStore(stored, makeId) {
  const meta = stored.meta;
  if (isObject(meta) && meta.version > STORE_VERSION) {
    throw new Error('Rolltop\'s saved data is from a newer version of Rolltop.');
  }
  if (isObject(meta)) {
    const spaces = {};
    const archives = {};
    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith('ws:')) spaces[key.slice(3)] = value;
      else if (key.startsWith('archive:')) archives[key.slice(8)] = value;
    }
    return { ...normalize({ meta, spaces, archives, log: stored.log }, makeId), legacy: false };
  }

  const id = makeId('w');
  const groups = isObject(stored.groups) ? stored.groups : {};
  // Pins used to be per group. A pinned sub-group takes its whole top-level
  // group above the line, so nothing it protected starts expiring.
  for (const g of Object.values(groups)) {
    const root = groups[chain(groups, g.id)[0]];
    if (!g.pinned || root === g) continue;
    root.pinned = true;
    g.pinned = false;
  }
  const space = { ...newSpace(id, 'Home'), groups, counters: { nextGroup: 1, topLevel: 0, ...(stored.counters || {}) } };
  delete space.counters.nextArchive;
  const doc = normalize({
    meta: { order: [id], current: id },
    spaces: { [id]: space },
    archives: { [id]: stored.archive },
    log: stored.log,
  }, makeId);
  return { ...doc, legacy: true };
}

// The document as the storage keys that hold it.
export function toKeys(doc) {
  const keys = { meta: doc.meta, log: doc.log };
  for (const id of doc.meta.order) {
    keys[wsKey(id)] = doc.spaces[id];
    keys[archiveKey(id)] = doc.archives[id] || [];
  }
  return keys;
}

export const isDocKey = (key) => key === 'meta' || key === 'log' || key.startsWith('ws:') || key.startsWith('archive:');

// A backup holds every workspace, its tab records and its archive. The
// settings, with the API key, and the sorting log are not in it.
export function backupOf(doc, at) {
  return JSON.parse(JSON.stringify({
    format: BACKUP_FORMAT,
    version: STORE_VERSION,
    exportedAt: at,
    meta: doc.meta,
    spaces: doc.spaces,
    archives: doc.archives,
  }));
}

// Checks a parsed backup and returns its document. Throws with a message fit
// to show the user when the file is not a backup.
export function readBackup(data, makeId) {
  if (!isObject(data) || data.format !== BACKUP_FORMAT) throw new Error('This is not a Rolltop backup.');
  if (!(data.version >= 2)) throw new Error('This backup has no version.');
  if (data.version > STORE_VERSION) throw new Error('This backup was made by a newer version of Rolltop.');
  if (!isObject(data.spaces) || !Object.values(data.spaces).some(isObject)) {
    throw new Error('This backup holds no workspaces.');
  }
  const { meta, spaces, archives } = normalize(JSON.parse(JSON.stringify(data)), makeId);
  return { meta, spaces, archives };
}

export function backupSummary(data) {
  const spaces = Object.values(isObject(data?.spaces) ? data.spaces : {}).filter(isObject);
  return {
    at: data?.exportedAt || 0,
    workspaces: spaces.length,
    tabs: spaces.reduce((n, s) => n + list(s.tabs).length, 0),
  };
}

// The daily snapshot keys that have aged out, given every key in storage.
export function staleSnapshots(keys, keep = SNAPSHOT_DAYS) {
  return keys
    .filter((k) => k.startsWith(SNAP_PREFIX) && k !== SNAP_BEFORE_RESTORE)
    .sort()
    .reverse()
    .slice(keep);
}
