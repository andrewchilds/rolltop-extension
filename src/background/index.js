import { createBackground } from './core.js';
import { classifyWithAI } from './classify-ai.js';
import { MENU } from '../../extension/lib/model.js';

const background = createBackground({ browser, classifyWithAI });
background.start().catch((e) => console.error('Rolltop failed to start', e));

browser.browserAction.onClicked.addListener(() => browser.sidebarAction.toggle());

browser.menus.create({
  id: 'rolltop-settings',
  title: 'Rolltop settings',
  contexts: ['browser_action'],
});

// Context menus for the sidebar's rows. The sidebar calls menus.overrideContext
// on right-click: tab rows open Firefox's tab menu with the 'tab' items added,
// group rows open a menu holding only the 'all' items. Restricting the items to
// our sidebar document keeps them off the native tab strip and other pages.
const sidebarOnly = {
  viewTypes: ['sidebar'],
  documentUrlPatterns: [browser.runtime.getURL('sidebar/*')],
};
const item = (id, title, contexts, extra = {}) =>
  browser.menus.create({ id, title, contexts, ...sidebarOnly, ...extra });

item(MENU.archiveTab, 'Archive tab', ['tab']);
// Shown by the sidebar when the row is one of several selected.
item(MENU.groupTabs, 'Group tabs', ['tab'], { visible: false });
item(MENU.move, 'Move to group', ['tab']);
item(MENU.moveNew, 'New group', ['tab'], { parentId: MENU.move });
item(MENU.moveSep, undefined, ['tab'], { parentId: MENU.move, type: 'separator' });
item(MENU.rename, 'Rename…', ['all']);
item(MENU.pinGroup, 'Pin group', ['all']);
item(MENU.toggleGroup, 'Collapse', ['all']);
item(MENU.archiveGroup, 'Archive group', ['all']);

// The "Move to group" submenu lists the current groups, rebuilt on each open.
let moveItems = [];
browser.menus.onShown.addListener((info, tab) => {
  if (!tab || !info.menuIds.includes(MENU.move)) return;
  moveItems.forEach((id) => browser.menus.remove(id).catch(() => {}));
  const targets = background.moveTargets(tab.id);
  moveItems = targets.map((t) => item(MENU.moveTo + t.id, t.title.replace(/&/g, '&&'), ['tab'], { parentId: MENU.move }));
  browser.menus.update(MENU.moveSep, { visible: targets.length > 0 });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'rolltop-settings') browser.runtime.openOptionsPage();
  else background.menuClick(info.menuItemId, tab ? tab.id : undefined);
});
