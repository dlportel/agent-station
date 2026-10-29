import { test, expect, mock } from 'claude-code/testing'

const OFFICE = 'https://claude.ai/artifact/test-station'
const options = { stations: OFFICE }
const STATION = {
  title: 'TEST STATION',
  coordination: 'coord',
  repos: [
    { remote: 'github.com/acme/app-repo', folder: 'app' },
    { remote: 'github.com/acme/coord', folder: 'coord' },
    { remote: 'github.com/acme/legal' },
    // The same rooms on other hosts, for the handoff tests.
    { remote: 'gitlab.com/acme/app', folder: 'app' },
    { remote: 'gitlab.acme.test/team/app', folder: 'app' },
    { remote: 'gitlab.other.test/team/app', folder: 'app' },
    { remote: 'bitbucket.org/acme/legal', folder: 'legal' },
  ],
}
const REMOTES: Record<string, string> = {
  'C:/work/app': 'https://github.com/acme/app-repo.git',
  'C:/work/coord': 'https://github.com/acme/coord.git',
  'C:/work/legal': 'https://github.com/acme/legal.git',
  'C:/work/other': 'https://github.com/someone/else.git',
}

type Doc = { data: Record<string, any>; version: number }

function fakeOfficeDatabase(on: any, failWrite: (e: any) => boolean = () => false) {
  const store = new Map<string, Doc>()
  const key = (collection: string, id: string) => `${collection}/${id}`
  const line = (collection: string, id: string) => {
    const doc = store.get(key(collection, id))!
    return JSON.stringify({ id, data: doc.data, version: doc.version })
  }
  store.set(key('config', 'departments'), { data: STATION, version: 1 })
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    const k = key(e.collection, e.doc_id)
    const existing = store.get(k)
    const reply = (text: string) => ({ result: { text } }) as any
    if (e.action === 'get') {
      return reply(existing ? `1 document\n${line(e.collection, e.doc_id)}` : 'No documents matched')
    }
    if (e.action === 'query') {
      const [field, op, value] = e.query?.where?.[0] ?? []
      const matches = (v: any) => field === undefined || (op === 'in' ? value.includes(v) : v === value)
      const lines = [...store.entries()]
        .filter(([k2, doc]) => k2.startsWith(`${e.collection}/`) && matches(doc.data[field]))
        .map(([k2]) => line(e.collection, k2.slice(e.collection.length + 1)))
      return reply(`${lines.length} documents\n${lines.join('\n')}`)
    }
    if (failWrite(e)) return reply('db write failed (network error)')
    if (existing && e.if_version === undefined) return reply(`db write failed (version_mismatch): ${e.collection}/${e.doc_id} already exists and this write carried no if_version — nothing was written.`)
    if (existing && e.if_version !== existing.version) return reply('db write failed (version_mismatch)')
    if (e.action === 'delete') {
      store.delete(k)
      return reply('Database delete committed.')
    }
    const data = e.action === 'update' ? { ...(existing?.data ?? {}), ...e.data } : e.data
    const version = (existing?.version ?? 0) + 1
    store.set(k, { data, version })
    return reply(`The document is now at version ${version}.`)
  })
  return {
    seed: (collection: string, id: string, data: Record<string, any>) => store.set(key(collection, id), { data, version: 1 }),
    read: (collection: string, id: string) => store.get(key(collection, id))?.data,
  }
}

// git answers for the folders above; gh, when given, answers issue lists.
// A checkout's state, for the tests of the branch an order starts from.
type CheckoutStub = { branch?: string; commit?: string; isDirty?: boolean; branchCommits?: Record<string, string> }
// git answers from the given remotes (and checkout, if any); gh and glab, from issueTool.
function stubGit(on: any, issueTool?: (argv: string[]) => any, remotes: Record<string, string> = REMOTES, checkout?: CheckoutStub) {
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    const path = String(argv[2] ?? '').replace(/\\/g, '/')
    if (argv[0] === 'git' && checkout && argv[3] === 'branch') return { value: checkout.branch ? { exitCode: 0, stdout: checkout.branch + '\n' } : { exitCode: 0, stdout: '\n' } }
    if (argv[0] === 'git' && checkout && argv[3] === 'status') return { value: { exitCode: 0, stdout: checkout.isDirty ? ' M src/app.ts\n' : '' } }
    if (argv[0] === 'git' && checkout && argv[3] === 'rev-parse' && argv[4] === '--short') {
      const ref = argv.at(-1) ?? ''
      const commit = ref === 'HEAD' ? checkout.commit : checkout.branchCommits?.[ref.replace('refs/heads/', '').replace('refs/remotes/', '')]
      return { value: commit ? { exitCode: 0, stdout: commit + '\n' } : { exitCode: 1, stdout: '' } }
    }
    if (argv[0] === 'git' && argv[3] === 'rev-parse') return { value: remotes[path] ? { exitCode: 0, stdout: path + '\n' } : { exitCode: 128, stdout: '' } }
    if (argv[0] === 'git' && argv[3] === 'remote') return { value: remotes[path] ? { exitCode: 0, stdout: remotes[path] + '\n' } : { exitCode: 128, stdout: '' } }
    if ((argv[0] === 'gh' || argv[0] === 'glab') && issueTool) return { value: issueTool(argv) }
    return { value: { exitCode: 1, stdout: '' } }
  })
}

function stubFolders(on: any, agentsIn: Record<string, Array<{ name: string; kind: string }>> = {}) {
  on('fs.list' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/')
    if (path === 'C:/work') return { value: ['app', 'coord', 'legal', 'other', '_tmp'].map(name => ({ name, kind: 'dir' })) }
    const agents = Object.entries(agentsIn).find(([folder]) => path === `C:/work/${folder}/.claude/agents`)
    if (agents) return { value: agents[1] }
    throw new Error('no such directory')
  })
}

function stubEngine(on: any, mcpCalls: any[], appSessions: any[] = [], statuses: any[] = [], sendReply: (sessionId: string) => string = () => 'delivered (delivery: delivered; message_id: m1)', cwd = 'C:/work/coord') {
  mock.env(on, { COMPUTERNAME: 'TESTPC', USERPROFILE: 'C:/Users/me' })
  on('session.cwd' as any, () => ({ value: cwd }))
  on('session.id' as any, () => ({ value: 'engine-id' }))
  on('ui.status' as any, (_$: any, e: any) => { statuses.push(e?.text ?? e); return { value: null } })
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  on('mcp.call' as any, (_$: any, e: any) => {
    mcpCalls.push(e)
    const text = (t: string) => ({ value: { content: [{ type: 'text', text: t }] } })
    if (e.tool === 'get_session') return text(JSON.stringify({ sessionId: 'local_coord', title: 'Coordination', model: 'claude-opus-5-5' }))
    if (e.tool === 'send_message') return text(sendReply(String(e.args?.session_id)))
    if (e.tool === 'set_session_model') return text('Model switched')
    if (e.tool === 'spawn_task') return text('task_id: t1')
    if (e.tool === 'list_sessions') return text(JSON.stringify(appSessions))
    return text('')
  })
}

