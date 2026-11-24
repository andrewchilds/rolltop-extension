# Rolltop Browser

A Firefox sidebar that groups, labels and archives tabs for you.

- **Groups by topic.** With an Anthropic API key, Claude files each tab into a named group ("Kyoto in spring"), nests sub-topics, and reuses existing groups. Without a key, tabs are grouped by website and nothing leaves the machine.
- **Workspaces.** The sidebar shows one workspace at a time, each with its own Favorites, Pinned and Browsing and its own archive. The name in the footer opens the list: switch, add, rename, or merge the one on show into its neighbour. Switching hides the other workspaces' tabs rather than closing them, so they keep their history and keep playing. A tab's or group's ellipsis menu moves it to another workspace; a tab leaves its group behind and is sorted again there. Each window remembers which workspace it shows.
- **Search.** Looks in every workspace, and a result from another one says which; choosing it switches there. Finds open and archived tabs and groups. Each group also carries a one-word label from the classifier ("Trip", "Shopping"), shown and matched only in search.
- **Auto-tidy.** A group whose tabs have not been visited for 8 hours collapses (configurable), pinned groups included. Untouched tabs fade after 2 days, and after 5 they fold away behind a "Show older" row in their group; this applies in Pinned too. In Browsing they are archived after 14 days (configurable). Archived tabs are closed but stay searchable and can be reopened into their group. Closing a tab any other way archives it too.
- **Favorites.** Pinned tabs sit in a grid at the top, in rows of one to six. Drag a tab or a pinned tile over the grid and the tiles make room: drop it within a row, or on a row's top or bottom edge to start a new one. 
- **Pinned and Browsing.** Below Favorites the list has two sections with a line between them. Pinning a top-level group moves it, with everything nested in it, up into Pinned; dragging a group beside one on the other side moves it across too. Pinned is yours: nothing fades or archives, and the classifier cannot file tabs there, add or rename groups, or move a tab out when it navigates. New tabs are always sorted into Browsing.
- **Right-click.** A tab row or pinned tile opens Firefox's own tab menu with **Archive tab** and **Move to group** added. A group row offers Rename, Pin, Collapse and Archive; the ellipsis on the row opens the same actions. A tab row or pinned tile also has an ellipsis, shown on hover, with Add to (or Remove from) Favorites, Rename and Close tab. A group you rename keeps its name, and a tab you move stays where you put it, whatever the classifier thinks.
- **Middle-click.** A tab row or pinned tile closes that tab; a group row closes the group. Both are archived, so they can be reopened.
- **Backups.** Settings has **Download backup**, a file holding every workspace with its groups, tabs and archive, and Rolltop keeps a snapshot from each of the last seven days it was used. Restoring either replaces every workspace without closing a tab: open tabs go back to their places, and the backup's tabs that are not open go to the archive. What was there before is kept as a snapshot.
- **Move to another browser.** Settings has **Export workspace**, which saves the open tabs of the workspace on show and their groups to a file, and an import for that file. Importing adds to what is there: groups with the same name are merged, a tab already open in its group is skipped, and tabs open unloaded until you visit them (pinned tabs load). Archived tabs and settings are not in the file.
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

## Firefox fork

The fork is a separate checkout at `../rolltop-browser`: Mozilla's `esr153` branch with Rolltop's changes on a local branch named `rolltop`. `origin` there is `git@github.com:andrewchilds/rolltop-browser.git`; Mozilla's repository, `https://github.com/mozilla-firefox/firefox`, is the `upstream` remote.

**The `rolltop` branch exists only on this machine.** Until it is pushed to a remote of your own, deleting the checkout loses the fork's commits.

### Build and run

```sh
cd ../rolltop-browser
./mach build faster && ./mach run
```

`build faster` covers JS, CSS and XHTML edits. Use `./mach build` after changing a `moz.build`, a `mozconfig`, or after a rebase. `./mach run` uses a throwaway profile in `obj-rolltop/tmp/profile-default`, separate from your real Firefox profile.

On a new machine: clone, check out `rolltop`, run `./mach --no-interactive bootstrap --application-choice browser_artifact_mode`, then recreate the local `mozconfig` below.

### The bundled extension

The fork ships this extension as a built-in add-on. `browser/extensions/rolltop/extension/` in the fork is a built copy of `extension/` here, committed there so the fork builds on its own. Do not edit the copy. After changing the extension:

```sh
npm run fork:sync                 # build, then copy extension/ into the fork
cd ../rolltop-browser
./mach build faster && ./mach run
```

Then commit the refreshed copy in the fork. Set `ROLLTOP_FIREFOX` if the checkout is somewhere other than `../rolltop-browser`.

Firefox hides built-in add-ons from `about:addons`, so Rolltop's settings are reached from the toolbar button's right-click menu. The button sits in the extensions panel (puzzle-piece icon) by default.

### uBlock Origin

