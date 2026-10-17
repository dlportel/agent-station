import { callOffice, mcpText, parseDocs, type EngineIo, type OfficeDoc } from './office'
import { issueCommand, issueRepoOf, joinPath, orderClaim, orderMark, parentOf, readMainRepoTop, readOriginRemote, ruleForRemote, type IssueKind, type Station } from './station'
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

// showsIssues is false for a repo whose rule says issues: false.
type LocalRepo = { path: string; remote: string; showsIssues: boolean }

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
    const match = remote ? ruleForRemote(remote, context.station.repos) : undefined
    if (match && remote && !repos.has(match.folder)) repos.set(match.folder, { path, remote, showsIssues: match.rule.issues !== false })
  }
  return repos
}

const POLL_MS = 30_000
// The lease is renewed every LEASE_RENEW_MS and only another session may take
// it over once it is older than LEASE_MS, so renewals have slack to fail.
const LEASE_MS = 5 * 60_000
const LEASE_RENEW_MS = 2 * 60_000
// Sessions the app deleted or archived are closed within a minute; old orders
// are cleaned up every five.
const RECONCILE_EVERY_POLLS = 2
const OLD_ORDERS_EVERY_POLLS = 10
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
          if (polls % RECONCILE_EVERY_POLLS === 0) await reconcileSessions(context)
          if (polls % OLD_ORDERS_EVERY_POLLS === 0) await removeOldOrders(context)
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

// What keeps a host's handoffs from being read on this machine, worked out
// once per host for the dispatcher's life: the tool is missing or has no login.
// Neither changes on its own, so it is not asked again every fifteen minutes;
// reloading the coordination session, after installing or logging in, asks
// again. A failure to list one repo is not kept: the next scan tries it again.
// isNew says the problem was found just now, so the user is told once.
const hostProblems = new Map<string, string | null>()
// The newest open issues read from each repo.
const ISSUES_PER_REPO = 100
async function issueHostProblem(context: DispatcherContext, kind: IssueKind, host: string): Promise<{ problem: string | null; isNew: boolean }> {
  const key = `${context.officeUrl}|${kind}|${host}`
  if (hostProblems.has(key)) return { problem: hostProblems.get(key) ?? null, isNew: false }
  const tool = kind === 'github' ? 'gh' : 'glab'
  const status = await runQuietly(context, [tool, 'auth', 'status', '--hostname', host])
  const login = `${tool} auth login${host === 'github.com' || host === 'gitlab.com' ? '' : ` --hostname ${host}`}`
  const problem = status.isMissing
    ? say(context, "`{tool}` is not installed on {machine}, so this room's handoffs are not read. Install it, log in and reload the coordination session.", { tool, machine: context.machine })
    : status.exitCode !== 0
      ? say(context, '`{tool}` has no login for {host} on {machine}. Log in with `{login}`{token} and reload the coordination session.', { tool, host, machine: context.machine, login, token: kind === 'gitlab' ? say(context, ' (or set GITLAB_TOKEN)') : '' })
      : null
  hostProblems.set(key, problem)
  return { problem, isNew: !!problem }
}

// A host whose name does not say what it is may be a GitLab of its own:
// glab knows it when it has a login for it. Asked once per host.
const probedHosts = new Map<string, IssueKind | undefined>()
async function probeGitLabHost(context: DispatcherContext, host: string): Promise<IssueKind | undefined> {
  if (!probedHosts.has(host)) {
    const status = await runQuietly(context, ['glab', 'auth', 'status', '--hostname', host])
    probedHosts.set(host, status.exitCode === 0 ? 'gitlab' : undefined)
  }
  return probedHosts.get(host)
}

// A command that may not exist on this machine: a missing tool comes back as
// isMissing instead of an exception. A command that could not be started at
// all (other than one that timed out) is a missing tool; one that ran counts as missing only when the shell
// says so naming the tool, so a tool's own error (a missing config file) is
// not taken for it.
const MISSING_TOOL = /not recognized|command not found|enoent/i
async function runQuietly(context: DispatcherContext, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string; isMissing: boolean }> {
  try {
    const reply = await context.io.runCommand(argv)
    const stderr = String(reply.stderr ?? '')
    const isMissing = reply.exitCode === 127 || reply.exitCode === 9009 || (!reply.stdout && MISSING_TOOL.test(stderr) && stderr.includes(argv[0]))
    return { exitCode: reply.exitCode, stdout: reply.stdout, stderr, isMissing }
  } catch (error) {
    const message = String((error as Error)?.message ?? error)
    return { exitCode: -1, stdout: '', stderr: message, isMissing: !/timed? ?out/i.test(message) }
  }
}