test('an order for an open session switches its model and delivers it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', model: 'claude-sonnet-5-5', lastEventAt: Date.now(), title: 'App' })
  db.seed('orders', 'o1', { text: 'Check your handoffs', folder: 'app', mode: 'any', model: 'claude-opus-5-5', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const order = db.read('orders', 'o1')
  expect(order?.status).toBe('delivered')
  expect(order?.deliveredTo).toBe('local_app')
  expect(mcpCalls.some(c => c.tool === 'set_session_model' && c.args?.model === 'claude-opus-5-5')).toBe(true)
  const sent = mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_app')
  expect(String(sent?.args?.message)).toContain('TEST STATION')
  await clock.advance(60_000)
})

test('the dispatcher keeps delivering while the coordination session cannot store its own report', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  const statuses: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }], statuses)
  stubGit(on)
  let isReportFailing = true
  const db = fakeOfficeDatabase(on, e => isReportFailing && e.collection === 'sessions' && e.doc_id === 'local_coord')
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'App' })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10 * 60_000)
  expect(String(statuses.at(-1))).toContain('station: no connection')

  db.seed('orders', 'late', { text: 'Check your handoffs', folder: 'app', mode: 'any', status: 'pending', createdAt: Date.now() })
  await clock.advance(60_000)
  expect(db.read('orders', 'late')?.status).toBe('delivered')

  isReportFailing = false
  await clock.advance(5 * 60_000)
  expect(statuses.at(-1)).toEqual({ text: undefined })
  expect(db.read('sessions', 'local_coord')?.folder).toBe('coord')
})

test('an order from another room says who asked and that the result goes back with propose_order', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_legal', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_legal', { folder: 'legal', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Legal' })
  db.seed('orders', 'p1', { text: 'Review clause 4', folder: 'legal', mode: 'any', status: 'pending', createdAt: Date.now(), proposedBy: { sessionId: 'local_app', title: 'Impact analysis', folder: 'app' } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const message = String(mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_legal')?.args?.message)
  expect(message).toContain('Order from the room "app" (folder `app`), asked by its session "Impact analysis"')
  expect(message).toContain('Review clause 4')
  expect(message).toContain('`propose_order`')
  expect(message).toContain('`folder: "app"`')
  expect(message).toContain('do not write to it or ask it to forward anything')
  expect(message).not.toContain('tell the user the result')
  await clock.advance(60_000)
})

test('a reply to an order this session sent is not answered with another order', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Impact analysis' })
  db.seed('orders', 'p2', { text: 'Clause 4 is fine', folder: 'app', mode: 'any', sessionId: 'local_app', replyTo: { sessionId: 'local_app', title: 'Impact analysis' }, status: 'pending', createdAt: Date.now(), proposedBy: { sessionId: 'local_legal', title: 'Legal', folder: 'legal' } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const message = String(mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_app')?.args?.message)
  expect(message).toContain('it answers an order this session sent')
  expect(message).toContain('do not answer it with another order')
  expect(message).toContain('`folder: "legal"`')
  await clock.advance(60_000)
})

test('an order of the user\'s is answered in the session itself, never through the coordination', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_legal', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_legal', { folder: 'legal', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Legal' })
  db.seed('orders', 'u1', { text: 'Draft the legal notice', folder: 'legal', mode: 'any', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const message = String(mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_legal')?.args?.message)
  expect(message).toContain('Order sent by the user from the station "TEST STATION"')
  expect(message).toContain('tell the user the result in this same session')
  expect(message).toContain('do not write to it or ask it to forward anything')
  expect(message).not.toContain('propose_order')
  expect(message).not.toContain('U+FF20')
  await clock.advance(60_000)
})

test('a delivered order with an at sign warns that the app replaces it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_legal', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_legal', { folder: 'legal', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Legal' })
  db.seed('orders', 'u2', { text: 'Write to legal@example.com', folder: 'legal', mode: 'any', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const message = String(mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_legal')?.args?.message)
  expect(message).toContain('Write to legal@example.com')
  expect(message).toContain('full-width ＠ (U+FF20)')
  await clock.advance(60_000)
})

test('an idle session quiet for hours still takes an order, unless the app closed it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_quiet', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const yesterday = Date.now() - 16 * 60 * 60_000
  db.seed('sessions', 'local_quiet', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: yesterday, title: 'Quiet' })
  db.seed('sessions', 'local_closed', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Closed in the app' })
  db.seed('orders', 'o5', { text: 'Answer this email', folder: 'app', mode: 'any', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'o5')?.status).toBe('delivered')
  expect(db.read('orders', 'o5')?.deliveredTo).toBe('local_quiet')
  await clock.advance(60_000)
})

test('a card starts by telling the new session which branch to start from', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on, undefined, REMOTES, { branch: 'feature/translation-hub', commit: 'a1b2c3d', isDirty: true })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'b1', { text: 'Fix the reports', folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const prompt = String(mcpCalls.find(c => c.tool === 'spawn_task')?.args?.prompt)
  expect(prompt.startsWith('Before you touch anything, start from the branch `feature/translation-hub` (commit `a1b2c3d`).')).toBe(true)
  expect(prompt).toContain('git switch -c <your-branch> feature/translation-hub')
  expect(prompt).toContain('not from `origin/feature/translation-hub`')
  expect(prompt).toContain('had changes that were not committed')
  expect(prompt).toContain('Fix the reports')
  const order = db.read('orders', 'b1')
  expect(order?.base).toBe('feature/translation-hub')
  expect(order?.baseCommit).toBe('a1b2c3d')
  expect(order?.baseIsDefault).toBe(true)
  await clock.advance(60_000)
})

test('an order that names its branch starts from it, with that branch\'s own commit', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on, undefined, REMOTES, { branch: 'master', commit: 'd654f15', isDirty: true, branchCommits: { 'release/2': 'e5f6a7b' } })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'b2', { text: 'Patch the release', folder: 'app', mode: 'new', status: 'pending', base: 'release/2', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const prompt = String(mcpCalls.find(c => c.tool === 'spawn_task')?.args?.prompt)
  expect(prompt).toContain('start from the branch `release/2` (commit `e5f6a7b`)')
  expect(prompt).not.toContain('had changes that were not committed')
  expect(db.read('orders', 'b2')?.baseIsDefault).toBe(false)
  await clock.advance(60_000)
})

test('a card whose branch git cannot tell is sent as before', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'b3', { text: 'Handle issue 3', folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const prompt = String(mcpCalls.find(c => c.tool === 'spawn_task')?.args?.prompt)
  expect(prompt).not.toContain('Before you touch anything')
  expect(db.read('orders', 'b3')?.status).toBe('needs_click')
  expect(db.read('orders', 'b3')?.base).toBeUndefined()
  await clock.advance(60_000)
})

test('an open session on another branch is told so before the order', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }])
  stubGit(on, undefined, REMOTES, { branch: 'feature/translation-hub', commit: 'a1b2c3d' })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'App', branch: 'master' })
  db.seed('orders', 'b4', { text: 'Fix the reports', folder: 'app', mode: 'any', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const message = String(mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_app')?.args?.message)
  expect(message.startsWith('This session is on the branch `master`, and this order was meant to start from `feature/translation-hub`.')).toBe(true)
  expect(message).toContain('Fix the reports')
  await clock.advance(60_000)
})

test('an open session in a worktree is told the order\'s branch and commit, not that it is on another branch', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }])
  stubGit(on, undefined, REMOTES, { branch: 'feature/translation-hub', commit: 'a1b2c3d' })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'App', branch: 'claude/hungry-dubinsky-0c57bc', inWorktree: true })
  db.seed('orders', 'b6', { text: 'Fix the reports', folder: 'app', mode: 'any', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const message = String(mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_app')?.args?.message)
  expect(message).not.toContain('This session is on the branch')
  expect(message.startsWith('This order starts from the branch `feature/translation-hub` (commit `a1b2c3d`). This session runs in a worktree, on a branch of its own')).toBe(true)
  expect(message).toContain('git switch -c <your-branch> feature/translation-hub')
  expect(message).toContain('Fix the reports')
  await clock.advance(60_000)
})

test('an open session on the order\'s branch gets the order as before', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }])
  stubGit(on, undefined, REMOTES, { branch: 'feature/translation-hub', commit: 'a1b2c3d' })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'App', branch: 'feature/translation-hub' })
  db.seed('orders', 'b5', { text: 'Fix the reports', folder: 'app', mode: 'any', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const message = String(mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_app')?.args?.message)
  expect(message).not.toContain('This session is on the branch')
  await clock.advance(60_000)
})

test('a new-session order prepares a card in the room\'s repo and waits for the click', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'o2', { text: 'Handle issue 2', folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'o2')?.status).toBe('needs_click')
  const spawn = mcpCalls.find(c => c.tool === 'spawn_task')
  expect(spawn?.args?.cwd).toBe('C:\\work\\app')
  expect(String(spawn?.args?.prompt)).toContain('[agent-station order o2 for app]')
  await clock.advance(60_000)
})

