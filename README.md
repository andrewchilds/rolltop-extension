# Rolltop Browser

A Firefox sidebar that groups, labels and archives tabs for you.

With an Anthropic API key, Claude sorts each tab into a named group. Without a key, tabs are grouped by website and nothing leaves the machine.

## Run it

```sh
npm install
npm start
```

This builds the extension and opens it in Firefox with a throwaway profile. Open the sidebar with the toolbar button or Alt+Shift+T.

To load it into your own Firefox, run `npm run build`, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick `extension/manifest.json`.

Settings, including the API key, are under the toolbar button's right-click menu: **Rolltop settings**.

## Develop

```sh
npm test            # run the tests
npm run watch       # rebuild on change
npm run fork:sync   # copy the built extension into the Firefox fork at ../rolltop-browser
```

## Privacy

Rolltop collects no usage data. When an API key is set, tab titles, addresses (without query strings) and group names are sent to Anthropic for sorting. Tabs in private windows are never sorted or recorded.
