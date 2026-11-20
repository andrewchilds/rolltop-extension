const DEFAULTS = { auto: true, archiveDays: 14, collapseHours: 8, apiKey: '', model: 'claude-opus-5-5' };
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