// A new-session order waiting for its card's click goes to the session the card
// opened, which recorded the order's mark as fromOrder, and to no other.
function seedSpawnedOrder(db: any) {
  const spawnedAt = Date.now() - 60_000
  db.seed('orders', 'n1', { text: 'Remove the TLS keys from the repo', folder: 'app', mode: 'new', status: 'needs_click', claimedBy: 'TESTPC', spawnedAt, createdAt: spawnedAt })
  return spawnedAt
}

test('a spawned order goes to the session its card opened', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_other', isArchived: false }, { sessionId: 'local_card', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const spawnedAt = seedSpawnedOrder(db)
  db.seed('sessions', 'local_other', { folder: 'app', machine: 'TESTPC', state: 'idle', startedAt: spawnedAt + 1_000, title: 'Unrelated work' })
  db.seed('sessions', 'local_card', { folder: 'app', machine: 'TESTPC', state: 'working', startedAt: spawnedAt + 5_000, title: 'TLS keys', fromOrder: 'n1' })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'n1')?.status).toBe('delivered')
  expect(db.read('orders', 'n1')?.deliveredTo).toBe('local_card')
  await clock.advance(60_000)
})

test('a resent order takes only the card of its current attempt', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_old_card', isArchived: false }, { sessionId: 'local_new_card', isArchived: false }])
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'r1', { text: 'Rotate the keys', folder: 'app', mode: 'new', status: 'pending', attempt: 2, createdAt: Date.now() })
  db.seed('sessions', 'local_old_card', { folder: 'app', machine: 'TESTPC', state: 'working', title: 'First attempt', fromOrder: 'r1' })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(String(mcpCalls.find(c => c.tool === 'spawn_task')?.args?.prompt)).toContain('[agent-station order r1#2 for app]')
  expect(db.read('orders', 'r1')?.status).toBe('needs_click')
  await clock.advance(60_000)
  expect(db.read('orders', 'r1')?.status).toBe('needs_click')

  db.seed('sessions', 'local_new_card', { folder: 'app', machine: 'TESTPC', state: 'working', title: 'Second attempt', fromOrder: 'r1#2' })
  await clock.advance(60_000)
  expect(db.read('orders', 'r1')?.status).toBe('delivered')
  expect(db.read('orders', 'r1')?.deliveredTo).toBe('local_new_card')
  await clock.advance(60_000)
})

test('a session of the same room that opens after the card does not take the order', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_other', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const spawnedAt = seedSpawnedOrder(db)
  db.seed('sessions', 'local_other', { folder: 'app', machine: 'TESTPC', state: 'working', startedAt: spawnedAt + 1_000, title: 'Unrelated work' })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'n1')?.status).toBe('needs_click')
  await clock.advance(60_000)
})

test('two sessions that claim the same order leave it failed, not delivered to either', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_card', isArchived: false }, { sessionId: 'local_copy', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const spawnedAt = seedSpawnedOrder(db)
  db.seed('sessions', 'local_card', { folder: 'app', machine: 'TESTPC', state: 'working', startedAt: spawnedAt + 5_000, title: 'TLS keys', fromOrder: 'n1' })
  db.seed('sessions', 'local_copy', { folder: 'app', machine: 'TESTPC', state: 'working', startedAt: spawnedAt + 9_000, title: 'Pasted mark', fromOrder: 'n1' })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'n1')?.status).toBe('failed')
  expect(db.read('orders', 'n1')?.deliveredTo).toBeUndefined()
  await clock.advance(60_000)
})

test('a card run in a session of another room fails the order instead of delivering it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_coordination', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const spawnedAt = seedSpawnedOrder(db)
  db.seed('sessions', 'local_coordination', { folder: 'coord', machine: 'TESTPC', state: 'working', startedAt: spawnedAt - 600_000, title: 'Coordination', fromOrder: 'n1' })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'n1')?.status).toBe('failed')
  expect(String(db.read('orders', 'n1')?.note)).toContain('coord')
  expect(db.read('orders', 'n1')?.deliveredTo).toBeUndefined()
  await clock.advance(60_000)
})

