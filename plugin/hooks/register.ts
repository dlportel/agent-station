import type { Register } from 'claude-code'
import { artifactKey, callOffice, isOfficeCall, mcpText, officeCallKey, parseDocs, toolDetail, type EngineIo, type OfficeDoc } from './office'
import { startDispatcherInBackground } from './dispatcher'
import { coordinationPeerNote, folderForRemote, joinPath, LANGS, readOriginRemote, readStationConfig, roomsLine, stationMap, stationRooms, stationUrls, isDirectSessionMessage, readOrderMark, type Lang, type Station } from './station'
import { tx } from './locale-es'

// Observer only: every hook hands the event on unchanged and never waits on
// the station. Writes run in the background, time out, and after repeated
// failures the mod goes quiet for the rest of the session.
//
// The plugin serves the stations listed in its `stations` option. A session
// belongs to the first of them whose repos (config/departments.repos) include
// the origin remote of its repo; any other session is ignored, so the mod
// never writes anywhere but that one station.

type SessionState = 'working' | 'waiting' | 'idle' | 'ended'

const MIN_WRITE_GAP_MS = 20_000
const MAX_CONSECUTIVE_FAILURES = 3
// A station that did not answer is asked again at once, then after 1, 5 and 15 minutes.
const STATION_RETRY_MS = [0, 60_000, 5 * 60_000, 15 * 60_000]
const QUESTION_TOOLS = new Set(['AskUserQuestion'])
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
  description: 'Propose an order for the agent of another room of this station, for example to wake it after opening a handoff issue for it, or to return the result of an order this session received from another room. This is the only way to ask another room for work: never message its sessions directly. The order is not delivered until the user approves it in the station. Input: folder (the folder of the target room, as the station map lists it; to return a result, the folder of the room that asked), text (what the agent must do, or the result you return; include the issue link if there is one; at most 20000 characters, a longer order is refused whole, never cut), optional agent (a subagent of that room, only when the user asks for a particular one; otherwise that room chooses), optional mode (any | existing | new, default any), optional session_id (the station id of the session that must receive it), and reason (why you ask, at most 1000 characters). When this session received an order from that room, the new order goes back to the session that sent it, without session_id; if that session is gone, to another session of the room. The coordination session only hands orders out: never ask it to forward work or results.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: { type: 'string' },
      text: { type: 'string' },
      agent: { type: 'string' },
      mode: { type: 'string', enum: ['any', 'existing', 'new'] },
      session_id: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['folder', 'text', 'reason'],
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
  let stationsFailures = 0
  let remoteRead: Promise<string | undefined> | undefined
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
  let areSessionToolsRegistered = false
  let proposeToolName = ''
  // The map of the station this session belongs to. It goes with the session's
  // first message as added context (waiting a moment for it while it is being
  // read), and again after /clear or a compaction, which drop it.
  let stationMapText = ''
  // The room this session belongs to, known as soon as its map is.
  let ownFolder = ''
  let isMapDelivered = false
  // Settles once the session knows whether it belongs to a station (and, if it
  // does, has its map), so the first message waits for that and no longer.
  let markMapSettled: () => void = () => {}
  const mapSettled = new Promise<void>(resolve => { markMapSettled = resolve })
  const ownCallsInFlight = new Map<string, number>()
  const isOwnCall = (input: any) => (ownCallsInFlight.get(officeCallKey(input)) ?? 0) > 0
  async function callToolAsMod(callTool: (call: any) => Promise<unknown>, call: Record<string, unknown>) {
    const key = officeCallKey(call)
    ownCallsInFlight.set(key, (ownCallsInFlight.get(key) ?? 0) + 1)
    try {
      return await callTool(call)
    } finally {
      const left = (ownCallsInFlight.get(key) ?? 1) - 1
      if (left > 0) ownCallsInFlight.set(key, left)
      else ownCallsInFlight.delete(key)
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
      const read = await Promise.all(urls.map(url => readStationConfig(io, url).catch(() => undefined)))
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
        remoteRead ??= io.cwd().then(cwd => readOriginRemote(io, cwd))
        const remote = await remoteRead
        if (!remote) return null
        const { read } = await loadStations(io)
        for (const candidate of read) {
          if (!candidate) {
            isWorthRetrying = true
            return null
          }
          const folder = folderForRemote(remote, candidate.repos)
          if (!folder) continue
          station = candidate
          officeUrl = candidate.officeUrl
          ownKeys = candidate.officeKeys
          return { station: candidate, folder }
        }
        return null
      } catch {
        isWorthRetrying = true
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
  async function registerSessionTools(engine: EngineIo, calls: SessionCalls) {
    if (areSessionToolsRegistered) return
    try {
      const member = await resolveMembership(engine)
      if (!member) {
        markMapSettled()
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
      await calls.registerCommand(coordinatorCommand(member.station.language)).catch(() => {})
      areSessionToolsRegistered = true
    } catch {
      markMapSettled()
    }
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
    if (e.reason === 'clear') isMapDelivered = false
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    startOnce(engineIoFor($, callToolAsMod), sessionCallsFor($), 'working')
    // Never let an agent's write through before the stations' ids are known.
    if (io && !isOwnCall(e) && (isArtifactDataWrite(e.tool, e) || isArtifactPageChange(e.tool, e))) await loadStations(io)
    // The station page itself: only its own coordination session may republish
    // or delete it, and the user is asked (PreToolUse below).
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
    if (e.tool === DESKTOP_SESSION_TOOL) return next(e)
    if (isProposeTool(e.tool)) return { result: await proposeOrder(e) } as any
    const isQuestion = QUESTION_TOOLS.has(e.tool)
    const droneKey = SUBAGENT_TOOLS.has(e.tool) ? String((e as any).tool_use_id ?? Math.random()) : ''
    if (droneKey) activeDrones.set(droneKey, String((e as any).subagent_type || 'general-purpose'))
    updateReport({
      state: (isQuestion ? 'waiting' : 'working') satisfies SessionState,
      tool: e.tool,
      detail: toolDetail(e.tool, e),
      waitKind: isQuestion ? 'question' : null,
      drones: [...activeDrones.values()],
    }, isQuestion || !!droneKey)
    try {
      const result = await next(e)
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

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    refreshDesktopDetailsInBackground()
    updateReport({ state: 'idle' satisfies SessionState, tool: null, detail: null, waitKind: null }, true)
    return result
  })

  on('classic.SessionEnd', ($, e, next) => {
    isSessionOver = true
    updateReport({ state: 'ended' satisfies SessionState, tool: null, detail: null, waitKind: null, endedAt: Date.now() }, true)
    return next(e)
  })

  // The mod's own station calls must never open a permission dialog; the
  // agent's calls go through the normal permission flow. A write the guard
  // cannot place (a URL it does not recognise, or an alias of a station that
  // has not answered yet) asks the user instead of passing silently.
  on('classic.PreToolUse', ($, e, next) => {
    const input = e.tool_input
    // Work between rooms goes through propose_order and its approval: a message
    // straight to another session of the app asks the user.
    if (station && isDirectSessionMessage(e.tool_name, input)) {
      return { ask: tx(station.language, 'This agent wants to write to another Claude Code session directly, outside the station. Work between rooms goes through propose_order, which waits for your approval in the station: allow this only if you asked for it.') }
    }
    if (isOwnCall(input) && isOfficeCall(allKeys, e.tool_name, input)) return { allow: true }
    if (isArtifactPageChange(e.tool_name, input) && isStationUrl(input) && isOwnStationPageChange(input)) {
      const isDelete = String(input?.action ?? 'publish') === 'delete'
      const ask = isDelete
        ? 'The coordination session wants to delete the station page ({url}).'
        : 'The coordination session wants to republish the station page ({url}).'
      return { ask: tx(station?.language, ask, { url: String(input?.url) }) }
    }
    if (isArtifactDataWrite(e.tool_name, input) && !isOwnCall(input)) {
      if (isOfficeCall(allKeys, e.tool_name, input)) {
        if (isCoordinationWrite(input)) return { ask: describeCoordinationWrite(input, station?.language) }
        return next(e)
      }
      const unverified = describeUnverifiedWrite(input)
      if (unverified) return { ask: unverified }
    }
    return next(e)
  })

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
      }, true)
      isCoordination = !!member.station.coordination && member.folder === member.station.coordination
      if (isCoordination && desktop?.sessionId) {
        startDispatcherInBackground({
          io,
          officeUrl,
          station: member.station,
          machine,
          ownSessionId: docId,
          isAlive: () => isReporting && !isSessionOver,
        })
      }
      return true
    } catch {
      isReporting = false
      return false
    }
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
    const mode = ORDER_MODES.has(String(input.mode)) ? String(input.mode) : 'any'
    const target = mode === 'new' ? undefined : await findReplyTarget(folder, input.session_id ? String(input.session_id).trim() : '')
    if (typeof target === 'string') return target
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
        status: 'proposed',
        reason,
        proposedBy: { sessionId: docId, title: report.title ?? '', folder: report.folder ?? '' },
        createdAt: Date.now(),
      },
    })
    if (!reply.isOk) return `The order could not be proposed: ${reply.text.slice(0, 200)}`
    const to = target ? ` It goes to the session «${String(target.data.title || target.id)}», or to another one of ${folder} if that one is gone.` : ''
    return `Order proposed. It will be delivered only after the user approves it in the station.${to}`
  }

  // The session an order goes back to: the one named in session_id, or else
  // the session of that department whose order this session received last, so
  // a reply reaches whoever asked instead of any session of the department.
  // A string is a refusal to return to the agent.
  async function findReplyTarget(folder: string, sessionId: string): Promise<OfficeDoc | string | undefined> {
    if (!io) return undefined
    if (sessionId) {
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
    const reply = await callOffice(io, officeUrl, { action: 'get', collection: 'sessions', doc_id: String(asker.data.proposedBy.sessionId) })
    const session = reply.isOk ? parseDocs(reply.text)[0] : undefined
    return session && session.data.state !== 'ended' ? session : undefined
  }

  function refreshDesktopDetailsInBackground() {
    if (!isReporting || !io) return
    void readDesktopSessionFromApp(io)
      .then(desktop => {
        const patch: Record<string, unknown> = {}
        if (desktop?.title && desktop.title !== report.title) patch.title = desktop.title
        if (desktop?.model && desktop.model !== report.model) patch.model = desktop.model
        if (Object.keys(patch).length > 0) updateReport(patch, false)
      })
      .catch(() => {})
  }

  function updateReport(patch: Record<string, unknown>, isUrgent: boolean) {
    if (!isReporting) return
    report = { ...report, ...patch, lastEventAt: Date.now() }
    hasUnsentChanges = true
    scheduleWrite(isUrgent)
  }

  function scheduleWrite(isUrgent: boolean) {
    if (!io || isWriting) return
    const waitMs = isUrgent ? 0 : Math.max(0, MIN_WRITE_GAP_MS - (Date.now() - lastWriteAt))
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
        const isWritten = await writeReportToOffice({ ...report })
        lastWriteAt = Date.now()
        if (isWritten) {
          if (consecutiveFailures > 0) io?.status(undefined)
          consecutiveFailures = 0
          continue
        }
        // Keep the report: the next write sends it, or the retry below.
        hasUnsentChanges = true
        consecutiveFailures++
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          isReporting = false
          io?.status(tx(station?.language, 'station: no connection'))
        }
        break
      }
    } finally {
      isWriting = false
    }
    if (hasUnsentChanges && isReporting) scheduleWrite(false)
  }

  async function writeReportToOffice(data: Record<string, unknown>): Promise<boolean> {
    if (!io) return false
    const target = { collection: 'sessions', doc_id: docId }
    const first = await callOffice(io, officeUrl, { action: 'set', ...target, data, if_version: version })
    if (first.version !== undefined) {
      version = first.version
      return true
    }
    if (!first.isVersionMismatch) return false
    const current = await callOffice(io, officeUrl, { action: 'get', ...target })
    const currentVersion = current.isOk ? parseDocs(current.text)[0]?.version : undefined
    if (currentVersion === undefined) return false
    const retry = await callOffice(io, officeUrl, { action: 'set', ...target, data, if_version: currentVersion })
    if (retry.version === undefined) return false
    version = retry.version
    return true
  }
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

