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

Orders and handoffs each have a full list, opened from the bridge (SEE ALL under RECENT ORDERS, SEE
THEM ALL in OPEN HANDOFFS, and a room's board, which opens it filtered by that room). It shows every item the page holds,
newest first, fifteen to a page with the range and the page number, a filter (an order's state, a
handoff's room) and a text search that ignores case and accents and needs every word typed: over an
order's text, reason, note, room, agent, branch, state, the session it reached and the one that
proposed it, and over a handoff's number, title, description, room, who asked and labels. The list is
built from the data the page already has, so it needs no extra reads. On the bridge, OPEN HANDOFFS
shows the five newest of each room and a link to the rest.

A handoff's state while it is open is one label at most, the same in every station: `To Do` while
nobody is on it, as a new issue starts, and `Doing` while someone or a session works on it. What
comes once its work is done belongs to each project's own instructions, not to the station: a label
of the team's own for work that waits to reach production (such as `Pending production`), which the
page shows as one more of the handoff's labels, or closing the issue. The page shows a handoff as
DOING when any of these holds: an order of the station made from it (`handoff.number` on the order) is
pending, waiting for its click, being picked up or delivered; its issue has `Doing`, or a name
teams give it (`in progress`, `wip`, `working`, `en curso`, `en progreso`, with or without a
`status:` prefix), which the dispatcher keeps as `progressLabel`; or its issue is assigned to
someone (`assignees`, up to three). Otherwise it is TO DO. The chip on each row and the handoff's
detail say which signs it has, each room's heading and its board count the ones being done, and the
full list filters by state. `To Do` and `Doing` are left out of the labels a handoff shows. A label that says a handoff is urgent (`urgent`, `urgente`, `critical`, `crítico`, `blocker` or `p0`, with or without a `priority:` prefix) is drawn in red, its handoffs go first in their room's list on the bridge, and the room's board counts them.

On GitHub, an issue takes only labels its repo has, so the dispatcher creates `To Do` and `Doing`
in each repo that lacks them, once, and never changes one that exists.
GitLab creates a label the first time it is added to an issue.

A handoff also shows its issue's own labels (`labels`, up to eight), such as the area or the
component it is about, so the handoffs of one repo can be told apart: every label but `handoff`,
the `from-*` one and the in-progress one, which the station already reads. They show next to the
state on each row and in the detail, and the text search finds them.

The dispatcher reads the open issues every fifteen minutes. ↻ UPDATE, in OPEN HANDOFFS and in the
full list of handoffs, writes the time to `config/refresh` (`handoffsAskedAt`); the dispatcher
checks that document every fifteen seconds and, when the time changed, reads the issues at once, so
the new list arrives a few seconds after the click. The button
shows UPDATING… until the new list arrives (or for three minutes at most), its tooltip says when
the list was last read, and with no dispatcher running it says that the list will be read when the
coordination session wakes up.

On a desktop screen (1100 px wide or more) the rooms sit on a grid so that the whole station fits
the window without scrolling. The columns are equal, as many as the screen is wide for, each the
narrowest a room is worth at the robots' scale. A room takes as many cells side by side as its
robots and furniture need, times its width (`weight`: 1 narrow, 1.2 normal, 1.4 wide), and a very
wide room (1.6 or more) takes a whole line of its deck, alone; it is as tall as its contents; the rooms of a line share their
height and nothing is stretched to fill the window. The lines fill up in order, a deck that does
not fit at the end of a line going on in the next under its label again. In automatic size the
station is drawn at one of the robots' scales (3, 2.5 or 2) under a zoom of its own, from 50% to
150% in steps of 5%, that takes everything with it, texts, signs and boards too. Of the plans that,
drawn and measured, fit the window's height without a line overflowing, it takes the one that
draws the station largest (its scale times its zoom), and at the same size the larger scale. So a
large window is filled, a short one shows it all, and the fine steps keep a room that spills into
one more line from throwing the station back a whole step. The plan in use is kept while it fits
in the same window, so opening a session moves nothing; a new window size looks for it afresh. The header's buttons are compact, so on a laptop they share the title's line
and leave the station that height.
Every try draws the whole station and measures it, so the search keeps the tries few: a scale
that fits at a zoom fits at every smaller one, so each scale's largest zoom is found by halving,
only among the zooms that would beat the best plan so far, and a scale whose smallest such zoom
does not fit is passed over after one try; a bridge that has to give way goes straight to the
size the station asks for. The fit found is kept in the
viewer's browser for that page version, window size, theme and decks, so a reload draws the station once.
The page draws the station once its data and its themes are in (or after 2.5 s), so it never shows
first in another theme; the template (`seed.json`) loads beside the rest, since only CONFIGURE needs
it. After that it redraws the station only when something it shows changes: a robot's state, tool,
title, model or subagents, an order's state, a room's handoffs or a deck. A session's event times,
the dispatcher's heartbeat or an order's text refresh the header and the bridge alone, so the rooms
are not rebuilt and their animations not restarted. While the order form is open, or the tab is
hidden, the station stays as it is and is redrawn once it can be seen again, if it changed; a
hidden tab still draws the header, which plays the alerts.
A fitted station then reaches down to the window's foot, its decks on top as they are and the
ground of its theme at the bottom.
On a short screen, such as a 16-inch laptop with the system scaled, that zoom goes below 100% and
the bridge keeps its size. Robots, capsules and tubes are placed in the station's own units, so they stay where they are
drawn at any zoom. So that the two never look too far apart, the bridge gives way too when the
station has to shrink a lot: it goes down to 90, 85 or 80%, its column narrowing with it, until the
station's drawn size (its scale out of 3, times its zoom) is at least 60% of the bridge's. When not even 50% fits, the station flows deck under deck and the page scrolls,
as on a phone. On the grid
the legend sits at the foot of the bridge, which scrolls on its own; the bridge can be folded away
(BRIDGE), which the browser remembers. The decks are drawn in the layout's order and the rooms
of a deck in the order of the station's repo list (the canteen and the hangar keep their place),
both moved up and down with ▲ and ▼ in CONFIGURE. Off the grid a room's width sets how much it
grows in its row, and a very wide room takes the row alone. They reach the
grid through one ordered list (`arrangedDecks`). The
plugin writes at most one report every 20 seconds, so the pose shows the latest tool at that
moment, not every tool call.

The header shows the page's version beside the station's title, amber when the open sessions'
plugin is newer than the page, which means the page was not republished. The clock closes the
buttons' row, with the shift beside the hour (the hour alone on a narrow window) and a lamp that
lights up with each signal from the station and dims after five minutes without one; its tooltip
says when the last one came. Below the header there is a line only while the page connects or to
say what went wrong. The bridge's dispatch
console has a lamp for the dispatcher (green while it waits for orders, amber while there are
capsules to deliver, red when no dispatcher runs), the number of capsules waiting and the queue
itself; its robot works at its desk while the dispatcher runs, watching its screen while it waits for
orders and typing while there are capsules to deliver. Beside it a small support robot hovers while
orders are awaited, carries each capsule from the queue to the coordinator while it delivers, and
lands switched off when no dispatcher runs.

SOUND (off by default, kept in the browser) sounds only what really happens: a robot waiting for
your OK, a robot starting to work, a new robot, a new order, a new handoff, an order delivered and
work finished. However many handoffs one update of the catalog brings, they sound once: one sound
for a single new handoff, another for several, and the coordinator's support robot hops for twelve seconds (or until it is clicked) under a sign
saying how many came. A robot's start of work sounds once every two minutes at most. The robots' walks and lift rides are silent, and so is the first read of each list
when the page opens.

## The configuration

`config/departments` is one JSON document:

| Field | What it is |
|---|---|
| `repos` | The station's repos by origin remote, one per entry: `{ "remote": "github.com/org/repo", "folder": "dept" }` makes that repo the department `dept` (or the repo's own name without `folder`). A remote ending in `/*` takes every repo directly under that group, each as a department named after the repo. `"issues": false` on an entry leaves its repo's issues (or those of every repo of the group) off the station: the dispatcher stops reading them when its session reloads, and the page hides a single repo's at once (a group's rooms follow the dispatcher). An entry with no remote, `{ "folder": "dept", "local": "<id>" }`, is a folder room (see *Folder rooms*). |
| `title` | The station's name, shown on the page and in every order it sends. |
| `language` | `en` (also when the field is missing) or `es`: the language of everything the station says, to people and to agents. The page, the map each session gets, the orders delivered, the dispatcher's notes on them, the coordination's notes and its command (`/coordinator`, or `/coordinador` in Spanish). The page and the plugin are written in English; the Spanish of each text lives in a dictionary, the page's `ES` and the plugin's `hooks/locale-es.ts`, and a text missing there is said in English. What the station's own config holds (room names, places, deck labels, descriptions) is shown as written. |
| `theme` | The station's scenery. `space` (stars and planets, from `themes/space.js`) is the default, used when the field is missing or names a theme that is not loaded. A station adds its own themes in a `theme.js` published next to the page (see *Themes* in the README). A theme changes only the scenery, never the robots, the rooms or what the page does. |
| `coordination` | The department whose sessions act as coordination: they run the dispatcher and may write orders and this document. |
| `keepAwake` | `true` keeps the dispatcher's session awake with a background command (see *Keeping the dispatcher awake*). Off when missing. |
| `departments` | Each room: `name`, `place`, `accent`, `wall`, `floor`, `furniture`, `accessory`, `weight` (width: 1 narrow, 1.2 normal, 1.4 wide, 1.6 a line of its own), fallback `agents`. |
| `layout` | Rows of rooms: `{ "label": "ROW", "items": ["dept", "#canteen", "#hangar"] }`. Departments not placed in a row are shown after them. Every station also has two shared rooms: `#canteen`, where robots idle for a while go to rest (and to sleep in the small hours), and `#hangar`, where they go to recharge on its pads. A row can place them; one placed in no row is shown after the rows. |
| `departments["#canteen"]`, `departments["#hangar"]` | The shared rooms' own look, set from SHARED ROOMS in DECKS, where each has a row with its deck (or not on the station) and SETTINGS, which opens its panel beside the configuration as a repo's room has it: `name`, `place` (the line under the name), `accent`, `wall` and `floor`. A field left out keeps the theme's. |
| `offStation` | The shared rooms taken off the station (`["#canteen"]`, `["#hangar"]` or both), chosen in CONFIGURE as "(not on the station)". A station without them simply has no such visits. |
| `senders` | Which department each `from-*` handoff label stands for. |
| `aliases` | Other URLs the same artifact answers at (`https://claude.ai/code/artifact/<uuid>`). Not part of a template: each station writes its own. |

The page's **CONFIGURE** button opens the configuration in five tabs, with SAVE below them: GENERAL
(the title, the theme, the language, the coordination repo and KEEP AWAKE), REPOS (the repos and
their rooms, and each computer's places), FOLDERS (the folder rooms and their marks), DECKS and VIEW. VIEW is not part of the station's configuration: it is how this
browser draws the page, kept in its `localStorage` (`office-look`) and shown at once, with no SAVE,
so each screen has its own. It sets the station's size (automatic, the largest that fits, or a
fixed 50 to 150% of the robots' full size, the page scrolling when it does not fit), the bridge's
size (automatic or a fixed 70 to 130%), the dialogs' size (80 to 150%: an order, a robot's card, the
lists, the configuration), all with their texts, the light (by the clock, or always
day) and whether the legend, the bridge's station map and its recent orders show. It edits the title, the theme, the language, the coordination repo, KEEP AWAKE and the repos, one
row per repo (its remote, its room's visible name, which SETTINGS edits too, and its room's deck). Its **DECKS** section edits the layout:
it renames, adds and removes decks, and places the shared rooms on a deck or off the station; each
repo row chooses its room's deck. A named deck with no rooms yet is saved, and drawn once a room is
on it (a row with neither a name nor rooms is dropped), and a room on no deck is
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

A room on a deck whose repo is not in the repo list is drawn by the page, but the sessions' map and
`propose_order` go by the repo list alone, so nobody can ask it for work. Saving in CONFIGURE takes
such rooms off the decks, so only a configuration written elsewhere leaves one; the bridge and
CONFIGURE, REPOS then name them in amber, with what to do. A room's folder is, everywhere, its
row's `folder`, or the last part of its remote when the row has none.

### Folder rooms

A folder room is a room whose agents work in a folder that is no git repo. With no remote to be
known by, it is known by a mark: the file `.agent-station` inside its folder, which holds the
room's id (32 hex digits the page draws at random when the room is added with **+ ADD FOLDER
ROOM**, in CONFIGURE, FOLDERS) and, in the mark the coordination session writes, the station's URL. Only a folder with
that mark is the room, whatever its name, and a mark that names another station, or an id the
station does not have, is no room at all. In `repos` the room is `{ "folder": "dept", "local":
"<id>" }`; the folder takes only letters, digits, dot, hyphen and underscore, and the coordination
is never a folder room, since the dispatcher needs git. A folder room taken from a template gets a
new id, so two stations made from one template never share a mark.

Each row of CONFIGURE, FOLDERS has, under it, the folder's full path on each computer that runs a
dispatcher, kept in `config/places` as `folderRooms` (`{ "<computer>": { "<room>": "<path>" } }`),
apart from the configuration since paths belong to each computer; left empty, the folder is looked
for next to the coordination repo. On SAVE, the dispatcher of that computer goes to the folder set
for it and, if it has no mark, writes the room's: the path and the room come together from the
owner, so nothing is guessed. It never marks a folder that is not there, a git repo with a remote,
or one that carries another room's mark, and each row says, per computer, what it found (found,
not found, a repo, marked for another room). A mark can also be written by the coordination
session's `mark_folder_room` tool, by the folder's name next to the coordination repo or by its
full path (with the same refusals), or by hand with the text CONFIGURE, FOLDERS shows folded under
the rows, which names the room alone since the page cannot tell its own address. A session opened in that folder, or in a subfolder of it,
reads the mark when git says the folder has no origin, and joins the room; a folder with a remote
is always its repo's room, mark or not. The dispatcher finds the marked folder when it looks for
the repos, so orders reach the room and a new session opens in its folder. A folder room has no
handoffs and no branch: the map says so to every room, its own included, and an order starts with
no branch to start from.

