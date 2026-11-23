import { buildView, canNest, MENU, PIN_MAX, UNGROUPED } from '../lib/model.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const ICONS = {
  chevron: { size: 11, box: 12, width: 1.5, paths: ['M4.5 2.5L8 6l-3.5 3.5'] },
  close: { size: 12, box: 12, width: 1.5, paths: ['M3 3l6 6M9 3l-6 6'] },
  more: { size: 14, box: 16, width: 2.2, paths: ['M3.5 8h.01M8 8h.01M12.5 8h.01'] },
};

function icon(name, { filled = false, cls = '' } = {}) {
  const def = ICONS[name];
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', def.size);
  svg.setAttribute('height', def.size);
  svg.setAttribute('viewBox', `0 0 ${def.box} ${def.box}`);
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', def.width);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (cls) svg.setAttribute('class', cls);
  for (const d of def.paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'data') Object.assign(node.dataset, value);
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

const hueClass = (hue) => (hue == null ? 'neutral' : 'hued');
const hueStyle = (hue) => (hue == null ? '' : `--h:${hue};`);

// Favicon on the group's tint; falls back to the title's first letter.
function tile(item, big) {
  const node = el('span', { class: 'tile' + (big ? ' big' : ''), 'aria-hidden': 'true' });
  if (/^(https?|data):/.test(item.favIconUrl)) {
    const img = el('img', { src: item.favIconUrl, alt: '' });
    img.addEventListener('error', () => { node.textContent = item.mono; });
    node.append(img);
  } else {
    node.textContent = item.mono;
  }
  return node;
}

const actBtn = (act, label, data, child, extra = {}) =>
  el('button', { type: 'button', class: 'act', 'aria-label': label, title: label, data: { act, ...data }, ...extra }, child);

function pinNode(p) {
  const renaming = editingTab === p.tabId;
  return el('div', {
    class: `pin ${hueClass(p.hue)}${p.current ? ' current' : ''}${renaming ? ' editing' : ''}`,
    style: hueStyle(p.hue), title: renaming ? null : p.title,
    data: { ctxTab: p.tabId },
    draggable: renaming ? null : 'true',
  },
    // Inert while renaming, like a group row.
    renaming
      ? el('div', { class: 'pin-main' }, tile(p, true), renameInput(p.title, 'Tab name', 80))
      : el('div', {
        class: 'pin-main', role: 'button', tabindex: '0',
        'aria-label': p.badge == null ? p.title : `${p.title}, ${p.badge || 'new'} alerts`,
        'aria-current': p.current ? 'page' : null, data: { act: 'activate', tab: p.tabId },
      }, tile(p, true), el('span', { class: 'pin-title' }, p.title)),
    p.badge == null ? null : el('span', { class: 'badge' + (p.badge ? '' : ' dot'), 'aria-hidden': 'true' }, p.badge),
    renaming ? null : actBtn('tabMenu', 'Tab actions', { tab: p.tabId, fav: '1' }, icon('more'), { 'aria-haspopup': 'menu' }),
  );
}

function groupNode(r) {
  const fixed = r.id === UNGROUPED;
  const renaming = editing === r.id;
  const busy = renaming;
  // Only the arrow opens and closes the group; the rest of the row is left
  // for dragging and for double-clicking to rename. Not a <button>: Firefox
  // does not start a drag from inside one. Inert while renaming.
  const twist = fixed ? null : el('span', {
    class: 'twist',
    ...(busy ? {} : {
      role: 'button', tabindex: '0',
      'aria-label': `${r.open ? 'Collapse' : 'Expand'} ${r.name}`, 'aria-expanded': String(r.open),
      data: { act: 'toggleGroup', group: r.id },
    }),
  }, icon('chevron', { cls: 'chev' }));
  const parts = [
    twist,
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    renaming ? renameInput(r.name, 'Group name', 40) : el('span', { class: 'gname' }, r.name),
    r.sorting ? el('span', { class: 'chip' }, 'Sorting') : null,
  ];
  return el('div', {
    class: `row group ${hueClass(r.hue)}${r.open ? ' open' : ''}${r.top ? ' top' : ''}${fixed ? ' static' : ''}${busy ? ' editing' : ''}`,
    style: `${hueStyle(r.hue)}padding-left:${r.depth * 14}px;opacity:${busy ? 1 : r.fade}`,
    data: fixed ? {} : { ctxGroup: r.id },
    draggable: fixed || busy ? null : 'true',
  },
    el('div', { class: 'row-main', title: busy ? null : r.name }, ...parts),
    el('div', { class: 'acts' },
      fixed ? null : actBtn('groupMenu', 'Group actions', { group: r.id }, icon('more'), { 'aria-haspopup': 'menu' }),
    ),
  );
}

function tabNode(r) {
  const renaming = editingTab === r.tabId;
  const indent = `padding-left:${22 + r.depth * 14}px`;
  return el('div', {
    class: `row tab ${hueClass(r.hue)}${r.current ? ' current' : ''}${renaming ? ' editing' : ''}`,
    style: `${hueStyle(r.hue)}opacity:${renaming ? 1 : r.fade}`,
    title: renaming ? null : r.title,
    data: { ctxTab: r.tabId, ...(r.groupId ? { ctxIn: r.groupId } : {}) },
    draggable: renaming ? null : 'true',
  },
    renaming
      ? el('div', { class: 'row-main', style: indent }, tile(r), renameInput(r.title, 'Tab name', 80))
      : el('div', {
        class: 'row-main', role: 'button', tabindex: '0', style: indent,
        'aria-current': r.current ? 'page' : null, data: { act: 'activate', tab: r.tabId },
      }, tile(r), el('span', { class: 'ttitle' }, r.title)),
    r.idleLabel ? el('span', { class: 'meta' }, r.idleLabel) : null,
    // Laid over the end of the title while the row is hovered or focused.
    el('div', { class: 'acts' },
      actBtn('tabMenu', 'Tab actions', { tab: r.tabId }, icon('more'), { 'aria-haspopup': 'menu' }),
      actBtn('closeTab', 'Close tab', { tab: r.tabId }, icon('close')),
    ),
  );
}

function resultsNodes(view) {
  const out = [];
  if (view.groupResults.length) {
    out.push(el('div', { class: 'res-section' },
      el('span', { class: 'res-head' }, 'Groups'),
      ...view.groupResults.map((g) => el('div', { class: `res-group ${hueClass(g.hue)}`, style: hueStyle(g.hue) },
        el('div', { class: 'res-text' },
          el('div', { class: 'res-line' },
            el('span', { class: 'dot', 'aria-hidden': 'true' }),
            el('span', { class: 'gname' }, g.name),
            el('span', { class: 'chip' }, g.label),
          ),
          el('span', { class: 'res-sub' }, g.sub),
        ),
        el('button', { type: 'button', class: 'res-act', data: { act: g.gone ? 'reopenGroup' : 'showGroup', group: g.id } }, g.actLabel),
      )),
    ));
  }
  if (view.tabResults.length) {
    out.push(el('div', { class: 'res-section' },
      el('span', { class: 'res-head' }, 'Tabs'),
      ...view.tabResults.map((t) => el('button', {
        type: 'button', class: `res-tab ${hueClass(t.hue)}`, style: hueStyle(t.hue), title: t.title,
        data: t.archiveId ? { act: 'reopenTab', archive: t.archiveId } : { act: 'activate', tab: t.tabId, ctxTab: t.tabId },
      }, tile(t), el('span', { class: 'ttitle' }, t.title), el('span', { class: 'res-tag' }, t.tag))),
    ));
  }
  if (view.noResults) out.push(el('p', { class: 'empty' }, 'No tabs or groups match, open or archived.'));
  return out;
}

// ---- state and wiring ----------------------------------------------------

let snap = null;
let here = null; // the workspace this window shows: { id, name, groups, archiveCounts }
let windowId = null;
let port = null;
let query = '';
let hits = { query: '', tabs: [] }; // archived tabs matching a query, from the background
let editing = null; // id of the group being renamed in its row
const older = new Set(); // ids of the groups whose older tabs are being shown
let editingTab = null; // id of the tab being renamed in its row or pinned tile
let editingWs = null; // id of the workspace being renamed in the footer
let menuTarget = null; // what this sidebar's open context menu was opened on
let drag = null; // what is being dragged: { tabId }, { groupId } or { pinId } for a pinned tile
let marked = null; // the drop target currently highlighted
let gap = null; // the drop zone open in the pin grid: { spot, zone, node }
let pinLayout = ''; // the pin grid's rows of tab ids as last rendered, as JSON

function renameInput(value, label, maxlength) {
  const input = el('input', {
    type: 'text', class: 'rename', value, maxlength,
    'aria-label': label, autocomplete: 'off', spellcheck: 'false',
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finishRename(input, true);
    else if (event.key === 'Escape') finishRename(input, false);
  });
  input.addEventListener('blur', () => finishRename(input, true));
  return input;
}

function finishRename(input, commit) {
  if (editing == null && editingTab == null) return;
  const groupId = editing;
  const tabId = editingTab;
  editing = null;
  editingTab = null;
  const name = input.value.trim();
  if (commit && name !== input.defaultValue) {
    // Shown at once; the next snapshot confirms it.
    if (tabId != null) {
      const tab = snap.tabs.find((t) => t.id === tabId);
      if (tab) tab.name = name;
      send('renameTab', { tabId, name }); // an empty name restores the page's title
    } else if (name && snap.groups[groupId]) {
      snap.groups[groupId].name = name;
      send('renameGroup', { groupId, name });
    }
  }
  render();
}

// The footer's workspace button: its name, and a menu to switch, add, rename
// and merge workspaces. While renaming it is a field instead.
let spaceSig = null;
function renderSpace() {
  const renaming = editingWs === here.id;
  const sig = JSON.stringify([here.id, here.name, renaming]);
  if (sig === spaceSig) return;
  spaceSig = sig;
  hideMenu();
  if (!renaming) {
    $('space').replaceChildren(el('button', {
      type: 'button', class: 'space-btn', title: 'Workspaces', 'aria-haspopup': 'menu', data: { act: 'spaceMenu' },
    }, el('span', { class: 'space-name' }, here.name), icon('chevron', { cls: 'chev' })));
    return;
  }
  const input = el('input', {
    type: 'text', class: 'rename', value: here.name, maxlength: 30,
    'aria-label': 'Workspace name', autocomplete: 'off', spellcheck: 'false',
  });
  const finish = (commit) => {
    if (editingWs == null) return;
    const wsId = editingWs;
    editingWs = null;
    const name = input.value.trim();
    if (commit && name && name !== input.defaultValue) {
      // Shown at once; the next snapshot confirms it.
      const space = snap.spaces.find((s) => s.id === wsId);
      if (space) space.name = name;
      send('renameWorkspace', { wsId, name });
    }
    render();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  $('space').replaceChildren(input);
  window.focus();
  input.focus();
  input.select();
}

const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const SLIDE_MS = 200; // matches the row animations in sidebar.css
let listSig = null; // what the list last rendered, to leave it alone when nothing changed
let pinsSig = null; // the same for the pin grid

// Rebuilds the list. Rows that are new slide open and rows that went away
// slide shut in place, which is what opening and closing a group looks like.
function renderList(rows) {
  hideMenu(); // its button may be about to be replaced
  const list = $('list');
  const scroll = list.scrollTop;
  const animate = motion && list.childElementCount > 0;
  const old = new Map();
  for (const node of list.children) {
    if (node.dataset.key) old.set(node.dataset.key, node);
  }
  const fresh = new Map();
  const turned = []; // group rows whose chevron should rotate rather than jump
  const nodes = rows.map((r) => {
    const group = r.kind === 'group';
    const section = r.kind === 'section';
    const fold = r.kind === 'older';
    const node = section ? el('div', { class: 'section' + (r.line ? ' line' : '') }, r.name)
      : fold ? el('button', {
        type: 'button', class: 'older', style: `margin-left:${22 + r.depth * 14}px`, 'aria-expanded': String(r.open),
        data: { act: 'toggleOlder', group: r.groupId },
      }, r.open ? 'Hide older' : `Show ${r.count} older`)
        : group ? groupNode(r) : tabNode(r);
    const key = section ? 's:' + r.id : fold ? 'o:' + r.groupId : group ? 'g:' + r.id : 't:' + r.tabId;
    node.dataset.key = key;
    const was = old.get(key);
    if (animate && !was) node.classList.add('enter');
    if (animate && was && group && was.classList.contains('open') !== r.open) turned.push(node);
    fresh.set(key, node);
    return node;
  });
  if (animate) {
    let at = -1; // index of the last surviving row seen, where leavers are kept
    for (const node of [...list.children]) {
      const key = node.dataset.key;
      if (!key) continue; // already on its way out
      if (fresh.has(key)) {
        at = nodes.indexOf(fresh.get(key));
        continue;
      }
      delete node.dataset.key;
      node.removeAttribute('draggable');
      node.classList.remove('enter');
      node.classList.add('exit');
      node.addEventListener('animationend', () => node.remove());
      nodes.splice(++at, 0, node);
    }
  }
  list.replaceChildren(...nodes);
  list.scrollTop = scroll;
  // The rows are new nodes, so a CSS transition has nothing to start from.
  for (const node of turned) {
    const angles = node.classList.contains('open') ? [0, 90] : [90, 0];
    node.querySelector('.chev').animate(
      angles.map((deg) => ({ transform: `rotate(${deg}deg)` })),
      { duration: SLIDE_MS, easing: 'ease-in-out' },
    );
  }
}

function render() {
  if (!snap || windowId == null) return;
  const view = buildView({
    // A private tab belongs to no workspace and shows in whichever is open.
    tabs: snap.tabs.filter((t) => t.windowId === windowId && (t.ws == null || t.ws === here.id)),
    groups: snap.groups,
    archiveCounts: snap.archiveCounts,
    ws: here.id,
    spaces: snap.spaces,
    allTabs: snap.tabs,
    archiveHits: hits.query === query ? hits.tabs : [],
    older: [...older],
    auto: snap.auto,
    query,
    now: Date.now(),
  });

  $('browse').hidden = view.searching;
  $('results').hidden = !view.searching;
  if (view.searching) {
    $('results').replaceChildren(...resultsNodes(view));
  } else {
    // The tab being renamed may have closed before its field was built.
    if (editingTab != null && !snap.tabs.some((t) => t.id === editingTab)) editingTab = null;
    // A drag keeps everything in place: its source has to stay in the document.
    // So does a rename in progress: rebuilding would drop what was typed.
    const renaming = editing != null || editingTab != null;
    if (!drag && !(renaming && $('browse').querySelector('.rename'))) {
      $('pins').hidden = !view.pins.length;
      // Left alone when unchanged, like the list: a double-click's first click
      // re-renders, and its target has to still be in the document.
      const pinSig = JSON.stringify([view.pinRows, editingTab]);
      if (pinSig !== pinsSig) {
        pinsSig = pinSig;
        hideMenu();
        pinLayout = JSON.stringify(view.pinRows.map((row) => row.map((p) => p.tabId)));
        $('pins').replaceChildren(...view.pinRows.map((row) => el('div', { class: 'pin-row' }, ...row.map(pinNode))));
      }
      const sig = JSON.stringify([view.rows, editing, editingTab]);
      if (sig !== listSig) {
        listSig = sig;
        renderList(view.rows);
      }
      const input = $('browse').querySelector('.rename');
      if (input) {
        window.focus();
        input.focus();
        input.select();
      }
    }
  }

  renderSpace();
  $('notice').hidden = !snap.error;
  $('notice').textContent = snap.error || '';
}

function send(type, extra = {}) {
  port.postMessage({ type, windowId, ...extra });
}

function clearSearch() {
  query = '';
  hits = { query: '', tabs: [] };
  $('q').value = '';
}

function searchArchive() {
  if (query.trim()) send('search', { query });
}

// ---- action menus ----------------------------------------------------------
// The ellipsis on a group row, a tab row or a pinned tile opens a small menu
// of that row's actions. A group's matches its right-click menu.

let menu = null; // the menu element, made on first use
let menuFor = null; // the button it is open for

function menuItems(button) {
  const { act, group, tab, fav } = button.dataset;
  const others = snap.spaces.filter((s) => s.id !== here.id);
  if (act === 'spaceMenu') {
    const at = snap.spaces.indexOf(here);
    const next = snap.spaces[at + 1] || snap.spaces[at - 1];
    const item = (name, text, ws) => el('button', { type: 'button', role: 'menuitem', data: { act: name, ws } }, text);
    return ['Workspaces', [
      ...snap.spaces.map((s) => el('button', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(s === here), data: { act: 'switchWorkspace', ws: s.id },
      }, s.name)),
      el('hr'),
      item('newWorkspace', 'New workspace'),
      item('renameWorkspace', 'Rename', here.id),
      // Nothing is closed: its tabs, groups and archive join the next workspace.
      next ? item('deleteWorkspace', `Merge into ${next.name}`, here.id) : null,
    ]];
  }
  const moves = (name, data) => others.map((s) => el('button', {
    type: 'button', role: 'menuitem', data: { act: name, ws: s.id, ...data },
  }, `Move to ${s.name}`));
  if (group) {
    const g = snap.groups[group];
    if (!g) return null;
    const item = (act, text) => el('button', { type: 'button', role: 'menuitem', data: { act, group: g.id } }, text);
    return ['Group actions', [
      item('renameGroup', 'Rename'),
      // Only a top-level group can be pinned; what is nested in it goes with it.
      g.parentId && snap.groups[g.parentId] ? null : item('pinGroup', g.pinned ? 'Unpin group' : 'Pin group'),
      item('toggleGroup', g.collapsed ? 'Expand' : 'Collapse'),
      item('archiveGroup', 'Archive group'),
      ...moves('moveGroupWs', { group: g.id }),
    ]];
  }
  const item = (act, text) => el('button', { type: 'button', role: 'menuitem', data: { act, tab } }, text);
  return ['Tab actions', [
    fav ? item('unpinTab', 'Remove from Favorites') : item('pinTab', 'Add to Favorites'),
    item('renameTab', 'Rename'),
    item('closeTab', 'Close tab'),
    ...moves('moveTabWs', { tab }),
  ]];
}

function showMenu(button) {
  const made = menuItems(button);
  if (!made) return;
  if (!menu) {
    menu = el('div', { class: 'menu', role: 'menu' });
    document.body.append(menu);
  }
  menu.setAttribute('aria-label', made[0]);
  menu.replaceChildren(...made[1].filter(Boolean));
  menu.hidden = false;
  menuFor = button;
  button.setAttribute('aria-expanded', 'true');
  // Under the button, or above it when there is no room below.
  const rect = button.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = menu;
  const below = rect.bottom + 4;
  menu.style.top = (below + height > innerHeight - 4 && rect.top - 4 - height >= 4 ? rect.top - 4 - height : below) + 'px';
  menu.style.left = Math.max(4, Math.min(rect.right - width, innerWidth - width - 4)) + 'px';
  menu.querySelector('button').focus();
}

function hideMenu() {
  if (!menuFor) return;
  menu.hidden = true;
  menuFor.removeAttribute('aria-expanded');
  menuFor = null;
}

$('list').addEventListener('scroll', hideMenu);
addEventListener('resize', hideMenu);
addEventListener('blur', hideMenu);
document.addEventListener('keydown', (event) => {
  if (!menuFor) return;
  const items = [...menu.querySelectorAll('button')];
  const at = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    const button = menuFor;
    hideMenu();
    if (button.isConnected) button.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  } else if (event.key === 'Tab') {
    hideMenu();
  }
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  // Any click closes the open menu; one on its own button does only that.
  const reopening = target && target === menuFor;
  hideMenu();
  if (!target || !snap || reopening) return;
  const { act, tab, group, archive, ws } = target.dataset;
  const tabId = tab ? Number(tab) : undefined;
  switch (act) {
    case 'groupMenu': case 'tabMenu': case 'spaceMenu': showMenu(target); return;
    case 'switchWorkspace':
      if (ws !== here.id) send('switchWorkspace', { wsId: ws });
      break;
    // The background answers with editWorkspace, to name it.
    case 'newWorkspace': clearSearch(); send('newWorkspace'); break;
    case 'renameWorkspace': editingWs = ws; break;
    case 'deleteWorkspace': send('deleteWorkspace', { wsId: ws }); break;
    case 'moveTabWs': send('moveTabToWorkspace', { tabId, wsId: ws }); break;
    case 'moveGroupWs': send('moveGroupToWorkspace', { groupId: group, wsId: ws }); break;
    case 'renameGroup':
      if (!snap.groups[group]) return;
      editing = group;
      editingTab = null;
      break;
    case 'renameTab':
      if (!snap.tabs.some((t) => t.id === tabId)) return;
      editing = null;
      editingTab = tabId;
      break;
    case 'activate': clearSearch(); send('activate', { tabId }); break;
    case 'closeTab': send('closeTab', { tabId }); break;
    case 'pinTab': send('pinTab', { tabId, pinned: true }); break;
    case 'unpinTab': send('pinTab', { tabId, pinned: false }); break;
    case 'toggleGroup':
      // Shown at once; the background's next snapshot confirms it.
      if (snap.groups[group]) snap.groups[group].collapsed = !snap.groups[group].collapsed;
      send('toggleGroup', { groupId: group });
      break;
    case 'pinGroup': send('pinGroup', { groupId: group }); break;
    case 'toggleOlder':
      if (!older.delete(group)) older.add(group);
      break;
    case 'archiveGroup': send('archiveGroup', { groupId: group }); break;
    case 'showGroup': clearSearch(); send('showGroup', { groupId: group }); break;
    case 'reopenGroup': clearSearch(); send('reopenGroup', { groupId: group }); break;
    case 'reopenTab': clearSearch(); send('reopenTab', { archiveId: archive }); break;
    case 'newTab': send('newTab'); break;
    case 'settings': browser.runtime.openOptionsPage(); break;
    default: return;
  }
  render();
});

