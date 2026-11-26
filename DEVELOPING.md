# Trying a change without deploying it

Only the web app's `/exec` URL needs a deployment (a version). Everything else runs the
latest saved code ("HEAD"). Three levels, fastest first:

## 1. Local, seconds: `node tools/dev.mjs`

The real `index.html` and `Sidebar.html`, the real `Code.gs` on the in-memory Sheets model
(`test/code.mjs`; a model, not the real service). Edit a file, reload the page.

    npm install --no-save marked dompurify    # once, only for --offline
    node tools/dev.mjs [--offline] [--latency 200] [--lan] [--port 8787] [--reset]

| URL | What |
|---|---|
| `/` | the app, as `/exec`; sample cards: long answers, tabs, svg, live frame |
| `/framed` | the app in a frame like Apps Script's (other origin, `sandbox`); `?block=1` also forbids navigating the top window: the update banner instead of the auto reload |
| `/sidebar`, `/sidebar?mode=window` | Flash > Preview at its real size; pick the row on the left |
| `/__dev/version?v=X` | "X was just deployed": the open app should update itself |
| `/__dev/fail?fn=updateCard&n=3` | the next 3 calls of a function fail (offline, quota) |

`google.script.run` is replaced by `fetch`, with Apps Script's refusal of Dates and functions.
The sheet is kept in `.dev/sheet.json`; cards come from `tools/dev-fixtures.mjs`
(`--reset` reseeds). `--lan` opens it on a phone (plain http: no clipboard API).

Not proven locally: `IMAGE()`, emoji styling, number formats, Drive thumbnails, the real
sandbox, CSV download, the YouTube embed, quotas. Use level 2 for those.

## 2. Real Apps Script, no version: `node tools/dev-push.mjs`

Pushes a copy of the files (with a `-dev.<time>` version stamp; the repo is untouched) to the
**HEAD** of a script, then prints the web app's `/dev` URL. The Flash menu runs HEAD too.
An open `/dev` tab sees the new version and updates itself.

    node tools/dev-push.mjs                  # dev: a copy of your spreadsheet
    node tools/dev-push.mjs --target prod    # your real sheet; asks first (--yes to skip)
    node tools/dev-push.mjs --restore        # push the files as in the repo (clean HEAD)

- dev: File > Make a copy of the spreadsheet (its script is copied too), then save
  `{"scriptId": "<Script ID>"}` in `.clasp.dev.json` (Project Settings of the copy).
- prod: `.clasp.json`. HEAD changes, `/exec` does not; rating a card in `/dev` writes your
  real data, viewing cards and the preview does not.
- `/dev` opens for editors only. clasp uses your environment (`HTTPS_PROXY` for a VPN).

## 3. Release: the deploy workflow (`/exec`)

Commit (the pre-commit hooks stamp the version), then run the `deploy` workflow: `/exec` moves to
a new version.