function engineIoFor($: any, callToolAsMod: (callTool: (call: any) => Promise<unknown>, call: Record<string, unknown>) => Promise<unknown>): EngineIo {
  return {
    callTool: call => callToolAsMod(c => $.tool.call(c as any), call),
    sleep: ms => $.clock.sleep(ms),
    status: text => $.ui.status(text),
    callMcp: (server, tool, args) => $.mcp.call(server, tool, args),
    cwd: () => $.session.cwd(),
    sessionId: () => $.session.id(),
    // Windows names the machine in COMPUTERNAME; elsewhere a desktop app may get
    // no HOSTNAME, so the hostname command answers last.
    computerName: async () => (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME')) ?? await hostnameOf($),
    listDir: path => $.fs.list(path),
    readText: async path => String(await $.fs.read(path)),
    runCommand: async argv => { const r: any = await $.process.run(argv, { timeoutMs: 30000 }); return { exitCode: Number(r?.exitCode ?? 1), stdout: String(r?.stdout ?? '') } },
    userProfile: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
    pluginName: async () => $.plugin.name,
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

async function readDesktopSessionFromApp(io: EngineIo): Promise<{ sessionId?: string; title?: string; link?: string; model?: string } | null> {
  try {
    const parsed = JSON.parse(mcpText(await io.callMcp('ccd_session_mgmt', 'get_session', { session_id: 'self' })))
    return { sessionId: parsed.sessionId, title: parsed.title, link: parsed.link, model: parsed.model }
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