// Middle-clicking a tab's row, a pinned tile or a group's row closes it, as
// the tab's close button or the group's Archive would. Open fields keep the default (paste).
function middleTarget(event) {
  if (event.button !== 1 || !snap || !event.target.closest || event.target.closest('input')) return null;
  return event.target.closest('[data-ctx-tab], [data-ctx-group]');
}

// Firefox starts autoscroll on the press, before any click arrives.
document.addEventListener('mousedown', (event) => {
  if (middleTarget(event)) event.preventDefault();
});

document.addEventListener('auxclick', (event) => {
  const node = middleTarget(event);
  if (!node) return;
  event.preventDefault();
  if (node.dataset.ctxTab) send('closeTab', { tabId: Number(node.dataset.ctxTab) });
  else send('archiveGroup', { groupId: node.dataset.ctxGroup });
});

// Double-clicking a group's row, a tab's row or a pinned tile renames it in
// place. A group's arrow is left out: two quick clicks there toggle it twice.
// So is any open field.
document.addEventListener('dblclick', (event) => {
  if (!snap || !event.target.closest || event.target.closest('.twist, input')) return;
  const main = event.target.closest('#list .row-main, #pins .pin-main');
  if (!main) return;
  const groupId = main.parentNode.dataset.ctxGroup;
  if (groupId && snap.groups[groupId]) {
    editing = groupId;
    editingTab = null;
  } else if (main.dataset.tab) {
    editing = null;
    editingTab = Number(main.dataset.tab);
  } else {
    return;
  }
  render();
});