The fork ships uBlock Origin as the signed file from addons.mozilla.org, in `browser/extensions/rolltop/distribution/`. The build puts it in the app's `distribution/extensions/`, and Firefox copies it into each new profile on first run. From then on it is an ordinary add-on: it is listed in `about:addons`, updates itself from addons.mozilla.org, and can be disabled or removed. A removed copy is not reinstalled.

Existing profiles pick it up the first time they run a build with a new Firefox version. For `./mach run`, delete `obj-rolltop/tmp/profile-default` to get it straight away.

The bundled copy only decides which version a new profile starts on. To refresh it:

```sh
npm run fork:ublock               # download the latest signed release into the fork
cd ../rolltop-browser
./mach build faster
```

Then commit the new file in the fork. To ship another add-on the same way, add its signed `.xpi`, named `<add-on ID>.xpi`, to that directory and list it in the `moz.build` there.

uBlock Origin does not run in private windows until that is allowed in its `about:addons` entry.

### Branding

The logo source is `branding/rolltop-logo.svg`. `npm run fork:brand` rasterizes it into `browser/branding/rolltop/` in the fork: window icons, the macOS app icon (`Assets.car` and `firefox.icns`), Windows `.ico` files and the about-page logo. It needs macOS with Xcode and ImageMagick. Commit the regenerated files in the fork.

Error pages (no connection, page not found, certificate errors) show the logo in place of Mozilla's illustrations. The fork's branding `jar.mn` points their URLs at `about-logo.svg`, and `rolltop-neterror.css` sets its size.

The product name is set in that directory's `configure.sh` and `locales/en-US/brand.ftl` and `brand.properties`.

Still Mozilla's Nightly artwork, copied from `browser/branding/unofficial`: the document and disk-image icons, the DMG background, the Windows installer bitmaps and MSIX tiles, and the private-browsing icons. Replace them before distributing.

### Window chrome

The fork hides the native tab strip, trims the toolbar to back, forward, reload, the address bar and the menu, opens the Rolltop sidebar by default without its header, draws the page as a rounded card, and reopens the previous session's tabs on startup (`browser.startup.page` is `3`; Firefox's default restores only pinned tabs).

| What | Where in the fork |
|---|---|
| Styles | `browser/branding/rolltop/content/rolltop.css` |
| Default prefs | `browser/branding/rolltop/pref/firefox-branding.js` |

Upstream files the fork edits, which are where a rebase can conflict:

| File | Edit |
|---|---|
| `browser/extensions/moz.build` | Adds the `rolltop` directory. |
| `browser/themes/shared/browser-shared.css` | Imports `rolltop.css`. |
| `toolkit/themes/shared/aboutNetError.css` | Imports `rolltop-neterror.css`. |
| `browser/components/tabbrowser/content/tabbrowser.js` | Hides the tab strip when `rolltop.hideTabStrip` is set. |
| `browser/components/extensions/parent/ext-tabs.js` | A built-in add-on hiding tabs gets no warning popup and no all-tabs button: Rolltop hides the tabs of workspaces that are not on show. |
| `browser/components/customizableui/CustomizableUI.sys.mjs` | Drops the flexible spaces and the account button from the default toolbar. |

Toolbar defaults and the sidebar-open default only apply to a new profile. `./mach run` keeps its profile between runs; delete `obj-rolltop/tmp/profile-default` to see defaults again.

### What the fork turns off

Default prefs in `browser/branding/rolltop/pref/firefox-branding.js` turn off telemetry upload and the data-reporting notice, studies and remote experiments, crash report submission, sponsored and recommended content (new tab, address bar, add-ons manager), trending searches in the address bar, Mozilla's default new-tab tiles and search-engine shortcuts, the AI chatbot, link previews and smart tab groups, promotions for other Mozilla products (VPN, Focus, mobile, Relay, Monitor), Firefox accounts and Sync, and Firefox's onboarding, tours and post-update pages. `rolltop/mozconfig-release` also builds without the updater and the crash reporter.

Still talking to Mozilla, on purpose:

- **Remote Settings** (`firefox.settings.services.mozilla.com`): certificate revocation, the add-on blocklist, search engine config and tracking-protection lists. Turning it off makes the browser less safe.
- **Captive-portal and connectivity checks** (`detectportal.firefox.com`).
- **addons.mozilla.org**, when you install or update add-ons.
- **Media codec downloads** (OpenH264, Widevine) on first use.

Missing until Rolltop has its own keys: Google Safe Browsing (phishing and malware warnings), which needs a Google API key built in. Mozilla's own builds have one; this fork does not, so those warnings are not active.

Artifact builds still contain Mozilla's updater. It finds no updates on this build's channel, but it does ask.

### Build config

| File | Tracked | Holds |
|---|---|---|
| `rolltop/mozconfig` | yes | Options every build shares. |
| `mozconfig` | no (upstream ignores it) | Sources the file above and adds local options. |

