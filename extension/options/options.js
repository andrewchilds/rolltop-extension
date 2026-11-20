const DEFAULTS = { auto: true, archiveDays: 14, apiKey: '', model: 'claude-opus-5-5' };
const $ = (id) => document.getElementById(id);

async function load() {
  const { settings } = await browser.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('auto').checked = s.auto;
  $('archiveDays').value = s.archiveDays;
}

async function save() {
  const { settings } = await browser.storage.local.get('settings');
  const days = Math.round(Number($('archiveDays').value));
  await browser.storage.local.set({
    settings: {
      ...DEFAULTS,
      ...(settings || {}),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim() || DEFAULTS.model,
      auto: $('auto').checked,
      archiveDays: Number.isFinite(days) && days >= 1 ? days : DEFAULTS.archiveDays,
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

load();