// Rows and pinned tiles are divs with a button role (see groupNode), so give
// them button keys.
document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role="button"]')) {
    event.preventDefault();
    event.target.click();
  }
});

// ---- drag and drop -----------------------------------------------------------
// A tab dropped on a group joins it; dropped on a tab it also takes the place
// before or after it. A group dropped on the middle of a group nests in it;
// on the top or bottom edge it becomes its sibling there. Over the pin grid a
// tab or pinned tile opens a drop zone where it would land: within a row, the
// tiles there squeezing aside, or as a row of its own. Dropping sets the grid.

// A spot in the pin grid: in `row` before the tile `before` (last when null),
// or, with no `row`, as a new row before the row `before` (at the end when null).
const END = { row: null, before: null };
const PIN_GAP = 4; // between tiles, as in sidebar.css
const GAP_MS = 160; // matches the drop zone's transitions in sidebar.css
const sameSpot = (a, b) => !!a && !!b && a.row === b.row && a.before === b.before;
const rowAfter = (rowEl) => {
  let next = rowEl.nextElementSibling;
  while (next && next.classList.contains('fresh')) next = next.nextElementSibling;
  return next;
};

// Opens the drop zone at `spot` and closes the one open elsewhere.
function setGap(spot, instant = false) {
  if (sameSpot(gap && gap.spot, spot) || (!gap && !spot)) return;
  if (gap) {
    const old = gap.node;
    gap = null;
    old.classList.remove('open', 'instant');
    old.classList.add('closing');
    old.style.width = '';
    if (motion) setTimeout(() => old.remove(), GAP_MS);
    else old.remove();
  }
  if (!spot) return;
  const zone = el('div', { class: 'pin-gap' });
  const node = spot.row ? zone : el('div', { class: 'pin-row fresh' }, zone);
  // Within a row the zone grows to an even share. Its width is animated, not
  // its flex-grow: a tile's width is not linear in that, which skews the easing.
  let share = null;
  if (spot.row) {
    const tiles = spot.row.querySelectorAll('.pin:not(.lifted)').length;
    share = (spot.row.getBoundingClientRect().width - PIN_GAP * tiles) / (tiles + 1);
  }
  (spot.row || $('pins')).insertBefore(node, spot.before);
  if (instant) node.classList.add('instant');
  else node.getBoundingClientRect(); // lets the zone grow from nothing
  node.classList.add('open');
  if (share != null) zone.style.width = share + 'px';
  gap = { spot, zone, node };
}