### Places

The dispatcher of each computer looks for the station's repos and folder rooms next to the
coordination repo, and also in the places listed for that computer in `config/places`:
`{ "byMachine": { "<computer>": ["D:\\Clients\\*", "D:\\Projects\\notes"] } }`, keyed by
the computer's name as its dispatcher reports it. A path ending in `\*` (or `/*`) takes each folder
directly inside it, at most 300; any other path is that folder alone. Only full paths count, from a drive or the root, never a network path (a server's share would be handed the user's credentials), at most
50 per computer. The station's own configuration never holds a path, since each computer has its own
disks: each dispatcher reads only its computer's list. A place only says where to look. What each
folder is, its remote or its mark says, as next to the coordination repo, so a wrong or stale path
finds nothing and mistakes no folder for another room. The neighbours of the coordination repo are
looked at first, so a room keeps its folder there over a copy in a place.

CONFIGURE, REPOS edits the list under each computer of REPOS ON EACH COMPUTER (one path per line,
SAVE PLACES), and shows what each place gave on that computer's last scan: its rooms, or that it was
not found. Saving asks the dispatchers to look again at once. Places are kept in a document of their
own, so saving them never touches the configuration.

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
result of an order received from another room. A session asks another session of its own room
the same way, with its own folder: the order never goes back to the session that proposed it. An
order's text takes up to 20,000 characters and
its reason up to 1,000, on the page as in `propose_order`: a longer one is refused whole with its
length, never cut, so a room never acts on half an order. It also says that the coordination session is no
go-between: nobody writes to it to ask for work, return a result or forward anything. It leaves out the other rooms' subagents: how to do a task, and with which subagent, is
for the room that takes it to decide. `propose_order` still takes an `agent`, for when the user
asks for a particular one. A room's own subagents need no map: Claude Code loads the repo's
`.claude/agents` itself.