test('a new session is never prepared outside the station\'s repos', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'o6', { text: 'Leave the station', folder: 'other', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'o6')?.status).toBe('failed')
  expect(mcpCalls.some(c => c.tool === 'spawn_task')).toBe(false)
  await clock.advance(60_000)
})

test('an existing-only order with no open session is marked failed', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'o3', { text: 'Hello', folder: 'legal', mode: 'existing', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'o3')?.status).toBe('failed')
  await clock.advance(60_000)
})

test('a reply goes to the session that asked for the work, even while it works', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_asker', isArchived: false }, { sessionId: 'local_free', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_asker', { folder: 'app', machine: 'TESTPC', state: 'working', lastEventAt: Date.now() - 60_000, title: 'Asker' })
  db.seed('sessions', 'local_free', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Free' })
  db.seed('orders', 'r1', { text: 'Done what you asked', folder: 'app', mode: 'any', sessionId: 'local_asker', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'r1')?.status).toBe('delivered')
  expect(db.read('orders', 'r1')?.deliveredTo).toBe('local_asker')
  await clock.advance(60_000)
})

test('a reply whose asker is gone goes to another session of the department, then to a new one', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  // local_asker was deleted from the app but the station still shows it idle.
  stubEngine(on, mcpCalls, [{ sessionId: 'local_free', isArchived: false }])
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_asker', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Asker' })
  db.seed('sessions', 'local_free', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now() - 60_000, title: 'Free' })
  db.seed('orders', 'r2', { text: 'Done', folder: 'app', mode: 'any', sessionId: 'local_asker', status: 'pending', createdAt: Date.now() })
  db.seed('orders', 'r3', { text: 'Done too', folder: 'legal', mode: 'any', sessionId: 'local_gone', status: 'pending', createdAt: Date.now() + 1 })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'r2')?.deliveredTo).toBe('local_free')
  expect(db.read('orders', 'r2')?.note).toContain('another one of the room takes it')
  expect(db.read('orders', 'r3')?.status).toBe('needs_click')
  await clock.advance(60_000)
})

test('a session that refuses the message hands the order to the next one', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_asker', isArchived: false }, { sessionId: 'local_free', isArchived: false }], [],
    id => id === 'local_asker' ? 'Session not found' : 'delivered (delivery: delivered; message_id: m2)')
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_asker', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Asker' })
  db.seed('sessions', 'local_free', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now() - 60_000, title: 'Free' })
  db.seed('orders', 'r4', { text: 'Done', folder: 'app', mode: 'any', sessionId: 'local_asker', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'r4')?.status).toBe('delivered')
  expect(db.read('orders', 'r4')?.deliveredTo).toBe('local_free')
  await clock.advance(60_000)
})

test('an order for one chosen session never goes to another', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [{ sessionId: 'local_free', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_chosen', { folder: 'app', machine: 'TESTPC', state: 'ended', lastEventAt: Date.now(), title: 'Chosen' })
  db.seed('sessions', 'local_free', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Free' })
  db.seed('orders', 'r5', { text: 'Only for you', folder: 'app', mode: 'existing', sessionId: 'local_chosen', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'r5')?.status).toBe('failed')
  expect(db.read('orders', 'r5')?.deliveredTo).toBeUndefined()
  await clock.advance(60_000)
})

test('sessions deleted from the app are closed and old closed ones removed', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [{ sessionId: 'local_alive', isArchived: false }, { sessionId: 'local_archived', isArchived: true }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const now = Date.now()
  db.seed('sessions', 'local_gone', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: now })
  db.seed('sessions', 'local_alive', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: now })
  db.seed('sessions', 'local_archived', { folder: 'legal', machine: 'TESTPC', state: 'working', lastEventAt: now })
  db.seed('sessions', 'local_old', { folder: 'legal', machine: 'TESTPC', state: 'ended', endedAt: now - 8 * 24 * 60 * 60_000 })
  db.seed('sessions', 'local_other_pc', { folder: 'legal', machine: 'OTHERPC', state: 'idle', lastEventAt: now })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('sessions', 'local_gone')?.state).toBe('ended')
  expect(db.read('sessions', 'local_gone')?.endReason).toBe('deleted')
  expect(db.read('sessions', 'local_archived')?.endReason).toBe('archived')
  expect(db.read('sessions', 'local_alive')?.state).toBe('idle')
  expect(db.read('sessions', 'local_old')).toBe(undefined)
  expect(db.read('sessions', 'local_other_pc')?.state).toBe('idle')
  await clock.advance(60_000)
})

test('a session deleted from the app while the dispatcher runs is closed within about a minute', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const appSessions = [{ sessionId: 'local_coord', isArchived: false }, { sessionId: 'local_app', isArchived: false }]
  stubEngine(on, [], appSessions)
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  expect(db.read('sessions', 'local_app')?.state).toBe('idle')

  appSessions.splice(1, 1)
  await clock.advance(65_000)

  expect(db.read('sessions', 'local_app')?.state).toBe('ended')
  expect(db.read('sessions', 'local_app')?.endReason).toBe('deleted')
  await clock.advance(60_000)
})

test('finished orders older than 30 days are removed', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const now = Date.now()
  db.seed('orders', 'old', { text: 'x', status: 'delivered', createdAt: now - 40 * 24 * 60 * 60_000, updatedAt: now - 40 * 24 * 60 * 60_000 })
  db.seed('orders', 'recent', { text: 'y', status: 'failed', createdAt: now - 2 * 24 * 60 * 60_000, updatedAt: now - 2 * 24 * 60 * 60_000 })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'old')).toBe(undefined)
  expect(db.read('orders', 'recent')?.status).toBe('failed')
  await clock.advance(60_000)
})

test('the dispatcher reads the agents of each of the station\'s repos into the catalog', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on)
  stubFolders(on, {
    app: [{ name: 'feature-dev.md', kind: 'file' }, { name: 'notes.txt', kind: 'file' }],
    other: [{ name: 'intruder.md', kind: 'file' }],
  })
  on('fs.read' as any, () => ({ value: ['---', 'name: feature-dev', 'description: Develops features', 'model: claude-opus-5', '---', 'Body'].join(String.fromCharCode(10)) }))
  const db = fakeOfficeDatabase(on)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const catalog = db.read('config', 'agents')
  expect(catalog?.byFolder?.app?.[0]?.name).toBe('feature-dev')
  expect(catalog?.byFolder?.app?.[0]?.model).toBe('claude-opus-5')
  expect(catalog?.byFolder?.legal).toBe(undefined)
  expect(catalog?.byFolder?.other).toBe(undefined)
  await clock.advance(60_000)
})