// Where the pointer says the dragged tile goes. Measured from the tiles'
// centres, which stay on their side of the pointer as the zone opens, so the
// zone does not chase itself.
function pinSpot(event) {
  if (gap && gap.node.contains(event.target)) return gap.spot;
  const rowEl = event.target.closest('.pin-row:not(.fresh)');
  const tiles = rowEl ? [...rowEl.querySelectorAll('.pin:not(.lifted)')] : [];
  if (!tiles.length) return gap ? gap.spot : null; // between rows
  const rect = rowEl.getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  // The top and bottom edges make a new row; so does all of a full row.
  const edge = tiles.length >= PIN_MAX ? 0.5 : 0.25;
  if (y < edge) return { row: null, before: rowEl };
  if (y >= 1 - edge) return { row: null, before: rowAfter(rowEl) };
  const before = tiles.find((t) => {
    const r = t.getBoundingClientRect();
    return event.clientX < r.left + r.width / 2;
  });
  return { row: rowEl, before: before || null };
}

// Moves the drop zone under the pointer and returns the drop that would set
// the grid as it then stands, the zone standing for the dragged tile.
function pinDrop(event) {
  const pins = $('pins');
  const over = !pins.hidden && pins.contains(event.target);
  // An empty grid keeps its one zone open, as there is nothing else to aim at.
  const empty = !pins.querySelector('.pin:not(.lifted)');
  setGap((over && pinSpot(event)) || (empty && !pins.hidden ? END : null));
  if (!over || !gap) return null;
  const id = drag.tabId ?? drag.pinId;
  const rows = [...pins.querySelectorAll('.pin-row')]
    .map((rowEl) => [...rowEl.children].flatMap((n) => {
      if (n === gap.zone) return [id];
      return n.matches('.pin:not(.lifted)') ? [Number(n.dataset.ctxTab)] : [];
    }))
    .filter((row) => row.length);
  return { rows, msg: ['layoutPins', { rows }] };
}

