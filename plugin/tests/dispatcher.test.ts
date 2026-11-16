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

function fakeOfficeDatabase(on: any, failWrite: (e: any) => boolean = () => false, failRead: (e: any) => string | undefined = () => undefined) {
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
    const readFailure = failRead(e)
    if (readFailure) return reply(readFailure)
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
    // A write of someone else (the page), which moves the version on.
    change: (collection: string, id: string, patch: Record<string, any>) => {
      const doc = store.get(key(collection, id))!
      store.set(key(collection, id), { data: { ...doc.data, ...patch }, version: doc.version + 1 })
    },
    read:(collection: string, id: string) => store.get(key(collection, id))?.data,
    remove: (collection: string, id: string) => store.delete(key(collection, id)),
    ids: (collection: string) => [...store.keys()].filter(k => k.startsWith(`${collection}/`)).map(k => k.slice(collection.length + 1)),
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

test('an order to its own room goes to another session of the room, never back to the one that asked', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [{ sessionId: 'local_app', isArchived: false }, { sessionId: 'local_app2', isArchived: false }])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('sessions', 'local_app', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now() + 1000, title: 'Impact analysis' })
  db.seed('sessions', 'local_app2', { folder: 'app', machine: 'TESTPC', state: 'idle', lastEventAt: Date.now(), title: 'Release' })
  db.seed('orders', 'p3', { text: 'Rebase onto main', folder: 'app', mode: 'any', status: 'pending', createdAt: Date.now(), proposedBy: { sessionId: 'local_app', title: 'Impact analysis', folder: 'app' } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const sent = mcpCalls.filter(c => c.tool === 'send_message')
  expect(sent.map(c => c.args?.session_id)).toEqual(['local_app2'])
  expect(String(sent[0].args?.message)).toContain('Order from another session of this same room, its session "Impact analysis"')
  expect(String(sent[0].args?.message)).toContain('`folder: "app"`')
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
  expect(handoffs?.marks?.app).toBe('glab issue update <n> -R https://gitlab.com/acme/app --label "Doing" --unlabel "To Do"')
  expect(String(handoffs?.problems?.legal)).toContain('bitbucket.org, which has no handoffs')
  expect(handoffs?.problems?.app).toBeUndefined()
  await clock.advance(60_000)
})

test('every open issue is read, except those of a repo set to issues false and of the coordination repo', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  const listed: string[] = []
  stubGit(on, argv => {
    if (argv[1] === 'issue' && argv.includes('list')) listed.push(argv[argv.indexOf('--repo') + 1])
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

test('a handoff keeps who it is assigned to and its state labels', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  const created: string[] = []
  stubGit(on, argv => {
    if (argv[1] === 'label' && argv[2] === 'list') return { exitCode: 0, stdout: JSON.stringify([{ name: 'bug' }, { name: 'to do' }]) }
    if (argv[1] === 'label' && argv[2] === 'create') { created.push(`${argv[argv.indexOf('--repo') + 1]}: ${argv[3]} ${argv[argv.indexOf('--color') + 1]}`); return { exitCode: 0, stdout: '' } }
    return argv.includes('acme/app-repo')
      ? { exitCode: 0, stdout: JSON.stringify([
        { number: 4, title: 'Doing it', url: 'u4', createdAt: 'x', labels: [{ name: 'bug' }, { name: 'In Progress' }], assignees: [{ login: 'amn' }] },
        { number: 5, title: 'Waiting', url: 'u5', createdAt: 'x', labels: [{ name: 'progress-report' }, { name: 'To Do' }], assignees: [] },
        { number: 6, title: 'Merged', url: 'u6', createdAt: 'x', labels: [{ name: 'Pending production' }], assignees: [{ login: 'amn' }] },
      ]) }
      : { exitCode: 0, stdout: '[]' }
  })
  stubFolders(on)
  const db = fakeOfficeDatabase(on)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const [doing, waiting, merged] = db.read('config', 'handoffs')?.byFolder?.app ?? []
  expect(doing?.progressLabel).toBe('In Progress')
  expect(doing?.assignees).toEqual(['amn'])
  expect(db.read('config', 'handoffs')?.marks?.app).toBe('gh issue edit <n> --repo acme/app-repo --add-label "Doing" --remove-label "To Do"')
  expect(doing?.labels).toEqual(['bug'])
  expect(waiting?.labels).toEqual(['progress-report'])
  // A label for what comes after is the project's own, and shows as one more label.
  expect(merged?.labels).toEqual(['Pending production'])
  expect(merged?.progressLabel).toBe('')
  // Each repo lacked Doing: the dispatcher made it once, and left "to do" as it was.
  expect(created).toEqual(['acme/app-repo: Doing 0E8A16', 'acme/legal: Doing 0E8A16'])
  await $.tool.call({ tool: 'Read', file_path: 'C:/y.md' } as any)
  await clock.advance(16 * 60_000)
  expect(created.length).toBe(2)
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

// A folder room, "books": a folder next to the coordination repo with no repo,
// known by its mark.
const BOOKS_ID = '0123456789abcdef0123456789abcdef'
const FOLDER_STATION = { ...STATION, repos: [...STATION.repos, { folder: 'books', local: BOOKS_ID }] }
function stubFolderRoomFiles(on: any, marks: Record<string, unknown>, written: Array<{ path: string; text: string }> = [], extra: string[] = []) {
  on('fs.list' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/')
    if (path === 'C:/work') return { value: ['app', 'coord', 'legal', 'books', ...extra].map(name => ({ name, kind: 'dir' })) }
    throw new Error('no such directory')
  })
  on('fs.read' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/')
    if (path in marks) return { value: JSON.stringify(marks[path]) }
    throw new Error('no such file')
  })
  on('fs.write' as any, (_$: any, e: any) => {
    const path = String(e.path ?? '').replace(/\\/g, '/')
    // The plugin also writes its logs; only the marks count here.
    if (!path.endsWith('/.agent-station')) return { value: null }
    written.push({ path, text: String(e.text ?? e.content ?? '') })
    marks[path] = JSON.parse(String(e.text ?? e.content ?? '{}'))
    return { value: null }
  })
}

test('a new-session order for a folder room opens its card in the marked folder, with no branch to start from', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubFolderRoomFiles(on, { 'C:/work/books/.agent-station': { station: OFFICE, room: BOOKS_ID } })
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', FOLDER_STATION)
  db.seed('orders', 'f1', { text: 'Close the month', folder: 'books', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'f1')?.status).toBe('needs_click')
  const spawn = mcpCalls.find(c => c.tool === 'spawn_task')
  expect(spawn?.args?.cwd).toBe('C:\\work\\books')
  expect(String(spawn?.args?.prompt)).not.toContain('start from the branch')
  expect(db.read('dispatchers', 'TESTPC')?.rooms).toContain('books')
  await clock.advance(60_000)
})

test('a folder with no mark, or another station\'s, is no folder room', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubFolderRoomFiles(on, { 'C:/work/stray/.agent-station': { station: 'https://claude.ai/artifact/other-station', room: BOOKS_ID } }, [], ['stray'])
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', FOLDER_STATION)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(15_000)

  expect(db.read('dispatchers', 'TESTPC')?.rooms).toEqual(['app', 'legal'])
  await clock.advance(60_000)
})

