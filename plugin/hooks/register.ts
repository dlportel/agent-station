import type { AskOptions, Register } from 'claude-code'
import { artifactKey, callOffice, isOfficeCall, mcpText, officeCallKey, parseDocs, toolDetail, type EngineIo, type OfficeDoc } from './office'
import { findRepos, isAbsolutePlace, startDispatcherInBackground, type DispatcherContext } from './dispatcher'
import { coordinationPeerNote, folderForMark, folderForRemote, folderMarkText, isFolderName, MARK_FILE, parentOf, readFolderMark, readFolderMarkAt, readMainRepoTop, readOriginRemote, isBranchName, joinPath, LANGS, readCurrentBranch, readOriginRemoteAnswer, readStationConfig, roomsLine, stationMap, stationRooms, stationUrls, isDirectSessionMessage, readOrderMark, type Lang, type Station } from './station'
import { tx } from './locale-es'

// Observer only: every hook hands the event on unchanged and never waits on
// the station. Writes run in the background and time out. After repeated
// failures the session shows the last error in the status line, logs it to
// ~/.claude/agent-station-logs/<session>.log and keeps trying, less often,
// until a write goes through.
//
// The plugin serves the stations listed in its `stations` option. A session
// belongs to the first of them whose repos (config/departments.repos) include
// the origin remote of its repo; any other session is ignored, so the mod
// never writes anywhere but that one station.

type SessionState = 'working' | 'waiting' | 'idle' | 'ended'

const MIN_WRITE_GAP_MS = 20_000
const MAX_CONSECUTIVE_FAILURES = 3
// Once the station counts as unreachable, its report is sent again after 30 s,
// 1, 2 and then every 5 minutes, whatever the session does meanwhile.
const OFFLINE_RETRY_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000]
const STATUS_ERROR_MAX = 60
const LOG_ERROR_MAX = 300
// The log keeps its last lines only, so it never grows past a few dozen KB.
const LOG_MAX_LINES = 200
const LOG_FOLDER = 'agent-station-logs'
// A station that did not answer is asked again at once, then after 1, 5 and 15 minutes.
const STATION_RETRY_MS = [0, 60_000, 5 * 60_000, 15 * 60_000]
// A session that cannot join yet tries again this often by itself, and says so
// once it has kept failing for this long.
const JOIN_RETRY_MS = 60_000
// The folders where the desktop app keeps sessions ready before it gives them
// a project: ~/.claude/spares/spare-…, and ~/.claude-spares/spare-… in older
// versions of the app.
const SPARE_FOLDER = /[\\/]\.claude(-spares|[\\/]spares)([\\/]|$)/
const QUESTION_TOOLS = new Set(['AskUserQuestion'])
// How the station says that a document is not there.
const MISSING_DOC = /no (such )?documents?|0 documents|not found|does not exist/i
// The permission modes where tool.check's verdict is what the user sees, and
// how long the mod waits for it before a call goes on unmarked.
const PERMISSION_CHECKED_MODES = new Set(['default', 'acceptEdits', 'plan'])
const PERMISSION_CHECK_MS = 1_000
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
// An agent looking up its own session is not work worth showing on the station.
const DESKTOP_SESSION_TOOL = 'mcp__ccd_session_mgmt__get_session'
const PROPOSE_TOOL_NAME = 'propose_order'
const READ_ACTIONS = new Set(['get', 'list', 'query', 'profiles'])
// The command that tells the coordination session about a problem, in the
// station's language; every language's name answers, whichever one a session
// registered.
const coordinatorCommand = (language: Lang) => ({
  name: tx(language, 'coordinator'),
  description: tx(language, "Tell the station's coordination session about a problem with the system: the station, orders, the dispatcher or the mod itself"),
  argumentHint: tx(language, '[message]'),
})
const COORDINATOR_COMMANDS = LANGS.map(coordinatorCommand)
const PROPOSE_SPEC = {
  name: PROPOSE_TOOL_NAME,
  description: 'Propose an order for the agent of another room of this station, for example to wake it after opening a handoff issue for it, or to return the result of an order this session received from another room. This is the only way to ask another room for work: never message its sessions directly. The order is not delivered until the user approves it in the station. Input: folder (the folder of the target room, as the station map lists it; to return a result, the folder of the room that asked), text (what the agent must do, or the result you return; include the issue link if there is one; at most 20000 characters, a longer order is refused whole, never cut), optional agent (a subagent of that room, only when the user asks for a particular one; otherwise that room chooses), optional mode (any | existing | new, default any), optional session_id (the station id of the session that must receive it), optional base (the branch the work must start from; by default, the branch the checkout of the room is on when the order is delivered), and reason (why you ask, at most 1000 characters). When this session received an order from that room, the new order goes back to the session that sent it, without session_id; if that session is gone, to another session of the room. The coordination session only hands orders out: never ask it to forward work or results.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: { type: 'string' },
      text: { type: 'string' },
      agent: { type: 'string' },
      mode: { type: 'string', enum: ['any', 'existing', 'new'] },
      session_id: { type: 'string' },
      base: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['folder', 'text', 'reason'],
  },
  isDeferred: false,
}
// Only the coordination session gets it: the dispatcher runs there, and the
// user asks it to look again for the repos cloned on this machine.
const FIND_REPOS_TOOL_NAME = 'find_repos'
const FIND_REPOS_SPEC = {
  name: FIND_REPOS_TOOL_NAME,
  description: "Look again for this station's repos on this machine: the folders next to the coordination repo whose origin remote is one of the station's repos, reading the station's repo list again first. Use it when the user asks you to check the repos or folders of the station, for example after cloning a repo or adding one in CONFIGURE, so the dispatcher can deliver orders to its room without restarting. It answers which rooms it found, with their folders, and which rooms of the station have no clone here. No input.",
  inputSchema: { type: 'object', properties: {} },
  isDeferred: false,
}
// Also only for the coordination session: it writes a folder room's mark,
// which nothing else may do, when the user asks for it.
const MARK_FOLDER_TOOL_NAME = 'mark_folder_room'
const MARK_FOLDER_SPEC = {
  name: MARK_FOLDER_TOOL_NAME,
  description: `Mark a folder as one of the station's folder rooms: a room whose agents work in a folder that is no git repo. It writes the file ${MARK_FILE} in that folder, with the station's URL and the room's id, so the sessions opened there join that room and the dispatcher can open new sessions in it. Use it only when the user asks you to mark a folder as a room. The room must already be a folder room in CONFIGURE, REPOS. Input: room (the room's folder, as CONFIGURE lists it) and, only if the folder is named otherwise or is elsewhere, directory: the name of the folder next to the coordination repo, or the full path of a folder of this computer. A folder that is a git repo with an origin remote is refused: such a room is added by its remote.`,
  inputSchema: {
    type: 'object',
    properties: {
      room: { type: 'string', description: "The folder room, by its folder as the station's REPOS list shows it." },
      directory: { type: 'string', description: 'The folder to mark, when it is not the one named room next to the coordination repo: its name there, or its full path on this computer.' },
    },
    required: ['room'],
  },
  isDeferred: false,
}
const ORDER_MODES = new Set(['any', 'existing', 'new'])
// The longest text and reason an order takes. An order is never cut: a longer
// one is refused whole, with its length, so the agent shortens or splits it.
// The page uses the same limit for the text.
const ORDER_TEXT_MAX = 20_000
const ORDER_REASON_MAX = 1_000
const MAP_WAIT_MS = 8_000
// How long a station call of the plugin's own keeps its mark at most: twice
// the time callOffice waits for an answer.
const OWN_CALL_MARK_MS = 16_000
// How long a notice for the user stays on screen.
const TOAST_MS = 30_000
// The app stops the process of a session that has been idle for a while, and
// the dispatcher with it, but not one with background work. When the station's
// config sets keepAwake, the session that dispatches keeps a command running in
// the background that never ends, and stops it when keepAwake is switched off.
// The mark tells it apart from the agent's own commands. The command writes
// the time to a file of its own every minute (its beat), so the plugin knows
// it is alive without asking the app: a beat older than KEEPER_STALE_MS means
// it ended (stopped by hand, or its process closed) and another is started.
//
// The whole loop is written in the command itself, never in a script it runs,
// so what is approved is all that runs: a script could be rewritten after its
// call was approved. Its folder is made first, for a machine with no log yet.
const KEEPER_MARK = 'agent-station-keep-awake'
const KEEPER_BEAT_S = 60
const KEEPER_STALE_MS = 3 * 60_000
// After the computer wakes, the keeper (frozen with it) beats again within a
// minute: its beat is not judged until this long after the plugin wakes.
const KEEPER_WAKE_GRACE_MS = 90_000
const keeperCommand = (beatPath: string) => `mkdir -p "${beatPath.replace(/\/[^/]*$/, '')}"; while :; do date +%s > "${beatPath}"; sleep ${KEEPER_BEAT_S}; done # ${KEEPER_MARK}`
// A keeper that could not start is tried again after this long.
const KEEPER_RETRY_MS = 10 * 60_000

type Membership = { station: Station; folder: string }
// Each configured station's config, in the order of the option (undefined: it did not answer).
type StationsRead = { read: Array<Station | undefined>; isComplete: boolean }