// Shown at once; the next snapshot confirms it.
function applyPinLayout(rows) {
  let at = 0;
  rows.forEach((row, r) => row.forEach((id) => {
    const tab = snap.tabs.find((t) => t.id === id);
    if (tab) Object.assign(tab, { pinned: true, pinRow: r, index: at++ - 1e6 }); // ahead of every unpinned tab
  }));
}

function dropFor(event) {
  if (!drag || !snap || !event.target.closest) return null;
  if (drag.groupId == null) {
    const drop = pinDrop(event);
    if (drop || drag.pinId != null) return drop;
  }
  const row = event.target.closest('#list .row');
  if (!row) return null;
  const { ctxTab, ctxGroup, ctxIn } = row.dataset;
  const rect = row.getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  if (drag.tabId != null) {
    if (ctxGroup) return { row, where: 'into', msg: ['moveTab', { tabId: drag.tabId, groupId: ctxGroup }] };
    if (!ctxIn || Number(ctxTab) === drag.tabId) return null;
    const after = y > 0.5;
    return {
      row,
      where: after ? 'after' : 'before',
      msg: ['moveTab', { tabId: drag.tabId, groupId: ctxIn, nearTabId: Number(ctxTab), after }],
    };
  }
  if (!ctxGroup || ctxGroup === drag.groupId) return null;
  const parentOf = (where) => (where === 'into' ? ctxGroup : snap.groups[ctxGroup].parentId || null);
  let where = y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
  // Too deep to nest here, or its own descendant: offer the nearer edge instead.
  if (!canNest(snap.groups, drag.groupId, parentOf(where))) where = y < 0.5 ? 'before' : 'after';
  if (!canNest(snap.groups, drag.groupId, parentOf(where))) return null;
  return { row, where, msg: ['moveGroup', { groupId: drag.groupId, targetId: ctxGroup, where }] };
}