test('a proposed order is never delivered until the user approves it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now() })
  db.seed('orders', 'p1', { text: 'Review the issue', folder: 'app', mode: 'any', status: 'proposed', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(65_000)

  expect(db.read('orders', 'p1')?.status).toBe('proposed')
  expect(mcpCalls.some(c => c.tool === 'send_message')).toBe(false)
})

test('the dispatcher lists open handoff issues and notices the ones that closed', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on, argv => argv.includes('acme/app-repo')
    ? { exitCode: 0, stdout: JSON.stringify([{ number: 2, title: 'Rename folder', url: 'u2', createdAt: 'x', labels: [{ name: 'handoff' }, { name: 'from-coord' }] }]) }
    : { exitCode: 0, stdout: '[]' })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'handoffs', { byFolder: { app: [{ number: 1, title: 'BigQuery', url: 'u1', from: 'legal', createdAt: 'x' }, { number: 2, title: 'Rename folder', url: 'u2', from: 'coord', createdAt: 'x' }] }, closedRecently: [] })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const handoffs = db.read('config', 'handoffs')
  expect(handoffs?.byFolder?.app?.length).toBe(1)
  expect(handoffs?.byFolder?.app?.[0]?.from).toBe('coord')
  expect(handoffs?.closedRecently?.[0]?.number).toBe(1)
  await clock.advance(60_000)
})

test('handoffs of a GitLab repo are read with glab, and a repo on another host gets a note', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  const remotes = { 'C:/work/coord': 'https://github.com/acme/coord.git', 'C:/work/app': 'git@gitlab.com:acme/app.git', 'C:/work/legal': 'https://bitbucket.org/acme/legal.git' }
  stubGit(on, argv => {
    if (argv[0] === 'glab' && argv.includes('--hostname')) return argv.includes('gitlab.com') ? { exitCode: 0, stdout: 'Logged in' } : { exitCode: 1, stdout: '', stderr: 'not logged in' }
    if (argv[0] === 'glab' && argv.includes('https://gitlab.com/acme/app')) return { exitCode: 0, stdout: JSON.stringify([{ iid: 7, title: 'Add the delta endpoint', web_url: 'https://gitlab.com/acme/app/-/work_items/7', created_at: '2026-10-16T10:00:00Z', labels: ['handoff', 'from-legal', 'doing'], assignees: [{ username: 'ana' }], description: 'The app needs\n\na delta endpoint. ' + 'x'.repeat(400) }]) }
    return { exitCode: 0, stdout: '[]' }
  }, remotes)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'handoffs', { byFolder: {}, closedRecently: [] })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const handoffs = db.read('config', 'handoffs')
  expect(handoffs?.byFolder?.app?.[0]).toEqual({ number: 7, title: 'Add the delta endpoint', url: 'https://gitlab.com/acme/app/-/work_items/7', from: 'legal', labels: [], progressLabel: 'doing', assignees: ['ana'], createdAt: '2026-10-16T10:00:00Z', excerpt: `The app needs a delta endpoint. ${'x'.repeat(247)}…` })
  expect(handoffs?.views?.app).toBe('glab issue view <n> -R https://gitlab.com/acme/app')
  // The command that marks an issue in progress, for the orders that hand it to an agent.
  expect(handoffs?.marks?.app).toBe('glab issue update <n> -R https://gitlab.com/acme/app --label "in progress"')
  expect(String(handoffs?.problems?.legal)).toContain('bitbucket.org, which has no handoffs')
  expect(handoffs?.problems?.app).toBeUndefined()
  await clock.advance(60_000)
})

test('every open issue is read, except those of a repo set to issues false and of the coordination repo', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  const listed: string[] = []
  stubGit(on, argv => {
    if (argv.includes('list')) listed.push(argv[argv.indexOf('--repo') + 1])
    return argv.includes('acme/app-repo')
      ? { exitCode: 0, stdout: JSON.stringify([{ number: 3, title: 'Crash on login', url: 'u3', createdAt: 'x', labels: [{ name: 'bug' }] }]) }
      : { exitCode: 0, stdout: '[]' }
  })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', { ...STATION, repos: STATION.repos.map(r => r.remote === 'github.com/acme/legal' ? { ...r, issues: false } : r) })
  db.seed('config', 'handoffs', { byFolder: {}, closedRecently: [] })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(listed).toEqual(['acme/app-repo'])
  expect(db.read('config', 'handoffs')?.byFolder?.app?.[0]?.title).toBe('Crash on login')
  await clock.advance(60_000)
})

test('a room that cannot be read keeps its list, and the others still drop their closed issues', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on, argv => argv.includes('acme/legal') && argv.includes('list') ? { exitCode: 1, stdout: '', stderr: 'HTTP 502' } : { exitCode: 0, stdout: '[]' })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'handoffs', { byFolder: { app: [{ number: 1, title: 'Done', url: 'u1', from: '', createdAt: 'x' }], legal: [{ number: 5, title: 'Clause', url: 'u5', from: '', createdAt: 'x' }] }, closedRecently: [] })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const handoffs = db.read('config', 'handoffs')
  expect(handoffs?.byFolder?.app).toBeUndefined()
  expect(handoffs?.byFolder?.legal?.[0]?.number).toBe(5)
  expect(handoffs?.closedRecently?.map((c: any) => `${c.folder}#${c.number}`)).toEqual(['app#1'])
  expect(String(handoffs?.problems?.legal)).toContain('HTTP 502')
  await clock.advance(60_000)
})

test('a repo whose issues are turned off drops them without counting them as closed', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on, () => ({ exitCode: 0, stdout: '[]' }))
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', { ...STATION, repos: STATION.repos.map(r => r.remote === 'github.com/acme/legal' ? { ...r, issues: false } : r) })
  db.seed('config', 'handoffs', { byFolder: { legal: [{ number: 5, title: 'Clause', url: 'u5', from: '', createdAt: 'x' }], coord: [{ number: 9, title: 'Map', url: 'u9', from: '', createdAt: 'x' }] }, closedRecently: [] })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const handoffs = db.read('config', 'handoffs')
  expect(handoffs?.byFolder?.legal).toBeUndefined()
  expect(handoffs?.closedRecently).toEqual([])
  await clock.advance(60_000)
})

test('a catalog the station refuses is told once, and a version clash not at all', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on, () => ({ exitCode: 0, stdout: '[]' }))
  stubFolders(on)
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })
  const db = fakeOfficeDatabase(on, e => e.collection === 'config' && e.doc_id === 'handoffs' && e.action === 'set')
  db.seed('config', 'handoffs', { byFolder: {}, closedRecently: [] })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  await clock.advance(16 * 60_000)

  expect(toasts.filter(t => t.includes('could not be saved')).length).toBe(1)
  await clock.advance(60_000)
})

