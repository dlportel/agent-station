import { callOffice, mcpText, parseDocs, type EngineIo, type OfficeDoc } from './office'
import { folderForRemote, joinPath, orderMark, parentOf, readMainRepoTop, readOriginRemote, type Station } from './station'
import { tx } from './locale-es'

// Delivers the orders written in the station to this machine's sessions. One
// session per machine holds the dispatcher lease; every step is best effort
// and a failed step leaves the order with a note instead of retrying blindly.
//
// The station's repos on this machine are the folders next to the
// coordination repo whose origin remote is one of the station's repos.

export type DispatcherContext = {
  io: EngineIo
  officeUrl: string
  station: Station
  machine: string
  ownSessionId: string
  isAlive: () => boolean
}

type LocalRepo = { path: string; remote: string }

const localReposByContext = new WeakMap<DispatcherContext, Promise<Map<string, LocalRepo>>>()

function localRepos(context: DispatcherContext): Promise<Map<string, LocalRepo>> {
  let found = localReposByContext.get(context)
  if (!found) {
    found = scanLocalRepos(context)
    localReposByContext.set(context, found)
  }
  return found
}

async function scanLocalRepos(context: DispatcherContext): Promise<Map<string, LocalRepo>> {
  const repos = new Map<string, LocalRepo>()
  const top = await readMainRepoTop(context.io, await context.io.cwd())
  if (!top) return repos
  const parent = parentOf(top)
  let entries: Array<{ name: string; kind: string }> = []
  try {
    entries = await context.io.listDir(parent)
  } catch {
    return repos
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const path = joinPath(parent, entry.name)
    const remote = await readOriginRemote(context.io, path)
    const folder = remote ? folderForRemote(remote, context.station.repos) : undefined
    if (folder && remote && !repos.has(folder)) repos.set(folder, { path, remote })
  }
  return repos
}

const POLL_MS = 30_000
// The lease is renewed every LEASE_RENEW_MS and only another session may take
// it over once it is older than LEASE_MS, so renewals have slack to fail.
const LEASE_MS = 5 * 60_000
const LEASE_RENEW_MS = 2 * 60_000
const RECONCILE_EVERY_POLLS = 10
const HANDOFFS_EVERY_POLLS = 30
const CLOSED_HANDOFF_KEEP_MS = 24 * 60 * 60_000
const SESSION_LIST_LIMIT = 200
const ENDED_RETENTION_MS = 7 * 24 * 60 * 60_000
const STALE_SESSION_MS = 10 * 60_000
const ORDER_RETENTION_MS = 30 * 24 * 60 * 60_000
const MODEL_ID_PATTERN = /claude-[a-z0-9][a-z0-9.-]*[a-z0-9]/g

export function startDispatcherInBackground(context: DispatcherContext) {
  void (async () => {
    // Counted only while holding the lease, so a session that takes it over
    // scans handoffs and reconciles on its first turn.
    let polls = 0
    let leaseRenewedAt = 0
    let hasScannedAgents = false
    while (context.isAlive()) {
      try {
        const isLeaseFresh = Date.now() - leaseRenewedAt < LEASE_RENEW_MS
        if (!isLeaseFresh) leaseRenewedAt = (await holdDispatcherLease(context)) ? Date.now() : 0
        if (leaseRenewedAt > 0) {
          if (!hasScannedAgents) {
            hasScannedAgents = true
            await syncAgentCatalog(context)
          }
          if (polls % HANDOFFS_EVERY_POLLS === 0) await syncHandoffs(context)
          if (polls % RECONCILE_EVERY_POLLS === 0) {
            await reconcileSessions(context)
            await removeOldOrders(context)
          }
          const open = await queryOrders(context, ['pending', 'needs_click'])
          await deliverPendingOrders(context, open.filter(order => order.data.status === 'pending'))
          await completeSpawnedOrders(context, open.filter(order => order.data.status === 'needs_click'))
          polls++
        }
      } catch {}
      const hasSlept = await context.io.sleep(POLL_MS).then(() => true, () => false)
      if (!hasSlept) return
    }
  })()
}

