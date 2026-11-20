import { buildView, canNest, MENU, UNGROUPED } from '../lib/model.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const ICONS = {
  chevron: { size: 11, box: 12, width: 1.5, paths: ['M4.5 2.5L8 6l-3.5 3.5'] },
  pin: { size: 14, box: 16, width: 1.4, paths: ['M6 2h4l-.5 4 2 2.5h-7l2-2.5z', 'M8 8.5V14'] },
  close: { size: 12, box: 12, width: 1.5, paths: ['M3 3l6 6M9 3l-6 6'] },
  plus: { size: 14, box: 14, width: 1.5, paths: ['M7 2v10M2 7h10'] },
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
    renaming ? null : actBtn('unpinTab', 'Unpin tab', { tab: p.tabId }, icon('pin', { filled: true })),
  );
}

// The blank cell that evens out the pin grid: opens a new pinned tab, and
// takes a dropped tab as the last pin.
function pinSlot() {
  return el('button', {
    type: 'button', class: 'pin-add', 'aria-label': 'New pinned tab', title: 'New pinned tab',
    data: { act: 'newPinnedTab' },
  }, icon('plus'));
}

function groupNode(r) {
  const fixed = r.id === UNGROUPED;
  const renaming = editing === r.id;
  const pin =actBtn('pinGroup', r.pinLabel, { group: r.id }, icon('pin', { filled: r.hard }), { 'aria-pressed': String(r.hard) });
  if (r.kept) pin.classList.add('on');
  // Only the arrow opens and closes the group; the rest of the row is left
  // for dragging and for double-clicking to rename. Not a <button>: Firefox
  // does not start a drag from inside one. Inert while renaming.
  const twist = fixed ? null : el('span', {
    class: 'twist',
    ...(renaming ? {} : {
      role: 'button', tabindex: '0',
      'aria-label': `${r.open ? 'Collapse' : 'Expand'} ${r.name}`, 'aria-expanded': String(r.open),
      data: { act: 'toggleGroup', group: r.id },
    }),
  }, icon('chevron', { cls: 'chev' }));
  const parts = [
    twist,
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    renaming ? renameInput(r.name, 'Group name', 40) : el('span', { class: 'gname' }, r.name),
    el('span', { class: 'chip' }, r.label),
  ];
  return el('div', {
    class: `row group ${hueClass(r.hue)}${r.open ? ' open' : ''}${r.top ? ' top' : ''}${fixed ? ' static' : ''}${renaming ? ' editing' : ''}`,
    style: `${hueStyle(r.hue)}padding-left:${r.depth * 14}px;opacity:${renaming ? 1 : r.fade}`,
    data: fixed ? {} : { ctxGroup: r.id },
    draggable: fixed || renaming ? null : 'true',
  },
    el('div', { class: 'row-main', title: renaming ? null : r.name }, ...parts),
    el('div', { class: 'acts' },
      fixed ? null : pin,
      fixed ? null : actBtn('archiveGroup', 'Close group', { group: r.id }, icon('close')),
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
    el('div', { class: 'acts' },
      actBtn('pinTab', 'Pin tab', { tab: r.tabId }, icon('pin')),
      actBtn('closeTab', 'Close tab', { tab: r.tabId }, icon('close')),
      el('span', { class: 'meta' }, r.idleLabel),
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
let windowId = null;
let port = null;
let query = '';
let hits = { query: '', tabs: [] }; // archived tabs matching a query, from the background
let editing = null; // id of the group being renamed in its row
let editingTab = null; // id of the tab being renamed in its row or pinned tile
let menuTarget = null; // what this sidebar's open context menu was opened on
let drag = null; // what is being dragged: { tabId }, { groupId } or { pinId } for a pinned tile
let marked = null; // the drop target currently highlighted

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

const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const SLIDE_MS = 200; // matches the row animations in sidebar.css
let listSig = null; // what the list last rendered, to leave it alone when nothing changed
let pinsSig = null; // the same for the pin grid

// Rebuilds the list. Rows that are new slide open and rows that went away
// slide shut in place, which is what opening and closing a group looks like.
function renderList(rows) {
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
    const node = group ? groupNode(r) : tabNode(r);
    const key = group ? 'g:' + r.id : 't:' + r.tabId;
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
    tabs: snap.tabs.filter((t) => t.windowId === windowId),
    groups: snap.groups,
    archiveCounts: snap.archiveCounts,
    archiveHits: hits.query === query ? hits.tabs : [],
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
      const pinSig = JSON.stringify([view.pins, editingTab]);
      if (pinSig !== pinsSig) {
        pinsSig = pinSig;
        $('pins').replaceChildren(...view.pins.map(pinNode), view.pins.length % 2 ? pinSlot() : '');
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

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target || !snap) return;
  const { act, tab, group, archive } = target.dataset;
  const tabId = tab ? Number(tab) : undefined;
  switch (act) {
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
    case 'archiveGroup': send('archiveGroup', { groupId: group }); break;
    case 'showGroup': clearSearch(); send('showGroup', { groupId: group }); break;
    case 'reopenGroup': clearSearch(); send('reopenGroup', { groupId: group }); break;
    case 'reopenTab': clearSearch(); send('reopenTab', { archiveId: archive }); break;
    case 'newTab': send('newTab'); break;
    case 'newPinnedTab': send('newTab', { pinned: true }); break;
    case 'settings': browser.runtime.openOptionsPage(); break;
    default: return;
  }
  render();
});

// Double-clicking a group's row, a tab's row or a pinned tile renames it in
// place. A group's arrow is left out: two quick clicks there toggle it twice.
document.addEventListener('dblclick', (event) => {
  if (!snap || !event.target.closest || event.target.closest('.twist')) return;
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
// on the top or bottom edge it becomes its sibling there. A pinned tile can
// be reordered among the pinned tiles. A tab dropped on the pin grid is pinned:
// beside the tile it lands on, or last when dropped on the blank cell.

function dropFor(event) {
  if (!drag || !snap || !event.target.closest) return null;
  const slot = event.target.closest('#pins .pin-add');
  const pin = event.target.closest('#pins .pin');
  if (slot) {
    if (drag.tabId != null) return { row: slot, where: 'into', msg: ['pinTab', { tabId: drag.tabId, pinned: true }] };
    const last = slot.previousElementSibling;
    const nearTabId = last ? Number(last.dataset.ctxTab) : drag.pinId;
    if (drag.pinId == null || nearTabId === drag.pinId) return null;
    return { row: slot, where: 'into', msg: ['placeTab', { tabId: drag.pinId, nearTabId, after: true }] };
  }
  if (pin && drag.tabId != null) {
    const rect = pin.getBoundingClientRect();
    const after = (event.clientX - rect.left) / rect.width > 0.5;
    return {
      row: pin,
      where: after ? 'right' : 'left',
      msg: ['pinTab', { tabId: drag.tabId, pinned: true, nearTabId: Number(pin.dataset.ctxTab), after }],
    };
  }
  if (drag.pinId != null) {
    const nearTabId = pin ? Number(pin.dataset.ctxTab) : drag.pinId;
    if (nearTabId === drag.pinId) return null;
    const rect = pin.getBoundingClientRect();
    const after = (event.clientX - rect.left) / rect.width > 0.5;
    return { row: pin, where: after ? 'right' : 'left', msg: ['placeTab', { tabId: drag.pinId, nearTabId, after }] };
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

function markDrop(drop) {
  if (marked) marked.row.classList.remove('drop-' + marked.where);
  if (drop) drop.row.classList.add('drop-' + drop.where);
  marked = drop;
}

document.addEventListener('dragstart', (event) => {
  const row = event.target.closest ? event.target.closest('#list .row[draggable], #pins .pin[draggable]') : null;
  if (!row) return;
  if (row.classList.contains('pin')) drag = { pinId: Number(row.dataset.ctxTab) };
  else drag = row.dataset.ctxTab ? { tabId: Number(row.dataset.ctxTab) } : { groupId: row.dataset.ctxGroup };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-tidy-row', '1'); // Firefox needs some data to start a drag
  row.classList.add('dragging');
  // With nothing pinned there is no grid to drop on: show a blank cell for the
  // drag. Deferred, as changing the layout inside dragstart can cancel the drag.
  if (drag.tabId != null && $('pins').hidden) {
    requestAnimationFrame(() => {
      if (!drag) return;
      $('pins').replaceChildren(pinSlot());
      pinsSig = null;
      $('pins').hidden = false;
    });
  }
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
  send(...drop.msg);
});
document.addEventListener('dragend', () => {
  markDrop(null);
  drag = null;
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
  browser.menus.update(MENU.pinGroup, { visible, title: g && g.pinned ? 'Unpin group' : 'Pin group' });
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
      snap = msg;
      searchArchive(); // the archive may have changed under an open search
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