test('a missing glab is noted once and not asked again at every scan', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  const calls: string[][] = []
  stubGit(on, argv => {
    calls.push(argv)
    return argv[0] === 'glab' ? { exitCode: 127, stdout: '', stderr: 'glab: command not found' } : { exitCode: 0, stdout: '[]' }
  }, { 'C:/work/coord': 'https://github.com/acme/coord.git', 'C:/work/app': 'https://gitlab.acme.test/team/app.git' })
  stubFolders(on)
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'handoffs', { byFolder: {}, closedRecently: [] })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  await clock.advance(16 * 60_000)

  expect(String(db.read('config', 'handoffs')?.problems?.app)).toContain('`glab` is not installed on TESTPC')
  expect(calls.filter(argv => argv[0] === 'glab').length).toBe(1)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Agent station · app: `glab` is not installed on TESTPC')
  await clock.advance(60_000)
})

test('glab without a login is told apart from a repo it cannot see', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on, argv => argv.includes('auth')
    ? { exitCode: 1, stdout: '', stderr: 'not logged in to gitlab.other.test' }
    : { exitCode: 1, stdout: '', stderr: '404 Not Found' },
  { 'C:/work/coord': 'https://github.com/acme/coord.git', 'C:/work/app': 'https://gitlab.other.test/team/app.git' })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'handoffs', { byFolder: {}, closedRecently: [] })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const problem = String(db.read('config', 'handoffs')?.problems?.app)
  expect(problem).toContain('`glab` has no login for gitlab.other.test on TESTPC')
  expect(problem).toContain('glab auth login --hostname gitlab.other.test')
  expect(problem).toContain('reload the coordination session')
  await clock.advance(60_000)
})

test('a busy-looking session whose process stopped is set back to idle',{ options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [{ sessionId: 'local_stopped', isArchived: false, isRunning: false }, { sessionId: 'local_busy', isArchived: false, isRunning: true }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const old = Date.now() - 60 * 60_000
  db.seed('sessions', 'local_stopped', { folder: 'app', machine: 'TESTPC', state: 'working', tool: 'Edit', lastEventAt: old })
  db.seed('sessions', 'local_busy', { folder: 'app', machine: 'TESTPC', state: 'working', tool: 'Edit', lastEventAt: old })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('sessions', 'local_stopped')?.state).toBe('idle')
  expect(db.read('sessions', 'local_busy')?.state).toBe('working')
  await clock.advance(60_000)
})


// The expected texts are the Spanish translation under test (hooks/locale-es.ts).
test('a station set to Spanish delivers its orders in Spanish', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_legal', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', { ...STATION, language: 'es' })
  db.seed('sessions', 'local_legal', { folder: 'legal', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Legal' })
  db.seed('orders', 'e1', { text: 'Review clause 4', folder: 'legal', mode: 'any', status: 'pending', createdAt: Date.now(), proposedBy: { sessionId: 'local_app', title: 'Impact analysis', folder: 'app' } })
  db.seed('orders', 'e2', { text: 'Draft the legal notice', folder: 'legal', mode: 'any', status: 'pending', createdAt: Date.now() + 1 })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const messages = mcpCalls.filter(c => c.tool === 'send_message').map(c => String(c.args?.message))
  expect(messages[0]).toContain('Orden de la sala «app» (carpeta `app`), pedida por su sesión «Impact analysis»')
  expect(messages[0]).toContain('`folder: "app"`')
  expect(messages[0]).not.toContain('Order from the room')
  expect(messages[1]).toContain('Orden enviada por el usuario desde la estación «TEST STATION»')
  expect(messages[1]).toContain('en esta misma sesión')
  await clock.advance(60_000)
})


// The app often opens a session in a worktree inside the repo
// (.claude/worktrees/<name>). A coordination session there still finds the
// station's repos beside the main checkout, not beside the worktree.
test('a coordination session in a worktree finds the station\'s repos beside the main checkout', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  const worktree = 'C:/work/coord/.claude/worktrees/w1'
  stubEngine(on, mcpCalls, [], [], undefined, worktree)
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    const path = String(argv[2] ?? '').replace(/\\/g, '/')
    if (argv[0] === 'git' && argv[3] === 'rev-parse' && argv.includes('--git-common-dir')) {
      return { value: path === worktree ? { exitCode: 0, stdout: 'C:/work/coord/.git\n' } : { exitCode: 128, stdout: '' } }
    }
    if (argv[0] === 'git' && argv[3] === 'rev-parse') return { value: path === worktree ? { exitCode: 0, stdout: worktree + '\n' } : { exitCode: 128, stdout: '' } }
    const remote = path === worktree ? REMOTES['C:/work/coord'] : REMOTES[path]
    if (argv[0] === 'git' && argv[3] === 'remote') return { value: remote ? { exitCode: 0, stdout: remote + '\n' } : { exitCode: 128, stdout: '' } }
    return { value: { exitCode: 1, stdout: '' } }
  })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'w1', { text: 'Start', folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(String(mcpCalls.find(c => c.tool === 'spawn_task')?.args?.cwd).replace(/\\/g, '/')).toBe('C:/work/app')
  expect(db.read('orders', 'w1')?.status).toBe('needs_click')
  await clock.advance(60_000)
})


// git prints a repo's top as the machine writes paths. On macOS or Linux that
// is /work/coord, and the station's repos are found and opened there. (The
// test harness hands fs paths to its hooks in Windows form on Windows, so the
// path is checked where it leaves the plugin unchanged: the new session's cwd.)
test('with macOS or Linux paths the dispatcher opens a new session in the repo\'s own folder', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  const remotes: Record<string, string> = { '/work/coord': 'https://github.com/acme/coord.git', '/work/app': 'https://github.com/acme/app-repo.git' }
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    const path = String(argv[2] ?? '').replace(/\\/g, '/')
    if (argv[0] === 'git' && argv[3] === 'rev-parse') return { value: { exitCode: 0, stdout: '/work/coord\n' } }
    if (argv[0] === 'git' && argv[3] === 'remote') {
      const remote = remotes[path] ?? remotes[path.replace(/^[A-Za-z]:/, '')]
      return { value: remote ? { exitCode: 0, stdout: remote + '\n' } : { exitCode: 128, stdout: '' } }
    }
    return { value: { exitCode: 1, stdout: '' } }
  })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'x1', { text: 'Start', folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(mcpCalls.find(c => c.tool === 'spawn_task')?.args?.cwd).toBe('/work/app')
  expect(db.read('orders', 'x1')?.status).toBe('needs_click')
  await clock.advance(60_000)
})

