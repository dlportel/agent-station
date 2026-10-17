# agent-station plugin

Reports each Claude Code session of a station's repos to that station, gives every session a map
of the station's rooms, and lets agents propose work to each other, which you approve on the
station page. The project, the live demo and the full documentation are in the
[agent-station repository](https://github.com/dlportel/agent-station).

To start, run `/agent-station:setup`. Until a station is set up, the plugin only shows a notice
saying so, once per session.

## What it does on your machine

This section lists everything the plugin does beyond reading the conversation's events, so you can
check it before installing.

### Its hooks, and what they decide

- **Before a tool runs** (`tool.call`, `classic.PreToolUse`): it never lets an agent write to a
  station's database or republish a station page (it denies those calls, and the coordination
  session's own station writes ask you). A message from an agent to another Claude Code session
  (`SendMessage`, `send_message`) asks you first, since work between repos goes through orders you
  approve. A write to an artifact the plugin cannot tell apart from a station asks you too.
  Everything else passes unchanged.
- **Its own station calls** (`tool.check`, `classic.PreToolUse`): the plugin reports to the
  stations in its `stations` option with the ArtifactData tool, and approves only those calls of
  its own, while they are in flight, so that a report never opens a permission dialog and auto mode
  does not deny it. An agent's call to the same tool gets the normal permission flow.
- **The propose_order tool** (`tool.call`): `propose_order` is a tool the plugin registers itself,
  so it answers that call itself: it writes the proposed order to the station, where it waits for
  your approval.
- **A prompt** (`prompt.submit`): it adds the station's map as context for the model, and nothing
  else; the prompt itself passes unchanged.
- **Notices and the session's lifecycle** (`classic.Notification`, `turn.complete`, session
  start and end): it reads them to show the session's state (working, waiting for your permission
  or answer, idle) on the station. It never decides a permission.

### What it sends, and where

Only to the station artifacts you list in its `stations` option, on your own claude.ai account:
each session's title, room, machine name, model, state, the name of the tool it is running with a
short detail (a file's name, a command's first word, a search pattern, a site's host), its active
subagents, and the orders and proposals you or your agents create. Nothing is sent anywhere else.

### Tools it calls itself

- **ArtifactData**, on its own stations only, to report and to read the station's configuration.
- In every session, the desktop app's `get_session` on the session itself, for its title, model
  and link; and `send_message` when you send the coordination session a note with
  `/coordinator`.
- In the **coordination session** only, the desktop app's session tools: `list_sessions` (to see
  which sessions are open), `send_message` (to deliver an order you approved), `set_session_model`
  (when an order asks for another model) and `spawn_task` (to leave a card that opens a new
  session).

### Programs it runs

With fixed arguments, never through a shell:

- `git`, to read a repo's origin remote and top folder (`git remote get-url origin`,
  `git rev-parse`).
- `hostname`, to name the machine when the environment does not.
- In the coordination session, `gh` and `glab`, read-only, to list each repo's open issues
  (`issue list`) and check that they have a login (`auth status`), when they are installed.

### Files it reads and writes

- It reads `~/.claude/settings.json` for its own `stations` option only, and each station repo's
  `.claude/agents` folder for the names and descriptions of its subagents.
- It writes only `~/.claude/agent-station-logs/<session>.log`: one line per failed station write,
  so you can send it when a machine keeps dropping out of the station.

### Credentials

It reads no credential. `gh` and `glab` use their own login (`gh auth login`, `glab auth login` or
`GITLAB_TOKEN`), which the plugin never reads, copies or writes.