async function holdDispatcherLease(context: DispatcherContext): Promise<boolean> {
  const { io, officeUrl, machine, ownSessionId } = context
  const leaseId = sanitizeId(machine || 'unknown')
  const current = await callOffice(io, officeUrl, { action: 'get', collection: 'dispatchers', doc_id: leaseId })
  // A lease that could not be read is never taken: it may be held by a live session.
  if (!current.isOk) return false
  const lease = parseDocs(current.text)[0]
  const isHeldByOther = lease
    && lease.data.sessionId !== ownSessionId
    && Date.now() - Number(lease.data.heartbeatAt ?? 0) < LEASE_MS
  if (isHeldByOther) return false
  const written = await callOffice(io, officeUrl, {
    action: 'set',
    collection: 'dispatchers',
    doc_id: leaseId,
    data: { sessionId: ownSessionId, machine, heartbeatAt: Date.now() },
    if_version: lease?.version,
  })
  return written.isOk
}

// The agents each project defines in .claude/agents/*.md, read once when the
// dispatcher starts: they change rarely, and /reload-plugins rereads them.
async function syncAgentCatalog(context: DispatcherContext) {
  const byFolder: Record<string, Array<{ name: string; description: string; model: string }>> = {}
  const repos = await localRepos(context)
  if (!repos.size) return
  for (const [folder, repo] of repos) {
    const agentsDir = joinPath(repo.path, '.claude', 'agents')
    let files: Array<{ name: string; kind: string }> = []
    try {
      files = await context.io.listDir(agentsDir)
    } catch {
      continue
    }
    const agents = []
    for (const file of files) {
      if (file.kind !== 'file' || !file.name.endsWith('.md')) continue
      try {
        const meta = readFrontmatter(await context.io.readText(joinPath(agentsDir, file.name)))
        agents.push({ name: meta.name || file.name.replace(/\.md$/, ''), description: (meta.description || '').slice(0, 240), model: meta.model || '' })
      } catch {}
    }
    if (agents.length) byFolder[folder] = agents.sort((a, b) => a.name.localeCompare(b.name))
  }
  const current = await callOffice(context.io, context.officeUrl, { action: 'get', collection: 'config', doc_id: 'agents' })
  // A catalog that could not be read is left alone: writing it now would drop what it holds.
  if (!current.isOk) return
  const doc = parseDocs(current.text)[0]
  const previous: Record<string, Array<{ name: string }>> = doc?.data?.byFolder ?? {}
  const firstSeen: Record<string, number> = { ...(doc?.data?.firstSeen ?? {}) }
  const hadCatalog = Object.keys(previous).length > 0
  for (const [folder, agents] of Object.entries(byFolder)) {
    for (const agent of agents) {
      const key = `${folder}/${agent.name}`
      const isKnown = (previous[folder] ?? []).some(a => a.name === agent.name)
      if (hadCatalog && !isKnown && !firstSeen[key]) firstSeen[key] = Date.now()
    }
  }
  await callOffice(context.io, context.officeUrl, {
    action: 'set',
    collection: 'config',
    doc_id: 'agents',
    data: { byFolder: { ...previous, ...byFolder }, firstSeen, scannedAt: Date.now(), scannedBy: context.machine },
    if_version: doc?.version,
  })
}

function readFrontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (pair) meta[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim()
  }
  return meta
}