It also tells the session what handoffs are for its own room: the open issues of its repo, so that
"review the pending handoffs" means those issues, with the command that lists them on the repo's
host; its states (`To Do`, and `Doing`, which with someone assigned means it is taken and not to
be started); the command that marks one `Doing` and removes `To Do` before the agent starts it
without a station order; and, once its work is done, to remove `Doing` and finish it as the
project's own instructions say. Each room's command to open a handoff adds the label `To Do`. A room whose repo is
on a host without issues, or whose issues the station does not show (ISSUES: NO), gets none of it.

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
this account cannot read, counts as answered with no repos. In a folder git says is no repo or has
no `origin`, the session looks for a folder room's mark there and in the folders above it (see
*Folder rooms*). A session in no station's repos and under no mark is ignored while it stays in
that folder: the plugin never writes anywhere but that one station. The desktop app starts some new
sessions in a spare folder of its own (`~/.claude/spares/…`, `~/.claude-spares/…` in older
versions) and moves them to their project a moment later: nothing is decided in a spare folder,
and a session that moves to another folder works its station out again there, on its next event.
Each attempt makes the first message wait afresh, so the message sent from the project carries
the map even when the app keeps its spare sessions somewhere the plugin does not know. When git fails instead (it cannot run, times out or
ends with any other error), the remote is read again a minute later, and every minute after.