test('mark_folder_room writes the mark of a folder room, and refuses a repo or a folder marked for another room', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  const written: Array<{ path: string; text: string }> = []
  const marks: Record<string, unknown> = { 'C:/work/taken/.agent-station': { station: OFFICE, room: 'ffffffffffffffffffffffffffffffff' } }
  stubFolderRoomFiles(on, marks, written, ['taken'])
  const registered: string[] = []
  on('tool.register' as any, (_$: any, e: any) => {
    registered.push(e.name)
    return { value: { tool: `mcp__agent-station__${e.name}` } }
  })
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', FOLDER_STATION)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  expect(registered).toContain('mark_folder_room')

  const text = async (input: Record<string, unknown>) => JSON.stringify(await $.tool.call({ tool: 'mcp__agent-station__mark_folder_room', ...input } as any))
  expect(await text({ room: 'nope' })).toContain('has no folder room')
  expect(await text({ room: 'books', directory: 'legal' })).toContain('is a git repo with the remote')
  expect(await text({ room: 'books', directory: 'taken' })).toContain('already has a mark')
  expect(await text({ room: 'books', directory: '../up' })).toContain('or the full path of a folder')
  expect(written.length).toBe(0)

  expect(await text({ room: 'books' })).toContain('The dispatcher found it')
  expect(written.map(w => w.path)).toEqual(['C:/work/books/.agent-station'])
  expect(JSON.parse(written[0].text)).toEqual({ station: OFFICE, room: BOOKS_ID })
  expect(await text({ room: 'books' })).toContain('is already marked')
  await clock.advance(60_000)
})

test('only the coordination session gets mark_folder_room', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls, [], [], undefined, 'C:/work/app')
  stubGit(on)
  stubFolderRoomFiles(on, {})
  const registered: string[] = []
  on('tool.register' as any, (_$: any, e: any) => {
    registered.push(e.name)
    return { value: { tool: `mcp__agent-station__${e.name}` } }
  })
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', FOLDER_STATION)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  expect(registered).toContain('propose_order')
  expect(registered).not.toContain('mark_folder_room')
  await clock.advance(60_000)
})

// Places: where a machine looks besides the coordination repo's neighbours,
// as config/places lists them under the machine's name.
function stubPlacesDisk(on: any, dirs: Record<string, string[]>, marks: Record<string, unknown> = {}) {
  on('fs.list' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/').replace(/\/+$/, '')
    if (path in dirs) return { value: dirs[path].map(name => ({ name, kind: 'dir' })) }
    throw new Error('no such directory')
  })
  on('fs.read' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/')
    if (path in marks) return { value: JSON.stringify(marks[path]) }
    throw new Error('no such file')
  })
}

test('the dispatcher also looks in the places listed for its machine, and says what each one gave', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on, undefined, { ...REMOTES, 'D:/clients/legal-copy': 'https://github.com/acme/legal.git', 'D:/clients/app2': 'https://github.com/acme/app-repo.git' })
  stubPlacesDisk(on, {
    'C:/work': ['coord', 'legal'],
    'D:/clients': ['app2', 'legal-copy', 'misc'],
    'E:/books': [],
  }, { 'E:/books/.agent-station': { room: BOOKS_ID } })
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', FOLDER_STATION)
  db.seed('config', 'places', { byMachine: { TESTPC: ['D:\\clients\\*', 'E:\\books', 'F:\\gone', 'relative\\path', '\\\\server\\share\\*', '//server/share', '/\\server\\share', '\\\\?\\C:\\x'], OTHERPC: ['G:\\never'] } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(15_000)

  const lease = db.read('dispatchers', 'TESTPC')
  expect(lease?.rooms).toEqual(['app', 'books', 'legal'])
  expect(lease?.places).toEqual([
    { path: 'D:\\clients\\*', rooms: 1, isMissing: false },
    { path: 'E:\\books', rooms: 1, isMissing: false },
    { path: 'F:\\gone', rooms: 0, isMissing: true },
  ])
  await clock.advance(60_000)
})

test('a room next to the coordination repo keeps its folder over a copy in a place', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on, undefined, { ...REMOTES, 'D:/clients/app-old': 'https://github.com/acme/app-repo.git' })
  stubPlacesDisk(on, { 'C:/work': ['app', 'coord'], 'D:/clients': ['app-old'] })
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'places', { byMachine: { TESTPC: ['D:\\clients\\*'] } })
  db.seed('orders', 'pl1', { text: 'Fix the build', folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(mcpCalls.find(c => c.tool === 'spawn_task')?.args?.cwd).toBe('C:\\work\\app')
  expect(db.read('dispatchers', 'TESTPC')?.places).toEqual([{ path: 'D:\\clients\\*', rooms: 0, isMissing: false }])
  await clock.advance(60_000)
})

test('a new-session order opens in the place where its room was found', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on, undefined, { ...REMOTES, 'D:/clients/legal': 'https://github.com/acme/legal.git' })
  stubPlacesDisk(on, { 'C:/work': ['coord'], 'D:/clients': ['legal'] })
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'places', { byMachine: { TESTPC: ['D:\\clients\\*'] } })
  db.seed('orders', 'pl2', { text: 'Review clause 9', folder: 'legal', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(mcpCalls.find(c => c.tool === 'spawn_task')?.args?.cwd).toBe('D:\\clients\\legal')
  await clock.advance(60_000)
})

test('mark_folder_room marks a folder by its full path, which the dispatcher finds once its place is listed', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  const marks: Record<string, unknown> = {}
  const written: string[] = []
  on('fs.list' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/').replace(/\/+$/, '')
    if (path === 'C:/work') return { value: ['app', 'coord', 'legal'].map(name => ({ name, kind: 'dir' })) }
    if (path === 'E:/books') return { value: [] }
    throw new Error('no such directory')
  })
  on('fs.read' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/')
    if (path in marks) return { value: JSON.stringify(marks[path]) }
    throw new Error('no such file')
  })
  on('fs.write' as any, (_$: any, e: any) => {
    const path = String(e.path ?? '').replace(/\\/g, '/')
    if (!path.endsWith('/.agent-station')) return { value: null }
    written.push(path)
    marks[path] = JSON.parse(String(e.text ?? e.content ?? '{}'))
    return { value: null }
  })
  on('tool.register' as any, (_$: any, e: any) => ({ value: { tool: `mcp__agent-station__${e.name}` } }))
  const db = fakeOfficeDatabase(on)
  db.seed('config', 'departments', FOLDER_STATION)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  const text = async (input: Record<string, unknown>) => JSON.stringify(await $.tool.call({ tool: 'mcp__agent-station__mark_folder_room', ...input } as any))
  expect(await text({ room: 'books', directory: 'F:\\nowhere' })).toContain('there is no folder')
  expect(await text({ room: 'books', directory: 'E:\\books' })).toContain('adds its path')
  expect(written).toEqual(['E:/books/.agent-station'])

  db.seed('config', 'places', { byMachine: { TESTPC: ['E:\\books'] } })
  expect(await text({ room: 'books', directory: 'E:\\books' })).toContain('is already marked')
  const found: any = await $.tool.call({ tool: 'mcp__agent-station__find_repos' } as any)
  expect(JSON.stringify(found)).toContain('books (E:')
  await clock.advance(60_000)
})

