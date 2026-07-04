---
name: verify
description: How to run and drive the Earthquake CLI app to verify frontend/backend changes end-to-end.
---

# Verifying Earthquake CLI changes

## Launch

- `npx wrangler dev --port 8787` (background). **Port 8787 is often already
  taken by the user's own dev server** — check first with
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/`. wrangler
  dev serves `public/` assets live from disk, so an already-running server
  picks up frontend edits with a browser reload; confirm with
  `curl -s localhost:8787/styles.css | grep <new-thing>`.
- Local D1 usually already has data (the user's dev DB). If empty:
  `npx wrangler d1 migrations apply earthquake-db --local`, then
  `curl -X POST localhost:8787/admin/ingest -H "Authorization: Bearer $(grep ADMIN_TOKEN .dev.vars | cut -d'"' -f2)"`.

## Drive

- **Frontend (browser GUI)**: Playwright works. Install the library in the
  scratchpad (`npm i playwright@<installed-version>` — browsers are already in
  `~/Library/Caches/ms-playwright`; check `npx playwright --version` for the
  matching version). Load `http://localhost:8787/`, wait for `.status--open`
  (WebSocket connected), then `page.click("#terminal")` +
  `page.keyboard.type("list")` + Enter to run commands. Wait ~2s after a
  command for the round trip + map `fitBounds` ease before screenshotting.
- Useful selectors: `#term-window` (floating terminal window, classes
  `.maximized`/`.minimized`), `#term-titlebar` (drag handle), `#term-help` /
  `#term-min` / `#term-max` (window buttons), `#term-dock` (restore chip when
  minimized), `#help-modal` + `#help-close` (guide), `.status__label`
  (connection text).
- The guide modal auto-opens on a fresh browser profile (no `eq-guide-seen`
  in localStorage) — close it first (`#help-close`) or clicks on the terminal
  will be intercepted. Commands whose reply carries map features (`list`,
  `search`, `nearby`, …) auto-minimize the terminal — restore via `#term-dock`
  before typing the next command.
- **Backend (WebSocket)**: any WS client; send
  `{"type":"input","line":"list --mag>6"}` to `ws://localhost:8787/ws`, read
  the `{type:"output",text,mapData}` reply.

## Flows worth driving

- `list` → table in terminal + circles plotted on the map behind it.
- Window management: maximize/restore (`#term-max`, titlebar dblclick),
  minimize → dock chip → restore, titlebar drag (clamped to viewport,
  re-clamped on browser resize), typing still works after each transition.
- `export csv` → triggers a browser download; `richter 6.5`, `help` are cheap
  no-map commands.

## Gotchas

- The map basemap needs `PROTOMAPS_KEY` in `.dev.vars`; without it points plot
  on a plain dark canvas (still verifiable).
- xterm runs with a transparent background — visual transparency regressions
  only show in screenshots, not in the DOM.
