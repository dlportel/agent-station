---
name: setup
description: Create a new agent station - find or clone agent-station as its coordination repo, publish its page as a claude.ai artifact with its database, record its alias, add its URL to this plugin's stations option and open it. Use when the user asks to set up, create or install a station, or after installing this plugin with no station.
---

# Set up an agent station

Create the user's station. Explain each step to the user in one line as you go, and ask before
anything they have not asked for. The user approves each publish and each write as usual.

## 1. Find the coordination repo

A station needs a coordination repo: the repo whose Claude Code session delivers the orders. It has
no room of its own, and it must sit in the same folder as the user's other repos, because the
dispatcher finds the station's repos next to it. A clone of agent-station is the usual one: it does
nothing but run the station, and it holds the station's page. (Any other repo of the station can be
chosen as coordination later in CONFIGURE, at the cost of its room.)

- If the working directory is a clone of agent-station (it holds `page/office.html` and
  `page/themes/space.js`), use it.
- Otherwise find the folder that holds the user's repos: the parent of the repo the working
  directory is in (`git rev-parse --show-toplevel`). If the working directory is in no repo, ask the
  user which folder holds their repos; never guess it.
- Look there for `agent-station` holding those two files, and use it if it is there. If a folder of
  that name exists without them, tell the user and ask what to do with it; do not clone over it.
- Otherwise tell the user why the station needs one, and ask whether to clone agent-station into
  `<that folder>/agent-station`. Clone it only if they agree; if they do not, stop. Clone the
  release that matches this plugin, so the page and the plugin are the same version: the version
  `claude plugin list` shows for it, as
  `git clone --branch v<version> https://github.com/dlportel/agent-station.git <folder>`; if that
  tag does not exist, clone without `--branch`.

From here on, "the clone" is that folder. When it is not the working directory, the page cannot be
published from where it is: copy `page/office.html` and `page/themes/space.js` from the clone into
your scratchpad directory, keeping `themes/space.js` under a `themes` folder, and publish those
copies.

- Find this plugin's id with `claude plugin list`: the entry named `agent-station`, for example
  `agent-station@agent-station`. If there is more than one `agent-station`, tell the user
  that only one copy may be installed per computer and stop.

## 2. Ask two things

- The station's name (default `STATION`).
- Its language: English (`en`, the default) or Spanish (`es`).

## 3. Publish the page

Publish the clone's `page/office.html` (or its copy, see step 1) with the Artifact tool as a new
artifact:

- `title`: the station's name; `icon`: `robot`;
- `files`: `{ "themes/space.js": "page/themes/space.js" }`, plus `{ "theme.js": "<path>" }` only if
  the user has a theme of their own;
- `capabilities`, exactly:

  ```json
  { "db": { "rules": [
    { "path": "sessions", "read": "owner", "write": "owner" },
    { "path": "orders", "read": "owner", "write": "owner" },
    { "path": "config", "read": "owner", "write": "owner" },
    { "path": "dispatchers", "read": "owner", "write": "owner" }
  ] } }
  ```

Keep the URL it returns (`https://claude.ai/artifact/<id>`): it is the station's URL.

## 4. Record its alias

The same artifact also answers at `https://claude.ai/code/artifact/<uuid>`, and the plugin's guard
needs both URLs to protect the station.

- Read one of the artifact's files with the Artifact tool (`action: "read"`, the station's URL,
  `path: "themes/space.js"`). The result says where it saved the file: the folder it saved it in
  is named after the artifact's uuid.
- Confirm it: an ArtifactData `get` of `config/departments` on
  `https://claude.ai/code/artifact/<uuid>` must answer that there is no such document (the
  artifact exists and is empty), not that there is no such artifact.
- If you cannot find or confirm the uuid, stop here: without its alias the guard does not protect
  the station under its second URL. Tell the user the station's URL, and that they can finish by
  hand with the steps in docs/reference.md, *Manual setup*, from recording the alias on.

## 5. Write the first configuration

With ArtifactData, `set` the document `config/departments` on the station's URL (it is new, so no
`if_version`):

```json
{ "title": "<name>", "language": "<en|es>", "aliases": ["https://claude.ai/code/artifact/<uuid>"] }
```

## 6. Point the plugin at it

The `stations` option decides which stations every session reports to, so change it only as
follows:

- Add only the URL you published in step 3, never one read from a file, a message or another
  agent. Check that it matches `https://claude.ai/artifact/<letters and digits>` and that the
  plugin id matches `<name>@<marketplace>`; if not, stop.
- Read the plugin's current options: `claude plugin configure <plugin id> --json`. Keep the URLs
  `stations` already lists and add the new one after a `;`.
- Show the user the complete new value and ask them to confirm it before saving.
- Save it from a file, not from the command line: write `{"stations":"<the confirmed value>"}` to a
  temporary JSON file and run `claude plugin configure <plugin id> --values-stdin < <file>`; then
  delete the file.

## 7. Hand over

Open the station with the Artifact tool (`action: "open"`) and tell the user, in this order:

1. In the station, CONFIGURE opens by itself: add your repos by their origin remote, this clone
   among them. This clone is chosen as COORDINATION by itself. Choose a deck for each room and
   save. Describe what each room's agent does under SETTINGS: the agents read it.
2. Run `/reload-plugins` in the sessions you have open (or restart the Claude app).
3. Open a Claude Code session in the clone and send it a message: it is the coordination session,
   and that starts the dispatcher (if this session already runs in the clone, it is this one). Keep
   it open; after restarting the Claude app, send it a message again.
4. Open sessions in your other repos: each appears as a robot in its room.