test('a folder room\'s folder set for this machine gets its mark and is found; a repo, another room\'s mark or a missing folder is reported', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on, undefined, { ...REMOTES, 'D:/code/legal': 'https://github.com/acme/legal.git' })
  const marks: Record<string, unknown> = { 'E:/other/.agent-station': { room: 'ffffffffffffffffffffffffffffffff' } }
  const written: string[] = []
  on('fs.list' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/').replace(/\/+$/, '')
    if (path === 'C:/work') return { value: ['coord'].map(name => ({ name, kind: 'dir' })) }
    if (['E:/books', 'E:/other', 'D:/code/legal'].includes(path)) return { value: [] }
    throw new Error('no such directory')
  })
  on('fs.read' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e).replace(/\\/g, '/')
    if (path in marks) return { value: JSON.stringify(marks[path]) }
    throw new Error('no such file')
  })
  on('fs.write' as any, (_$: any, e: any) => {
    const path = String(e.path ?? '').replace(/\\/g, '/')
    if (!path.endsWith('/.agent-station')) return { value: null }
    written.push(path)
    marks[path] = JSON.parse(String(e.text ?? e.content ?? '{}'))
    return { value: null }
  })
  const db = fakeOfficeDatabase(on)
  const station = { ...STATION, repos: [...STATION.repos, { folder: 'books', local: BOOKS_ID }, { folder: 'notes', local: '11111111111111111111111111111111' }, { folder: 'ledger', local: '22222222222222222222222222222222' }, { folder: 'gone', local: '33333333333333333333333333333333' }] }
  db.seed('config', 'departments', station)
  db.seed('config', 'places', { folderRooms: { TESTPC: { books: 'E:\\books', notes: 'E:\\other', ledger: 'D:\\code\\legal', gone: 'F:\\gone', nobody: 'E:\\books' }, OTHERPC: { books: 'G:\\books' } } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(15_000)

  expect(written).toEqual(['E:/books/.agent-station'])
  expect(marks['E:/books/.agent-station']).toEqual({ station: OFFICE, room: BOOKS_ID })
  const lease = db.read('dispatchers', 'TESTPC')
  expect(lease?.rooms).toContain('books')
  expect(lease?.folderPaths).toEqual([
    { room: 'books', path: 'E:\\books', state: 'found' },
    { room: 'notes', path: 'E:\\other', state: 'taken' },
    { room: 'ledger', path: 'D:\\code\\legal', state: 'repo' },
    { room: 'gone', path: 'F:\\gone', state: 'missing' },
  ])
  await clock.advance(60_000)
})

test('a dispatcher whose plugin copy has been reloaded stops polling', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubEngine(on, mcpCalls)
  stubGit(on)
  stubFolders(on)
  let orderQueries = 0
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any, next: any) => {
    if (e.action === 'query' && e.collection === 'orders') orderQueries++
    return next(e)
  })
  fakeOfficeDatabase(on)
  // A reload of the plugin starts a newer dispatcher, which writes its own generation.
  let isReloaded = false
  on('state.get' as any, (_$: any, e: any, next: any) => e.key === 'dispatcherGeneration' && isReloaded ? { value: { value: 'a-newer-copy' } } : next(e))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(2 * 60_000)
  const whileCurrent = orderQueries
  expect(whileCurrent).toBeGreaterThan(0)

  isReloaded = true
  await clock.advance(30_000)
  const atStop = orderQueries
  await clock.advance(5 * 60_000)
  expect(orderQueries).toBe(atStop)
})

test('an unchanged catalog of handoffs is not written again whole, only when it was read', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  let issues = [{ number: 3, title: 'Crash on login', url: 'u3', createdAt: 'x', labels: [] }]
  stubGit(on, argv => argv[1] === 'issue' && argv.includes('acme/app-repo') ? { exitCode: 0, stdout: JSON.stringify(issues) } : { exitCode: 0, stdout: '[]' })
  stubFolders(on)
  const writes: string[] = []
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any, next: any) => {
    if (e.collection === 'config' && e.doc_id === 'handoffs' && e.action !== 'get') writes.push(e.action)
    return next(e)
  })
  const db = fakeOfficeDatabase(on)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  expect(writes).toEqual(['set'])

  // Fifteen minutes later nothing has changed: only the time of the reading.
  await clock.advance(15 * 60_000)
  expect(writes).toEqual(['set', 'update'])
  expect(db.read('config', 'handoffs')?.byFolder?.app?.[0]?.title).toBe('Crash on login')

  // A new issue writes the catalog whole again.
  issues = [...issues, { number: 4, title: 'Slow sync', url: 'u4', createdAt: 'y', labels: [] }]
  await clock.advance(15 * 60_000)
  expect(writes).toEqual(['set', 'update', 'set'])
  expect(db.read('config', 'handoffs')?.byFolder?.app?.length).toBe(2)
  await clock.advance(60_000)
})

test('a card nobody has clicked for an hour is looked at every tenth poll, and still delivered', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [{ sessionId: 'local_card', isArchived: false }])
  stubGit(on)
  stubFolders(on)
  let cardQueries = 0
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any, next: any) => {
    if (e.action === 'query' && e.collection === 'sessions' && e.query?.where?.[0]?.[0] === 'fromOrder') cardQueries++
    return next(e)
  })
  const db = fakeOfficeDatabase(on)
  const spawnedAt = Date.now() - 2 * 60 * 60_000
  db.seed('orders', 'old1', { text: 'Tidy the docs', folder: 'app', mode: 'new', status: 'needs_click', claimedBy: 'TESTPC', spawnedAt, createdAt: spawnedAt })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10 * 30_000)
  expect(cardQueries).toBeLessThanOrEqual(2)

  // Clicked at last: the session it opened is found, and the order delivered.
  db.seed('sessions', 'local_card', { folder: 'app', machine: 'TESTPC', state: 'working', fromOrder: 'old1', title: 'Tidy', lastEventAt: Date.now() })
  await clock.advance(10 * 30_000)
  expect(db.read('orders', 'old1')?.status).toBe('delivered')
  await clock.advance(60_000)
})

