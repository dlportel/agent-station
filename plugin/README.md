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
  (`SendMessage`, `send_message`) asks you first, since work between sessions, also of the same repo, goes
  through orders you approve. A write to an artifact the plugin cannot tell apart from a station asks you too.
  Everything else passes unchanged.
- **Its own station calls** (`tool.check`, `classic.PreToolUse`): the plugin reports to the
  stations in its `stations` option with the ArtifactData tool, and approves only those calls of
  its own, while they are in flight, so that a report never opens a permission dialog and auto mode
  does not deny it. An agent's call to the same tool gets the normal permission flow.
- **The propose_order tool** (`tool.call`): `propose_order` is a tool the plugin registers itself,
  so it answers that call itself: it writes the proposed order to the station, where it waits for
  your approval. The coordination session also gets `find_repos`, which looks for the station's
  repos on the machine again, and `mark_folder_room`, which writes a folder room's mark when you
  ask for it.
- **A prompt** (`prompt.submit`): it adds the station's map as context for the model, and nothing
  else; the prompt itself passes unchanged.
- **A permission prompt** (`classic.PermissionRequest`): it marks the session as waiting for
  your permission on the station and passes the request on unchanged. It never decides it.
- **Notices and the session's lifecycle** (`classic.Notification`, `turn.complete`, session
  start and end): it reads them to show the session's state (working, waiting for your answer,
  idle) on the station.

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
  session). With KEEP AWAKE on, it also starts one background `Bash` command, which only writes a
  heartbeat file once a minute, and stops it with `TaskStop` when KEEP AWAKE goes off.

### Programs it runs

With fixed arguments, never through a shell:

- `git`, to read a repo's origin remote and top folder (`git remote get-url origin`,
  `git rev-parse`).
- `hostname`, to name the machine when the environment does not.
- In the coordination session, `gh` and `glab`, when they are installed, to list each repo's open
  issues (`issue list`) and check that they have a login (`auth status`). On GitHub it also lists a
  repo's labels and creates `To Do` and `Doing` when the repo lacks them (`label list`,
  `label create`), once, and never changes a label that exists. It changes no issue.

### Files it reads and writes

- It reads `~/.claude/settings.json` for its own `stations` option only, each station repo's
  `.claude/agents` folder for the names and descriptions of its subagents, and the file
  `.agent-station` of a folder with no git remote (a session's folder and the folders above it,
  and the folders the dispatcher looks in), which marks a folder room.
- It writes `~/.claude/agent-station-logs/<session>.log`, the last 200 lines of how the session
  joined its station and of failed station writes, so you can send it when a machine keeps
  dropping out; and, with KEEP AWAKE, the keeper's heartbeat in the same folder.
- In the coordination session, it writes a folder room's mark, `.agent-station` (the station's URL
  and the room's id), in the folder you set for that room on that computer, or when you ask with
  `mark_folder_room`. It never writes one in a folder that is a git repo with a remote or that
  carries another room's mark, and it refuses paths on a network share.

### Credentials

It reads no credential. `gh` and `glab` use their own login (`gh auth login`, `glab auth login` or
`GITLAB_TOKEN`), which the plugin never reads, copies or writes.