A session that cannot tell yet whether it belongs to a station, because git failed or a station
earlier in the list does not answer, tries again by itself every minute, without waiting for the
agent's next step. If its retry a minute later fails too, it says so once in a notice: the
reason, that it keeps trying, and that `/reload-plugins` starts it over. A station that does not
answer is named in the notice with its error (in auto mode, the classifier's refusal), since the
repo may belong to it. A reply that is neither the station's configuration nor a plain "there is
none" counts as no answer, never as an empty station.

Every attempt to join is logged when its outcome changes, under the app's id for the session from
the start (`~/.claude/agent-station-logs/<session>.log`, `action=join`): the folder it read, the remote git gave, each
station's answer in the order of `stations` (lists this repo, answered, or did not answer and why)
and where the session landed or what it waits for.

**Known case: an earlier station that does not answer holds back the later ones.** With two
stations in `stations`, a session whose repo is only in the second one does not join it while the
first does not answer, even if the second does. The plugin cannot tell that the first station
does not list the repo too until it answers, and joining the second meanwhile could put the
session in the wrong station. The session joins as soon as the first one answers; until then it
has no map, and after a minute it shows the notice. Order `stations` with the station that
answers most reliably first, or keep each machine's `stations` to the stations it works for.

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
  between sessions, also of the same room, goes through `propose_order` and its approval.
  Messages to the session's own subagents pass.

The plugin's own station calls (its reports, the dispatcher's work, `propose_order`) never ask
for permission, in any mode: the plugin approves exactly the `ArtifactData` calls it has in flight
on its station, and every call of the agent gets the verdict of the session's rules and mode as
usual. It approves them in the engine's `tool.check` event, with `classic.PreToolUse` as a
fallback for apps that do not raise it. Approving them in `PreToolUse` alone is not enough: in auto
mode the call still goes to the classifier, and a classifier that gives no verdict denies it.