// An app with no spawn_task leaves no card: the order waits with a link to the
// app's new-session screen, and the coordination session opens it on a turn the
// user typed there.
function stubAppWithoutCards(on: any, mcpCalls: any[], startReply: (e: any) => string | Error, spawnError = 'agent-station: $.mcp.call: no connected MCP tool "spawn_task" on a server named "ccd_session"') {
  mock.env(on, { COMPUTERNAME: 'TESTPC', USERPROFILE: 'C:/Users/me' })
  on('session.cwd' as any, () => ({ value: 'C:/work/coord' }))
  on('session.id' as any, () => ({ value: 'engine-id' }))
  on('ui.status' as any, () => ({ value: null }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  on('tool.register' as any, (_$: any, e: any) => ({ value: { tool: `mcp__agent-station__${e.name}` } }))
  on('mcp.call' as any, (_$: any, e: any) => {
    mcpCalls.push(e)
    const text = (t: string, isError = false) => ({ value: { content: [{ type: 'text', text: t }], isError } })
    if (e.tool === 'spawn_task') return text(spawnError, true)
    if (e.tool === 'start_session') {
      const reply = startReply(e)
      return reply instanceof Error ? text(reply.message, true) : text(reply)
    }
    if (e.tool === 'get_session') return text(JSON.stringify({ sessionId: 'local_coord', title: 'Coordination', model: 'claude-opus-5-5' }))
    if (e.tool === 'list_sessions') return text('[]')
    return text('')
  })
}
const sessionStarted = (id: string) => `Started session "x" (session_id: ${id}, name: x). It runs on its own.`

test('with no spawn_task a new-session order waits with a link to the app, and never starts a session by itself', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubAppWithoutCards(on, mcpCalls, () => sessionStarted('local_new'))
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'l1', { text: 'Handle issue 2', folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const order = db.read('orders', 'l1')
  expect(order?.status).toBe('needs_click')
  expect(order?.awaitsOpen).toBe(true)
  expect(String(order?.note)).toContain('OPEN NEW SESSION')
  const link = new URL(String(order?.openLink))
  expect(link.protocol).toBe('claude:')
  expect(link.searchParams.get('folder')).toBe('C:\\work\\app')
  expect(String(link.searchParams.get('q')).endsWith('[agent-station order l1 for app]')).toBe(true)
  await clock.advance(5 * 60_000)
  expect(mcpCalls.filter(c => c.tool === 'spawn_task').length).toBe(1)
  expect(mcpCalls.some(c => c.tool === 'start_session')).toBe(false)
})

test('a long order gets a short link, and keeps its whole message for the session', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubAppWithoutCards(on, [], () => sessionStarted('local_new'))
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  const text = 'Long order '.repeat(400)
  db.seed('orders', 'l2', { text, folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const order = db.read('orders', 'l2')
  expect(order?.status).toBe('needs_click')
  expect(String(order?.openLink).length).toBeLessThanOrEqual(2000)
  const q = String(new URL(String(order?.openLink)).searchParams.get('q'))
  expect(q).toContain('Long order')
  expect(q.endsWith('[agent-station order l2 for app]')).toBe(true)
  expect(String(order?.openText)).toContain(text)
  await clock.advance(60_000)
})

test('a delivered order is finished once its session ends a turn the order started, and only then', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [
    { sessionId: 'local_done', isArchived: false, isRunning: true },
    { sessionId: 'local_busy', isArchived: false, isRunning: true },
    { sessionId: 'local_queued', isArchived: false, isRunning: true },
    { sessionId: 'local_opened', isArchived: false, isRunning: true },
  ])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const now = Date.now()
  const session = (state: string, turnStartedAt: number, extra: Record<string, any> = {}) => ({ folder: 'app', machine: 'TESTPC', state, turnStartedAt, lastEventAt: now - 1000, ...extra })
  const delivered = (deliveredTo: string, extra: Record<string, any> = {}) => ({ text: 'Do it', folder: 'app', mode: 'any', status: 'delivered', claimedBy: 'TESTPC', deliveredTo, deliveredAt: now - 60_000, createdAt: now - 120_000, ...extra })
  db.seed('sessions', 'local_done', session('idle', now - 50_000))
  db.seed('sessions', 'local_busy', session('working', now - 50_000))
  // Idle after the turn that was running when the order came; the order's own turn has not begun.
  db.seed('sessions', 'local_queued', session('idle', now - 90_000))
  // A session the order opened: its first turn began before the order was marked delivered.
  db.seed('sessions', 'local_opened', session('idle', now - 70_000, { fromOrder: 'o4' }))
  db.seed('orders', 'o1', delivered('local_done'))
  db.seed('orders', 'o2', delivered('local_busy'))
  db.seed('orders', 'o3', delivered('local_queued'))
  db.seed('orders', 'o4', delivered('local_opened'))
  db.seed('orders', 'o5', delivered('local_gone'))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  expect(db.read('orders', 'o1')?.finishedAt).toBe(now - 1000)
  expect(db.read('orders', 'o2')?.finishedAt).toBeUndefined()
  expect(db.read('orders', 'o3')?.finishedAt).toBeUndefined()
  expect(db.read('orders', 'o4')?.finishedAt).toBe(now - 1000)
  expect(db.read('orders', 'o5')?.finishedAt).toBeUndefined()
  expect(db.read('orders', 'o1')?.status).toBe('delivered')
  await clock.advance(60_000)
})

test('a finished order moves to the end of the turn its background work started, for the latest order only', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [
    { sessionId: 'local_bg', isArchived: false, isRunning: true },
    { sessionId: 'local_user', isArchived: false, isRunning: true },
  ])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  const now = Date.now()
  const finishedAt = now - 40_000
  const delivered = (deliveredTo: string, deliveredAt: number) => ({ text: 'Do it', folder: 'app', mode: 'any', status: 'delivered', claimedBy: 'TESTPC', deliveredTo, deliveredAt, finishedAt, createdAt: deliveredAt - 1000 })
  // The background task's notice started a turn after the order's turn ended.
  db.seed('sessions', 'local_bg', { folder: 'app', machine: 'TESTPC', state: 'idle', turnStartedAt: now - 10_000, turnOrigin: 'task-notification', lastEventAt: now - 2000 })
  // The user typed the next turn: that is other work.
  db.seed('sessions', 'local_user', { folder: 'app', machine: 'TESTPC', state: 'idle', turnStartedAt: now - 10_000, turnOrigin: 'sdk', lastEventAt: now - 2000 })
  db.seed('orders', 'latest', delivered('local_bg', now - 60_000))
  db.seed('orders', 'older', delivered('local_bg', now - 3_600_000))
  db.seed('orders', 'typed', delivered('local_user', now - 60_000))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  expect(db.read('orders', 'latest')?.finishedAt).toBe(now - 2000)
  expect(db.read('orders', 'older')?.finishedAt).toBe(finishedAt)
  expect(db.read('orders', 'typed')?.finishedAt).toBe(finishedAt)
  await clock.advance(60_000)
})

