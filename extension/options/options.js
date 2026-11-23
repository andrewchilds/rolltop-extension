const DEFAULTS = { auto: true, archiveDays: 14, collapseHours: 8, apiKey: '', model: 'claude-haiku-5-5' };
const $ = (id) => document.getElementById(id);

async function load() {
  const { settings } = await browser.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('auto').checked = s.auto;
  $('archiveDays').value = s.archiveDays;
  $('collapseHours').value = s.collapseHours;
}

async function save() {
  const { settings } = await browser.storage.local.get('settings');
  const days = Math.round(Number($('archiveDays').value));
  const hours = Math.round(Number($('collapseHours').value));
  await browser.storage.local.set({
    settings: {
      ...DEFAULTS,
      ...(settings || {}),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim() || DEFAULTS.model,
      auto: $('auto').checked,
      archiveDays: Number.isFinite(days) && days >= 1 ? days : DEFAULTS.archiveDays,
      collapseHours: Number.isFinite(hours) && hours >= 1 ? hours : DEFAULTS.collapseHours,
    },
  });
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await save();
  $('status').textContent = 'Saved.';
});

$('resort').addEventListener('click', async () => {
  await save();
  $('status').textContent = 'Sorting…';
  await browser.runtime.sendMessage({ type: 'resort' });
  $('status').textContent = 'Done.';
});

// ---- workspace export and import ------------------------------------------

const say = (text) => { $('workspaceStatus').textContent = text; };
const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const failure = (e) => (e && e.message) || String(e);
let pending = null; // the parsed file waiting for the Import button

$('export').addEventListener('click', async () => {
  try {
    const data = await browser.runtime.sendMessage({ type: 'exportWorkspace' });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    const d = new Date();
    const day = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
    link.download = `rolltop-workspace-${day}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    say(`Exported ${count(data.tabs.length, 'tab')} in ${count(data.groups.length, 'group')}.`);
  } catch (e) {
    say(failure(e));
  }
});

// Choosing a file only reads it; nothing changes until Import is pressed.
$('importFile').addEventListener('change', async () => {
  pending = null;
  $('import').disabled = true;
  const file = $('importFile').files[0];
  if (!file) return say('');
  try {
    const data = JSON.parse(await file.text());
    const size = (list) => (Array.isArray(list) ? list.length : 0);
    if (!data || data.format !== 'rolltop-workspace') throw new Error('This is not a Rolltop workspace file.');
    pending = data;
    $('import').disabled = false;
    say(`${count(size(data.tabs), 'tab')} in ${count(size(data.groups), 'group')} in this file.`);
  } catch (e) {
    say(e instanceof SyntaxError ? 'This file is not valid JSON.' : failure(e));
  }
});

$('import').addEventListener('click', async () => {
  if (!pending) return;
  $('import').disabled = true;
  say('Importing…');
  try {
    const here = await browser.tabs.getCurrent();
    const r = await browser.runtime.sendMessage({ type: 'importWorkspace', data: pending, windowId: here && here.windowId });
    pending = null;
    $('importFile').value = '';
    say([
      `Opened ${count(r.tabs, 'tab')}`,
      `added ${count(r.groups, 'group')}`,
      r.skipped ? `skipped ${count(r.skipped, 'tab')} already open` : '',
      r.failed ? `${count(r.failed, 'tab')} could not be opened` : '',
    ].filter(Boolean).join(', ') + '.');
  } catch (e) {
    $('import').disabled = false;
    say(failure(e));
  }
});

// ---- sorting log ---------------------------------------------------------

function node(tag, cls, ...children) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.append(...children.filter((c) => c != null && c !== ''));
  return n;
}

function logEntry(e, open) {
  const how = e.model ? (e.error ? `${e.model}, failed` : e.model) : 'by site, no API key';
  const tabs = e.tabs.map((t) => {
    const where = !t.by
      ? 'Not filed (the tab closed or was moved by hand first)'
      : `${t.created ? 'New group' : 'Existing group'}: ${t.group}${t.by === 'site' ? ' (by site)' : ''}`;
    return node('li', '',
      t.title || t.url,
      node('span', 'sub', t.url + (t.openedFrom ? ` · opened from ${t.openedFrom}` : '')),
      node('span', 'to', where),
      t.reason ? node('span', 'sub', t.reason) : null,
    );
  });
  const shown = node('details', '',
    node('summary', '', `Groups the model was shown (${e.groups.length})`),
    node('ul', '', ...e.groups.map((g) => node('li', '',
      `${g.name} · ${g.label}`,
      node('span', 'sub', g.titles.length ? g.titles.join(' | ') : 'No tab titles'),
    ))),
  );
  const details = node('details', '',
    node('summary', '', `${new Date(e.at).toLocaleString()} · ${e.tabs.length} ${e.tabs.length === 1 ? 'tab' : 'tabs'} · ${how}`),
    e.error ? node('p', 'err', e.error) : null,
    node('ul', '', ...tabs),
    ...e.renames.map((r) => node('p', 'sub', `Renamed group "${r.from}" to "${r.to}"`)),
    e.model ? shown : null,
  );
  details.open = open;
  return details;
}

async function loadLog() {
  const { log } = await browser.storage.local.get('log');
  const entries = log || [];
  $('log').replaceChildren(...(entries.length
    ? entries.map((e, i) => logEntry(e, i === 0))
    : [node('p', 'hint', 'Nothing sorted yet.')]));
}

$('clearLog').addEventListener('click', () => browser.runtime.sendMessage({ type: 'clearLog' }));
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.log) loadLog();
});

load();
loadLog();