// The keeper of the dispatcher: a background command that never ends, started
// and stopped by the session that dispatches, as config/departments keepAwake says.
// isBeating: whether the keeper's beat file holds a fresh time once a keeper started.
function stubKeeperTools(on: any, calls: any[], isBeating = () => true) {
  let next = 0
  on('fs.write' as any, () => ({ value: null }))
  // An empty beat reads as no beat at all; a fresh one is a time ahead of any the test reaches.
  on('fs.read' as any, (_$: any, e: any) => ({ value: String(e.path ?? e).endsWith('.beat') && next && isBeating() ? '99999999999' : '' }))
  on('tool.call', { tool: 'Bash' }, (_$: any, e: any) => {
    calls.push(e)
    return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `bg${++next}` } } as any
  })
  on('tool.call', { tool: 'TaskStop' }, (_$: any, e: any) => {
    calls.push(e)
    return { result: { message: 'stopped', task_id: e.task_id, task_type: 'local_bash' } } as any
  })
}

test('the dispatcher keeps its session awake while keepAwake is on, and stops when it is switched off', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  const toolCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubKeeperTools(on, toolCalls)
  const stateWrites: any[] = []
  on('state.set' as any, (_$: any, e: any, next: any) => { if (e.key === 'keeperTaskIds') stateWrites.push(e.value); return next(e) })
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', { ...STATION, keepAwake: true })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  const starts = () => toolCalls.filter(c => c.tool === 'Bash')
  expect(starts().length).toBe(1)
  expect(starts()[0].run_in_background).toBe(true)
  // The id is kept in the session's state, so a reload of the plugin finds it.
  expect(stateWrites.at(-1)).toEqual(['bg1'])
  expect(String(starts()[0].command)).toContain('agent-station-keep-awake')

  // One keeper only, however many polls go by.
  await clock.advance(5 * 60_000)
  expect(starts().length).toBe(1)

  db.seed('config', 'departments', { ...STATION, keepAwake: false })
  await clock.advance(2 * 60_000)
  expect(toolCalls.filter(c => c.tool === 'TaskStop').map(c => c.task_id)).toEqual(['bg1'])
  await clock.advance(60_000)
})

test('without keepAwake the dispatcher starts no background command', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  const toolCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubKeeperTools(on, toolCalls)
  fakeOfficeDatabase(on)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5 * 60_000)
  expect(toolCalls.length).toBe(0)
})

test('a session of another room never starts a keeper, even with keepAwake on', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  const toolCalls: any[] = []
  stubEngine(on, mcpCalls, [], [], undefined, 'C:/work/app')
  stubGit(on)
  stubKeeperTools(on, toolCalls)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', { ...STATION, keepAwake: true })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5 * 60_000)
  expect(toolCalls.length).toBe(0)
})

test("the agent's own keeper-like command is not approved by the plugin", { options }, async ($, on) => {
  mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  fakeOfficeDatabase(on)
  on('tool.check', { tool: 'Bash' }, () => ({ decision: 'ask', reason: 'beneath' }) as any)

  const verdict: any = await $.tool.check({ tool: 'Bash', input: { command: 'while :; do sleep 3600; done # agent-station-keep-awake' } } as any)
  expect(verdict.decision).toBe('ask')
})

test('an order whose branch exists only on origin says to use the remote one, and the order keeps it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }])
  stubGit(on, undefined, REMOTES, { branch: 'main', commit: 'd654f15', branchCommits: { 'origin/feature/x': 'c0ffee1' } })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'App', branch: 'claude/quiet-0c57bc', inWorktree: true })
  db.seed('orders', 'b9', { text: 'Finish feature x', folder: 'app', mode: 'any', status: 'pending', base: 'feature/x', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const message = String(mcpCalls.find(c => c.tool === 'send_message' && c.args?.session_id === 'local_app')?.args?.message)
  expect(message).toContain('starts from the branch `feature/x` (commit `c0ffee1`)')
  expect(message).toContain('There is no local branch `feature/x` in this repo: use `origin/feature/x`')
  const order = db.read('orders', 'b9')
  expect(order?.status).toBe('delivered')
  expect(order?.base).toBe('feature/x')
  expect(order?.baseCommit).toBe('c0ffee1')
  expect(order?.baseIsDefault).toBe(false)
  await clock.advance(60_000)
})

test('the page asking to read the handoffs now has the dispatcher read them within a minute, once', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  let reads = 0
  stubGit(on, () => { reads++; return { exitCode: 0, stdout: '[]' } })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  const afterStart = reads
  expect(afterStart).toBeGreaterThan(0)

  // Nothing asked: no read before the fifteen minutes.
  await clock.advance(3 * 60_000)
  expect(reads).toBe(afterStart)

  db.seed('config', 'refresh', { handoffsAskedAt: 1234 })
  await clock.advance(15_000)
  const afterAsk = reads
  expect(afterAsk).toBeGreaterThan(afterStart)

  // The same request is answered once.
  await clock.advance(3 * 60_000)
  expect(reads).toBe(afterAsk)
})

test('a handoff keeps who it is assigned to and its in-progress label', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on, argv => argv.includes('acme/app-repo')
    ? { exitCode: 0, stdout: JSON.stringify([
      { number: 4, title: 'Doing it', url: 'u4', createdAt: 'x', labels: [{ name: 'bug' }, { name: 'In Progress' }], assignees: [{ login: 'amn' }] },
      { number: 5, title: 'Waiting', url: 'u5', createdAt: 'x', labels: [{ name: 'progress-report' }], assignees: [] },
    ]) }
    : { exitCode: 0, stdout: '[]' })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const [doing, waiting] = db.read('config', 'handoffs')?.byFolder?.app ?? []
  expect(doing?.progressLabel).toBe('In Progress')
  expect(doing?.assignees).toEqual(['amn'])
  expect(db.read('config', 'handoffs')?.marks?.app).toBe('gh label create "in progress" --force --repo acme/app-repo && gh issue edit <n> --repo acme/app-repo --add-label "in progress"')
  expect(doing?.labels).toEqual(['bug'])
  expect(waiting?.progressLabel).toBe('')
  expect(waiting?.assignees).toEqual([])
  expect(waiting?.labels).toEqual(['progress-report'])
  await clock.advance(60_000)
})