// review_orders: the user's answer to its confirmation, and the questions asked.
function answerReview(on: any, answer: string, asked: any[] = []) {
  registersTools(on)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    asked.push(e)
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } } as any
  })
}
// A turn the user typed in the desktop app, which leaves it unstamped.
async function userTurn($: any, _on: any, text: string) {
  await $.prompt.submit({ text })
}
// The engine's side for the coordination tools, a prompt and a turn's end.
const registersTools = (on: any) => {
  on('tool.register' as any, (_$: any, e: any) => ({ value: { tool: `mcp__agent-station__${e.name}` } }))
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))
  on('turn.complete' as any, (_$: any, e: any) => ({ text: e.answer ?? '' }))
}
async function endTurn($: any) {
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: `t-${Math.random()}`, reason: 'answer' })
}
const REVIEW = 'mcp__agent-station__review_orders'
const proposal = (text: string, folder = 'app', createdAt = 1) => ({ text, folder, mode: 'any', status: 'proposed', reason: 'Because', proposedBy: { sessionId: 'local_legal', title: 'Legal work', folder: 'legal' }, createdAt })

const ORDERS_PANE = {
  plugin: 'agent-station',
  component: 'Pane',
  requestId: 'station-orders',
  props: { title: 'Station orders', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the coordination session opens its orders pane, and a press approves or rejects as the page does', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const opened: any[] = []
  stubEngine(on, [])
  stubGit(on)
  registersTools(on)
  on('ui.open' as any, (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'p1', proposal('Fix the login page', 'app', 1))
  db.seed('orders', 'p2', proposal('Translate the release notes', 'legal', 2))
  db.seed('orders', 'done', { ...proposal('Already approved', 'app', 3), status: 'pending' })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  expect(opened.some(e => e.id === 'station-orders')).toBe(true)

  const ui = await ($ as any).ui.mount({ ...ORDERS_PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /2 orders wait for your approval/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Fix the login page/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Already approved/ })).toBeUndefined()

  await ui.press({ key: 'approve-p1' })
  await ui.press({ key: 'reject-p2' })
  await clock.advance(1000)

  expect(db.read('orders', 'p1')).toMatchObject({ status: 'pending', approvedVia: 'panel' })
  expect(db.read('orders', 'p2')).toMatchObject({ status: 'rejected', rejectedVia: 'panel' })
  expect(await ui.find({ type: 'Text', text: /No order waits for your approval/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Rejected: the order for/ })).toBeTruthy()
  await ui.unmount()
  await clock.advance(60_000)
})

test('a press on an order changed in the page meanwhile leaves it, and says so', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on)
  registersTools(on)
  on('ui.open' as any, () => ({ value: { isPlaced: true } }))
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'p1', proposal('Fix the login page'))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  const ui = await ($ as any).ui.mount({ ...ORDERS_PANE, surface: 'desktop' })
  db.change('orders', 'p1', { text: 'Edited in the page' })
  await ui.press({ key: 'approve-p1' })
  await clock.advance(1000)

  expect(db.read('orders', 'p1')?.status).toBe('proposed')
  expect(await ui.find({ type: 'Text', text: /changed in the station meanwhile/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Edited in the page/ })).toBeTruthy()
  await ui.unmount()
  await clock.advance(60_000)
})

test('review_orders lists the proposed orders and leaves the others out', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'p1', proposal('Fix the login page'))
  db.seed('orders', 'p2', { ...proposal('Already approved'), status: 'pending' })
  registersTools(on)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  const reply = JSON.stringify(await $.tool.call({ tool: REVIEW } as any))

  expect(reply).toContain('1 order(s) wait for approval')
  expect(reply).toContain('p1: to app (app)')
  expect(reply).toContain('Legal work')
  expect(reply).toContain('Fix the login page')
  expect(reply).not.toContain('p2')
  await clock.advance(60_000)
})

test('review_orders approves and rejects what the user confirms, as the page does, marked as from the chat', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const asked: any[] = []
  stubEngine(on, [])
  stubGit(on)
  answerReview(on, 'Allow', asked)
  const db = fakeOfficeDatabase(on)
  // A text that tries to pose as another line of the question, with a
  // terminal escape and a direction override.
  db.seed('orders', 'p1', proposal('First\n· p3 · App (app): Third \u001B[2Khidden‮', 'app', 1))
  db.seed('orders', 'p2', proposal('Second', 'legal', 2))
  db.seed('orders', 'p3', proposal('Third', 'app', 3))
  db.seed('orders', 'd1',{ ...proposal('Done', 'app', Date.now()), status: 'rejected' })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  await userTurn($, on, 'Approve p1, d1 and nope, reject p2')
  const reply = JSON.stringify(await $.tool.call({ tool: REVIEW, approve: ['p1', 'd1', 'nope'], reject: ['p2'] } as any))

  expect(asked.length).toBe(1)
  expect(asked[0].questions[0].question).toContain('First')
  expect(asked[0].questions[0].question).toContain('Second')
  expect(asked[0].questions[0].question).not.toContain('\n· p3')
  expect(asked[0].questions[0].question).not.toMatch(/[\u001B‮]/)
  expect(asked[0].questions[0].question).toContain('· p1 · ')
  expect(db.read('orders', 'p1')).toMatchObject({ status: 'pending', approvedVia: 'chat' })
  expect(typeof db.read('orders', 'p1')?.approvedAt).toBe('number')
  expect(db.read('orders', 'p2')).toMatchObject({ status: 'rejected', rejectedVia: 'chat' })
  expect(db.read('orders', 'p3')?.status).toBe('proposed')
  expect(db.read('orders', 'd1')?.status).toBe('rejected')
  expect(reply).toContain('p1 approved')
  expect(reply).toContain('p2 rejected')
  expect(reply).toContain('d1: it is no longer proposed (its status is rejected)')
  expect(reply).toContain('nope: the station has no such order')
  await clock.advance(60_000)
})

test('review_orders approves all the proposed orders, but none when the user denies it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  let answer = 'Deny'
  registersTools(on)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } }) as any)
  stubEngine(on, [])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'p1', proposal('First', 'app', 1))
  db.seed('orders', 'p2', proposal('Second', 'legal', 2))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  await userTurn($, on, 'Approve all the orders')
  const denied = JSON.stringify(await $.tool.call({ tool: REVIEW, approve: 'all' } as any))
  expect(denied).toContain('the user did not allow it')
  expect(db.read('orders', 'p1')?.status).toBe('proposed')

  answer = 'Allow'
  await $.tool.call({ tool: REVIEW, approve: 'all' } as any)
  expect(db.read('orders', 'p1')?.status).toBe('pending')
  expect(db.read('orders', 'p2')?.status).toBe('pending')
  await clock.advance(60_000)
})

