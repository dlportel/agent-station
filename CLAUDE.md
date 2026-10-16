# Working on Agent Station

## What is where

- `page/office.html` is the whole station page: one self-contained file, published as a claude.ai
  artifact. `page/themes/space.js` is its default theme and the reference for writing one.
- `plugin/` is the `agent-station` Claude Code plugin: its hooks module (`hooks/register.ts` and
  the files it imports), its tests (`tests/`) and the guided setup skill (`skills/setup/`).
- `demo/` is the live demo on GitHub Pages: it loads `page/office.html` from this repo, with
  `demo/data.js` standing in for the station's database.
- `docs/reference.md` explains the station in detail; the README covers installing and using it.

## Branches and releases

Work happens on the branch `dev`. `main` receives one commit per version: when a version is ready,
`dev` is squash-merged into `main` as a single commit named after the version, tagged `vX.Y.Z` and
published as a GitHub release. Never push intermediate commits to `main`, and never force-push
without the maintainer's explicit consent.

The version lives in two places that must stay equal: `plugin/.claude-plugin/plugin.json` and
`plugin/hooks/version.ts`.

## Before a change is done

- Plugin: `claude plugin validate plugin` and `claude plugin test plugin` pass.
- Page: check the change at a wide desktop (1600 px), a narrow window (900 px) and a phone
  (375 px), in English and in Spanish (`?lang=es` in the demo). Serve the repo locally
  (`python -m http.server`) and open `/demo/`. When the page starts reading or writing data in a
  new way, update `demo/data.js` so the demo keeps working.
- Prefer the simplest change that works. A fix that adds state, waits or special cases for a
  rare problem is usually not worth it. No new dependencies without asking.

## Writing

- Code, identifiers, comments, tests, commit messages and docs are in English.
- Text the station shows in Spanish lives only in its dictionaries, keyed by the English text:
  the `ES` table in `page/office.html` and `plugin/hooks/locale-es.ts`.
- Docs describe how the station works now, not how it changed; the history belongs in commit
  messages.
- Nothing in this repo names a company, a client, a person's private data or a private URL.