// Open handoff issues of every GitHub repo of the station, for the department
// mailboxes, and the ones that closed since the last scan, for the station to
// celebrate. Uses the machine's gh, every fifteen minutes.
async function syncHandoffs(context: DispatcherContext) {
  const repos = await localRepos(context)
  if (!repos.size) return
  const byFolder: Record<string, Array<{ number: number; title: string; url: string; from: string; createdAt: string }>> = {}
  let isComplete = true
  for (const [folder, local] of repos) {
    try {
      const repo = local.remote.trim().replace(/\/+$/, '').replace(/\.git$/, '').match(/github\.com[/:]([^/\s]+\/[^/\s]+)$/)?.[1]
      if (!repo) continue
      const listed = await context.io.runCommand(['gh', 'issue', 'list', '--repo', repo, '--label', 'handoff', '--state', 'open', '--limit', '50', '--json', 'number,title,url,createdAt,labels'])
      if (listed.exitCode !== 0) { isComplete = false; continue }
      const issues = JSON.parse(listed.stdout || '[]')
      if (issues.length) byFolder[folder] = issues.map((i: any) => ({
        number: i.number,
        title: String(i.title ?? '').slice(0, 200),
        url: i.url,
        from: (i.labels ?? []).map((l: any) => String(l.name)).find((n: string) => n.startsWith('from-'))?.slice(5) ?? '',
        createdAt: i.createdAt,
      }))
    } catch {
      isComplete = false
    }
  }
  const current = await callOffice(context.io, context.officeUrl, { action: 'get', collection: 'config', doc_id: 'handoffs' })
  // A catalog that could not be read is left alone: writing it now would drop what it holds.
  if (!current.isOk) return
  const doc = parseDocs(current.text)[0]
  const previous: typeof byFolder = doc?.data?.byFolder ?? {}
  const closed: Array<{ folder: string; number: number; title: string; closedAt: number }> = (doc?.data?.closedRecently ?? [])
    .filter((c: any) => Date.now() - Number(c.closedAt ?? 0) < CLOSED_HANDOFF_KEEP_MS)
  if (isComplete && doc) {
    for (const [folder, issues] of Object.entries(previous)) {
      for (const issue of issues) {
        const isStillOpen = (byFolder[folder] ?? []).some(i => i.number === issue.number)
        if (!isStillOpen) closed.push({ folder, number: issue.number, title: issue.title, closedAt: Date.now() })
      }
    }
  }
  await callOffice(context.io, context.officeUrl, {
    action: 'set',
    collection: 'config',
    doc_id: 'handoffs',
    data: { byFolder: isComplete ? byFolder : { ...previous, ...byFolder }, closedRecently: closed.slice(-20), scannedAt: Date.now(), scannedBy: context.machine },
    if_version: doc?.version,
  })
}

// A session deleted or archived from the app never reports its end, so its
// office row would stay alive forever: compare with the app's own list.
async function reconcileSessions(context: DispatcherContext) {
  const listed = await callMcpSafely(context, 'ccd_session_mgmt', 'list_sessions', { limit: SESSION_LIST_LIMIT, include_archived: true })
  if (!listed.isOk) return
  let appSessions: Array<{ sessionId?: string; isArchived?: boolean; isRunning?: boolean }>
  try {
    appSessions = JSON.parse(listed.text)
  } catch {
    return
  }
  if (!Array.isArray(appSessions)) return
  const isListComplete = appSessions.length < SESSION_LIST_LIMIT
  const archivedById = new Map(appSessions.map(s => [String(s.sessionId), Boolean(s.isArchived)]))
  const runningById = new Map(appSessions.map(s => [String(s.sessionId), s.isRunning]))
  const reply = await callOffice(context.io, context.officeUrl, {
    action: 'query',
    collection: 'sessions',
    query: { where: [['machine', '==', context.machine]], limit: 500 },
  })
  if (!reply.isOk) return
  for (const session of parseDocs(reply.text)) {
    if (!context.isAlive()) return
    if (session.id === context.ownSessionId || !session.id.startsWith('local_')) continue
    if (session.data.state === 'ended') {
      if (Date.now() - Number(session.data.endedAt ?? 0) > ENDED_RETENTION_MS) {
        await callOffice(context.io, context.officeUrl, { action: 'delete', collection: 'sessions', doc_id: session.id, if_version: session.version })
      }
      continue
    }
    const isArchived = archivedById.get(session.id)
    const endReason = isArchived === true ? 'archived' : isArchived === undefined && isListComplete ? 'deleted' : ''
    // A session whose process stopped without reporting the end of its turn
    // would show as working, then silent, forever: the app knows it is idle.
    const isBusyState = session.data.state === 'working' || session.data.state === 'waiting'
    const isStale = Date.now() - Number(session.data.lastEventAt ?? 0) > STALE_SESSION_MS
    if (!endReason && isBusyState && isStale && runningById.get(session.id) === false) {
      await callOffice(context.io, context.officeUrl, {
        action: 'update',
        collection: 'sessions',
        doc_id: session.id,
        data: { state: 'idle', tool: null, drones: [] },
        if_version: session.version,
      })
      continue
    }
    if (!endReason) continue
    await callOffice(context.io, context.officeUrl, {
      action: 'update',
      collection: 'sessions',
      doc_id: session.id,
      data: { state: 'ended', tool: null, endedAt: Date.now(), endReason },
      if_version: session.version,
    })
  }
}