// The first line of a tool's error that says something.
function firstLine(text: string): string {
  return String(text ?? '').split(/\r?\n/).map(line => line.trim()).find(line => line && line !== 'ERROR') ?? ''
}

// The open issues of every repo of the station, its handoffs for the
// department mailboxes, and the ones that closed since the last scan, for the
// station to celebrate. Every fifteen minutes, each repo with the tool of its
// host: gh for GitHub, glab for GitLab. A repo whose rule says issues: false is
// left out, and so is the coordination repo, which has no room. A room whose
// handoffs cannot be read gets a note saying why, which the page shows instead
// of an empty board, and keeps the list of its last good read. Only the rooms
// read now count for the closed ones, so a room left out or unreadable never
// shows its issues as closed. `views` holds each room's command to read one
// issue, with <n> for its number.
type Handoff = { number: number; title: string; url: string; from: string; createdAt: string; excerpt: string }
// The start of an issue's description kept for the page, on one line, so the
// catalog of a hundred issues per repo stays small.
const EXCERPT_MAX = 280
function excerptOf(text: unknown): string {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > EXCERPT_MAX ? `${line.slice(0, EXCERPT_MAX - 1)}…` : line
}
async function syncHandoffs(context: DispatcherContext) {
  const repos = await localRepos(context)
  if (!repos.size) return
  const byFolder: Record<string, Handoff[]> = {}
  const views: Record<string, string> = {}
  const problems: Record<string, string> = {}
  // The rooms read now, and those that could not be read now.
  const read = new Set<string>()
  const unreadable = new Set<string>()
  // A missing tool or login found in this scan, with the rooms it leaves
  // without handoffs, for the notice in the coordination session.
  const newProblems = new Map<string, string[]>()
  for (const [folder, local] of repos) {
    if (!local.showsIssues || folder === context.station.coordination) continue
    const repo = issueRepoOf(local.remote)
    const kind = repo && (repo.kind ?? await probeGitLabHost(context, repo.host))
    if (!repo || !kind) {
      problems[folder] = say(context, 'Its repo is on {host}, which has no handoffs: only GitHub and GitLab do. Orders reach it as usual.', { host: repo?.host ?? local.remote })
      continue
    }
    const { problem: hostProblem, isNew } = await issueHostProblem(context, kind, repo.host)
    if (hostProblem) {
      problems[folder] = hostProblem
      if (isNew || newProblems.has(hostProblem)) newProblems.set(hostProblem, [...(newProblems.get(hostProblem) ?? []), folder])
      unreadable.add(folder)
      continue
    }
    const listed = await runQuietly(context, kind === 'github'
      ? ['gh', 'issue', 'list', '--repo', repo.path, '--state', 'open', '--limit', String(ISSUES_PER_REPO), '--json', 'number,title,url,createdAt,labels,body']
      : ['glab', 'issue', 'list', '-R', `https://${repo.host}/${repo.path}`, '-O', 'json', '-P', String(ISSUES_PER_REPO)])
    try {
      if (listed.exitCode !== 0) throw new Error(firstLine(listed.stderr || listed.stdout) || `exit ${listed.exitCode}`)
      const issues: any[] = JSON.parse(listed.stdout || '[]')
      read.add(folder)
      views[folder] = issueCommand(kind, repo.host, repo.path, 'view')
      if (issues.length) byFolder[folder] = issues.map(i => {
        const number = Number(kind === 'github' ? i.number : i.iid)
        const labels: string[] = (i.labels ?? []).map((l: any) => String(typeof l === 'string' ? l : l?.name))
        return {
          number,
          title: String(i.title ?? '').slice(0, 200),
          url: String((kind === 'github' ? i.url : i.web_url) ?? ''),
          from: labels.find(n => n.startsWith('from-'))?.slice(5) ?? '',
          createdAt: String((kind === 'github' ? i.createdAt : i.created_at) ?? ''),
          excerpt: excerptOf(kind === 'github' ? i.body : i.description),
        }
      })
    } catch (error) {
      problems[folder] = say(context, 'Its handoffs could not be read ({error}). They are read again in fifteen minutes.', { error: String((error as Error)?.message ?? error).slice(0, 200) })
      unreadable.add(folder)
    }
  }
  // The user is told in the coordination session too, not only on the page,
  // since a tool or login to set up is theirs to do.
  for (const [problem, folders] of newProblems) context.io.toast(say(context, 'Agent station · {rooms}: {problem}', { rooms: folders.join(', '), problem }))
  const current = await callOffice(context.io, context.officeUrl, { action: 'get', collection: 'config', doc_id: 'handoffs' })
  // A catalog that could not be read is left alone: writing it now would drop what it holds.
  if (!current.isOk) return
  const doc = parseDocs(current.text)[0]
  const previous: Record<string, Handoff[]> = doc?.data?.byFolder ?? {}
  const previousViews: Record<string, string> = doc?.data?.views ?? {}
  const closed: Array<{ folder: string; number: number; title: string; closedAt: number }> = (doc?.data?.closedRecently ?? [])
    .filter((c: any) => Date.now() - Number(c.closedAt ?? 0) < CLOSED_HANDOFF_KEEP_MS)
  if (doc) {
    for (const folder of read) {
      for (const issue of previous[folder] ?? []) {
        const isStillOpen = (byFolder[folder] ?? []).some(i => i.number === issue.number)
        if (!isStillOpen) closed.push({ folder, number: issue.number, title: issue.title, closedAt: Date.now() })
      }
    }
  }
  for (const folder of unreadable) {
    if (previous[folder]) byFolder[folder] = previous[folder]
    if (previousViews[folder]) views[folder] = previousViews[folder]
  }
  const saved = await callOffice(context.io, context.officeUrl, {
    action: 'set',
    collection: 'config',
    doc_id: 'handoffs',
    data: { byFolder, views, problems, closedRecently: closed.slice(-20), scannedAt: Date.now(), scannedBy: context.machine },
    if_version: doc?.version,
  })
  // A catalog the station refused (too large, or not allowed) leaves the boards
  // as they were: the user is told once, and the next scan tries again. One
  // written meanwhile by another dispatcher is no problem: the next scan wins.
  if (!saved.isOk && !saved.isVersionMismatch && !hasToldCatalogFailure) {
    hasToldCatalogFailure = true
    context.io.toast(say(context, 'Agent station: the list of open issues could not be saved ({error}). The boards keep the last list; it is tried again in fifteen minutes.', { error: saved.text.slice(0, 200) }))
  }
  if (saved.isOk) hasToldCatalogFailure = false
}
let hasToldCatalogFailure = false

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
  const message = composeOrderMessage(context, order)
  const reply = await callMcpSafely(context, 'ccd_session_mgmt', 'send_message', {
    session_id: session.id,
    message: message.includes('@') ? `${message}\n\n${atSignNote(context)}` : message,
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

${orderMark(order.id, folder, order.data.attempt)}`,
    cwd: local.path,
  })
  await updateOrder(context, order, reply.isOk
    ? { status: 'needs_click', spawnedAt: Date.now(), note: say(context, 'Card ready in the coordination session of {machine}: click it to create the session.', { machine: context.machine }) }
    : { status: 'failed', note: say(context, 'The new session could not be prepared: {error}', { error: reply.text.slice(0, 300) }) })
}

// A new-session order goes to the session its card opened: the one that found
// the order's mark in its first message and recorded it as fromOrder. Never to
// a session that merely started in the room meanwhile, nor to the card of an
// earlier attempt of a resent order. A card run in a session of another room
// (such as "do it here" in the coordination session) fails the order, since
// nobody in its room is doing it.
async function completeSpawnedOrders(context: DispatcherContext, spawned: OfficeDoc[]) {
  const waiting = spawned.filter(order => order.data.claimedBy === context.machine)
  for (const order of waiting) {
    if (!context.isAlive()) return
    const reply = await callOffice(context.io, context.officeUrl, {
      action: 'query',
      collection: 'sessions',
      query: { where: [['fromOrder', '==', orderClaim(order.id, order.data.attempt)]], limit: 10 },
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

// The Claude app replaces every at sign of a message between sessions with the
// full-width one (U+FF20), so an @ never attaches a file in the receiving
// session. A card keeps it. The note names both by code point because any at
// sign written in it would be replaced too.
function atSignNote(context: Pick<DispatcherContext, 'station'>): string {
  return tx(context.station.language, 'The Claude app replaces every at sign in this message with the full-width ＠ (U+FF20). In code, SQL, email addresses or paths, write the ordinary at sign (U+0040).')
}

function sanitizeId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 200)
}