The local `mozconfig`:

```sh
. "$topsrcdir/rolltop/mozconfig"
ac_add_options --enable-artifact-builds
```

For a full build, source `rolltop/mozconfig-release` instead and drop the artifact line. It adds `--with-app-basename=Rolltop`, which names the binary and the profile directory after Rolltop. Artifact builds cannot use it, so they are named Rolltop but run Mozilla's `firefox` binary and, outside `./mach run`, would use the regular Firefox profile directory. The release config has not been built yet.

`--enable-artifact-builds` downloads Mozilla's compiled binaries, so builds take about two minutes and only front-end changes take effect. A build you give to anyone else must be a full build: remove that line. Expect about an hour and 40 GB of disk the first time.

### Security releases

Mozilla ships security fixes to ESR every four weeks, and occasionally in between when a bug is being exploited. The dates are at <https://whattrainisitnow.com> and the fixes at <https://www.mozilla.org/security/advisories/>. Each advisory tells attackers where the bugs are, so take every release soon after it lands:

```sh
cd ../rolltop-browser
git fetch origin esr153
git rebase origin/esr153 rolltop
./mach build && ./mach run
```

Check `browser/config/version_display.txt` for the new version, and that the browser starts and the sidebar loads.

If the rebase stops on a conflict, it is in an upstream file the fork edited. Resolve it by reapplying the fork's few lines on top of upstream's new version, then `git rebase --continue`. `git rebase --abort` returns the branch to where it was.

`esr153` stops receiving fixes about three months after the next ESR branch appears, roughly a year after 153 shipped. Moving to the next ESR is the same rebase onto the new branch, with more conflicts.

### Keeping rebases cheap

- Put the fork's own files (prefs, stylesheets, modules) under `rolltop/`.
- Edit an upstream file only to reference one of those files, in as few lines as possible.
- One commit per change, so a conflict points at one feature.

## Layout

| Path | What it is |
|---|---|
| `extension/` | The loadable extension. `dist/background.js` is built. |
| `extension/lib/model.js` | Turns tabs and groups into the rows the sidebar renders. |
| `extension/lib/plan.js` | Applies a classifier's plan to the group tree; site-based fallback. |
| `extension/lib/workspace.js` | The workspace file: checks one being imported and merges its groups into the tree. |
| `extension/lib/store.js` | The stored document: its storage keys, loading (and reading version 1's data), backups and snapshots. |
| `src/background/core.js` | The document of workspaces, groups and tab records; binding open tabs to their records; classification queue, archive, auto-tidy, export, import and restore. |
| `src/background/classify-ai.js` | The Claude request. |
| `test/` | `npm test`. `test/harness/` renders the sidebar with sample data in any browser: serve the repo root and open `/test/harness/?w=300`. |

## Where things are stored

Everything is in the extension's `storage.local`, which Firefox keeps in the profile under the extension's ID. Changing the ID orphans it.

| Key | Holds |
|---|---|
| `meta` | The store version, the order of the workspaces and the one last chosen. |
| `ws:<id>` | One workspace: its name, its group tree and a record for each of its open tabs (address, title, group, name, whether it is a favorite and where). |
| `archive:<id>` | That workspace's archived tabs. |
| `snap:<day>`, `snap:before-restore` | Backups of all of the above: one per day of use, seven kept, and the state before the last restore. |
| `settings`, `log` | The settings, with the API key, and the sorting log. |
| `legacy-v1` | What the single-workspace version stored, copied aside when it was converted. |

A save writes only the keys whose content changed. If one fails, the sidebar says so and it is tried again.

An open tab carries one thing, in Firefox's session store: the `uid` of its record. A window carries the id of the workspace it shows. After a restart each tab is matched to its record by uid; a tab that lost its uid is matched by address. A record whose tab is not open goes to the archive with its uid, so a tab the browser brings back later (undo close, a restored window, a session restored late) gets its group, name and place again. Groups are removed only when nothing in the stored document, open or archived, is filed in them; what the browser reports as open at startup plays no part.

Firefox does not hide a pinned tab, so the favorites of a workspace that is not on show are unpinned in the tab strip while hidden and pinned again when it is shown. Their records keep them favorites throughout.

## What is sent to the API

Rolltop, the fork and the extension, collects no usage data. Neither reports to a server of ours, so we never see or have access to browsing activity, in standard or private windows. The settings page says so under "Privacy". The only request the extension makes is the one below, to Anthropic, under the user's own key; what the fork still fetches from Mozilla is listed under "What the fork turns off".

Only when a key is set, and only for tabs that need sorting: the tab's title, its address without the query string or fragment, and your existing group names with up to six tab titles each.

Tabs in private windows are never sorted, by Claude or by website, whether or not a key is set. Rolltop keeps no record of them, so they are also absent from the archive, the sorting log and workspace files. The settings page says so under "Private windows".