async function deliverPendingOrders(context: DispatcherContext, pending: OfficeDoc[]) {
  for (const order of pending) {
    if (!context.isAlive()) return
    if (order.data.machine && order.data.machine !== context.machine) continue
    const claimed = await updateOrder(context, order, { status: 'claimed', claimedBy: context.machine, claimedAt: Date.now() })
    if (claimed === undefined) continue
    await handleClaimedOrder(context, { ...order, version: claimed })
  }
}

// A note on an order, in the station's language.
const say = (context: Pick<DispatcherContext, 'station'>, text: string, vars?: Record<string, unknown>) => tx(context.station.language, text, vars)

async function handleClaimedOrder(context: DispatcherContext, order: OfficeDoc) {
  const mode = String(order.data.mode ?? 'any')
  const requestedId = order.data.sessionId ? String(order.data.sessionId) : ''
  let lastError = ''
  for (const target of mode === 'new' ? [] : await pickOpenSessions(context, order)) {
    const note = requestedId && target.id !== requestedId ? say(context, 'The chosen session was no longer open: another one of the room takes it.') : ''
    const outcome = await deliverToSession(context, order, target, note)
    if (outcome === true) return
    lastError = outcome
  }
  if (mode === 'existing') {
    await updateOrder(context, order, {
      status: 'failed',
      note: lastError
        ? say(context, 'It could not be delivered: {error}', { error: lastError })
        : requestedId
          ? say(context, 'The chosen session is no longer open on {machine}.', { machine: context.machine })
          : say(context, 'No session of {room} is standing by on {machine}.', { room: order.data.folder || say(context, 'that role'), machine: context.machine }),
    })
    return
  }
  await prepareNewSession(context, order)
}

// The open sessions that may take the order, in the order they are tried. An
// order for a given session goes to it even while it works (the message waits
// for its turn to end); with mode `existing` it goes nowhere else, and with
// `any`, if that session is gone, to the department's idle sessions.
async function pickOpenSessions(context: DispatcherContext, order: OfficeDoc): Promise<OfficeDoc[]> {
  const { io, officeUrl, machine, ownSessionId } = context
  // An idle session stays usable however long it has been quiet, as long as
  // the app still has it open: ask the app instead of guessing from its age.
  const openInApp = await listOpenAppSessions(context)
  const isOpen = (session: OfficeDoc) => session.id !== ownSessionId && session.data.machine === machine && (!openInApp || openInApp.has(session.id))
  const picked: OfficeDoc[] = []
  if (order.data.sessionId) {
    const reply = await callOffice(io, officeUrl, { action: 'get', collection: 'sessions', doc_id: String(order.data.sessionId) })
    const session = reply.isOk ? parseDocs(reply.text)[0] : undefined
    if (session && isOpen(session) && session.data.state !== 'ended') picked.push(session)
    if (order.data.mode === 'existing') return picked
  }
  const reply = await callOffice(io, officeUrl, {
    action: 'query',
    collection: 'sessions',
    query: { where: [['folder', '==', String(order.data.folder ?? '')]], limit: 100 },
  })
  if (!reply.isOk) return picked
  const idle = parseDocs(reply.text)
    .filter(session => session.data.state === 'idle' && isOpen(session) && !picked.some(p => p.id === session.id))
    .sort((a, b) => Number(b.data.lastEventAt ?? 0) - Number(a.data.lastEventAt ?? 0))
  return picked.concat(idle)
}

