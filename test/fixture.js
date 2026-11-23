// The mockup's sample data, as a background snapshot. Used by the unit tests
// and by the visual harness in test/harness/.

const DAY = 86400000;

const GROUPS = [
  { id: 'work', name: 'Sidebar redesign', label: 'Work', hue: 255, pinned: true },
  { id: 'a11y', parentId: 'work', name: 'Accessibility', label: 'Audit', hue: 280 },
  { id: 'read', name: 'Read later', label: 'Reading', hue: 325 },
  { id: 'trip', name: 'Kyoto in spring', label: 'Trip', hue: 55 },
  { id: 'transit', parentId: 'trip', name: 'Getting there', label: 'Transit', hue: 35 },
  { id: 'stay', parentId: 'trip', name: 'Where to stay', label: 'Lodging', hue: 80 },
  { id: 'tax', name: 'Tax paperwork', label: 'Admin', hue: 25, collapsed: true },
  { id: 'desk', name: 'Standing desk', label: 'Shopping', hue: 165 },
  { id: 'bread', name: 'Sourdough fixes', label: 'Cooking', hue: 105 },
  { id: 'bike', name: 'Bike commute', label: 'Local', hue: 215 },
  { id: 'sleeve', name: 'Laptop sleeve', label: 'Shopping', hue: 300 },
];

const TABS = [
  ['w1', 'work', 'Sprint 42 board', 'linework.app', 0, true],
  ['w2', 'work', 'PR #318: collapse tab groups', 'codehost.dev', 0, true],
  ['w3', 'work', 'Design review notes, Nov 17', 'pages.linework.app', 0],
  ['w4', 'a11y', 'Tab strip accessibility checklist', 'a11ynotes.dev', 3],
  ['w5', 'a11y', 'Focus order in tree views', 'a11ynotes.dev', 3],
  ['r1', 'read', 'How browsers schedule background tabs', 'enginenotes.dev', 2],
  ['r2', 'read', 'The case for boring typography', 'margins.blog', 4],
  ['k1', 'trip', 'Five slow days in Kyoto: a walking route', 'slowroutes.travel', 1, true],
  ['k4', 'trip', 'Kyoto 10-day weather', 'skycast.net', 6],
  ['k2', 'transit', 'Kansai Airport to Kyoto Station by train', 'railnotes.jp', 1],
  ['k5', 'transit', 'Haruka express timetable', 'railnotes.jp', 3],
  ['k3', 'stay', 'Machiya stays near Gion, Apr 3 to 8', 'staywell.com', 1, true],
  ['k6', 'stay', 'Ryokan etiquette for first-timers', 'staywell.com', 5],
  ['t1', 'tax', 'Estimated payments worksheet', 'ledgerly.com', 11],
  ['t2', 'tax', 'Home office deduction rules', 'ledgerly.com', 12],
  ['d1', 'desk', 'Standing desks compared: eight frames tested', 'benchmarked.io', 0],
  ['d2', 'desk', 'Oak desktop, 160 by 80 cm', 'northwood.shop', 1],
  ['d3', 'desk', 'Cable tray, under-desk', 'northwood.shop', 3],
  ['s1', 'bread', 'Why is my crumb gummy?', 'loafclinic.com', 7],
  ['s2', 'bread', 'Starter feeding ratios', 'loafclinic.com', 8],
  ['b1', 'bike', 'Riverside path closures, November', 'citycycle.org', 2],
  ['b2', 'bike', 'Commuter lights compared', 'benchmarked.io', 4],
];

const ARCHIVE = [
  ['a1', 'sleeve', 'Wool felt sleeves, 14 inch', 'feltworks.shop'],
  ['a2', 'sleeve', 'Sleeve sizing chart', 'feltworks.shop'],
];

export function mockArchive(now = Date.now()) {
  return ARCHIVE.map(([id, groupId, title, domain]) => ({
    id, groupId, title, url: `https://${domain}/`, favIconUrl: '', at: now - 21 * DAY,
  }));
}

export function mockSnapshot(now = Date.now()) {
  const groups = {};
  GROUPS.forEach((g, i) => {
    groups[g.id] = { parentId: null, pinned: false, collapsed: false, ...g, order: i + 1 };
  });
  return {
    type: 'state',
    groups,
    spaces: [
      { id: 'home', name: 'Home', groups, archiveCounts: { sleeve: ARCHIVE.length } },
      {
        id: 'side', name: 'Side project', archiveCounts: {},
        groups: { shop: { id: 'shop', name: 'Shop launch', label: 'Launch', hue: 200, parentId: null, pinned: false, collapsed: false, order: 1 } },
      },
    ],
    active: { 1: 'home' },
    tabs: [...TABS, ['x1', 'shop', 'Shopping cart checklist', 'launchpad.dev', 1]].map(([key, groupId, title, domain, idle, pinned], i) => ({
      id: i + 1,
      key,
      ws: key === 'x1' ? 'side' : 'home',
      windowId: 1,
      index: i,
      title,
      url: `https://${domain}/`,
      favIconUrl: '',
      pinned: !!pinned,
      active: key === 'w3',
      lastAccessed: now - idle * DAY - 1000,
      groupId,
      pending: false,
    })),
    archiveCounts: { sleeve: ARCHIVE.length },
    auto: true,
    ai: true,
    sorting: false,
    error: '',
  };
}

// What the sidebar of window 1 hands buildView for a snapshot.
export function shownIn(snap) {
  const here = snap.spaces.find((s) => s.id === snap.active[1]);
  return {
    tabs: snap.tabs.filter((t) => t.windowId === 1 && (t.ws == null || t.ws === here.id)),
    groups: here.groups,
    archiveCounts: here.archiveCounts,
    ws: here.id,
    spaces: snap.spaces,
    allTabs: snap.tabs,
  };
}