Claude Code's built-in security plugin (Team and Enterprise accounts, managed settings) passes over
`tool.check`, every `classic.*` event and `session.compact` for plugins the user installed. The
plugin learns it from its first agent call that goes through with no `classic.PreToolUse`; until a
`classic.PreToolUse` arrives it acts as if they were passed over, so no confirmation is lost:

- the confirmations above are asked in `tool.call` with `$.ui.ask` (Allow / Deny); a dismissed
  question denies the call;
- a call that `$.tool.check` answers with `ask` marks the session as waiting for permission, only
  in the `default`, `acceptEdits` and `plan` modes, where that verdict is the one the user sees;
- a compaction is seen as fewer user prompts in the session (`$.session.turns()`) at the next
  message, which then carries the map again; `session.compact` does the same where it runs;
- the end of the session is taken from `session.end`, which is never passed over; a `/clear` does
  not end it, it only sends the map again.

The plugin's own approvals and KEEP AWAKE have no replacement: they need bypass permissions there.

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

The app does not say whether a session's process is still running, so a session closed without
reporting its end (the app quit, a crash, a computer switched off) stays on the station as
standing by. Such a robot is taken off by hand: DISCONNECT on its card, or DISCONNECT INACTIVE in
the session list, which takes every session with no activity for more than 24 hours. Disconnecting
closes the session's document with the reason `disconnected`, so it leaves the station at once and
gets no orders. A session that is still open comes back by itself: its next report writes its whole
document again, with its own state and no reason, and one whose document was deleted meanwhile
writes it anew.