// The ids of the sessions the app has open (not archived), or undefined when
// the app does not answer or its list is cut short.
async function listOpenAppSessions(context: DispatcherContext): Promise<Set<string> | undefined> {
  const listed = await callMcpSafely(context, 'ccd_session_mgmt', 'list_sessions', { limit: SESSION_LIST_LIMIT, include_archived: false })
  if (!listed.isOk) return undefined
  try {
    const appSessions: Array<{ sessionId?: string; isArchived?: boolean }> = JSON.parse(listed.text)
    if (!Array.isArray(appSessions) || appSessions.length >= SESSION_LIST_LIMIT) return undefined
    return new Set(appSessions.filter(s => !s.isArchived).map(s => String(s.sessionId)))
  } catch {
    return undefined
  }
}

// True once the order is settled (delivered, or failed for good); otherwise
// why the session did not take it, so the next one can be tried.
async function deliverToSession(context: DispatcherContext, order: OfficeDoc, session: OfficeDoc, note: string): Promise<true | string> {
  const model = order.data.model ? String(order.data.model) : ''
  if (model && model !== session.data.model) {
    const switched = await switchSessionModel(context, session.id, model)
    if (!switched.isOk) {
      await updateOrder(context, order, { status: 'failed', note: say(context, 'The model could not be switched to {model}: {error}', { model, error: switched.text.slice(0, 300) }) })
      return true
    }
  }
  const reply = await callMcpSafely(context, 'ccd_session_mgmt', 'send_message', {
    session_id: session.id,
    message: composeOrderMessage(context, order),
  })
  if (!reply.isOk || !/delivered|queued/i.test(reply.text)) return reply.text.slice(0, 300) || 'no answer'
  const queued = /queued/i.test(reply.text) ? say(context, 'Queued: the session was finishing something else.') : ''
  await updateOrder(context, order, { status: 'delivered', deliveredTo: session.id, deliveredTitle: session.data.title ?? '', deliveredAt: Date.now(), note: [note, queued].filter(Boolean).join(' ') })
  return true
}

async function prepareNewSession(context: DispatcherContext, order: OfficeDoc) {
  const folder = String(order.data.folder ?? '')
  if (!folder) {
    await updateOrder(context, order, { status: 'failed', note: say(context, 'A new session needs a role.') })
    return
  }
  // Only a repo of this station on this machine can host the new session.
  const local = (await localRepos(context)).get(folder)
  if (!local) {
    await updateOrder(context, order, { status: 'failed', note: say(context, '{room} is not a room of this station on {machine}.', { room: folder, machine: context.machine }) })
    return
  }
  const text = String(order.data.text ?? '')
  const reply = await callMcpSafely(context, 'ccd_session', 'spawn_task', {
    title: `${say(context, 'Station')}: ${text.slice(0, 50)}`,
    tldr: say(context, 'Order sent from the station for {room}. Click to open the session with this order as its first message.', { room: folder }),
    // The mark lets the session the card opens claim this order, and only it.
    prompt: `${composeOrderMessage(context, order)}

${orderMark(order.id, folder)}`,
    cwd: local.path,
  })
  await updateOrder(context, order, reply.isOk
    ? { status: 'needs_click', spawnedAt: Date.now(), note: say(context, 'Card ready in the coordination session of {machine}: click it to create the session.', { machine: context.machine }) }
    : { status: 'failed', note: say(context, 'The new session could not be prepared: {error}', { error: reply.text.slice(0, 300) }) })
}

