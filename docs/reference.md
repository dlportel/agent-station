# Reference

How the station works in detail: what the page draws, what the configuration holds, what each
agent is told, who may read and write what, and how orders travel. The [README](../README.md)
covers installing and using it.

## The page

A working robot's pose follows its last tool (reading, editing, a terminal, the web, delegating
to a subagent, or thinking between tools), with a dialog box over it saying what it does and what
it touches. A robot that starts working walks from where it was in its room to its desk. The plugin
keeps that line deliberately small: a file's name without its folder, a search pattern, a
command's program and its first plain word (never flags, paths, quotes or values), a site's host.
A waiting robot shows whether it asks for a permission (`!`) or asks you a question (`?`). Each
room chooses its robots' silhouette, chassis colour and antenna in CONFIGURE. A room with more than
six subagents keeps them in a drone cabinet, one lit slot each (empty while the drone is out), which
opens the full list with a shortcut to give each one an order.

On a desktop screen (1100 px wide or more) the rooms sit on a grid so that the whole station fits
the window without scrolling. The columns are equal, as many as the screen is wide for, each the
narrowest a room is worth at the robots' scale. A room takes one cell, or as many side by side as
its robots and furniture need, and is as tall as its contents; the rooms of a line share their
height and nothing is stretched to fill the window. The lines fill up in order, a deck that does
not fit at the end of a line going on in the next under its label again. The robots get the
largest scale (4, 3, then 2) at which the station, drawn and measured, fits the window's height.
When none does, the station flows deck under deck and the page scrolls, as on a phone. On the grid
the legend sits at the foot of the bridge, which scrolls on its own; the bridge can be folded away
(BRIDGE), which the browser remembers. The rooms are drawn in the order of the station's repo
list, moved up and down with ▲ and ▼ in CONFIGURE: within a deck its rooms follow that order (the
canteen and the hangar keep their place), and the decks follow their first room. They reach the
grid through one ordered list (`arrangedDecks`). The
plugin writes at most one report every 20 seconds, so the pose shows the latest tool at that
moment, not every tool call.

## The configuration

`config/departments` is one JSON document:

| Field | What it is |
|---|---|
| `repos` | The station's repos by origin remote, one per entry: `{ "remote": "github.com/org/repo", "folder": "dept" }` makes that repo the department `dept` (or the repo's own name without `folder`). A remote ending in `/*` takes every repo directly under that group, each as a department named after the repo. `"issues": false` on an entry leaves its repo's issues (or those of every repo of the group) off the station: the dispatcher stops reading them when its session reloads, and the page hides a single repo's at once (a group's rooms follow the dispatcher). |
| `title` | The station's name, shown on the page and in every order it sends. |
| `language` | `en` (also when the field is missing) or `es`: the language of everything the station says, to people and to agents. The page, the map each session gets, the orders delivered, the dispatcher's notes on them, the coordination's notes and its command (`/coordinator`, or `/coordinador` in Spanish). The page and the plugin are written in English; the Spanish of each text lives in a dictionary, the page's `ES` and the plugin's `hooks/locale-es.ts`, and a text missing there is said in English. What the station's own config holds (room names, places, deck labels, descriptions) is shown as written. |
| `theme` | The station's scenery. `space` (stars and planets, from `themes/space.js`) is the default, used when the field is missing or names a theme that is not loaded. A station adds its own themes in a `theme.js` published next to the page (see *Themes* in the README). A theme changes only the scenery, never the robots, the rooms or what the page does. |
| `coordination` | The department whose sessions act as coordination: they run the dispatcher and may write orders and this document. |
| `departments` | Each room: `name`, `place`, `accent`, `wall`, `floor`, `furniture`, `accessory`, `weight` (width), fallback `agents`. |
| `layout` | Rows of rooms: `{ "label": "ROW", "items": ["dept", "#canteen", "#hangar"] }`. Departments not placed in a row are shown after them. Every station also has two shared rooms: `#canteen`, where robots idle for a while go to rest (and to sleep in the small hours), and `#hangar`, where they go to recharge on its pads. A row can place them; one placed in no row is shown after the rows. |
| `offStation` | The shared rooms taken off the station (`["#canteen"]`, `["#hangar"]` or both), chosen in CONFIGURE as "(not on the station)". A station without them simply has no such visits. |
| `senders` | Which department each `from-*` handoff label stands for, to colour its notes. |
| `aliases` | Other URLs the same artifact answers at (`https://claude.ai/code/artifact/<uuid>`). Not part of a template: each station writes its own. |

The page's **CONFIGURE** button edits the title, the theme, the language, the coordination repo and the repos, one
row per repo (its remote and its room's deck). Its **DECKS** section edits the layout:
it renames, adds and removes decks, and places the shared rooms on a deck or off the station; each
repo row chooses its room's deck. A deck left with no rooms is not saved, and a room on no deck is
shown after the decks, under OTHERS. Each row's **SETTINGS** button opens its room in a
panel beside it, with a live preview: the room's visible name, its folder (the identifier the
agents use, the repo's name unless set), what its agent does, the place, the accessory its robots wear, the accent colour,
the wall colour, the floor, the width and the furniture. A repo added with **+ ADD REPO** starts with a look of its own, a kind of room
(floor, furniture and accessory) in one of the accent colours, so new rooms do not all come out
alike; a repo whose room the station already has keeps that room's look. Saving starts from the station's config
as it is at that moment, so a change made meanwhile elsewhere is kept, and only what the panel
changed is written over it. Removing a repo removes its room and its place in the layout (shared
rooms such as `#canteen` stay; nothing is removed while a `/*` row may still bring repos in), and
the page stops showing that repo's sessions, even those opened before the change that still
report. Two
repos cannot share a department, and a `/*` row takes no department: each of its repos gets its
own room. Closing with unsaved changes takes a second press. The coordination is chosen among the station's repos, and its row shows COORDINATION
instead of a deck and a style, since it has no room. When no dispatcher is running, the bridge
says to open a session in the coordination repo and send it a message, or, with no coordination
chosen, to choose one in CONFIGURE.

The panel needs no Claude session and no plugin, and the page reads a malformed config without
breaking, so it is also the way to repair a broken configuration. When the page is published with
a `seed.json` next to it, an empty station opens the panel
with **START FROM THE TEMPLATE**, which fills in what the station lacks without overwriting what it
has, and the panel offers **+ ADD FROM THE TEMPLATE** for the template's repos the station does
not have, each with its room. A template never changes a station by itself, and never brings
`aliases`.

## What an agent knows about the other rooms

Every session of a station gets, with its first message (and again after /clear or a compaction, which drop it), a map built from its station: the rooms with
their folder and name, what each room's agent does (the room's `description`, set in CONFIGURE as
WHAT ITS AGENT DOES), how to ask another room for work with `propose_order` (folder, text and
reason, and optionally the `session_id` that must receive it), and that the same tool returns the
result of an order received from another room. An order's text takes up to 20,000 characters and
its reason up to 1,000, on the page as in `propose_order`: a longer one is refused whole with its
length, never cut, so a room never acts on half an order. It also says that the coordination session is no
go-between: nobody writes to it to ask for work, return a result or forward anything. It leaves out the other rooms' subagents: how to do a task, and with which subagent, is
for the room that takes it to decide. `propose_order` still takes an `agent`, for when the user
asks for a particular one. A room's own subagents need no map: Claude Code loads the repo's
`.claude/agents` itself.

The map goes out again whenever the session loads its plugins anew (`/reload-plugins`, an update,
a restart of the app). A room without a description shows in the map as not described, and
CONFIGURE marks it until it has one.

A session reads its station's config once, when it joins it (at its start or after
`/reload-plugins`), and builds from it both the map and the list of rooms in `propose_order`'s
description. A room added, removed or renamed in CONFIGURE afterwards does not reach the sessions
already open: they keep the map they got and tell the agent the room does not exist, and a
`/clear` resends that same old map. Each open session that should see the change needs
`/reload-plugins` and then a message, which carries the new map; sessions opened later see it on
their own.