export const register: Register = (on, options) => {
  let io: EngineIo | undefined
  let station: Station | undefined
  let officeUrl = ''
  let urls = stationUrls(options ?? {})
  // Every configured station's ids, guarded against agent writes; its aliases
  // join once its config is read. ownKeys: the station this session belongs to.
  let allKeys: ReadonlySet<string> = new Set(urls.map(artifactKey).filter((key): key is string => !!key))
  let ownKeys: ReadonlySet<string> = new Set()
  let stationsLoad: Promise<StationsRead> | undefined
  let stationsRead: StationsRead | undefined
  let stationsRetryAt = 0
  // Why each station that did not answer failed, by URL, for the join log and notice.
  const stationErrors = new Map<string, string>()
  let stationsFailures = 0
  // The repo's remote, kept once git gave a clear answer; a failed read is
  // read again only by the session's own retry, once a minute.
  let remoteRead: Promise<{ remote?: string; isFinal: boolean }> | undefined
  // The folder the last answer was worked out for: the app may start a new
  // session in a spare folder of its own and move it to its project a moment
  // later, so an answer holds only while the session stays where it was.
  let membershipCwd: string | undefined
  // Why the session could not tell yet whether it belongs to a station ('' once
  // it could), how many of its own retries have run, and whether the user was told.
  let joinProblem: '' | 'remote' | 'station' | 'unknown' = ''
  let joinProblemStation = ''
  let joinRetries = 0
  let hasToldJoinProblem = false
  let isJoinRetryScheduled = false
  let membership: Promise<Membership | null> | undefined
  let isReporting = false
  let docId = ''
  let version: number | undefined
  let report: Record<string, unknown> = {}
  let hasUnsentChanges = false
  let isWriting = false
  let isWriteScheduled = false
  let lastWriteAt = 0
  let consecutiveFailures = 0
  let isSessionOver = false
  let isCoordination = false
  const activeDrones = new Map<string, string>()
  // The keeper's background task: wanted (the station's keepAwake, told by the
  // dispatcher), the ids of those running, and the ones this mod is starting or
  // stopping right now, which only it may approve.
  let isKeeperWanted = false
  let keeperTaskIds: string[] = []
  let areKeepersLoaded = false
  let hasLoggedStopTasks = false
  let isKeeperSyncing = false
  let isKeeperResyncNeeded = false
  // When the keeper last failed to start; never, at first (the host's clock may start at 0).
  let keeperFailedAt = Number.NEGATIVE_INFINITY
  let keeperStartsInFlight = 0
  let keeperCommandInFlight = ''
  let keeperStartedAt = 0
  // When the keeper was last checked, to tell a suspended computer (a long gap
  // between checks) from a keeper that stopped.
  let lastKeeperCheckAt = 0
  let keeperGraceUntil = 0
  // A problem is told once in a notice and, while it lasts, in the status
  // line, which has one place: the station's connection first, then the keeper.
  let hasToldKeeperProblem = false
  let keeperProblem = ''
  let hasToldOffline = false
  const keeperStopsInFlight = new Set<string>()
  let areSessionToolsRegistered = false
  let proposeToolName = ''
  let findReposToolName = ''
  let markFolderToolName = ''
  // The dispatcher's context in a coordination session, for find_repos.
  let dispatcherContext: DispatcherContext | undefined
  // The map of the station this session belongs to. It goes with the session's
  // first message as added context (waiting a moment for it while it is being
  // read), and again after /clear or a compaction, which drop it.
  let stationMapText = ''
  // The room this session belongs to, known as soon as its map is.
  let ownFolder = ''
  let isMapDelivered = false
  // The user prompts the session held at the last message: fewer now means a
  // compaction dropped the earlier ones, and the map with them. session.compact
  // says so too, but the app may pass over it (see classicHooks).
  let lastTurns: number | undefined
  // Whether the app runs this mod's classic hooks and its tool.check. On Team
  // and Enterprise accounts the app's own security plugin passes over them for
  // plugins the user installed: the mod then asks its confirmations itself
  // and reads permission waits from tool.check queries. Undecided until a call
  // of the agent's has gone through; undecided counts as passed over, so a
  // confirmation is never lost.
  let classicHooks: 'unknown' | 'run' | 'skipped' = 'unknown'
  // Settles once the session knows whether it belongs to a station (and, if it
  // does, has its map), so the first message waits for that and no longer.
  // Each attempt to join waits afresh: a session the app moved from its spare
  // folder to its project joins on a later attempt, and the message that
  // starts it must wait for that one, not for the answer of the spare folder.
  let markMapSettled: () => void = () => {}
  let mapSettled = new Promise<void>(resolve => { markMapSettled = resolve })
  const awaitNextJoin = () => { mapSettled = new Promise<void>(resolve => { markMapSettled = resolve }) }
  const ownCallsInFlight = new Map<string, number>()
  const isOwnCall = (input: any) => (ownCallsInFlight.get(officeCallKey(input)) ?? 0) > 0
  async function callToolAsMod(callTool: (call: any) => Promise<unknown>, call: Record<string, unknown>, sleep?: (ms: number) => Promise<unknown>) {
    // Only station calls are tracked: the key of any other call (the keeper's
    // Bash, say) would match an agent's station call with the same empty fields.
    if (call.tool !== 'ArtifactData') return callTool(call)
    const key = officeCallKey(call)
    ownCallsInFlight.set(key, (ownCallsInFlight.get(key) ?? 0) + 1)
    let isReleased = false
    const release = () => {
      if (isReleased) return
      isReleased = true
      const left = (ownCallsInFlight.get(key) ?? 1) - 1
      if (left > 0) ownCallsInFlight.set(key, left)
      else ownCallsInFlight.delete(key)
    }
    // A call the host never answers lets go of its mark anyway: its own hooks
    // ran when it started, and a mark kept for good would let the same call
    // from the agent pass as the plugin's.
    if (sleep) void sleep(OWN_CALL_MARK_MS).then(release, release)
    try {
      return await callTool(call)
    } finally {
      release()
    }
  }


  // The config of every configured station, in the order of the option. A
  // station that did not answer is asked again later, waiting longer each
  // time, so a station that never answers costs a few calls, not one per tool.
  function loadStations(io: EngineIo): Promise<StationsRead> {
    if (stationsRead && !stationsRead.isComplete && Date.now() >= stationsRetryAt) {
      stationsLoad = undefined
      stationsRead = undefined
    }
    stationsLoad ??= (async () => {
      // The desktop app does not always hand an installed plugin its options;
      // they are then read from the user settings, where they are stored.
      if (!urls.length) {
        urls = await readStationUrlsFromSettings(io)
        allKeys = new Set([...allKeys, ...urls.map(artifactKey).filter((key): key is string => !!key)])
      }
      stationErrors.clear()
      const read = await Promise.all(urls.map(url => readStationConfig(io, url, error => stationErrors.set(url, error))
        .catch(error => { stationErrors.set(url, String((error as Error)?.message ?? error)); return undefined })))
      allKeys = new Set([...allKeys, ...read.flatMap(s => (s ? [...s.officeKeys] : []))])
      const result = { read, isComplete: read.every(s => !!s) }
      if (!result.isComplete) {
        stationsRetryAt = Date.now() + STATION_RETRY_MS[Math.min(stationsFailures, STATION_RETRY_MS.length - 1)]
        stationsFailures++
      }
      stationsRead = result
      return result
    })()
    return stationsLoad
  }

  // Whether this session belongs to one of the stations, worked out once: the
  // session's repo from git, then the first station in the option whose repos
  // include it. A clear "no" is kept for the whole session. A station that has
  // not answered is never skipped: the session waits for it, so it cannot land
  // on a later station that also lists its repo.
  function resolveMembership(io: EngineIo): Promise<Membership | null> {
    membership ??= (async () => {
      let isWorthRetrying = false
      try {
        const cwd = await io.cwd()
        membershipCwd = cwd
        // A spare session waits in a folder of the app's until it is given
        // its project: nothing is decided there, the next event asks again.
        if (SPARE_FOLDER.test(cwd)) {
          isWorthRetrying = true
          joinProblem = ''
          logJoin(`cwd ${cwd} is one of the app's spare folders: waiting for the session to move to its project`)
          return null
        }
        remoteRead ??= readOriginRemoteAnswer(io, cwd).catch(() => ({ isFinal: false }))
        const answer = await remoteRead
        if (!answer.remote) {
          if (answer.isFinal) {
            // A folder with no remote may be a folder room, known by its mark.
            const mark = await readFolderMark(io, cwd)
            if (mark) {
              const { read } = await loadStations(io)
              for (const [index, candidate] of read.entries()) {
                if (!candidate) {
                  isWorthRetrying = true
                  joinProblem = 'station'
                  joinProblemStation = urls[index] ?? ''
                  logJoin(`cwd ${cwd}; no origin remote; mark in ${mark.dir}; waiting for ${joinProblemStation}, which comes first in the stations option`)
                  return null
                }
                const folder = folderForMark(mark, candidate)
                if (!folder) continue
                station = candidate
                officeUrl = candidate.officeUrl
                ownKeys = candidate.officeKeys
                joinProblem = ''
                logJoin(`cwd ${cwd}; no origin remote; mark in ${mark.dir}; joined folder room ${folder} of ${candidate.officeUrl}`)
                return { station: candidate, folder }
              }
              joinProblem = ''
              logJoin(`cwd ${cwd}; no origin remote; the mark in ${mark.dir} names no folder room of the stations: this session belongs to no station while it stays there`)
              return null
            }
            joinProblem = ''
            logJoin(`cwd ${cwd}: no origin remote, or not a git repo, and no folder room's mark: this session belongs to no station while it stays there`)
            return null
          }
          isWorthRetrying = true
          joinProblem = 'remote'
          logJoin(`cwd ${cwd}: git could not read the origin remote; trying again in a minute`)
          return null
        }
        const remote = answer.remote
        const { read } = await loadStations(io)
        // Every station's answer, in the order of the option.
        const answers = read.map((candidate, k) => `${urls[k] ?? '?'}: ${candidate ? (folderForRemote(remote, candidate.repos) ? 'lists this repo' : 'answered') : `did not answer (${stationErrors.get(urls[k] ?? '') || 'no error given'})`}`).join('; ')
        for (const [index, candidate] of read.entries()) {
          if (!candidate) {
            isWorthRetrying = true
            joinProblem = 'station'
            joinProblemStation = urls[index] ?? ''
            logJoin(`cwd ${cwd}; remote ${remote}; ${answers}; waiting for ${joinProblemStation}, which comes first in the stations option`)
            return null
          }
          const folder = folderForRemote(remote, candidate.repos)
          if (!folder) continue
          station = candidate
          officeUrl = candidate.officeUrl
          ownKeys = candidate.officeKeys
          joinProblem = ''
          logJoin(`cwd ${cwd}; remote ${remote}; ${answers}; joined room ${folder} of ${candidate.officeUrl}`)
          return { station: candidate, folder }
        }
        joinProblem = ''
        logJoin(`cwd ${cwd}; remote ${remote}; ${answers}; this repo is in no station`)
        return null
      } catch (error) {
        isWorthRetrying = true
        joinProblem = 'unknown'
        logJoin(`the check failed: ${String((error as Error)?.message ?? error)}`)
        return null
      } finally {
        if (isWorthRetrying) void Promise.resolve().then(() => { membership = undefined })
      }
    })()
    return membership
  }

  // propose_order and /coordinator are registered as soon as the session
  // binds, so they are there from the first turn; a failed attempt is retried
  // on the next tool call.
  // A kept answer that the session is not in a station is thrown away when the
  // session has moved to another folder since, so it is worked out again there.
  async function forgetIfMoved(engine: EngineIo) {
    if (areSessionToolsRegistered || membershipCwd === undefined) return
    const cwd = await engine.cwd().catch(() => membershipCwd)
    if (cwd === membershipCwd) return
    membership = undefined
    remoteRead = undefined
    membershipCwd = undefined
  }

  // One attempt at a time: two at once would register the tools twice.
  let registering: Promise<void> | undefined
  function registerSessionTools(engine: EngineIo, calls: SessionCalls): Promise<void> {
    if (areSessionToolsRegistered) return Promise.resolve()
    if (!registering) {
      awaitNextJoin()
      registering = registerSessionToolsNow(engine, calls).finally(() => { registering = undefined })
    }
    return registering
  }
  async function registerSessionToolsNow(engine: EngineIo, calls: SessionCalls) {
    try {
      await forgetIfMoved(engine)
      const member = await resolveMembership(engine)
      if (!member) {
        markMapSettled()
        if (joinProblem) {
          tellJoinProblem(engine)
          scheduleJoinRetry(engine, calls)
          return
        }
        await tellWhenNoStation(engine)
        return
      }
      // The map is ready as soon as the station is known: the first message
      // must not wait for the rest of the session's start.
      const pluginName = await calls.pluginName()
      const expectedTool = `mcp__${pluginName || 'agent-station'}__${PROPOSE_TOOL_NAME}`
      stationMapText = stationMap(member.station, member.folder, expectedTool)
      ownFolder = member.folder
      markMapSettled()
      // The tool names the station's rooms and the session's own, so an agent
      // knows where it can send work even without the map.
      const registered: any = await calls.registerTool({ ...PROPOSE_SPEC, description: `${PROPOSE_SPEC.description} Rooms of this station, by folder: ${roomsLine(member.station)}. This session is in the room \`${member.folder}\`.` })
      proposeToolName = String(registered?.tool ?? (pluginName ? expectedTool : ''))
      if (proposeToolName && proposeToolName !== expectedTool) stationMapText = stationMap(member.station, member.folder, proposeToolName)
      if (member.station.coordination && member.folder === member.station.coordination) {
        const found: any = await calls.registerTool(FIND_REPOS_SPEC).catch(() => undefined)
        findReposToolName = String(found?.tool ?? (pluginName ? `mcp__${pluginName}__${FIND_REPOS_TOOL_NAME}` : ''))
        const mark: any = await calls.registerTool(MARK_FOLDER_SPEC).catch(() => undefined)
        markFolderToolName = String(mark?.tool ?? (pluginName ? `mcp__${pluginName}__${MARK_FOLDER_TOOL_NAME}` : ''))
      }
      await calls.registerCommand(coordinatorCommand(member.station.language)).catch(() => {})
      areSessionToolsRegistered = true
    } catch {
      markMapSettled()
    }
  }

  // A session that could not tell yet whether it belongs to a station (git
  // failed, or a station earlier in the list does not answer) tries again by
  // itself, so it joins without waiting for the agent's next step.
  function scheduleJoinRetry(engine: EngineIo, calls: SessionCalls) {
    if (isJoinRetryScheduled || isSessionOver) return
    isJoinRetryScheduled = true
    void engine.sleep(JOIN_RETRY_MS).then(() => {
      isJoinRetryScheduled = false
      if (areSessionToolsRegistered || isSessionOver) return
      joinRetries++
      if (joinProblem === 'remote') remoteRead = undefined
      startOnce(engine, calls, 'idle')
    }, () => { isJoinRetryScheduled = false })
  }

  // Said once, when the session's own retry a minute later fails too, so a slow
  // start says nothing.
  function tellJoinProblem(engine: EngineIo) {
    if (hasToldJoinProblem || joinRetries < 1) return
    hasToldJoinProblem = true
    const language = stationsRead?.read.find(s => !!s)?.language
    const reason = joinProblem === 'remote' ? tx(language, 'git could not read the remote of its repo')
      : joinProblem === 'station' ? tx(language, 'the station {url} could not be read: {error}', { url: joinProblemStation, error: shortError(stationErrors.get(joinProblemStation) || tx(language, 'no answer'), STATUS_ERROR_MAX) })
      : tx(language, 'it could not be checked')
    engine.toast(tx(language, 'Agent station: this session could not join its station yet ({reason}). It keeps trying; if it does not join, run /reload-plugins.', { reason }))
  }

  // A plugin installed without any station (from the plugin directory, say)
  // says once per session how to create one, instead of doing nothing silently.
  let hasToldNoStation = false
  async function tellWhenNoStation(engine: EngineIo) {
    if (hasToldNoStation) return
    hasToldNoStation = true
    const configured = urls.length ? urls : await readStationUrlsFromSettings(engine)
    if (!configured.length) engine.toast('Agent Station is installed but has no station yet. Run /agent-station:setup to create one.')
  }

  // A reload mid-session fires session.start again, but the first tool call
  // also initializes, so the mod never depends on one event having fired.
  // Nothing is awaited before next(e): a session must start even if a
  // registration hangs, so the tools are registered after it, in the background.
  // Reporting starts as soon as the session is known to belong to a station:
  // a station that answers late only delays it.
  let reportingStep: 'idle' | 'starting' | 'started' = 'idle'
  function startOnce(engine: EngineIo, calls: SessionCalls, initialState: SessionState) {
    io ??= engine
    if (!areSessionToolsRegistered) void registerSessionTools(io, calls)
    if (reportingStep !== 'idle') return
    reportingStep = 'starting'
    void startReporting(io, initialState).then(isStarted => { reportingStep = isStarted ? 'started' : 'idle' })
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    startOnce(engineIoFor($, callToolAsMod), sessionCallsFor($), 'idle')
    return result
  })

  // The map of the station goes with the session's first message as context
  // for the model, and again after /clear or a compaction, which drop it. The
  // first message waits for it while the station is being read.
  on('prompt.submit', async ($, e, next) => {
    updateReport({ state: 'working' satisfies SessionState, tool: null, detail: null, waitKind: null }, false)
    const turns = await $.session.turns().catch(() => undefined)
    if (typeof turns === 'number') {
      if (lastTurns !== undefined && turns < lastTurns) isMapDelivered = false
      lastTurns = turns
    }
    // A message from another session to the coordination session carries the
    // reminder that it does not forward work or results between rooms.
    if (isCoordination && proposeToolName && isPeerMessage(e.origin)) e = { ...e, context: [...(e.context ?? []), coordinationPeerNote(proposeToolName, station?.language, `/${coordinatorCommand(station?.language ?? 'en').name}`)] }
    if (readOrderMark(e.text)) {
      await Promise.race([mapSettled, $.clock.sleep(MAP_WAIT_MS)])
      e = claimOrderMark(e)
    }
    if (isMapDelivered) return next(e)
    if (!stationMapText) {
      startOnce(engineIoFor($, callToolAsMod), sessionCallsFor($), 'working')
      await Promise.race([mapSettled, $.clock.sleep(MAP_WAIT_MS)])
    }
    if (!stationMapText) return next(e)
    isMapDelivered = true
    // The session's report records when the map went out, so the station shows
    // that it reaches the agent.
    if (isReporting) updateReport({ mapAt: Date.now() }, false)
    else report = { ...report, mapAt: Date.now() }
    return next({ ...e, context: [...(e.context ?? []), stationMapText] })
  })

  // A new-session order's card carries its order's mark. The session that gets
  // it records the order as fromOrder, so the dispatcher hands the order to it
  // and to no other. A session of another room records it too (the dispatcher
  // then fails the order) and is told not to do it.
  function claimOrderMark(e: any) {
    const mark = readOrderMark(e.text)
    if (!mark || !station || !ownFolder) return e
    if (isReporting) updateReport({ fromOrder: mark.claim }, true)
    else report = { ...report, fromOrder: mark.claim }
    if (ownFolder === mark.folder) return e
    const note = tx(station.language, 'This message is the station order {order}, which is for the room {room}, not for this session (room {own}). Do not carry it out: tell the user that it belongs to {room}, and that its card has to be opened as a new session there.', { order: mark.orderId, room: mark.folder, own: ownFolder })
    return { ...e, context: [...(e.context ?? []), note] }
  }

  on('session.compact', ($, e, next) => {
    isMapDelivered = false
    return next(e)
  })

  on('session.end', ($, e, next) => {
    // A /clear goes on in the same process and the same app session: it keeps
    // reporting, and only needs the map again.
    if (e.reason === 'clear') {
      isMapDelivered = false
      return next(e)
    }
    isSessionOver = true
    updateReport({ state: 'ended' satisfies SessionState, tool: null, detail: null, waitKind: null, endedAt: Date.now() }, true)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    startOnce(engineIoFor($, callToolAsMod), sessionCallsFor($), 'working')
    // Never let an agent's write through before the stations' ids are known.
    if (io && !isOwnCall(e) && (isArtifactDataWrite(e.tool, e) || isArtifactPageChange(e.tool, e))) await loadStations(io)
    // Where the app passes over PreToolUse, its confirmation is asked here.
    if (classicHooks !== 'run' && !isOwnCall(e)) {
      const ask = confirmationFor(e.tool, e)
      if (ask && !(await isConfirmedByUser((question, options) => $.ui.ask(question, options), ask))) return { deny: tx(station?.language, 'The user did not allow it.') }
    }
    // The station page itself: only its own coordination session may republish
    // or delete it, and the user is asked (confirmationFor).
    if (isArtifactPageChange(e.tool, e) && isStationUrl(e)) {
      if (isOwnStationPageChange(e)) return next(e)
      return { deny: 'Agents may not republish or delete a station page. Ask the user, or the station\'s coordination session, to do it.' }
    }
    if (isOfficeCall(allKeys, e.tool, e)) {
      if (isOwnCall(e)) return next(e)
      // The agent may read the station but never write it: only the station
      // page, that is the user, creates or changes orders. The coordination
      // session may write orders and the station's config/departments, and
      // each write asks the user first.
      if (isAgentWrite(e) && !isCoordinationWrite(e)) return { deny: 'The station only accepts writes from the station page itself. To ask for another agent to be woken, use the propose_order tool; the user approves it in the station.' }
      return next(e)
    }
    if (e.tool === DESKTOP_SESSION_TOOL || isOwnKeeperCall(e.tool, e)) return next(e)
    if (isProposeTool(e.tool)) return { result: await proposeOrder(e) } as any
    if (findReposToolName && e.tool === findReposToolName) return { result: await findReposForAgent() } as any
    if (markFolderToolName && e.tool === markFolderToolName) return { result: await markFolderRoomForAgent(e) } as any
    const isQuestion = QUESTION_TOOLS.has(e.tool)
    const droneKey = SUBAGENT_TOOLS.has(e.tool) ? String((e as any).tool_use_id ?? Math.random()) : ''
    if (droneKey) activeDrones.set(droneKey, String((e as any).subagent_type || 'general-purpose'))
    const isPermissionWait = !isQuestion && await isPermissionDialogLikely(args => $.tool.check(args), ms => $.clock.sleep(ms), e)
    updateReport({
      state: (isQuestion || isPermissionWait ? 'waiting' : 'working') satisfies SessionState,
      tool: e.tool,
      detail: toolDetail(e.tool, e),
      waitKind: isQuestion ? 'question' : isPermissionWait ? 'permission' : null,
      drones: [...activeDrones.values()],
    }, isQuestion || isPermissionWait || !!droneKey)
    try {
      const result = await next(e)
      if (classicHooks === 'unknown') setClassicHooks('skipped')
      if (report.state === 'waiting') updateReport({ state: 'working' satisfies SessionState, waitKind: null }, true)
      return result
    } finally {
      if (droneKey && activeDrones.delete(droneKey)) updateReport({ drones: [...activeDrones.values()] }, true)
    }
  })

  on('classic.PermissionRequest', ($, e, next) => {
    updateReport({ state: 'waiting' satisfies SessionState, waitKind: 'permission' }, true)
    return next(e)
  })

  // An input dialog an MCP server opens also waits for the user; it shows only
  // as a notice.
  on('classic.Notification', ($, e, next) => {
    if (e.notification_type === 'elicitation_dialog') updateReport({ state: 'waiting' satisfies SessionState, waitKind: 'question' }, true)
    return next(e)
  })

  // Only the main loop's turn ending leaves the session idle: a subagent's
  // (e.agentId) ends inside the session's own turn, which goes on.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const result = await next(e)
    refreshDesktopDetailsInBackground()
    updateReport({ state: 'idle' satisfies SessionState, tool: null, detail: null, waitKind: null }, true)
    return result
  })

  // At the end of each turn the engine lists the session's background work: the
  // keepers found there are the ones running, whoever started them (a reload of
  // the mod forgets the ids it had).
  on('classic.Stop', ($, e, next) => {
    // An app that does not list them leaves the ids the mod already knows.
    const tasks = (e as any).background_tasks
    // A list taken while the mod starts a keeper may not show it yet.
    if (isCoordination && Array.isArray(tasks) && keeperStartsInFlight === 0) {
      const keepers = tasks.filter(task => String(task?.command ?? '').includes(KEEPER_MARK)).map(task => String(task.id))
      // Logged once per load: what the app lists, to tell its list apart from the mod's.
      if (!hasLoggedStopTasks) {
        hasLoggedStopTasks = true
        logStationEvent('keep-awake', `the turn's end lists ${tasks.length} background task(s), ${keepers.length} of them keepers`)
      }
      areKeepersLoaded = true
      setKeeperIds(keepers)
      void syncKeeper()
    }
    return next(e)
  })

  // The mod's own station calls are approved at tool.check, which settles the
  // verdict before the mode's decider: an allow from PreToolUse does not keep
  // auto mode from sending the call to its classifier, which denies it when it
  // gives no verdict. Only a station call the mod itself has in flight is
  // approved; the agent's calls get the verdict beneath.
  on('tool.check', { tool: 'ArtifactData' }, ($, e, next) => {
    const isOwnOfficeCall = isOwnCall(e.input) && isOfficeCall(allKeys, e.tool, e.input)
    return isOwnOfficeCall ? { decision: 'allow', reason: 'The agent-station plugin reporting to its station' } : next(e)
  })

  for (const tool of ['Bash', 'TaskStop']) {
    on('tool.check', { tool }, ($, e, next) => {
      return isOwnKeeperCall(e.tool, e.input) ? { decision: 'allow', reason: 'The agent-station plugin keeping the station dispatcher awake' } : next(e)
    })
  }

  // The mod's own station calls must never open a permission dialog, also on
  // an app that does not raise tool.check; the agent's calls go through the
  // normal permission flow, and the ones in confirmationFor ask the user.
  // Its firing at all tells the mod the app runs its classic hooks.
  on('classic.PreToolUse', ($, e, next) => {
    if (classicHooks !== 'run') setClassicHooks('run')
    const input = e.tool_input
    if (isOwnCall(input) && isOfficeCall(allKeys, e.tool_name, input)) return { allow: true }
    if (isOwnKeeperCall(e.tool_name, input)) return { allow: true }
    const ask = confirmationFor(e.tool_name, input)
    return ask ? { ask } : next(e)
  })

  // The calls the user confirms before they run, with the reason shown: a
  // message straight to another session (work between rooms goes through
  // propose_order and its approval), a change to the station page, a write of
  // the coordination session to its station, and a station write the guard
  // cannot place (a URL it does not recognise, or an alias of a station that
  // has not answered yet).
  function confirmationFor(tool: string, input: any): string | undefined {
    if (station && isDirectSessionMessage(tool, input)) {
      return tx(station.language, 'This agent wants to write to another Claude Code session directly, outside the station. Work between sessions, also of the same room, goes through propose_order, which waits for your approval in the station: allow this only if you asked for it.')
    }
    if (isArtifactPageChange(tool, input) && isStationUrl(input) && isOwnStationPageChange(input)) {
      const isDelete = String(input?.action ?? 'publish') === 'delete'
      const ask = isDelete
        ? 'The coordination session wants to delete the station page ({url}).'
        : 'The coordination session wants to republish the station page ({url}).'
      return tx(station?.language, ask, { url: String(input?.url) })
    }
    if (isArtifactDataWrite(tool, input) && !isOwnCall(input)) {
      if (isOfficeCall(allKeys, tool, input)) return isCoordinationWrite(input) ? describeCoordinationWrite(input, station?.language) : undefined
      return describeUnverifiedWrite(input)
    }
    return undefined
  }

  function setClassicHooks(state: 'run' | 'skipped') {
    classicHooks = state
    if (state === 'skipped') logStationEvent('hooks', 'the app passes over the classic hooks: confirmations are asked as questions and permission waits are read from tool.check')
  }

  // The confirmation asked as a question, where no PreToolUse can ask it. A
  // dismissed question, or none possible, refuses the call.
  async function isConfirmedByUser(askUser: (question: string, options: AskOptions) => Promise<string>, ask: string): Promise<boolean> {
    const language = station?.language
    const allow = tx(language, 'Allow')
    try {
      const answer = await askUser(`${ask} ${tx(language, 'Allow it?')}`, { options: [allow, tx(language, 'Deny')], header: tx(language, 'Station') })
      return answer === allow
    } catch {
      return false
    }
  }

  // Where the app passes over PermissionRequest, a call the permission check
  // would put to the user is marked as waiting for them. Only in the modes
  // where the check is the whole decision: auto mode's classifier may still
  // let the call through, and the mark would stay while it runs.
  async function isPermissionDialogLikely(check: (args: { tool: string; input: unknown }) => Promise<{ decision: string }>, sleep: (ms: number) => Promise<unknown>, e: any): Promise<boolean> {
    if (classicHooks !== 'skipped' || !PERMISSION_CHECKED_MODES.has(String(report.permissionMode ?? ''))) return false
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e
    const verdict = await Promise.race([check({ tool, input }).catch(() => undefined), sleep(PERMISSION_CHECK_MS).then(() => undefined)])
    return verdict?.decision === 'ask'
  }

  // Only the keeper this mod is starting, or one it is stopping: the same
  // command from the agent goes through the normal permission flow.
  function isOwnKeeperCall(tool: string, input: any) {
    if (tool === 'Bash') return keeperStartsInFlight > 0 && !!keeperCommandInFlight && input?.command === keeperCommandInFlight
    if (tool === 'TaskStop') return keeperStopsInFlight.has(String(input?.task_id ?? ''))
    return false
  }

  function setKeepAwake(isWanted: boolean) {
    isKeeperWanted = isWanted
    void syncKeeper()
  }

  // One keeper while it is wanted, none otherwise. Never throws: a keeper that
  // cannot start is tried again later, and the station works as it did without.
  async function syncKeeper() {
    if (!io || !isCoordination || isSessionOver) return
    if (isKeeperSyncing) {
      isKeeperResyncNeeded = true
      return
    }
    isKeeperSyncing = true
    try {
      // After a reload of the plugin, the keepers it had started are read back
      // from the session's state, so it never starts another one.
      if (!areKeepersLoaded) {
        const held = await io.readKeepers?.().catch(() => [] as string[]) ?? []
        areKeepersLoaded = true
        setKeeperIds([...new Set([...held, ...keeperTaskIds])])
      }
      do {
        isKeeperResyncNeeded = false
        const extra = isKeeperWanted ? keeperTaskIds.slice(1) : keeperTaskIds
        for (const id of extra) await stopKeeper(id)
        if (isKeeperWanted) {
          const now = await clockNow()
          // A long gap since the last check means this process slept with the
          // computer, and the keeper with it: it is given time to beat again.
          if (lastKeeperCheckAt > 0 && now - lastKeeperCheckAt > KEEPER_STALE_MS) keeperGraceUntil = now + KEEPER_WAKE_GRACE_MS
          lastKeeperCheckAt = now
          const isBeating = await isKeeperBeating(now)
          const isJudged = now >= keeperGraceUntil
          // A keeper known but not beating is stopped and forgotten before
          // another starts: one that is only frozen or hung would otherwise
          // run on beside the new one. One just started gets time for its
          // first beat.
          if (isJudged && keeperTaskIds.length && !isBeating && now - keeperStartedAt >= KEEPER_STALE_MS) {
            for (const id of [...keeperTaskIds]) await stopKeeper(id)
            setKeeperIds([])
          }
          // One beating that the plugin does not know (started before a
          // reload that lost its id) is left alone: no second one starts.
          if (isJudged && !keeperTaskIds.length && !isBeating && now - keeperFailedAt >= KEEPER_RETRY_MS) await startKeeper(now)
        }
      } while (isKeeperResyncNeeded && !isSessionOver)
    } catch {} finally {
      isKeeperSyncing = false
    }
  }

  async function clockNow(): Promise<number> {
    return (await io?.now?.().catch(() => undefined)) ?? Date.now()
  }

  // The keeper's beat: the time its command last wrote, in a file of this
  // session's under ~/.claude/agent-station-logs.
  async function keeperBeatPath(): Promise<string> {
    const home = await io?.userProfile().catch(() => undefined)
    return home ? joinPath(home, '.claude', LOG_FOLDER, `keeper-${docId || 'unknown'}.beat`).replace(/\\/g, '/') : ''
  }

  async function isKeeperBeating(now: number): Promise<boolean> {
    const path = await keeperBeatPath()
    if (!path || !io) return false
    try {
      const seconds = Number(String(await io.readText(path)).trim())
      return Number.isFinite(seconds) && seconds > 0 && now - seconds * 1000 < KEEPER_STALE_MS
    } catch {
      return false
    }
  }

  async function startKeeper(now: number) {
    if (!io) return
    const beatPath = await keeperBeatPath()
    if (!beatPath) return
    keeperStartsInFlight++
    keeperCommandInFlight = keeperCommand(beatPath)
    try {
      const reply: any = await io.callTool({
        tool: 'Bash',
        command: keeperCommandInFlight,
        run_in_background: true,
        description: tx(station?.language, 'Keep the station dispatcher awake'),
      })
      const id = reply?.result?.backgroundTaskId
      if (id) {
        setKeeperIds([...keeperTaskIds, String(id)])
        keeperStartedAt = now
        keeperFailedAt = Number.NEGATIVE_INFINITY
        setKeeperProblem('')
      } else {
        keeperFailedAt = now
        const error = String(reply?.deny ?? JSON.stringify(reply ?? null))
        logStationEvent('keep-awake', `the keeper did not start: ${shortError(error, LOG_ERROR_MAX)}`)
        setKeeperProblem(error)
      }
    } catch (error) {
      keeperFailedAt = now
      const message = String((error as Error)?.message ?? error)
      logStationEvent('keep-awake', `the keeper did not start: ${message}`)
      setKeeperProblem(message)
    } finally {
      keeperStartsInFlight--
      if (!keeperStartsInFlight) keeperCommandInFlight = ''
    }
  }

  async function stopKeeper(id: string) {
    if (!io) return
    keeperStopsInFlight.add(id)
    try {
      await io.callTool({ tool: 'TaskStop', task_id: id })
    } catch {} finally {
      keeperStopsInFlight.delete(id)
      setKeeperIds(keeperTaskIds.filter(other => other !== id))
    }
  }

  // Told once in a notice, with what to do; shown in the status line while it
  // lasts, unless the station's connection is down, which goes first.
  function setKeeperProblem(error: string) {
    const language = station?.language
    const isAutoMode = /auto mode/i.test(error)
    keeperProblem = !error ? '' : isAutoMode
      ? tx(language, 'auto mode refuses its command')
      : shortError(error, STATUS_ERROR_MAX)
    if (keeperProblem && !hasToldKeeperProblem) {
      hasToldKeeperProblem = true
      io?.toast(isAutoMode
        ? tx(language, 'Agent station: KEEP AWAKE cannot start its command, because auto mode refuses it. Run this coordination session with permissions bypassed for it to work. It keeps trying every ten minutes.')
        : tx(language, 'Agent station: KEEP AWAKE cannot start its command ({error}). It keeps trying every ten minutes.', { error: keeperProblem }))
    }
    showStatus()
  }

  function showStatus() {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return
    io?.status(keeperProblem ? tx(station?.language, 'station: KEEP AWAKE does not start ({problem})', { problem: keeperProblem }) : undefined)
  }

  function setKeeperIds(ids: string[]) {
    keeperTaskIds = ids
    void io?.writeKeepers?.(ids).catch(() => {})
  }

  function isAgentWrite(input: any) {
    return !READ_ACTIONS.has(String(input?.action ?? ''))
  }

  function isArtifactDataWrite(tool: string, input: any) {
    return tool === 'ArtifactData' && isAgentWrite(input)
  }

  // A publish (the Artifact tool's default action) or a delete of a page.
  function isArtifactPageChange(tool: string, input: any) {
    return tool === 'Artifact' && !!input?.url && ['publish', 'delete'].includes(String(input?.action ?? 'publish'))
  }

  function isStationUrl(input: any) {
    const key = artifactKey(input?.url)
    return !!key && allKeys.has(key)
  }

  function isOwnStationPageChange(input: any) {
    const key = artifactKey(input?.url)
    return isCoordination && !!key && ownKeys.has(key)
  }

  // Why an agent's write to an artifact the guard cannot vouch for needs the
  // user: a URL that names no artifact it can read, or a uuid URL while some
  // station's aliases are still unknown.
  function describeUnverifiedWrite(input: any): string | undefined {
    const key = artifactKey(input?.url)
    const language = station?.language
    if (!key) return tx(language, 'An agent wants to write to {url}, which cannot be checked for being a station.', { url: String(input?.url ?? tx(language, 'an empty URL')) })
    const isUuidUrl = /\/code\/artifact\//i.test(String(input?.url))
    if (isUuidUrl && stationsRead && !stationsRead.isComplete) return tx(language, 'An agent wants to write to {url} while a station does not answer, so it cannot be checked for being one of them.', { url: String(input?.url) })
    return undefined
  }

  // Orders and the station's own configuration (config/departments), never
  // sessions, the dispatcher's catalogs or leases, and never a batch that
  // could hide other collections.
  // Only on its own station: another configured station stays read-only.
  function isCoordinationWrite(input: any) {
    if (!isCoordination || input?.action === 'batch') return false
    const key = artifactKey(input?.url)
    if (!key || !ownKeys.has(key)) return false
    return input?.collection === 'orders' || (input?.collection === 'config' && input?.doc_id === 'departments')
  }

  // The registered tool carries the plugin's own prefix (mcp__<plugin>__propose_order),
  // so another station's plugin loaded in the same session keeps its own tool.
  function isProposeTool(tool: string) {
    return !!proposeToolName && tool === proposeToolName
  }

  // /coordinator <message>: the user tells the coordination session about a
  // problem with the system, from whichever session they are in.
  for (const command of COORDINATOR_COMMANDS) {
    on('command.run', { command: command.name }, async ($, e) => ({
      text: await notifyCoordinator(String(e.args ?? '').trim()),
    }))
  }

  // The coordination session is the station's own session of the coordination
  // department on this machine, as the station lists it.
  async function notifyCoordinator(message: string): Promise<string> {
    const language = station?.language
    const say = (text: string, vars?: Record<string, unknown>) => tx(language, text, vars)
    const command = coordinatorCommand(language ?? 'en').name
    if (!message) return say('Write the notice after the command, for example: /{command} this session does not see propose_order', { command })
    if (!io || !station || !isReporting) return say('This session belongs to no station, so there is no coordination to tell.')
    if (!station.coordination) return say('The station has no coordination repo (field coordination of config/departments).')
    try {
      const reply = await callOffice(io, officeUrl, {
        action: 'query',
        collection: 'sessions',
        query: { where: [['folder', '==', station.coordination]], limit: 100 },
      })
      const target = parseDocs(reply.isOk ? reply.text : '')
        .filter(s => s.id !== docId && s.data.machine === report.machine && s.data.state !== 'ended')
        .sort((a, b) => Number(b.data.lastEventAt ?? 0) - Number(a.data.lastEventAt ?? 0))[0]
      if (!target) return say('No session of {room} is open on this computer. Open one and send the notice again.', { room: station.coordination })
      const header = say('Notice from the user for the coordination, sent from the session "{title}" ({room}, {id}) with /{command}:', {
        title: String(report.title || say('untitled session')),
        room: String(report.folder || '—'),
        id: docId || say('no id'),
        command,
      })
      const sent = mcpText(await io.callMcp('ccd_session_mgmt', 'send_message', {
        session_id: target.id,
        message: `${header}\n\n${message}`,
      }))
      return /delivered|queued/i.test(sent)
        ? say('Notice sent to the coordination ("{title}").', { title: String(target.data.title || target.id) })
        : say('The notice could not be sent: {error}', { error: sent.slice(0, 200) })
    } catch (error) {
      return say('The notice could not be sent: {error}', { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }

  async function startReporting(io: EngineIo, initialState: SessionState): Promise<boolean> {
    try {
      await forgetIfMoved(io)
      const member = await resolveMembership(io)
      if (!member) return false
      const machine = (await io.computerName()) ?? ''
      const desktop = await readDesktopSessionFromApp(io)
      docId = sanitizeDocId(desktop?.sessionId ?? (await io.sessionId()))
      isReporting = true
      updateReport({
        title: desktop?.title ?? '',
        link: desktop?.link ?? null,
        model: desktop?.model ?? null,
        folder: member.folder,
        machine,
        modVersion: member.station.modVersion,
        state: initialState,
        tool: null,
        detail: null,
        waitKind: null,
        drones: [],
        startedAt: Date.now(),
        endedAt: null,
        branch: await readSessionBranch(io),
        inWorktree: await isInWorktree(io),
        // The station page warns when KEEP AWAKE is on and the session that
        // dispatches is not in bypassPermissions, where its command cannot start.
        permissionMode: desktop?.permissionMode ?? null,
      }, true)
      isCoordination = !!member.station.coordination && member.folder === member.station.coordination
      // Every feature of the station works only with permissions bypassed (in
      // organizations, Claude Code's built-in security plugin answers the
      // plugin's own permission hooks first): the coordination says so once.
      if (isCoordination && desktop?.permissionMode && desktop.permissionMode !== 'bypassPermissions') {
        io.toast(tx(member.station.language, 'Agent station: this coordination session runs in the {mode} permission mode. The station works fully only with permissions bypassed; in auto mode, KEEP AWAKE cannot start.', { mode: desktop.permissionMode }))
      }
      if (isCoordination && desktop?.sessionId) {
        // This copy's generation goes into the host's state, which outlives a
        // reload of the plugin: a dispatcher that finds another one there
        // belongs to an older copy, and stops.
        const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        await io.writeDispatcherGeneration?.(generation).catch(() => {})
        const engine = io
        dispatcherContext = {
          io,
          officeUrl,
          station: member.station,
          machine,
          ownSessionId: docId,
          isAlive: () => isReporting && !isSessionOver,
          isCurrent: async () => {
            const held = await engine.readDispatcherGeneration?.()
            return held === undefined || held === generation
          },
          setKeepAwake,
        }
        startDispatcherInBackground(dispatcherContext)
      }
      return true
    } catch {
      isReporting = false
      return false
    }
  }

  // find_repos, for the coordination session's agent: the dispatcher looks for
  // the station's repos again and says what it found.
  async function findReposForAgent(): Promise<string> {
    if (!dispatcherContext) return 'The dispatcher has not started in this session yet: it starts once the session has joined its station. Try again in a moment.'
    const { machine, rooms, missing } = await findRepos(dispatcherContext)
    const found = rooms.length ? rooms.map(room => `${room.folder} (${room.path})`).join(', ') : 'none'
    const absent = missing.length ? ` Rooms of the station with no clone next to the coordination repo on ${machine}: ${missing.join(', ')}. Orders that need a new session there cannot be delivered on this machine until they are cloned.` : ' Every room of the station has its clone here.'
    return `Looked for the station's repos again on ${machine}. Rooms found: ${found}.${absent} The station shows this list in CONFIGURE, REPOS.`
  }

  // mark_folder_room, for the coordination session's agent: writes the mark of
  // a folder room in a folder next to the coordination repo, then looks for
  // the station's rooms again so the dispatcher knows it at once. It never
  // marks a repo with a remote, nor a folder another room's mark already holds.
  async function markFolderRoomForAgent(input: any): Promise<string> {
    if (!dispatcherContext || !io || !officeUrl) return 'The dispatcher has not started in this session yet: it starts once the session has joined its station. Try again in a moment.'
    const engine = io
    const fresh = await readStationConfig(engine, officeUrl).catch(() => undefined)
    if (!fresh) return 'Not marked: the station did not answer. Try again in a moment.'
    const roomName = String(input.room ?? '').trim()
    const room = fresh.folderRooms.find(candidate => candidate.folder === roomName)
    if (!room) {
      const listed = fresh.folderRooms.map(candidate => candidate.folder).join(', ')
      return `Not marked: the station has no folder room "${roomName.slice(0, 100)}". ${listed ? `Its folder rooms are: ${listed}.` : 'It has none yet.'} The user adds one in CONFIGURE, REPOS, with + ADD FOLDER ROOM, and saves.`
    }
    // A folder next to the coordination repo by its name, or any folder of
    // this computer by its full path (found by the dispatcher once its place
    // is listed for this computer in CONFIGURE, REPOS).
    const directory = String(input.directory ?? '').trim() || room.folder
    let path = ''
    if (isAbsolutePlace(directory) && !/[\\/]\*$/.test(directory)) {
      const isThere = await engine.listDir(directory).then(() => true, () => false)
      if (!isThere) return `Not marked: there is no folder ${directory} on this computer. Create it first, or give the path it has.`
      path = directory.replace(/[\\/]+$/, '')
    } else {
      if (!isFolderName(directory)) return 'Not marked: directory is the name of a folder next to the coordination repo, or the full path of a folder of this computer.'
      const top = await readMainRepoTop(engine, await engine.cwd())
      if (!top) return 'Not marked: git could not tell where the coordination repo is.'
      const parent = parentOf(top)
      const entries = await engine.listDir(parent).catch(() => [] as Array<{ name: string; kind: string }>)
      if (!entries.some(entry => entry.kind === 'dir' && entry.name === directory)) return `Not marked: there is no folder "${directory}" in ${parent}. Create it there first, or give its full path.`
      path = joinPath(parent, directory)
    }
    const remote = await readOriginRemote(engine, path)
    if (remote) return `Not marked: ${path} is a git repo with the remote ${remote}. A room with a repo is added in CONFIGURE, REPOS by its remote, not as a folder room.`
    const existing = await readFolderMarkAt(engine, path)
    if (existing && folderForMark(existing, fresh) === room.folder) return `${path} is already marked as the folder room ${room.folder}.`
    if (existing) return `Not marked: ${path} already has a mark (${MARK_FILE}) for another room or station. Remove that file first if the folder is to be this room, and only if the user says so.`
    try {
      await engine.writeText(joinPath(path, MARK_FILE), folderMarkText(fresh.officeUrl, room.id))
    } catch (error) {
      return `Not marked: the file could not be written in ${path}: ${String((error as Error)?.message ?? error).slice(0, 200)}`
    }
    const { rooms } = await findRepos(dispatcherContext)
    const isFound = rooms.some(found => found.folder === room.folder)
    return `Marked ${path} as the folder room ${room.folder} (file ${MARK_FILE}).${isFound ? ' The dispatcher found it: orders for the room reach it from now on.' : ' The dispatcher did not find it: if the folder is not next to the coordination repo, the user adds its path (or its parent, ending in \\*) under this computer in CONFIGURE, REPOS, REPOS ON EACH COMPUTER.'} A session already open in that folder joins the room once it is opened again.`
  }

  async function proposeOrder(input: any): Promise<string> {
    if (!io || !isReporting) return 'This session does not belong to a station, so the order was not proposed.'
    const folder = String(input.folder ?? '').trim()
    const text = String(input.text ?? '').trim()
    const reason = String(input.reason ?? '').trim()
    if (!folder || !text || !reason) return 'Not proposed: folder, text and reason are required.'
    if (text.length > ORDER_TEXT_MAX) return `Not proposed: the text has ${text.length} characters and an order takes at most ${ORDER_TEXT_MAX}. Nothing was stored. Shorten it (point to files or links instead of pasting them) or split it into several orders.`
    if (reason.length > ORDER_REASON_MAX) return `Not proposed: the reason has ${reason.length} characters and takes at most ${ORDER_REASON_MAX}. Nothing was stored. Keep it to why you ask; the details go in the text.`
    // A department that does not exist is refused with the ones that do.
    if (station) {
      const { rooms, groups } = stationRooms(station)
      if (!rooms.some(room => room.folder === folder) && !groups.length) return `Not proposed: this station has no room with the folder "${folder}". Its rooms, by folder, are: ${roomsLine(station)}.`
    }
    const base = input.base === undefined || input.base === null || String(input.base).trim() === '' ? null : String(input.base).trim()
    if (base !== null && !isBranchName(base)) return `Not proposed: "${base.slice(0, 80)}" is not a branch name. Give the branch as git shows it (letters, digits and . _ / -), or leave base out to start from the branch the room's checkout is on.`
    const mode = ORDER_MODES.has(String(input.mode)) ? String(input.mode) : 'any'
    const found = mode === 'new' ? undefined : await findReplyTarget(folder, input.session_id ? String(input.session_id).trim() : '')
    if (typeof found === 'string') return found
    // A reply whose asker is gone goes to the room, and says whom it answered.
    const gone = found && 'gone' in found ? found.gone : undefined
    const target = found && !('gone' in found) ? found : undefined
    const orderId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const reply = await callOffice(io, officeUrl, {
      action: 'set',
      collection: 'orders',
      doc_id: orderId,
      data: {
        text,
        folder,
        agent: input.agent ? String(input.agent) : null,
        mode,
        model: null,
        sessionId: target?.id ?? null,
        machine: target ? String(target.data.machine ?? '') || null : null,
        replyTo: target ? { sessionId: target.id, title: String(target.data.title ?? '') } : null,
        replyGone: gone ?? null,
        base,
        status: 'proposed',
        reason,
        proposedBy: { sessionId: docId, title: report.title ?? '', folder: report.folder ?? '' },
        createdAt: Date.now(),
      },
    })
    if (!reply.isOk) return `The order could not be proposed: ${reply.text.slice(0, 200)}`
    const to = target ? ` It goes to the session «${String(target.data.title || target.id)}», or to another one of ${folder} if that one is gone.`
      : gone ? ` It answers the session «${gone.title || gone.sessionId}», which no longer exists, so it goes to another session of ${folder}: make sure its text explains it from scratch, for someone who did not ask for it.` : ''
    return `Order proposed. It will be delivered only after the user approves it in the station.${to}`
  }

  // The session an order goes back to: the one named in session_id, or else
  // the session of that department whose order this session received last, so
  // a reply reaches whoever asked instead of any session of the department.
  // A string is a refusal to return to the agent; { gone } is an asker that
  // no longer exists, so the reply goes to the room and says whom it answered.
  async function findReplyTarget(folder: string, sessionId: string): Promise<OfficeDoc | string | { gone: { sessionId: string; title: string } } | undefined> {
    if (!io) return undefined
    if (sessionId) {
      if (sanitizeDocId(sessionId) === docId) return 'Not proposed: session_id is this same session. Leave it out to give the order to another session of the room.'
      const reply = await callOffice(io, officeUrl, { action: 'get', collection: 'sessions', doc_id: sanitizeDocId(sessionId) })
      const session = reply.isOk ? parseDocs(reply.text)[0] : undefined
      if (!session || session.data.folder !== folder) return `Not proposed: the station has no session "${sessionId}" in ${folder}.`
      if (session.data.state === 'ended') return `Not proposed: the session "${sessionId}" has ended. Propose it without session_id.`
      return session
    }
    const received = await callOffice(io, officeUrl, {
      action: 'query',
      collection: 'orders',
      query: { where: [['deliveredTo', '==', docId]], limit: 100 },
    })
    const asker = parseDocs(received.isOk ? received.text : '')
      .filter(order => order.data.proposedBy?.folder === folder && order.data.proposedBy?.sessionId)
      .sort((a, b) => Number(b.data.deliveredAt ?? 0) - Number(a.data.deliveredAt ?? 0))[0]
    if (!asker) return undefined
    const askerId = String(asker.data.proposedBy.sessionId)
    const reply = await callOffice(io, officeUrl, { action: 'get', collection: 'sessions', doc_id: askerId })
    const session = reply.isOk ? parseDocs(reply.text)[0] : undefined
    if (session && session.data.state !== 'ended') return session
    // Read but gone (ended, or no longer in the station): told, not hidden.
    if (!reply.isOk) return undefined
    return { gone: { sessionId: askerId, title: String(session?.data.title ?? asker.data.proposedBy.title ?? '') } }
  }

  function refreshDesktopDetailsInBackground() {
    if (!isReporting || !io) return
    void readDesktopSessionFromApp(io)
      .then(desktop => {
        const patch: Record<string, unknown> = {}
        if (desktop?.title && desktop.title !== report.title) patch.title = desktop.title
        if (desktop?.model && desktop.model !== report.model) patch.model = desktop.model
        if (desktop?.permissionMode && desktop.permissionMode !== report.permissionMode) patch.permissionMode = desktop.permissionMode
        if (Object.keys(patch).length > 0) updateReport(patch, false)
      })
      .catch(() => {})
    // The session's branch, so an order meant for another one says so.
    const engine = io
    void readSessionBranch(engine).then(branch => { if (branch !== report.branch) updateReport({ branch }, false) }).catch(() => {})
  }

  // A session the app opened in a worktree of its repo, which it keeps under
  // .claude/worktrees: such a session works on a branch of its own.
  async function isInWorktree(engine: EngineIo): Promise<boolean> {
    try {
      return /[\\/]\.claude[\\/]worktrees[\\/]/.test(await engine.cwd())
    } catch {
      return false
    }
  }

  // Never throws: a branch that cannot be read is null, and the session reports
  // as it always did.
  async function readSessionBranch(engine: EngineIo): Promise<string | null> {
    try {
      return (await readCurrentBranch(engine, await engine.cwd())) ?? null
    } catch {
      return null
    }
  }

  function updateReport(patch: Record<string, unknown>, isUrgent: boolean) {
    if (!isReporting) return
    report = { ...report, ...patch, lastEventAt: Date.now() }
    hasUnsentChanges = true
    scheduleWrite(isUrgent)
  }

  // While the station is unreachable, nothing is urgent: the report waits for
  // the next retry, so a busy session does not hammer a station that is down.
  function scheduleWrite(isUrgent: boolean) {
    if (!io || isWriting) return
    const isOffline = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
    const gapMs = isOffline
      ? OFFLINE_RETRY_MS[Math.min(consecutiveFailures - MAX_CONSECUTIVE_FAILURES, OFFLINE_RETRY_MS.length - 1)]
      : MIN_WRITE_GAP_MS
    const waitMs = isUrgent && !isOffline ? 0 : Math.max(0, gapMs - (Date.now() - lastWriteAt))
    if (waitMs === 0) {
      void flushReportToOffice()
      return
    }
    if (isWriteScheduled) return
    isWriteScheduled = true
    void io.sleep(waitMs).then(() => {
      isWriteScheduled = false
      void flushReportToOffice()
    }).catch(() => { isWriteScheduled = false })
  }

  async function flushReportToOffice() {
    if (isWriting || !isReporting) return
    isWriting = true
    try {
      while (hasUnsentChanges && isReporting) {
        hasUnsentChanges = false
        const failure = await writeReportToOffice({ ...report })
        lastWriteAt = Date.now()
        if (!failure) {
          const failedWrites = consecutiveFailures
          consecutiveFailures = 0
          if (failedWrites >= MAX_CONSECUTIVE_FAILURES) {
            showStatus()
            logStationEvent('set', `reconnected after ${failedWrites} failed writes`)
            if (hasToldOffline) {
              hasToldOffline = false
              io?.toast(tx(station?.language, 'Agent station: this session reaches the station again.'))
            }
          }
          continue
        }
        // Keep the report: the next write sends it, or the retry below.
        hasUnsentChanges = true
        consecutiveFailures++
        logStationEvent(failure.action, `failure ${consecutiveFailures}: ${failure.error}`)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          io?.status(tx(station?.language, 'station: no connection ({error})', { error: shortError(failure.error, STATUS_ERROR_MAX) }))
          if (!hasToldOffline) {
            hasToldOffline = true
            io?.toast(tx(station?.language, 'Agent station: this session cannot reach the station ({error}), so the station does not show what it does. It keeps trying; the status line says so until it reconnects.', { error: shortError(failure.error, STATUS_ERROR_MAX) }))
          }
        }
        break
      }
    } finally {
      isWriting = false
    }
    if (hasUnsentChanges && isReporting) scheduleWrite(false)
  }

  // Undefined once the report is stored; otherwise the call that failed and
  // the station's reply to it.
  async function writeReportToOffice(data: Record<string, unknown>): Promise<{ action: string; error: string } | undefined> {
    if (!io) return { action: 'set', error: 'no engine' }
    const target = { collection: 'sessions', doc_id: docId }
    const first = await callOffice(io, officeUrl, { action: 'set', ...target, data, if_version: version })
    if (first.version !== undefined) {
      version = first.version
      return undefined
    }
    if (!first.isVersionMismatch && !MISSING_DOC.test(first.text)) return { action: 'set', error: first.text }
    const current = await callOffice(io, officeUrl, { action: 'get', ...target })
    const currentVersion = current.isOk ? parseDocs(current.text)[0]?.version : undefined
    // A row the dispatcher deleted meanwhile (one ended, or disconnected, a week
    // ago, of a session that comes back) is written anew.
    const isGone = current.isOk && currentVersion === undefined && MISSING_DOC.test(current.text)
    if (currentVersion === undefined && !isGone) return { action: 'get', error: current.text }
    const retry = await callOffice(io, officeUrl, { action: 'set', ...target, data, ...(isGone ? {} : { if_version: currentVersion }) })
    if (retry.version === undefined) return { action: 'set', error: retry.text }
    version = retry.version
    return undefined
  }

  // One line per event in ~/.claude/agent-station-logs/<session>.log, which
  // keeps its last LOG_MAX_LINES lines, so a user can send it when the station
  // keeps losing the session. Each session has its own file, since a file can
  // only be rewritten whole and two sessions would overwrite each other's
  // lines. Writes are chained, and a log that cannot be written is let go.
  let logWrite: Promise<void> = Promise.resolve()
  // Before it joins a station the session has no id there yet: the log then
  // goes under the app's own id for the session, which is the one it gets.
  let logId = ''
  async function sessionLogId(engine: EngineIo): Promise<string> {
    if (docId) return docId
    if (!logId) logId = sanitizeDocId((await readDesktopSessionFromApp(engine))?.sessionId ?? (await engine.sessionId().catch(() => '')) ?? '')
    return logId || 'unknown'
  }

  // Each attempt to join a station is logged when its outcome changes: the
  // remote git gave, the stations that answered and those that did not with
  // why, and where the session landed.
  let lastJoinLog = ''
  function logJoin(outcome: string) {
    if (outcome === lastJoinLog) return
    lastJoinLog = outcome
    logStationEvent('join', outcome)
  }

  function logStationEvent(action: string, message: string) {
    const engine = io
    if (!engine) return
    logWrite = logWrite.then(async () => {
      const id = await sessionLogId(engine)
      const line = [
        new Date().toISOString(),
        `session=${id}`,
        `folder=${String(report.folder || '-')}`,
        `action=${action}`,
        shortError(message, action === 'join' ? LOG_ERROR_MAX * 3 : LOG_ERROR_MAX),
      ].join(' ')
      const home = await engine.userProfile()
      if (!home) return
      const path = joinPath(home, '.claude', LOG_FOLDER, `${id}.log`)
      const previous = await engine.readText(path).catch(() => '')
      const lines = [...previous.split(/\r?\n/).filter(Boolean), line].slice(-LOG_MAX_LINES)
      await engine.writeText(path, lines.join('\n') + '\n')
    }).catch(() => {})
  }
}

// An error on one line, cut to `max` characters.
function shortError(text: string, max: number): string {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim() || 'no reply'
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// The `stations` option as `claude plugin configure` stored it in the user
// settings, under this plugin's id (<plugin>@<marketplace>).
async function readStationUrlsFromSettings(io: EngineIo): Promise<string[]> {
  try {
    const home = await io.userProfile()
    if (!home) return []
    const settings = JSON.parse(await io.readText(joinPath(home, '.claude', 'settings.json')))
    const name = (await io.pluginName().catch(() => undefined)) || 'agent-station'
    const entry = Object.entries(settings?.pluginConfigs ?? {}).find(([id]) => id.startsWith(`${name}@`))
    return entry ? stationUrls((entry[1] as any)?.options ?? {}) : []
  } catch {
    return []
  }
}

type SessionCalls = {
  registerTool: (spec: any) => Promise<unknown>
  registerCommand: (spec: any) => Promise<unknown>
  pluginName: () => Promise<string | undefined>
}

function engineIoFor($: any, callToolAsMod: (callTool: (call: any) => Promise<unknown>, call: Record<string, unknown>, sleep?: (ms: number) => Promise<unknown>) => Promise<unknown>): EngineIo {
  return {
    callTool: call => callToolAsMod(c => $.tool.call(c as any), call, ms => $.clock.sleep(ms)),
    sleep: ms => $.clock.sleep(ms),
    status: text => $.ui.status(text),
    toast: text => $.ui.toast(text, { timeoutMs: TOAST_MS }),
    callMcp: (server, tool, args) => $.mcp.call(server, tool, args),
    cwd: () => $.session.cwd(),
    sessionId: () => $.session.id(),
    // Windows names the machine in COMPUTERNAME; elsewhere a desktop app may get
    // no HOSTNAME, so the hostname command answers last.
    computerName: async () => (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME')) ?? await hostnameOf($),
    listDir: path => $.fs.list(path),
    readText: async path => String(await $.fs.read(path)),
    writeText: (path, text) => $.fs.write(path, text),
    runCommand: async argv => { const r: any = await $.process.run(argv, { timeoutMs: 30000 }); return { exitCode: Number(r?.exitCode ?? 1), stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? '') } },
    userProfile: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
    pluginName: async () => $.plugin.name,
    now: async () => Number(await $.clock.now()),
    readKeepers: async () => {
      const held: any = await $.state.get({ plugin: 'agent-station', key: 'keeperTaskIds' } as const)
      return Array.isArray(held?.value) ? held.value.map(String) : []
    },
    writeKeepers: async ids => { await $.state.set({ plugin: 'agent-station', key: 'keeperTaskIds' } as const, ids) },
    readDispatcherGeneration: async () => {
      const held: any = await $.state.get({ plugin: 'agent-station', key: 'dispatcherGeneration' } as const)
      return typeof held?.value === 'string' ? held.value : undefined
    },
    writeDispatcherGeneration: async generation => { await $.state.set({ plugin: 'agent-station', key: 'dispatcherGeneration' } as const, generation) },
  }
}

async function hostnameOf($: any): Promise<string | undefined> {
  try {
    const reply: any = await $.process.run(['hostname'], { timeoutMs: 5000 })
    return Number(reply?.exitCode) === 0 ? String(reply?.stdout ?? '').trim() || undefined : undefined
  } catch {
    return undefined
  }
}

function sessionCallsFor($: any): SessionCalls {
  return {
    registerTool: spec => $.tool.register(spec),
    registerCommand: spec => $.command.register(spec),
    pluginName: async () => $.plugin.name,
  }
}

async function readDesktopSessionFromApp(io: EngineIo): Promise<{ sessionId?: string; title?: string; link?: string; model?: string; permissionMode?: string } | null> {
  try {
    const parsed = JSON.parse(mcpText(await io.callMcp('ccd_session_mgmt', 'get_session', { session_id: 'self' })))
    return { sessionId: parsed.sessionId, title: parsed.title, link: parsed.link, model: parsed.model, permissionMode: typeof parsed.permissionMode === 'string' ? parsed.permissionMode : undefined }
  } catch {
    return null
  }
}

// A message another Claude session sent: the app's own (send_message) or the
// SendMessage tool's.
function isPeerMessage(origin: unknown): boolean {
  const kind = (origin as { kind?: string } | undefined)?.kind
  return kind === 'peer' || kind === 'peer-send-message'
}

function sanitizeDocId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 200)
}

// What the user sees in the permission prompt when the coordination session
// writes to the station: the action, the document and the fields it sets.
function describeCoordinationWrite(input: any, language: Lang | undefined): string {
  const data = input?.data && typeof input.data === 'object' ? input.data : {}
  const fields = Object.entries(data)
    .map(([k, v]) => `${k}: ${(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 160)}`)
    .join('\n')
  const source = input?.file_path ? `\n${tx(language, '(data from the file {file})', { file: String(input.file_path) })}` : ''
  const target = `${String(input?.action)} ${String(input?.collection)}/${String(input?.doc_id ?? '')}`
  return `${tx(language, 'The coordination session wants to write to the station ({target}).', { target })}${fields ? '\n' + fields : ''}${source}`
}