An order that is waiting for your click, failed or was delivered can be resent from its detail on
the page, as it is or with another destination. It goes back to the queue with its attempt number
raised and the trace of its last delivery cleared (a branch taken from the checkout is read again;
one the order named stays), and the dispatcher handles it as a new order.
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
the app no longer has, or one that refuses the message, passes the order to the next. When the
session that asked has already ended when the reply is proposed, the order goes to the department
by its mode and keeps whom it answered (`replyGone`); the agent is told, so its text can explain
itself to whoever gets it. The page shows the session a proposal goes back to, or that it answers
one that no longer exists, before you approve it.

The message a session receives says how to answer. An order another room proposed names that room
(or says it comes from another session of the same room) and the session that asked, and says to return the result with `propose_order` to that room, which
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
sibling folder whose origin remote is in `repos`, and every sibling folder with no remote whose
mark names one of the station's folder rooms; then the same in the places listed for its computer
(see *Places*). The dispatcher's lease carries what each place gave (`places`). It reads their `.claude/agents` into
`config/agents` when it starts, their open issues (the newest hundred of each repo, whatever their labels) into `config/handoffs` every fifteen
minutes, and it never opens a new session outside them. It looks for the repos again, reading the
station's `repos` again first, only before failing an order for a room it does not find and on
request: the FIND REPOS button of CONFIGURE, REPOS (`config/refresh.reposAskedAt`), or the
coordination session's `find_repos` tool, which the user can ask it to use. So a repo cloned or
added to the station while the coordination session runs is found without restarting it. Each scan
goes on the dispatcher's lease (`dispatchers/<machine>.rooms` and `roomsScannedAt`), and CONFIGURE,
REPOS shows, per computer, the rooms found and the station's rooms with no clone there. Each repo's issues are read with the tool
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
opened from the list on the bridge or the full list, has **ASSIGN TO AN AGENT**: it
opens the order form for that department, filled in with the instruction to mark the issue
`Doing` first (with its host's command, which the dispatcher keeps in `config/handoffs` as
`marks`), read the issue with its host's command and handle it, and then remove `Doing` and
finish it as the project's own instructions say; left unfinished, it goes back to `To Do`; the user picks the agent, the session and the model, and the order keeps the issue it
came from (`handoff`).
`/coordinator <message>` sends a note to the station's coordination session on the same machine.

### Keeping the dispatcher awake

The dispatcher is a loop inside the process of the coordination session, and the app stops the
process of a session that has been idle for a while. With it stops the dispatcher: approved orders
wait until someone writes to the coordination session, which starts its process again. The app
does not stop a session that has background work, so with `keepAwake` on (KEEP AWAKE in CONFIGURE)
the session that holds the dispatcher lease keeps one. It works only when that session runs with
permissions bypassed: every session reports its permission mode (`permissionMode`), and while KEEP
AWAKE is on and the dispatching session is in another mode, the bridge and GENERAL in CONFIGURE say
that KEEP AWAKE does not work on that machine and why.

- **What runs.** A Bash command started by the plugin itself, in the background, that never ends
  and writes the time to a file every minute, its beat
  (`~/.claude/agent-station-logs/keeper-<session>.beat`). The whole loop is written in the command,
  never in a script it runs, so what is approved is all that runs. In auto mode the classifier
  refuses it, and no permission rule should let it through: KEEP AWAKE needs the coordination
  session with permissions bypassed. It costs no tokens, and since it never
  ends it never wakes the model.
