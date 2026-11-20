# Rolltop Browser

A Firefox sidebar that groups, labels and archives tabs for you.

- **Groups by topic.** With an Anthropic API key, Claude files each tab into a named group ("Kyoto in spring"), nests sub-topics, and reuses existing groups. Without a key, tabs are grouped by website and nothing leaves the machine.
- **Search.** Finds open and archived tabs and groups. Each group also carries a one-word label from the classifier ("Trip", "Shopping"), shown and matched only in search.
- **Auto-tidy.** A group whose tabs have not been visited for 8 hours collapses (configurable), pinned groups included. Untouched tabs fade after 2 days, and after 5 they fold away behind a "Show older" row in their group; this applies in Pinned too. In Browsing they are archived after 14 days (configurable). Archived tabs are closed but stay searchable and can be reopened into their group. Closing a tab any other way archives it too.
- **Favorites.** Pinned tabs sit in a grid at the top, in rows of one to six. Drag a tab or a pinned tile over the grid and the tiles make room: drop it within a row, or on a row's top or bottom edge to start a new one. 
- **Pinned and Browsing.** Below Favorites the list has two sections with a line between them. Pinning a top-level group moves it, with everything nested in it, up into Pinned; dragging a group beside one on the other side moves it across too. Pinned is yours: nothing fades or archives, and the classifier cannot file tabs there, add or rename groups, or move a tab out when it navigates. New tabs are always sorted into Browsing.
- **Right-click.** A tab row or pinned tile opens Firefox's own tab menu with **Archive tab** and **Move to group** added. A group row offers Rename, Pin, Collapse and Archive; the ellipsis on the row opens the same actions. A group you rename keeps its name, and a tab you move stays where you put it, whatever the classifier thinks.
- **Middle-click.** A tab row or pinned tile closes that tab; a group row closes the group. Both are archived, so they can be reopened.
- **Drag and drop.** Drag a tab onto a group to move it, or beside another tab to place it. Drag a group onto another to nest it (up to three levels), or to its top or bottom edge to reorder.

## Run it

```sh
npm install
npm run build
```

Then in Firefox open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick `extension/manifest.json`. Open the sidebar with the toolbar button or Alt+Shift+T. Temporary add-ons are removed when Firefox quits.

`npm start` does the same in a throwaway profile through `web-ext`. It launches the installed Firefox, which applies any update Firefox has staged.

Settings (API key, model, archive age) are under the add-on's Preferences, or right-click the toolbar button and choose **Rolltop settings**.

## Hide the native tab strip

Extensions cannot remove Firefox's own tab bar. To hide it, set `toolkit.legacyUserProfileCustomizations.stylesheets` to `true` in `about:config`, then add this to `chrome/userChrome.css` in your profile folder and restart:

```css
#TabsToolbar { visibility: collapse !important; }
#sidebar-header { display: none !important; }
```

## Layout

| Path | What it is |
|---|---|
| `extension/` | The loadable extension. `dist/background.js` is built. |
| `extension/lib/model.js` | Turns tabs and groups into the rows the sidebar renders. |
| `extension/lib/plan.js` | Applies a classifier's plan to the group tree; site-based fallback. |
| `src/background/core.js` | Tab tracking, classification queue, archive, auto-tidy. |
| `src/background/classify-ai.js` | The Claude request. |
| `test/` | `npm test`. `test/harness/` renders the sidebar with sample data in any browser: serve the repo root and open `/test/harness/?w=300`. |

## What is sent to the API

Only when a key is set, and only for tabs that need sorting: the tab's title, its address without the query string or fragment, and your existing group names with up to six tab titles each. Private windows are not included.