// Highlights the list row a drop would land on. The pin grid shows its zone instead.
function markDrop(drop) {
  if (marked) marked.row.classList.remove('drop-' + marked.where);
  marked = drop && drop.row ? drop : null;
  if (marked) marked.row.classList.add('drop-' + marked.where);
}

document.addEventListener('dragstart', (event) => {
  const row = event.target.closest ? event.target.closest('#list .row[draggable], #pins .pin[draggable]') : null;
  if (!row) return;
  if (row.classList.contains('pin')) drag = { pinId: Number(row.dataset.ctxTab) };
  else drag = row.dataset.ctxTab ? { tabId: Number(row.dataset.ctxTab) } : { groupId: row.dataset.ctxGroup };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-rolltop-row', '1'); // Firefox needs some data to start a drag
  row.classList.add('dragging');
  // Deferred, as changing the layout inside dragstart can cancel the drag.
  requestAnimationFrame(() => {
    if (!drag) return;
    if (drag.pinId != null) {
      // The tile leaves the grid for a zone in its place, so nothing moves yet.
      // It stays in the document: a drag needs its source there.
      const rowEl = row.parentNode;
      const alone = rowEl.querySelectorAll('.pin').length === 1;
      row.classList.add('lifted');
      rowEl.classList.toggle('vacant', alone);
      setGap(alone ? { row: null, before: rowAfter(rowEl) } : { row: rowEl, before: row.nextElementSibling }, true);
    } else if (drag.tabId != null && $('pins').hidden) {
      // With nothing pinned there is no grid to drop on: show a zone for the drag.
      $('pins').hidden = false;
      setGap(END, true);
    }
  });
});
document.addEventListener('dragover', (event) => {
  const drop = dropFor(event);
  markDrop(drop);
  if (!drop) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});
