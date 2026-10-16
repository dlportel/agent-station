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
  ],
}
const REMOTES: Record<string, string> = {
  'C:/work/app': 'https://github.com/acme/app-repo.git',
  'C:/work/coord': 'https://github.com/acme/coord.git',
  'C:/work/legal': 'https://github.com/acme/legal.git',
  'C:/work/other': 'https://github.com/someone/else.git',
}

type Doc = { data: Record<string, any>; version: number }

function fakeOfficeDatabase(on: any) {
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
function stubGit(on: any, gh?: (argv: string[]) => any) {
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    const path = String(argv[2] ?? '').replace(/\\/g, '/')
    if (argv[0] === 'git' && argv[3] === 'rev-parse') return { value: REMOTES[path] ? { exitCode: 0, stdout: path + '\n' } : { exitCode: 128, stdout: '' } }
    if (argv[0] === 'git' && argv[3] === 'remote') return { value: REMOTES[path] ? { exitCode: 0, stdout: REMOTES[path] + '\n' } : { exitCode: 128, stdout: '' } }
    if (argv[0] === 'gh' && gh) return { value: gh(argv) }
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
  mock.env(on, { COMPUTERNAME: 'TESTPC' })
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