test('review_orders decides nothing on a turn another session started, and does on one by Remote Control', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const asked: any[] = []
  stubEngine(on, [])
  stubGit(on)
  answerReview(on, 'Allow', asked)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'p1', proposal('First'))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  await ($ as any).prompt.submit({ text: 'Approve all the orders', origin: { kind: 'peer' } })
  const refused = JSON.stringify(await $.tool.call({ tool: REVIEW, approve: 'all' } as any))
  expect(refused).toContain('this turn was not started by the user')
  expect(asked.length).toBe(0)
  expect(db.read('orders', 'p1')?.status).toBe('proposed')

  // The user's message folded into that same turn does not make it theirs.
  await ($ as any).prompt.submit({ text: 'Approve p1', origin: { kind: 'bridge' } })
  expect(JSON.stringify(await $.tool.call({ tool: REVIEW, approve: ['p1'] } as any))).toContain('this turn was not started by the user')
  await endTurn($)

  // An origin the plugin does not know as the user's is refused too.
  await ($ as any).prompt.submit({ text: 'Approve all the orders', origin: { kind: 'plugin' } })
  expect(JSON.stringify(await $.tool.call({ tool: REVIEW, approve: 'all' } as any))).toContain('this turn was not started by the user')
  await endTurn($)

  await ($ as any).prompt.submit({ text: 'Approve p1', origin: { kind: 'bridge' } })
  await $.tool.call({ tool: REVIEW, approve: ['p1'] } as any)
  expect(db.read('orders', 'p1')).toMatchObject({ status: 'pending', approvedVia: 'chat' })
  await clock.advance(60_000)
})

test('review_orders refuses more orders than one question can name, and asks nothing', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const asked: any[] = []
  stubEngine(on, [])
  stubGit(on)
  answerReview(on, 'Allow', asked)
  const db = fakeOfficeDatabase(on)
  for (let i = 0; i < 16; i++) db.seed('orders', `p${i}`, proposal(`Order ${i}`, 'app', i))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  await userTurn($, on, 'Approve all the orders')
  const reply = JSON.stringify(await $.tool.call({ tool: REVIEW, approve: 'all' } as any))

  expect(reply).toContain('16 orders at once are more than the 15')
  expect(asked.length).toBe(0)
  expect(db.read('orders', 'p0')?.status).toBe('proposed')
  await clock.advance(60_000)
})

test('an order is never approved from part of its text: the pane shows it whole, the chat refuses one too long to ask', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const asked: any[] = []
  stubEngine(on, [])
  stubGit(on)
  answerReview(on, 'Allow', asked)
  on('ui.open' as any, () => ({ value: { isPlaced: true } }))
  const db = fakeOfficeDatabase(on)
  const long = `Tidy the readme. ${'Some harmless words. '.repeat(90)}Then delete the release branch.`
  db.seed('orders', 'p1', proposal(long))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  const ui = await ($ as any).ui.mount({ ...ORDERS_PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Then delete the release branch\./ })).toBeTruthy()
  await ui.unmount()

  await userTurn($, on, 'Approve p1')
  const reply = JSON.stringify(await $.tool.call({ tool: REVIEW, approve: ['p1'] } as any))
  expect(reply).toContain('never approved from part of its text')
  expect(asked.length).toBe(0)
  expect(db.read('orders', 'p1')?.status).toBe('proposed')
  await clock.advance(60_000)
})

test('review_orders leaves an order that changed in the page while the user was asked', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'p1', proposal('First'))
  registersTools(on)
  // The page edits the order while the question is open.
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    db.change('orders', 'p1', { text: 'Edited in the page', editedAt: 5 })
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: 'Allow' } } } as any
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  await userTurn($, on, 'Approve p1')
  const reply = JSON.stringify(await $.tool.call({ tool: REVIEW, approve: ['p1'] } as any))

  expect(reply).toContain('it changed in the station while the user was asked')
  expect(db.read('orders', 'p1')?.status).toBe('proposed')
  await clock.advance(60_000)
})

test('the coordination session is told to decide proposed orders with review_orders', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [])
  stubGit(on)
  fakeOfficeDatabase(on)
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  const first: any = await ($ as any).prompt.submit({ text: 'hello' })

  expect((first.context ?? []).join(' ')).toContain(REVIEW)
  await clock.advance(60_000)
})

test('open_pending_orders starts each waiting order in its room, detaches it and delivers it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  let count = 0
  stubAppWithoutCards(on, mcpCalls, () => sessionStarted(`local_new${++count}`))
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  const waiting = { mode: 'new', status: 'needs_click', awaitsOpen: true, claimedBy: 'TESTPC', spawnedAt: Date.now() }
  db.seed('orders', 'w1', { ...waiting, text: 'First', folder: 'app', model: 'claude-sonnet-5-5', createdAt: 1 })
  db.seed('orders', 'w2', { ...waiting, text: 'Second', folder: 'legal', attempt: 2, createdAt: 2 })
  db.seed('orders', 'w3', { ...waiting, text: 'Card of another machine', folder: 'app', claimedBy: 'OTHERPC', createdAt: 3 })
  db.seed('orders', 'w4', { ...waiting, text: 'A card of an older app', folder: 'app', awaitsOpen: undefined, createdAt: 4 })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  const reply: any = await $.tool.call({ tool: 'mcp__agent-station__open_pending_orders' } as any)

  expect(JSON.stringify(reply)).toContain('Opened a session for 2 order(s)')
  const starts = mcpCalls.filter(c => c.tool === 'start_session')
  expect(starts.length).toBe(2)
  expect(starts[0].args).toMatchObject({ initiation: 'user_asked', context: 'fresh', use_worktree: false, cwd: 'C:\\work\\app' })
  expect(String(starts[0].args.background).length).toBeGreaterThanOrEqual(80)
  expect(String(starts[0].args.prompt).endsWith('[agent-station order w1 for app]')).toBe(true)
  expect(String(starts[1].args.prompt).endsWith('[agent-station order w2#2 for legal]')).toBe(true)
  expect(db.read('orders', 'w1')).toMatchObject({ status: 'delivered', deliveredTo: 'local_new1' })
  expect(db.read('orders', 'w2')).toMatchObject({ status: 'delivered', deliveredTo: 'local_new2' })
  expect(db.read('orders', 'w3')?.status).toBe('needs_click')
  expect(db.read('orders', 'w4')?.status).toBe('needs_click')
  expect(mcpCalls.filter(c => c.tool === 'detach_session').map(c => c.args.session_id)).toEqual(['local_new1', 'local_new2'])
  expect(mcpCalls.some(c => c.tool === 'set_session_model' && c.args.session_id === 'local_new1' && c.args.model === 'claude-sonnet-5-5')).toBe(true)
  await clock.advance(60_000)
})

test('when the app refuses, the round stops and the orders go on waiting, with the reason on the first', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubAppWithoutCards(on, mcpCalls, () => new Error('The user is working over Remote Control, and this turn cannot start that session.'))
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  const waiting = { mode: 'new', status: 'needs_click', awaitsOpen: true, claimedBy: 'TESTPC', spawnedAt: Date.now() }
  db.seed('orders', 'r1', { ...waiting, text: 'First', folder: 'app', createdAt: 1 })
  db.seed('orders', 'r2', { ...waiting, text: 'Second', folder: 'legal', createdAt: 2 })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  const reply: any = await $.tool.call({ tool: 'mcp__agent-station__open_pending_orders' } as any)

  expect(JSON.stringify(reply)).toContain('2 order(s) go on waiting')
  expect(mcpCalls.filter(c => c.tool === 'start_session').length).toBe(1)
  expect(db.read('orders', 'r1')?.status).toBe('needs_click')
  expect(String(db.read('orders', 'r1')?.note)).toContain('Remote Control')
  expect(db.read('orders', 'r2')?.status).toBe('needs_click')
  await clock.advance(5 * 60_000)
  expect(mcpCalls.filter(c => c.tool === 'start_session').length).toBe(1)
})