document.addEventListener('drop', (event) => {
  const drop = dropFor(event);
  if (!drop) return;
  event.preventDefault();
  if (!drop.rows) {
    send(...drop.msg);
  } else if (JSON.stringify(drop.rows) !== pinLayout) {
    applyPinLayout(drop.rows);
    send(...drop.msg);
  }
});
document.addEventListener('dragend', () => {
  markDrop(null);
  drag = null;
  gap = null;
  pinsSig = null; // the grid was rearranged for the drag: build it again
  document.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
  render();
});

// ---- context menus ---------------------------------------------------------
// Rows open Firefox's native menu: its own tab menu plus our items on a tab,
// our items alone on a group. The background handles the clicks.

const GROUP_ITEMS = [MENU.rename, MENU.pinGroup, MENU.toggleGroup, MENU.archiveGroup];

document.addEventListener('contextmenu', (event) => {
  if (event.target.closest('input')) {
    menuTarget = {}; // text fields keep the default menu
    return;
  }
  const node = event.target.closest('[data-ctx-tab], [data-ctx-group]');
  if (!node || !snap) {
    event.preventDefault();
    return;
  }
  if (node.dataset.ctxTab) {
    menuTarget = { tabId: Number(node.dataset.ctxTab) };
    browser.menus.overrideContext({ context: 'tab', tabId: menuTarget.tabId });
  } else {
    menuTarget = { groupId: node.dataset.ctxGroup };
    browser.menus.overrideContext({ showDefaults: false });
  }
  send('menuTarget', menuTarget);
}, { capture: true });