test('a keeper that stopped beating is replaced, and one still beating is never doubled', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const toolCalls: any[] = []
  let isBeating = true
  stubEngine(on, [])
  stubGit(on)
  stubKeeperTools(on, toolCalls, () => isBeating)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', { ...STATION, keepAwake: true })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  const starts = () => toolCalls.filter(c => c.tool === 'Bash')
  expect(starts().length).toBe(1)
  // The whole loop is in the command: nothing it runs can be rewritten after approval.
  expect(String(starts()[0].command)).toContain('while :; do date +%s > "C:/Users/me/.claude/agent-station-logs/keeper-local_coord.beat"; sleep 60; done')
  expect(String(starts()[0].command)).not.toContain('.sh')

  await clock.advance(10 * 60_000)
  expect(starts().length).toBe(1)

  // No beat any more: the old one is stopped first (it may be frozen, not
  // gone), then another starts, and beats.
  isBeating = false
  await clock.advance(60_000)
  expect(starts().length).toBe(2)
  const order = toolCalls.map(c => c.tool === 'TaskStop' ? `stop ${c.task_id}` : c.tool === 'Bash' ? 'start' : '').filter(Boolean)
  expect(order).toEqual(['start', 'stop bg1', 'start'])
  isBeating = true
  await clock.advance(10 * 60_000)
  expect(starts().length).toBe(2)
})

test('a coordination session not in bypass mode says once that the station works fully only there', { options }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { COMPUTERNAME: 'TESTPC', USERPROFILE: 'C:/Users/me' })
  on('session.cwd' as any, () => ({ value: 'C:/work/coord' }))
  on('session.id' as any, () => ({ value: 'engine-id' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  on('mcp.call' as any, (_$: any, e: any) => ({ value: { content: [{ type: 'text', text: e.tool === 'get_session' ? JSON.stringify({ sessionId: 'local_coord', title: 'Coordination', permissionMode: 'auto' }) : '' }] } }))
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })
  stubGit(on)
  fakeOfficeDatabase(on)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Read', file_path: 'C:/y.md' } as any)
  await clock.advance(5_000)
  expect(toasts.filter(t => t.includes('runs in the auto permission mode')).length).toBe(1)
  await clock.advance(60_000)
})

test('KEEP AWAKE refused by auto mode is told once, with what to do, and shown in the status line', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const statuses: any[] = []
  stubEngine(on, [], [], statuses)
  stubGit(on)
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })
  on('fs.write' as any, () => ({ value: null }))
  on('fs.read' as any, () => ({ value: '' }))
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'The server-side auto mode classifier gave no verdict for Bash' }) as any)
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', { ...STATION, keepAwake: true })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(25 * 60_000)
  expect(toasts.filter(t => t.includes('KEEP AWAKE cannot start its command, because auto mode refuses it. Run this coordination session with permissions bypassed')).length).toBe(1)
  expect(statuses.some(s => String(s?.text ?? s).includes('KEEP AWAKE does not start (auto mode refuses its command)'))).toBe(true)
})

test('an order that could not be delivered is told in the coordination session', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on)
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'nf', { text: 'Check it', folder: 'app', mode: 'existing', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  expect(db.read('orders', 'nf')?.status).toBe('failed')
  expect(toasts.filter(t => t.startsWith('Agent station: the order for app was not delivered:')).length).toBe(1)
  await clock.advance(60_000)
})

// A repo cloned next to the coordination repo, and added to the station, after
// the dispatcher started: an order for its room looks for it again first.
test('an order for a room cloned after the dispatcher started is not failed for it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  const remotes: Record<string, string> = { ...REMOTES }
  stubGit(on, undefined, remotes)
  const folders = ['app', 'coord', 'legal']
  on('fs.list' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/')
    if (path === 'C:/work') return { value: folders.map(name => ({ name, kind: 'dir' })) }
    throw new Error('no such directory')
  })
  const db = fakeOfficeDatabase(on)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  // The repo is cloned and added to the station; an order for its room comes.
  folders.push('newroom')
  remotes['C:/work/newroom'] = 'https://github.com/acme/newroom.git'
  db.seed('config', 'departments', { ...STATION, repos: [...STATION.repos, { remote: 'github.com/acme/newroom' }] })
  db.seed('orders', 'c1', { text: 'Set up the new repo', folder: 'newroom', mode: 'new', status: 'pending', createdAt: Date.now() })
  db.seed('orders', 'c2', { text: 'Nothing here', folder: 'ghost', mode: 'new', status: 'pending', createdAt: Date.now() })
  await clock.advance(35_000)

  expect(db.read('orders', 'c1')?.status).toBe('needs_click')
  expect(db.read('orders', 'c2')?.status).toBe('failed')
  expect(String(db.read('orders', 'c2')?.note)).toContain('ghost')
  await clock.advance(60_000)
})

// The repos are looked for again only on request: the page's FIND REPOS (or
// the coordination's find_repos tool), never with the handoffs' UPDATE.
test('the repos are looked for again on the page\'s request, not with the handoffs\' update', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  const remotes: Record<string, string> = { ...REMOTES }
  stubGit(on, () => ({ exitCode: 0, stdout: '[]' }), remotes)
  const folders = ['app', 'coord', 'legal']
  on('fs.list' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/')
    if (path === 'C:/work') return { value: folders.map(name => ({ name, kind: 'dir' })) }
    throw new Error('no such directory')
  })
  const db = fakeOfficeDatabase(on)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(15_000)
  expect(db.read('dispatchers', 'TESTPC')?.rooms).toEqual(['app', 'legal'])

  folders.push('newroom')
  remotes['C:/work/newroom'] = 'https://github.com/acme/newroom.git'
  db.seed('config', 'departments', { ...STATION, repos: [...STATION.repos, { remote: 'github.com/acme/newroom' }] })
  db.seed('config', 'refresh', { handoffsAskedAt: 5 })
  await clock.advance(25_000)
  expect(db.read('dispatchers', 'TESTPC')?.rooms).toEqual(['app', 'legal'])

  db.seed('config', 'refresh', { reposAskedAt: 9 })
  await clock.advance(25_000)
  expect(db.read('dispatchers', 'TESTPC')?.rooms).toEqual(['app', 'legal', 'newroom'])
  await clock.advance(60_000)
})

test('the coordination session gets find_repos, which says what it found and what is missing', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubFolders(on)
  const registered: string[] = []
  on('tool.register' as any, (_$: any, e: any) => {
    registered.push(e.name)
    return { value: { tool: `mcp__agent-station__${e.name}` } }
  })
  fakeOfficeDatabase(on)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  expect(registered).toContain('find_repos')
  const reply: any = await $.tool.call({ tool: 'mcp__agent-station__find_repos' } as any)
  const text = JSON.stringify(reply)
  expect(text).toContain('Rooms found: app (')
  expect(text).toContain('legal (')
  expect(text).not.toContain('coord (')
  await clock.advance(60_000)
})
