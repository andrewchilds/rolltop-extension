import { buildView, canNest, MENU, UNGROUPED } from '../lib/model.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const ICONS = {
  chevron: { size: 11, box: 12, width: 1.5, paths: ['M4.5 2.5L8 6l-3.5 3.5'] },
  pin: { size: 14, box: 16, width: 1.4, paths: ['M6 2h4l-.5 4 2 2.5h-7l2-2.5z', 'M8 8.5V14'] },
  archive: { size: 14, box: 16, width: 1.4, paths: ['M2.5 4h11v2.5h-11z', 'M3.5 6.5V13h9V6.5', 'M6.5 9.5h3'] },
  close: { size: 12, box: 12, width: 1.5, paths: ['M3 3l6 6M9 3l-6 6'] },
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
  return el('div', {
    class: `pin ${hueClass(p.hue)}${p.current ? ' current' : ''}`, style: hueStyle(p.hue), title: p.title,
    data: { ctxTab: p.tabId },
  },
    el('button', {
      type: 'button', class: 'pin-main', 'aria-label': p.title,
      'aria-current': p.current ? 'page' : null, data: { act: 'activate', tab: p.tabId },
    }, tile(p, true), el('span', { class: 'pin-title' }, p.title)),
    actBtn('unpinTab', 'Unpin tab', { tab: p.tabId }, icon('pin', { filled: true })),
  );
}

function groupNode(r) {
  const fixed = r.id === UNGROUPED;
  const pin = actBtn('pinGroup', r.pinLabel, { group: r.id }, icon('pin', { filled: r.hard }), { 'aria-pressed': String(r.hard) });
  if (r.kept) pin.classList.add('on');
  const renaming = editing === r.id;
  const parts = [
    fixed ? null : icon('chevron', { cls: 'chev' }),
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    renaming ? renameInput(r) : el('span', { class: 'gname' }, r.name),
    el('span', { class: 'chip' }, r.label),
  ];
  return el('div', {
    class: `row group ${hueClass(r.hue)}${r.open ? ' open' : ''}${r.top ? ' top' : ''}${fixed ? ' static' : ''}${renaming ? ' editing' : ''}`,
    style: `${hueStyle(r.hue)}padding-left:${r.depth * 14}px;opacity:${renaming ? 1 : r.fade}`,
    data: fixed ? {} : { ctxGroup: r.id },
    draggable: fixed || renaming ? null : 'true',
  },
    // Not a <button>: Firefox does not start a drag from inside one. The row
    // is inert while renaming.
    renaming
      ? el('div', { class: 'row-main' }, ...parts)
      : el('div', {
        class: 'row-main', title: r.name,
        role: fixed ? null : 'button', tabindex: fixed ? null : '0',
        'aria-expanded': fixed ? null : String(r.open),
        data: fixed ? {} : { act: 'toggleGroup', group: r.id },
      }, ...parts),
    el('div', { class: 'acts' },
      fixed ? null : pin,
      fixed ? null : actBtn('archiveGroup', 'Archive group', { group: r.id }, icon('archive')),
      el('span', { class: 'meta' }, String(r.count)),
    ),
  );
}

function tabNode(r) {
  return el('div', {
    class: `row tab ${hueClass(r.hue)}${r.current ? ' current' : ''}`,
    style: `${hueStyle(r.hue)}opacity:${r.fade}`,
    title: r.title,
    data: { ctxTab: r.tabId, ...(r.groupId ? { ctxIn: r.groupId } : {}) },
    draggable: 'true',
  },
    el('div', {
      class: 'row-main', role: 'button', tabindex: '0', style: `padding-left:${22 + r.depth * 14}px`,
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
let menuTarget = null; // what this sidebar's open context menu was opened on
let drag = null; // the row being dragged: { tabId } or { groupId }
let marked = null; // the drop target currently highlighted

function renameInput(r) {
  const input = el('input', {
    type: 'text', class: 'rename', value: r.name, maxlength: 40,
    'aria-label': 'Group name', autocomplete: 'off', spellcheck: 'false',
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finishRename(input, true);
    else if (event.key === 'Escape') finishRename(input, false);
  });
  input.addEventListener('blur', () => finishRename(input, true));
  return input;
}

function finishRename(input, commit) {
  if (editing == null) return;
  const groupId = editing;
  editing = null;
  const name = input.value.trim();
  if (commit && name && name !== input.defaultValue && snap.groups[groupId]) {
    snap.groups[groupId].name = name; // shown at once; the next snapshot confirms it
    send('renameGroup', { groupId, name });
  }
  render();
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
    const list = $('list');
    $('pins').hidden = !view.pins.length;
    $('pins').replaceChildren(...view.pins.map(pinNode));
    // A rename in progress keeps its row: rebuilding would drop what was typed.
    // So does a drag: its source row has to stay in the document.
    if (!drag && (editing == null || !list.querySelector('.rename'))) {
      const scroll = list.scrollTop;
      list.replaceChildren(...view.rows.map((r) => (r.kind === 'group' ? groupNode(r) : tabNode(r))));
      list.scrollTop = scroll;
      const input = list.querySelector('.rename');
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
    case 'toggleGroup': send('toggleGroup', { groupId: group }); break;
    case 'pinGroup': send('pinGroup', { groupId: group }); break;
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

// Rows are divs with a button role (see groupNode), so give them button keys.
document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.row-main[role="button"]')) {
    event.preventDefault();
    event.target.click();
  }
});

// ---- drag and drop -----------------------------------------------------------
// A tab dropped on a group joins it; dropped on a tab it also takes the place
// before or after it. A group dropped on the middle of a group nests in it;
// on the top or bottom edge it becomes its sibling there.

function dropFor(event) {
  const row = event.target.closest ? event.target.closest('#list .row') : null;
  if (!row || !drag || !snap) return null;
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
  const row = event.target.closest ? event.target.closest('#list .row[draggable]') : null;
  if (!row) return;
  drag = row.dataset.ctxTab ? { tabId: Number(row.dataset.ctxTab) } : { groupId: row.dataset.ctxGroup };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-tidy-row', '1'); // Firefox needs some data to start a drag
  row.classList.add('dragging');
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