// Every sidebar hears about every menu; only the one that was right-clicked
// has a target. Tab menus need nothing here.
browser.menus.onShown.addListener(() => {
  if (!menuTarget || menuTarget.tabId) return;
  const g = menuTarget.groupId ? snap.groups[menuTarget.groupId] : null;
  const visible = !!g;
  browser.menus.update(MENU.rename, { visible });
  // Only a top-level group can be pinned; what is nested in it goes with it.
  const top = !!g && !(g.parentId && snap.groups[g.parentId]);
  browser.menus.update(MENU.pinGroup, { visible: top, title: g && g.pinned ? 'Unpin group' : 'Pin group' });
  browser.menus.update(MENU.toggleGroup, { visible, title: g && g.collapsed ? 'Expand' : 'Collapse' });
  browser.menus.update(MENU.archiveGroup, { visible });
  browser.menus.refresh();
});
browser.menus.onHidden.addListener(() => {
  if (!menuTarget) return;
  // Hidden for a text field's menu; a group menu must not open empty.
  if (!menuTarget.groupId && !menuTarget.tabId) {
    GROUP_ITEMS.forEach((id) => browser.menus.update(id, { visible: true }));
  }
  menuTarget = null;
});

$('q').addEventListener('input', (event) => {
  query = event.target.value;
  searchArchive();
  render();
});
$('q').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    clearSearch();
    render();
  }
});

function connect() {
  port = browser.runtime.connect({ name: 'sidebar' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'archiveHits') {
      hits = msg;
    } else if (msg.type === 'state') {
      const was = here && here.id;
      snap = msg;
      here = msg.spaces.find((s) => s.id === msg.active[windowId]) || msg.spaces[0];
      // The rest of this file reads the shown workspace's tree from the snapshot.
      snap.groups = here.groups;
      snap.archiveCounts = here.archiveCounts;
      if (was !== here.id) {
        editing = null;
        editingTab = null;
        older.clear();
      }
      searchArchive(); // the archive may have changed under an open search
    } else if (msg.type === 'editWorkspace') {
      if (!snap) return;
      clearSearch();
      editingWs = msg.wsId; // its snapshot may only arrive next
    } else if (msg.type === 'editGroup') {
      clearSearch();
      editingTab = null;
      editing = msg.groupId; // its row may only arrive with the next snapshot
    } else {
      return;
    }
    render();
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
}

browser.windows.getCurrent().then((win) => {
  windowId = win.id;
  connect();
});

// Idle ages and fading move on even when no tab event fires.
setInterval(render, 10 * 60 * 1000);