- **How the plugin knows it is alive.** By its beat, not by what the app lists: a beat older than
  three minutes means the command ended (stopped by hand, or its session's process closed), and the
  plugin stops it, in case it is only frozen or hung, before it starts another within a minute; a
  beat that is fresh keeps it from starting a second one, also after a reload that lost the
  command's id. After the computer was suspended (a gap of more than three minutes between the
  plugin's own checks) the beat is not judged for ninety seconds, the time the keeper, frozen with
  the computer, takes to beat again. The plugin approves that exact command only while it is starting
  it, and the stop only while it is stopping it; the same command from an agent gets the normal
  permission flow.
- **When.** The dispatcher reads `keepAwake` every minute, so switching it takes effect without
  restarting the session: on, the plugin starts the command; off, it stops it with `TaskStop`. The
  plugin keeps the command's task id in the session's state (`$.state`, `keeperTaskIds`), which
  survives a reload of the plugin, so an update or `/reload-plugins` never starts a second one; the
  state ends with the session's process, as the command does. At the end of each turn the app lists
  the session's background work, and the plugin keeps one command and stops any other.
- **What it costs.** The app may count the session as busy while the command runs, and then its
  setting to keep the computer awake while Claude works keeps the computer from going to sleep on
  its own while the coordination session is open. A computer that sleeps anyway, or a closed app,
  stops the dispatcher as before. A session that loses the dispatcher lease to another one stops
  its command.
- **When it cannot start** (the Bash tool is missing or the call is refused), the coordination
  session says so once in a notice, with what to do when auto mode refused it, and its status line
  says so until the command runs. The plugin logs it in `~/.claude/agent-station-logs/<session>.log`,
  tries again ten minutes later, and the station works as it does without it.

The plugin tells the user of a problem in a notice once, with what to do, and in the status line
while it lasts; the status line holds one thing, the station's connection first:

| Problem | Where it is told |
|---|---|
| The session cannot reach the station | Notice when it is lost and when it is back; status line meanwhile |
| KEEP AWAKE cannot start its command | Notice once; status line until it runs |
| An order cannot be delivered | Notice in the coordination session, once per order; the order's note on the page |
| A room's handoffs cannot be read, or their list cannot be saved | Notice in the coordination session; the room's board |
| The session cannot join its station yet | Notice after a minute of trying |
| The coordination session runs in another mode than bypass | Notice when it starts |

Whether the setting is on or off, when no dispatcher holds a fresh lease (`LEASE_MS`, five
minutes) for an approved order, the page says so: a **NO DISPATCHER** button in the header with
the number of orders waiting, and a *Dispatcher* line in each waiting order's detail that names the
machine when the order is for one. Writing any message to that machine's coordination session
wakes it.

### The branch an order starts from

Every order starts from a branch of its room's repo, its **base**:

- **Which branch.** The one the order names, if any: an agent can give it with
  `propose_order`'s `base`, and you can set or change it while editing a proposal on the page, in
  STARTING BRANCH (OPTIONAL). Left empty, its placeholder names the repo's current branch when a
  session in the repo's own folder reports it, and it suggests the branches the room's sessions were
  seen on (never the app's `claude/…` worktree branches).
  Otherwise, the branch the room's checkout is on, on the dispatcher's machine, at the moment the
  order is delivered. The person who asks rarely knows the branches of another room's repo, so
  the default is where that repo actually is.
- **What the order keeps.** The branch, the commit it points at, and whether it came from the
  checkout (`base`, `baseCommit`, `baseIsDefault`), whether it went to a new session or an open one. The order's detail on the page shows them. A
  resend reads a branch taken from the checkout again, and keeps one the order named.
- **When git cannot tell** (a detached HEAD, a folder that is no repo), the order goes out as
  before, with no word about branches.
- **A branch only on origin.** When the order names a branch this machine has only as
  `origin/<base>`, the session is told so, and to use `origin/<base>` after `git fetch origin
  <base>`, or to ask you if git does not find it either.

Why the session has to be told: the app opens the session of a new-session card in a worktree of
the repo (a folder under `.claude/worktrees`) on a branch of its own, made from the remote's
default branch, not from the branch the checkout is on. That session's branch name is always its
own (`claude/…`), so what matters is the commit it starts from, not the name.

What each session reads first:

| Session | The message starts with |
|---|---|
| New, from a card | The base and its commit. If the session's commit is not the one the local base points at (`git rev-parse --short <base>`), it creates its work branch from the local base, never from `origin/<base>`, which may be behind: `git switch -c <its-branch> <base>`. If it runs in the repo's own folder and is not on the base, it does not switch branches there: it asks you. When the checkout had changes not committed, which a worktree does not see, it says so. |
| Open, in a worktree | The same: the base and its commit, and to start from the local base when its own commit is another. It is never told it is "on another branch", since a worktree's branch is always its own. |
| Open, in the repo's own folder, on another branch | That it is on another branch than the order's, and to check with you before changing anything. |
| Open, in the repo's own folder, on the base | Nothing: it is where the order starts. |

Each session reports to the station the branch it is on (`branch`) and whether it runs in one of
the app's worktrees (`inWorktree`), which is how the dispatcher tells these cases apart.

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