## Who reads and writes what

Each station's database has owner-only rules (`read: owner`, `write: owner` on `sessions`,
`orders`, `config` and `dispatchers`). The claude.ai server enforces them, so only the artifact's
owner, and the sessions running under that same account, can read or write a station.

| Who | Reads | Writes |
|---|---|---|
| The plugin, in each session | `config/departments` of every station in `stations` | Its own document in `sessions`, in the station it belongs to |
| The page, opened by the owner | Everything | Orders (create, edit a proposal's text, approve, reject, discard, resend) and `config/departments` |
| Agents | May read the station | Nothing directly: they propose orders with `mcp__agent-station__propose_order`, which wait for approval on the page |
| A coordination session | Everything | Orders and `config/departments` of its own station, and republishing its own station page, asking the user each time |
| The dispatcher (inside a coordination session) | Orders and sessions | Order status, `config/agents`, `config/handoffs`, `config/models` and its lease in `dispatchers`; it also closes the session documents of sessions the app no longer has, deletes closed ones after 7 days and finished orders after 30 |

A session belongs to the first station in `stations` whose `repos` include the origin remote of
its repo, read with git when the session starts. While an earlier station in the list has not
answered, the session waits for it instead of landing on a later one. A station that does not
answer is asked again at once, then after 1, 5 and 15 minutes; one that does not exist, or that
this account cannot read, counts as answered with no repos. A session in no station's repos, or
outside a git repo, is ignored for its whole life: the plugin never writes anywhere but that one
station.

The guard keeps agents off every configured station, matching the artifact by its id across its
URL and its `aliases`:

- an `ArtifactData` write to a station is refused, except the coordination session's own writes
  to orders and `config/departments`, which ask the user;
- republishing or deleting a station page with the `Artifact` tool is refused, except the
  coordination session on its own station, which asks the user;
- an `ArtifactData` write the guard cannot place asks the user instead of passing: a URL that
  names no artifact it can read, or a `claude.ai/code/artifact/<uuid>` URL while some station has
  not answered yet (its aliases are still unknown);
- a message from a station session straight to another Claude Code session of the app
  (`SendMessage` to a `local_…` session, or the app's `send_message`) asks the user, since work
  between rooms goes through `propose_order` and its approval. Messages to the session's own
  subagents pass.

The plugin's own station calls (its reports, the dispatcher's work, `propose_order`) never ask
for permission, in any mode: the plugin approves exactly the `ArtifactData` calls it has in flight
on its station, and every call of the agent gets the verdict of the session's rules and mode as
usual. It approves them in the engine's `tool.check` event, with `classic.PreToolUse` as a
fallback for apps that do not raise it. Approving them in `PreToolUse` alone is not enough: in auto
mode the call still goes to the classifier, and a classifier that gives no verdict denies it.

A station whose `aliases` were never recorded is guarded only by its main URL, so recording them
(step 3 of the README's quick start) matters. The plugin only observes: every event is handed on unchanged, writes
run in the background with a timeout and a failed report is sent again. After three failures in
a row the status line shows `station: no connection (<error>)` and the report is retried after
30 s, 1 min, 2 min and then every 5 minutes; the first write that goes through clears the status,
and the session, and in the coordination session the dispatcher, carry on as before. Every failed
write, and the reconnection, is written as one line (time, session, room, action, error) to
`~/.claude/agent-station-logs/<session>.log`, one file per session (so sessions never overwrite each
other's lines), each keeping its last 200 lines: those files are what to send when a machine keeps
dropping out of the station.

The plugin runs with the Claude desktop app on **Windows** and **macOS**. It writes paths in the
machine's own form (`C:\work\app` or `/Users/me/work/app`), finds the user's home in `USERPROFILE`
or `HOME`, and names the machine from `COMPUTERNAME`, `HOSTNAME` or the `hostname` command. The
dispatcher delivers orders and lists sessions through the desktop app's own tools
(`ccd_session_mgmt`), so on Linux, which has no desktop app, sessions still report to the station
and agents can propose orders, but no dispatcher can deliver them.

## Orders and the dispatcher

Each order names a department or a session, a model (or keeps the session's), and where it runs:
an open session, a new session, or either. One coordination session per station and machine holds
the dispatcher lease and checks the pending orders every 30 seconds. For an open session it picks
an idle one of that department on that machine, switches its model if the order asks for another,
and sends it the order as a message. A new session cannot be created from a plugin, so the
dispatcher leaves a task card in the coordination session and the order shows as waiting for your
click, first among the pending orders on the bridge, where it can also be discarded. The card's
message ends with the order's mark, `[agent-station order <id> for <folder>]`. The session the card
opens finds the mark at the very end of its first message and records that order as its
`fromOrder`, and the dispatcher delivers the order to that session only (an open session of the
same machine), never to another one that happens to start in the room meanwhile. If two sessions
claim the same order, it fails rather than going to either. If the card is run in a
session of another room (for example with "do it here" in the coordination session), that session
is told the order is not for it and not to carry it out, and the order fails with a note saying so.

Every minute the dispatcher also compares the sessions the station lists for its machine with the
ones the desktop app still has. A session the app deleted or archived is closed with that reason
(`endReason`), and the page takes it off the station at once, desk and list row included; a
session that ended on its own keeps an empty desk for three hours. This only covers the machine
of the dispatcher, and only while a coordination session is open there: a session deleted on a
machine without one stays on the station. The same pass deletes session documents closed more
than 7 days ago; finished orders are deleted after 30 days, checked every five minutes.

An order that is waiting for your click, failed or was delivered can be resent from its detail on
the page, as it is or with another destination. It goes back to the queue with its attempt number
raised and the trace of its last delivery cleared, and the dispatcher handles it as a new order.
Before resending a delivered order the page says which session got it, since it may already be
done. From the second attempt on, the card's mark carries the attempt
(`[agent-station order <id>#<attempt> for <folder>]`) and the dispatcher only takes the session
that recorded that attempt, so the card of an earlier attempt, opened later, never takes the order.
An order for one particular session goes to the machine of that session; any other order
is taken by the first dispatcher that sees it, on whichever machine, so with several machines it
may open a new session on one even when another has an idle session of that department.

An order for one particular session reaches it even while it works: the message waits for the end
of its turn. If the user chose that session on the page (mode `existing`), it goes nowhere else
and fails when the session is gone. A reply goes back to whoever asked: when a session proposes an
order for a department whose order it received, `propose_order` points the new order at the
session that sent that one (or at the one the agent names in `session_id`), with mode `any`. The
dispatcher then tries that session, then the department's idle sessions, then a new one; a session
the app no longer has, or one that refuses the message, passes the order to the next. The page
shows the session a proposal goes back to before you approve it.

The message a session receives says how to answer. An order another room proposed names that room
and the session that asked, and says to return the result with `propose_order` to that room, which
delivers it to that very session; when the order is itself the answer to one the session sent, it
says not to answer it with another order. An order of the user's says to tell the result to the
user in the session itself. Every order adds that the coordination session only hands orders out
and is never asked to forward anything. A message from another session that reaches the
coordination session carries the same reminder as context, so it points the sender to
`propose_order` instead of relaying; the user's `/coordinator` notices are still for it.

The desktop app replaces every at sign in a message between sessions with the full-width one
(U+FF20), so that an `@` never attaches a file in the session that receives it; a new session's
card keeps it. An order delivered to an open session whose text has an at sign ends with a note
saying so, and that code, SQL, email addresses and paths need the ordinary one.

The dispatcher finds the station's repos on its machine next to the coordination repo: every
sibling folder whose origin remote is in `repos`. It reads their `.claude/agents` into
`config/agents` when it starts, their open issues (the newest hundred of each repo, whatever their labels) into `config/handoffs` every fifteen
minutes, and it never opens a new session outside them. Each repo's issues are read with the tool
of the host in its remote: `gh` for github.com, `glab` for a host with "gitlab" in its name, and,
for any other host, `glab` too when it has a login for that host (a GitLab of your own under
another name). A repo on a host that is neither takes only orders. When a room's handoffs cannot
be read, `config/handoffs.problems` holds why, in the station's language, and the list on the
bridge shows it: the tool is not installed on the dispatcher's machine, it has no login for that
host, the host has no handoffs, or listing the repo failed (with the tool's error). A missing tool
or login also shows as a notice in the coordination session when it is found, and is checked once per host while the dispatcher lives, since neither changes on its own;
reloading the coordination session checks again. A failed listing is tried again at the next scan,
and meanwhile the room keeps the handoffs of the last good one. Only the rooms read in a scan count
for the issues that closed, so a room that cannot be read, or whose issues were turned off, never
shows its issues as closed. `config/handoffs.views` holds each room's command to read one issue,
with `<n>` for its number. If the station refuses to save the catalog, the coordination session
shows a notice once and the boards keep the last list.

The map tells each session how to open a handoff in every room's repo, with the command of that
repo's host (`gh issue create --repo …` or `glab issue create -R https://…`), names the rooms that
take only orders, and says that when the tool is missing or has no login the agent tells the user
and asks for the work with an order meanwhile, never writing a token anywhere. An open handoff,
opened from its department's board or from the list on the bridge, has **ASSIGN TO AN AGENT**: it
opens the order form for that department, filled in with the instruction to read the issue with
its host's command, handle it and close it with the commit or the pull or merge request that
resolves it; the user picks the agent, the session and the model, and the order keeps the issue it
came from (`handoff`).
`/coordinator <message>` sends a note to the station's coordination session on the same machine.

## What a change reaches

A session reads the configuration when it starts (and again only while a station has not
answered), and the dispatcher scans the repos on its machine once, when it takes the lease. A repo added to `repos` is reported from its next session
on; sessions already open keep their decision until `/reload-plugins` or a restart. A repo cloned
away from the coordination repo still reports its sessions, but the dispatcher neither reads its
agents nor opens new sessions in it.

## Manual setup

What `/agent-station:setup` does, step by step, for doing it by hand or when the command is not
available:

1. **Publish the station.** In a Claude Code session, ask Claude to publish `page/office.html` from
   this repo as a new artifact, titled with your station's name, with `page/themes/space.js` as the
   supporting file `themes/space.js`, and with the `db` capability and owner-only rules:

   ```json
   { "db": { "rules": [
     { "path": "sessions", "read": "owner", "write": "owner" },
     { "path": "orders", "read": "owner", "write": "owner" },
     { "path": "config", "read": "owner", "write": "owner" },
     { "path": "dispatchers", "read": "owner", "write": "owner" }
   ] } }
   ```

   To start from a template, publish your own `seed.json` next to it (see `examples/seed.json`).

2. **Record the station's aliases.** The same artifact also answers at
   `https://claude.ai/code/artifact/<uuid>`. Ask Claude to read the published artifact to learn that
   uuid and to write `{ "aliases": ["https://claude.ai/code/artifact/<uuid>"] }` into the database
   document `config/departments`. The plugin then recognises the station under both URLs.

3. **Point the plugin at it.** Set the station's URL in the plugin's `stations` option (several
   stations are separated by `;`), with `/plugin configure agent-station@agent-station`, and
   run `/reload-plugins` in the sessions you have open.