// A new-session order goes to the session its card opened: the one that found
// the order's mark in its first message and recorded it as fromOrder. Never to
// a session that merely started in the room meanwhile. A card run in a session
// of another room (such as "do it here" in the coordination session) fails the
// order, since nobody in its room is doing it.
async function completeSpawnedOrders(context: DispatcherContext, spawned: OfficeDoc[]) {
  const waiting = spawned.filter(order => order.data.claimedBy === context.machine)
  for (const order of waiting) {
    if (!context.isAlive()) return
    const reply = await callOffice(context.io, context.officeUrl, {
      action: 'query',
      collection: 'sessions',
      query: { where: [['fromOrder', '==', order.id]], limit: 10 },
    })
    if (!reply.isOk) continue
    // Only an open session of this machine counts; two that claim the same
    // order leave it unclear which one does the work.
    const claims = parseDocs(reply.text).filter(s => s.data.machine === context.machine && s.data.state !== 'ended')
    if (!claims.length) continue
    if (claims.length > 1) {
      await updateOrder(context, order, { status: 'failed', note: say(context, 'More than one session claims this order, so it is unclear which one is doing it. Give the order again and open its card as a new session.') })
      continue
    }
    const session = claims[0]
    const folder = String(order.data.folder ?? '')
    if (session.data.folder !== folder) {
      await updateOrder(context, order, { status: 'failed', note: say(context, 'Its card was run in a session of {other}, not in {room}, so nobody in {room} is doing it. Give the order again and open its card as a new session.', { other: session.data.folder || '?', room: folder }) })
      continue
    }
    const model = order.data.model ? String(order.data.model) : ''
    let note = say(context, 'Session created with your click.')
    if (model && model !== session.data.model) {
      const switched = await switchSessionModel(context, session.id, model)
      note = switched.isOk
        ? say(context, 'Session created with your click and switched to {model}.', { model })
        : say(context, 'Session created, but the model could not be switched: {error}', { error: switched.text.slice(0, 200) })
    }
    await updateOrder(context, order, { status: 'delivered', deliveredTo: session.id, deliveredTitle: session.data.title ?? '', deliveredAt: Date.now(), note })
  }
}

async function switchSessionModel(context: DispatcherContext, sessionId: string, model: string) {
  const reply = await callMcpSafely(context, 'ccd_session_mgmt', 'set_session_model', { session_id: sessionId, model })
  if (!reply.isOk) await rememberPickerModels(context, reply.text)
  return reply
}

// The app answers an unknown model id with the ids its picker offers: keep them
// so the office lists new models without a code change.
async function rememberPickerModels(context: DispatcherContext, text: string) {
  const ids = [...new Set(text.match(MODEL_ID_PATTERN) ?? [])]
  if (ids.length === 0) return
  const current = await callOffice(context.io, context.officeUrl, { action: 'get', collection: 'config', doc_id: 'models' })
  // A catalog that could not be read is left alone: writing it now would drop what it holds.
  if (!current.isOk) return
  const doc = parseDocs(current.text)[0]
  await callOffice(context.io, context.officeUrl, {
    action: 'set',
    collection: 'config',
    doc_id: 'models',
    data: { ...(doc?.data ?? {}), pickerModels: ids, pickerModelsAt: Date.now() },
    if_version: doc?.version,
  })
}

async function removeOldOrders(context: DispatcherContext) {
  const finished = await queryOrders(context, ['delivered', 'failed', 'rejected'], 200)
  for (const order of finished) {
    if (!context.isAlive()) return
    const finishedAt = Number(order.data.updatedAt ?? order.data.createdAt ?? 0)
    if (Date.now() - finishedAt <= ORDER_RETENTION_MS) continue
    await callOffice(context.io, context.officeUrl, { action: 'delete', collection: 'orders', doc_id: order.id, if_version: order.version })
  }
}