test('any other error from spawn_task fails the order with its reason, once', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubAppWithoutCards(on, mcpCalls, () => sessionStarted('local_new'), 'The app could not queue the task.')
  on('ui.toast' as any, () => ({ value: null }))
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'e1', { text: 'Refused', folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'e1')?.status).toBe('failed')
  expect(String(db.read('orders', 'e1')?.note)).toContain('could not queue')
  await clock.advance(5 * 60_000)
  expect(mcpCalls.filter(c => c.tool === 'spawn_task').length).toBe(1)
})

test('a started session the app gives no id for is not opened again, and its mark claims the order', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const mcpCalls: any[] = []
  stubAppWithoutCards(on, mcpCalls, () => 'Started the session.')
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'n1', { mode: 'new', status: 'needs_click', awaitsOpen: true, claimedBy: 'TESTPC', spawnedAt: Date.now(), text: 'First', folder: 'app', createdAt: 1 })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  await $.tool.call({ tool: 'mcp__agent-station__open_pending_orders' } as any)
  await $.tool.call({ tool: 'mcp__agent-station__open_pending_orders' } as any)

  expect(mcpCalls.filter(c => c.tool === 'start_session').length).toBe(1)
  expect(db.read('orders', 'n1')?.status).toBe('needs_click')
  db.seed('sessions', 'local_new', { folder: 'app', machine: 'TESTPC', state: 'working', fromOrder: 'n1', title: 'New' })
  await clock.advance(60_000)
  expect(db.read('orders', 'n1')).toMatchObject({ status: 'delivered', deliveredTo: 'local_new' })
})

for (const [name, answer] of [
  ['that says so', 'db read failed (unavailable): try later'],
  ['with no error flag', 'that check is no longer on record: nothing was done'],
] as const) {
  test(`a failed read ${name} is reported as one, never as no orders`, { options }, async ($, on) => {
    const clock = mock.clock(on)
    const mcpCalls: any[] = []
    stubAppWithoutCards(on, mcpCalls, () => sessionStarted('local_new'))
    stubGit(on)
    stubFolders(on)
    let isFailing = false
    const db = fakeOfficeDatabase(on, () => false, e => isFailing && e.collection === 'orders' && e.action === 'query' ? answer : undefined)
    db.seed('orders', 'f1', { mode: 'new', status: 'needs_click', awaitsOpen: true, claimedBy: 'TESTPC', spawnedAt: Date.now(), text: 'First', folder: 'app', createdAt: 1 })

    await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
    await clock.advance(10_000)
    isFailing = true
    const reply = JSON.stringify(await $.tool.call({ tool: 'mcp__agent-station__open_pending_orders' } as any))
    isFailing = false

    expect(reply).toContain('could not be read')
    expect(reply).toContain(answer)
    expect(reply).not.toContain('No order is waiting')
    expect(mcpCalls.some(c => c.tool === 'start_session')).toBe(false)
    await clock.advance(60_000)
  })
}

test('with really no order waiting the tool says so', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubAppWithoutCards(on, [], () => sessionStarted('local_new'))
  stubGit(on)
  stubFolders(on)
  fakeOfficeDatabase(on)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__agent-station__open_pending_orders' } as any))).toContain('No order is waiting')
  await clock.advance(60_000)
})

test('a long order with an emoji where its excerpt ends still gets its link', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubAppWithoutCards(on, [], () => sessionStarted('local_new'))
  stubGit(on)
  stubFolders(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'u1', { text: `${'x'.repeat(159)}\u{1F600}${'Long order '.repeat(300)}`, folder: 'app', mode: 'new', status: 'pending', createdAt: Date.now() })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(db.read('orders', 'u1')?.status).toBe('needs_click')
  expect(String(db.read('orders', 'u1')?.openLink)).toContain('claude://code/new?q=')
  await clock.advance(60_000)
})

// A tool call's row in the transcript, as the engine raises it.
const toolRow = (tool: string, id: string) => ({
  plugin: 'agent-station',
  component: 'ToolUse',
  requestId: id,
  props: { tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false },
}) as any
const PROPOSE = 'mcp__agent-station__propose_order'
// The engine's own row, which the mod's card keeps inside it.
const drawsRows = (on: any) => on('ui.render', { component: 'ToolUse' }, ($: any, e: any) => {
  const { Text } = $.ui.resolve(e)
  return h(Text, null, `row ${e.props.tool}`)
})

test('the row of a propose_order call follows its order, until the turn it started is done', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [], [], undefined, 'C:/work/legal')
  stubGit(on)
  registersTools(on)
  drawsRows(on)
  const db = fakeOfficeDatabase(on)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  await $.tool.call({ tool: PROPOSE, tool_use_id: 'tu1', folder: 'app', text: 'Fix the login page', reason: 'Users cannot sign in' } as any)
  const [orderId] = db.ids('orders')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await ($ as any).ui.mount({ ...toolRow(PROPOSE, 'tu1'), surface })
    expect(await ui.find({ type: 'Text', text: /row mcp__agent-station__propose_order/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /waiting for your approval in the station/ })).toBeTruthy()
    await ui.unmount()
  }

  db.change('orders', orderId, { status: 'delivered', deliveredTo: 'local_app', deliveredTitle: 'Login work', deliveredAt: Date.now() })
  await clock.advance(60_000)
  let ui = await ($ as any).ui.mount({ ...toolRow(PROPOSE, 'tu1'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /delivered to «Login work»/ })).toBeTruthy()
  await ui.unmount()

  db.change('orders', orderId, { finishedAt: Date.now() })
  await clock.advance(60_000)
  ui = await ($ as any).ui.mount({ ...toolRow(PROPOSE, 'tu1'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /done; «Login work» finished/ })).toBeTruthy()
  await ui.unmount()

  // Another tool's row, and a proposal this session has no card for, stay as they are.
  for (const [tool, id] of [['Read', 'tu2'], [PROPOSE, 'tu3']]) {
    ui = await ($ as any).ui.mount({ ...toolRow(tool, id), surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Order to/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: new RegExp(`row ${tool}`) })).toBeTruthy()
    await ui.unmount()
  }
  await clock.advance(60_000)
})

