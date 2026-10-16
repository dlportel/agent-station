---
name: setup
description: Create a new agent station from a clone of claude-agent-station - publish its page as a claude.ai artifact with its database, record its alias, add its URL to this plugin's stations option and open it. Use when the user asks to set up, create or install a station.
---

# Set up an agent station

Create the user's station from the clone of claude-agent-station this session runs in. Explain each
step to the user in one line as you go, and ask before anything they have not asked for. The user
approves each publish and each write as usual.

## 1. Check where you are

- The working directory must be a clone of claude-agent-station: it holds `page/office.html` and
  `page/themes/space.js`. If it does not, tell the user to open this session in their clone (the
  one they will use as the coordination repo, next to their other repos) and stop.
- Find this plugin's id with `claude plugin list`: the entry named `agent-station`, for example
  `agent-station@claude-agent-station`. If there is more than one `agent-station`, tell the user
  that only one copy may be installed per computer and stop.

## 2. Ask two things

- The station's name (default `STATION`).
- Its language: English (`en`, the default) or Spanish (`es`).

## 3. Publish the page

Publish `page/office.html` with the Artifact tool as a new artifact:

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
- If you cannot find or confirm the uuid, go on without it and tell the user, at the end, that
  the station works but its guard only knows its main URL.

## 5. Write the first configuration

With ArtifactData, `set` the document `config/departments` on the station's URL (it is new, so no
`if_version`):

```json
{ "title": "<name>", "language": "<en|es>", "aliases": ["https://claude.ai/code/artifact/<uuid>"] }
```

Leave `aliases` out when step 4 found no uuid.

## 6. Point the plugin at it

- Read the plugin's current options: `claude plugin configure <plugin id> --json`. If `stations`
  already lists URLs, keep them and add the new one after a `;`.
- Save the list:
  `echo '{"stations":"<url>[;<url>…]"}' | claude plugin configure <plugin id> --values-stdin`

## 7. Hand over

Open the station with the Artifact tool (`action: "open"`) and tell the user, in this order:

1. In the station, CONFIGURE opens by itself: add your repos by their origin remote, this clone
   among them. This clone is chosen as COORDINATION by itself. Choose a deck for each room and
   save. Describe what each room's agent does under SETTINGS: the agents read it.
2. Run `/reload-plugins` in the sessions you have open (or restart the Claude app).
3. Send this session a message: it is the coordination session, and that starts the dispatcher.
   Keep it open; after restarting the Claude app, send it a message again.
4. Open sessions in your other repos: each appears as a robot in its room.