async function queryOrders(context: DispatcherContext, statuses: string[], limit = 50): Promise<OfficeDoc[]> {
  const reply = await callOffice(context.io, context.officeUrl, {
    action: 'query',
    collection: 'orders',
    // Oldest first, so with more than `limit` of them the ones to clean up come back first.
    query: { where: [['status', 'in', statuses]], order_by: { field: 'createdAt', direction: 'asc' }, limit },
  })
  if (!reply.isOk) return []
  return parseDocs(reply.text).sort((a, b) => Number(a.data.createdAt ?? 0) - Number(b.data.createdAt ?? 0))
}

async function updateOrder(context: DispatcherContext, order: OfficeDoc, patch: Record<string, unknown>): Promise<number | undefined> {
  const reply = await callOffice(context.io, context.officeUrl, {
    action: 'update',
    collection: 'orders',
    doc_id: order.id,
    data: { ...patch, updatedAt: Date.now() },
    if_version: order.version,
  })
  if (!reply.isOk) return undefined
  order.version = reply.version ?? order.version + 1
  return order.version
}

async function callMcpSafely(context: DispatcherContext, server: string, tool: string, args: Record<string, unknown>) {
  try {
    const result = await Promise.race([
      context.io.callMcp(server, tool, args),
      context.io.sleep(15_000).then(() => ({ isError: true, content: [{ type: 'text', text: 'timed out' }] })),
    ])
    return { isOk: !result?.isError, text: mcpText(result) }
  } catch (error) {
    return { isOk: false, text: String((error as Error)?.message ?? error) }
  }
}

// The message a session receives: who asked for the work and how the result
// goes back. An order another room proposed goes back with propose_order to
// that room, which delivers it to the very session that asked (replyTo); an
// order of the user's is answered in the session itself. Either way the
// coordination session only hands orders out, and is never asked to forward.
export function composeOrderMessage(context: Pick<DispatcherContext, 'station'>, order: OfficeDoc): string {
  const say = (text: string, vars?: Record<string, unknown>) => tx(context.station.language, text, vars)
  const agent = order.data.agent ? `${say("Use this project's subagent `{agent}` to do it.", { agent: String(order.data.agent) })}\n\n` : ''
  const station = context.station.title ? say('the station "{title}"', { title: context.station.title }) : say('the station')
  const text = String(order.data.text ?? '')
  const noRelay = say('The coordination session only hands orders out: do not write to it or ask it to forward anything.')
  const asker = order.data.proposedBy ?? {}
  const askerFolder = typeof asker.folder === 'string' ? asker.folder : ''
  if (!askerFolder || askerFolder === context.station.coordination) {
    return `${say('Order sent by the user from {station}:', { station })}\n\n${agent}${text}\n\n${say('When you finish, tell the user the result in this same session.')} ${noRelay}`
  }
  const room = context.station.rooms?.[askerFolder]?.name || askerFolder
  const session = asker.title ? say('its session "{title}"', { title: String(asker.title) }) : say('one of its sessions')
  const answer = say("return the result with the station's `propose_order` tool and `folder: \"{folder}\"`: the station delivers it to that same session once the user approves it, without you naming it.", { folder: askerFolder })
  const howToAnswer = order.data.replyTo
    ? say('It is addressed to this session because it answers an order this session sent to that room. If it is the result of what you asked for, do not answer it with another order: go on with your work and tell the user what is needed. If it asks you for something more, {answer}', { answer })
    : say('When you finish, {answer}', { answer })
  const header = say('Order from the room "{room}" (folder `{folder}`), asked by {session} and sent from {station} with the user\'s approval:', { room, folder: askerFolder, session, station })
  return `${header}\n\n${agent}${text}\n\n${howToAnswer} ${noRelay}`
}

function sanitizeId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 200)
}