test('a rejected proposal says so, and is not read again', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const reads: string[] = []
  stubEngine(on, [], [], [], undefined, 'C:/work/legal')
  stubGit(on)
  registersTools(on)
  drawsRows(on)
  on('tool.call', { tool: 'ArtifactData' }, ($: any, e: any, next: any) => {
    if (e.action === 'get' && e.collection === 'orders') reads.push(e.doc_id)
    return next(e)
  })
  const db = fakeOfficeDatabase(on)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  await $.tool.call({ tool: PROPOSE, tool_use_id: 'tu1', folder: 'app', text: 'Fix it', reason: 'Broken' } as any)
  const [orderId] = db.ids('orders')
  db.change('orders', orderId, { status: 'rejected' })
  await clock.advance(60_000)
  await clock.advance(60_000)
  await clock.advance(60_000)

  const ui = await ($ as any).ui.mount({ ...toolRow(PROPOSE, 'tu1'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Order to .*: rejected/ })).toBeTruthy()
  await ui.unmount()
  expect(reads.filter(id => id === orderId).length).toBe(1)
})

const BAND = {
  plugin: 'agent-station',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } },
} as any

test('the band above the coordination prompt says how many orders wait and opens the pane', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const opened: any[] = []
  stubEngine(on, [])
  stubGit(on)
  registersTools(on)
  on('ui.open' as any, (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'p1', proposal('Fix the login page', 'app', 1))
  db.seed('orders', 'p2', proposal('Translate the notes', 'legal', 2))
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await ($ as any).ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /2 orders wait for your approval/ })).toBeTruthy()
    opened.length = 0
    await ui.press({ key: 'open-orders' })
    expect(opened.some(e => e.id === 'station-orders')).toBe(true)
    await ui.unmount()
  }
  await clock.advance(60_000)
})

test('a room session has no band', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [], [], undefined, 'C:/work/legal')
  stubGit(on)
  registersTools(on)
  const db = fakeOfficeDatabase(on)
  db.seed('orders', 'p1', proposal('Fix the login page', 'app', 1))
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  const ui = await ($ as any).ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /wait for your approval/ })).toBeUndefined()
  await ui.unmount()
  await clock.advance(60_000)
})

// The engine's side of $.store and $.theme, with what the plugin set.
function stubLookEngine(on: any) {
  const seen = { themes: [] as any[], cleared: 0, stored: new Map<string, unknown>() }
  on('store.get' as any, (_$: any, e: any) => ({ value: seen.stored.get(e.key) }))
  on('store.set' as any, (_$: any, e: any) => { seen.stored.set(e.key, e.value); return { value: undefined } })
  on('theme.set' as any, (_$: any, e: any) => { seen.themes.push(e); return { value: { isDrawn: true, requestId: 'r1' } } })
  on('theme.clear' as any, () => { seen.cleared++; return { value: { isDrawn: false, reason: 'cleared' } } })
  return seen
}

test('the station look is off until the user turns it on, and the switch clears it again', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [], [], undefined, 'C:/work/legal')
  stubGit(on)
  registersTools(on)
  fakeOfficeDatabase(on)
  const seen = stubLookEngine(on)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  expect(seen.themes.length).toBe(0)

  const turnedOn: any = await $.command.run({ command: 'station-look', args: '' } as any)
  expect(String(turnedOn.text)).toContain('Station look «Space» on')
  expect(seen.themes[0].colors?.id).toBe('mod-theme')
  expect(seen.themes[0].backdrop?.scene).toBe('space')
  expect(seen.stored.get('look')).toBe('space')

  const turnedOff: any = await $.command.run({ command: 'station-look', args: '' } as any)
  expect(String(turnedOff.text)).toContain('Station look off')
  expect(seen.cleared).toBe(1)
  expect(seen.stored.get('look')).toBe(false)
  await clock.advance(60_000)
})

test('a look is chosen by its name, an unknown one lists the looks, and off turns it off', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [], [], undefined, 'C:/work/legal')
  stubGit(on)
  registersTools(on)
  fakeOfficeDatabase(on)
  const seen = stubLookEngine(on)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)

  const unknown: any = await $.command.run({ command: 'station-look', args: 'jungle' } as any)
  expect(String(unknown.text)).toContain('There is no look «jungle». Looks: Space.')
  expect(seen.themes.length).toBe(0)

  await $.command.run({ command: 'station-look', args: 'Espacial' } as any)
  expect(seen.stored.get('look')).toBe('space')
  // Naming a look while one is on sets it again rather than turning it off.
  await $.command.run({ command: 'station-look', args: 'space' } as any)
  expect(seen.themes.length).toBe(2)
  expect(seen.cleared).toBe(0)

  await $.command.run({ command: 'station-look', args: 'off' } as any)
  expect(seen.cleared).toBe(1)
  // The other language's word turns it off too.
  await $.command.run({ command: 'station-look', args: 'space' } as any)
  await $.command.run({ command: 'station-look', args: 'quitar' } as any)
  expect(seen.cleared).toBe(2)
  await clock.advance(60_000)
})

test('a session starts with the look chosen earlier', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, [], [], [], undefined, 'C:/work/legal')
  stubGit(on)
  registersTools(on)
  fakeOfficeDatabase(on)
  const seen = stubLookEngine(on)
  seen.stored.set('look', 'space')
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  expect(seen.themes.length).toBe(1)
  expect(seen.themes[0].backdrop?.scene).toBe('space')
  await clock.advance(60_000)
})

test('the space look draws its starfield behind the conversation, and leaves another plugin\'s scene', { options }, async ($, on) => {
  on('ui.render', { component: 'Backdrop' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'engine backdrop')
  })
  const backdrop = (plugin: string, scene: string) => ({
    plugin: 'agent-station', component: 'Backdrop', requestId: 'backdrop', surface: 'desktop',
    props: { scene, plugin, glass: { blur: 16, opacity: 0.72 } },
  }) as any
  let ui = await ($ as any).ui.mount(backdrop('agent-station', 'space'))
  const svg = await ui.find({ type: 'Svg' })
  expect(String(svg?.props?.source ?? svg?.source ?? '')).toContain('<svg')
  await ui.unmount()

  ui = await ($ as any).ui.mount(backdrop('someone-else', 'space'))
  expect(await ui.find({ type: 'Text', text: /engine backdrop/ })).toBeTruthy()
  await ui.unmount()
})

test('a proposal the station no longer has says so, and a failed read settles nothing', { options }, async ($, on) => {
  const clock = mock.clock(on)
  let isFailing = false
  stubEngine(on, [], [], [], undefined, 'C:/work/legal')
  stubGit(on)
  registersTools(on)
  drawsRows(on)
  const db = fakeOfficeDatabase(on, () => false, e => isFailing && e.action === 'get' && e.collection === 'orders' ? 'db read failed: not found (network error)' : undefined)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10_000)
  await $.tool.call({ tool: PROPOSE, tool_use_id: 'tu1', folder: 'app', text: 'Fix it', reason: 'Broken' } as any)
  const [orderId] = db.ids('orders')

  isFailing = true
  await clock.advance(60_000)
  let ui = await ($ as any).ui.mount({ ...toolRow(PROPOSE, 'tu1'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /waiting for your approval/ })).toBeTruthy()
  await ui.unmount()

  isFailing = false
  db.remove('orders', orderId)
  await clock.advance(60_000)
  ui = await ($ as any).ui.mount({ ...toolRow(PROPOSE, 'tu1'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /no longer in the station/ })).toBeTruthy()
  await ui.unmount()
})
