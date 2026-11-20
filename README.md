# Tidy

A Firefox sidebar that groups, labels and archives tabs for you.

- **Groups by topic.** With an Anthropic API key, Claude files each tab into a named group ("Kyoto in spring", label "Trip"), nests sub-topics, and reuses existing groups. Without a key, tabs are grouped by website and nothing leaves the machine.
- **Auto-tidy.** Untouched tabs fade after 2 and 5 days and are archived after 14 (configurable). Archived tabs are closed but stay searchable and can be reopened into their group. Closing a tab any other way archives it too.
- **Pins.** Pinned tabs sit in a grid at the top. A pinned group, and everything nested in it, never fades or archives.
- **Right-click.** A tab row or pinned tile opens Firefox's own tab menu with **Archive tab** and **Move to group** added. A group row offers Rename, Pin, Collapse and Archive. A group you rename keeps its name, and a tab you move stays where you put it, whatever the classifier thinks.
- **Middle-click.** A tab row or pinned tile closes that tab; a group row closes the group. Both are archived, so they can be reopened.
- **Tags.** Click the tag beside a group's name to change it: pick one already in use or type a new one. It changes that group only, and the classifier leaves it alone afterwards.
- **Drag and drop.** Drag a tab onto a group to move it, or beside another tab to place it. Drag a group onto another to nest it (up to three levels), or to its top or bottom edge to reorder.

## Run it

```sh
npm install
npm run build
```

Then in Firefox open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick `extension/manifest.json`. Open the sidebar with the toolbar button or Alt+Shift+T. Temporary add-ons are removed when Firefox quits.

`npm start` does the same in a throwaway profile through `web-ext`. It launches the installed Firefox, which applies any update Firefox has staged.

Settings (API key, model, archive age) are under the add-on's Preferences, or right-click the toolbar button and choose **Tidy settings**.

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
