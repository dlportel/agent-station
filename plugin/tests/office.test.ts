import { test, expect, mock } from 'claude-code/testing'
import { isBranchName, isDirectSessionMessage, issueRepoOf, stationFromConfig, stationMap } from '../hooks/station'

const OFFICE = 'https://claude.ai/artifact/test-station'
const options = { stations: OFFICE }
const STATION = {
  title: 'TEST STATION',
  coordination: 'coord',
  repos: [
    { remote: 'https://github.com/acme/app-repo.git', folder: 'app' },
    { remote: 'github.com/acme/coord', folder: 'coord' },
    { remote: 'github.com/acme/legal' },
    { remote: 'gitlab.com/group/*' },
  ],
  departments: {
    app: { name: 'App', description: 'Builds the mobile app' },
    legal: { name: 'Legal', description: 'Drafts legal texts' },
    coord: { name: 'Coordination' },
  },
}
const REMOTES: Record<string, string> = {
  'C:/work/app': 'https://github.com/acme/app-repo.git',
  'C:/work/coord': 'git@github.com:acme/coord.git',
  'C:/work/legal': 'https://github.com/acme/legal',
  'C:/work/shop': 'https://gitlab.com/group/shop.git',
  'C:/work/other': 'https://github.com/someone/else.git',
}

// The station answers config/departments; every other call goes to `handle`.
function stubStation(on: any, handle: (e: any) => any = () => ({ result: { text: 'The document is now at version 1.' } })) {
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    if (e.action === 'get' && e.collection === 'config' && e.doc_id === 'departments') {
      return { result: { text: `1 document\n${JSON.stringify({ id: 'departments', data: STATION, version: 1 })}` } } as any
    }
    return handle(e)
  })
}

function stubSession(on: any, id: string, cwd = 'C:/work/legal', env: Record<string, string> = { COMPUTERNAME: 'TESTPC' }, statuses: Array<string | undefined> = []) {
  mock.env(on, env)
  on('session.cwd' as any, () => ({ value: cwd }))
  on('session.id' as any, () => ({ value: id }))
  on('ui.status' as any, (_$: any, e: any) => { statuses.push(e?.text); return { value: null } })
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    const remote = argv[0] === 'git' && argv[3] === 'remote' ? REMOTES[argv[2]] : undefined
    return { value: remote ? { exitCode: 0, stdout: remote + '\n' } : { exitCode: 128, stdout: '' } }
  })
}

test('reports the session to the station without blocking the tool', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-1', 'C:/work/app')
  const officeCalls: any[] = []
  stubStation(on, e => {
    officeCalls.push(e)
    return { result: { text: `The document is now at version ${officeCalls.length}.` } }
  })

  const read: any = await $.tool.call({ tool: 'Read', file_path: 'C:\\x.md' } as any)
  expect(JSON.stringify(read)).toContain('ok')

  await clock.advance(30_000)

  const first = officeCalls.find(c => c.collection === 'sessions')
  expect(first.url).toBe(OFFICE)
  expect(first.action).toBe('set')
  expect(first.data.state).toBe('working')
  expect(first.data.folder).toBe('app')
})

test('the detail of a tool call names the file, never its folder, and leaves the arguments out of commands', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-detail', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.action === 'set') written.push(e.data)
    return { result: { text: `The document is now at version ${written.length}.` } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { text: 'ok' } }) as any)

  await $.tool.call({ tool: 'Read', file_path: 'C:/work/app/docs/x.md' } as any)
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Read', file_path: 'C:/work/app/docs/notes.md' } as any)
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'git -C C:/work/app push https://example.test/private-path/repo.git' } as any)
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'rsync -a C:/work/app/build/ backup.example.test:/var/www/site' } as any)
  await clock.advance(30_000)

  const details = written.map(d => d.detail).filter(Boolean)
  expect(details).toEqual(['notes.md', 'git push', 'rsync'])
  expect(JSON.stringify(written)).not.toContain('docs')
  expect(JSON.stringify(written)).not.toContain('private-path')
  expect(JSON.stringify(written)).not.toContain('var/www')
})

test('the department comes from the origin remote, by exact repo or by a /* pattern', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-remote', 'C:/work/shop')
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(writes.find(w => w.collection === 'sessions')?.data?.folder).toBe('shop')
})

test('a session whose repo is not one of the station\'s repos is never reported', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-outside', 'C:/work/other')
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } }
  })

  for (let i = 0; i < 3; i++) {
    await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
    await clock.advance(30_000)
  }

  expect(writes.length).toBe(0)
})

test('a folder that is not a git repo is ignored without asking the station', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-nogit', 'C:/scratch')
  const calls: any[] = []
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    calls.push(e)
    return { result: { text: 'The document is now at version 1.' } } as any
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(calls.length).toBe(0)
})

test('a failing station never breaks the tool call', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-down', 'C:/work/app')
  on('tool.call', { tool: 'ArtifactData' }, () => { throw new Error('station down') })

  for (let i = 0; i < 5; i++) {
    const read: any = await $.tool.call({ tool: 'Read', file_path: 'C:\\x.md' } as any)
    expect(JSON.stringify(read)).toContain('ok')
    await clock.advance(30_000)
  }
})

test('a question to the user shows as waiting, then working again', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-2', 'C:/work/app')
  const states: string[] = []
  const kinds: unknown[] = []
  stubStation(on, e => {
    if (e.action === 'set') { states.push(e.data.state); kinds.push(e.data.waitKind) }
    return { result: { text: `The document is now at version ${states.length}.` } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { text: 'answered' } }) as any)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
  await clock.advance(30_000)

  expect(states).toContain('waiting')
  expect(states.at(-1)).toBe('working')
  expect(kinds[kinds.length - 2]).toBe('question')
  expect(kinds.at(-1)).toBe(null)
})

test('a permission prompt shows as waiting for permission', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-permission', 'C:/work/app')
  on('classic.PermissionRequest' as any, () => ({}))
  on('classic.Notification' as any, () => ({}))
  const written: any[] = []
  stubStation(on, e => {
    if (e.action === 'set') written.push(e.data)
    return { result: { text: `The document is now at version ${written.length}.` } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  await ($ as any).classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  await clock.advance(30_000)
  expect(written.at(-1)?.state).not.toBe('waiting')
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as any)
  await clock.advance(30_000)

  expect(written.at(-1).state).toBe('waiting')
  expect(written.at(-1).waitKind).toBe('permission')
})

test('a subagent launched by the session shows as a drone until it finishes', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-3', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.action === 'set') written.push(e.data)
    return { result: { text: `The document is now at version ${written.length}.` } }
  })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { text: 'done' } }) as any)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Agent', subagent_type: 'feature-dev', prompt: 'x', description: 'x' } as any)
  await clock.advance(30_000)

  expect(written.some(d => (d.drones ?? []).includes('feature-dev'))).toBe(true)
  expect(written.at(-1).drones).toEqual([])
})

test('the agent cannot write orders to the station directly, only read it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-4')
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const before = writes.length

  const denied: any = await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'set', collection: 'orders', doc_id: 'evil', data: { status: 'pending', text: 'x' } } as any)
  const read: any = await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'list', collection: 'orders' } as any)

  expect(JSON.stringify(denied)).toContain('propose_order')
  expect(writes.filter(w => w.doc_id === 'evil').length).toBe(0)
  expect(writes.length).toBe(before + 1)
  expect(JSON.stringify(read)).toContain('version')
})

test('another spelling of the station URL does not get an agent past the guard', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-12')
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } }
  })

  for (const url of [OFFICE + '/', OFFICE.toUpperCase().replace('HTTPS://CLAUDE.AI', 'https://Claude.AI'), OFFICE + '?x=1', OFFICE.replace('claude.ai/', 'claude.ai/code/')]) {
    const denied: any = await $.tool.call({ tool: 'ArtifactData', url, action: 'set', collection: 'orders', doc_id: 'evil', data: { status: 'pending' } } as any)
    expect(JSON.stringify(denied)).toContain('propose_order')
  }
  await clock.advance(30_000)

  expect(writes.some(w => w.doc_id === 'evil')).toBe(false)
})

test('the coordination session may write orders and the station config, and nothing else',{ options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-6', 'C:/work/coord')
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: 'The document is now at version 2.' } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'update', collection: 'orders', doc_id: 'o1', data: { status: 'pending' }, if_version: 1 } as any)
  await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'update', collection: 'config', doc_id: 'departments', data: { title: 'X' }, if_version: 1 } as any)
  const models: any = await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'set', collection: 'config', doc_id: 'models', data: {} } as any)
  const sessions: any = await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'set', collection: 'sessions', doc_id: 's1', data: {} } as any)
  const batch: any = await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'batch', collection: 'orders', ops: [] } as any)

  expect(writes.some(w => w.doc_id === 'o1' && w.collection === 'orders')).toBe(true)
  expect(writes.some(w => w.doc_id === 'departments' && w.action === 'update')).toBe(true)
  expect(JSON.stringify(models)).toContain('propose_order')
  expect(JSON.stringify(sessions)).toContain('propose_order')
  expect(JSON.stringify(batch)).toContain('propose_order')
  expect(writes.some(w => w.doc_id === 'models' || w.doc_id === 's1' || w.action === 'batch')).toBe(false)
})

// Two stations: OFFICE as above, OTHER with only the shop group and its own coordination.
const OTHER = 'https://claude.ai/artifact/other-station'
const OTHER_STATION = { title: 'OTRA', coordination: 'legal', repos: [{ remote: 'github.com/acme/legal' }], aliases: ['https://claude.ai/code/artifact/0b2c-uuid-other'] }
function stubTwoStations(on: any, writes: any[]) {
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    if (e.action === 'get' && e.collection === 'config' && e.doc_id === 'departments') {
      const data = e.url === OTHER ? OTHER_STATION : { ...STATION, repos: STATION.repos.filter(r => !r.remote.includes('legal')) }
      return { result: { text: `1 document\n${JSON.stringify({ id: 'departments', data, version: 1 })}` } } as any
    }
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } } as any
  })
}

test('with several stations, a session reports only to the one that lists its repo', { options: { stations: `${OFFICE};${OTHER}` } }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-15', 'C:/work/legal')
  const writes: any[] = []
  stubTwoStations(on, writes)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  const reports = writes.filter(w => w.collection === 'sessions')
  expect(reports.length).toBeGreaterThan(0)
  expect(reports.every(w => w.url === OTHER)).toBe(true)
  expect(reports[0].data.folder).toBe('legal')
})

test('the coordination of one station cannot write another station, nor its alias', { options: { stations: `${OFFICE};${OTHER}` } }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-16', 'C:/work/coord')
  const writes: any[] = []
  stubTwoStations(on, writes)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'update', collection: 'orders', doc_id: 'mine', data: { status: 'pending' }, if_version: 1 } as any)
  const other: any = await $.tool.call({ tool: 'ArtifactData', url: OTHER, action: 'update', collection: 'orders', doc_id: 'theirs', data: { status: 'pending' }, if_version: 1 } as any)
  const alias: any = await $.tool.call({ tool: 'ArtifactData', url: OTHER_STATION.aliases[0], action: 'set', collection: 'config', doc_id: 'departments', data: {} } as any)

  expect(writes.some(w => w.doc_id === 'mine')).toBe(true)
  expect(JSON.stringify(other)).toContain('propose_order')
  expect(JSON.stringify(alias)).toContain('propose_order')
  expect(writes.some(w => w.doc_id === 'theirs' || (w.url === OTHER_STATION.aliases[0]))).toBe(false)
})

test('with config/departments missing, other repos stay outside the station', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-14', 'C:/work/app')
  const writes: any[] = []
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    writes.push(e)
    if (e.action === 'get') return { result: { text: 'No document "departments" in collection "config".' } } as any
    return { result: { text: 'The document is now at version 1.' } } as any
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(writes.some(w => w.collection === 'sessions')).toBe(false)
})

test('outside the coordination department the station config stays read-only',{ options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-11', 'C:/work/app')
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: 'The document is now at version 2.' } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  const denied: any = await $.tool.call({ tool: 'ArtifactData', url: OFFICE, action: 'update', collection: 'config', doc_id: 'departments', data: { title: 'X' }, if_version: 1 } as any)

  expect(JSON.stringify(denied)).toContain('propose_order')
  expect(writes.some(w => w.doc_id === 'departments' && w.action === 'update')).toBe(false)
})

test('propose_order is registered visible, and retried when the first attempt fails', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-7', 'C:/work/app')
  stubStation(on)
  const attempts: any[] = []
  on('tool.register' as any, (_$: any, e: any) => {
    attempts.push(e)
    if (attempts.length === 1) throw new Error('session not bound yet')
    return { value: { tool: 'mcp__agent-station__propose_order' } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(1_000)

  expect(attempts.length).toBe(2)
  expect(JSON.stringify(attempts[1])).toContain('propose_order')
  expect(JSON.stringify(attempts[1])).toContain('"isDeferred":false')
})

test('outside the station, propose_order is not registered', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-noreg', 'C:/work/other')
  stubStation(on)
  const attempts: any[] = []
  on('tool.register' as any, (_$: any, e: any) => {
    attempts.push(e)
    return { value: { tool: 'mcp__agent-station__propose_order' } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(1_000)

  expect(attempts.length).toBe(0)
})

test('/coordinator sends the message to the coordination session of this machine', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-8', 'C:/work/app')
  on('command.register' as any, () => ({ value: undefined }))
  const line = (id: string, data: any) => JSON.stringify({ id, data, version: 1 })
  stubStation(on, e => {
    if (e.action === 'query' && e.collection === 'sessions') return { result: { text: [
      '3 documents',
      line('local_coord_old', { folder: 'coord', machine: 'TESTPC', state: 'ended', lastEventAt: 3, title: 'Old' }),
      line('local_coord', { folder: 'coord', machine: 'TESTPC', state: 'idle', lastEventAt: 2, title: 'Coordinator' }),
      line('local_coord_other', { folder: 'coord', machine: 'OTHERPC', state: 'idle', lastEventAt: 4, title: 'Elsewhere' }),
    ].join('\n') } }
    return { result: { text: 'The document is now at version 1.' } }
  })
  const sent: any[] = []
  on('mcp.call' as any, (_$: any, e: any) => {
    const text = (t: string) => ({ value: { content: [{ type: 'text', text: t }] } })
    if (e.tool === 'send_message') { sent.push(e.args); return text('delivered (delivery: delivered; message_id: m1)') }
    return text('')
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  const empty: any = await $.command.run({ command: 'coordinator', args: '' } as any)
  const done: any = await $.command.run({ command: 'coordinator', args: 'this session does not see propose_order' } as any)

  expect(String(empty.text)).toContain('/coordinator')
  expect(sent.length).toBe(1)
  expect(sent[0].session_id).toBe('local_coord')
  expect(sent[0].message).toContain('this session does not see propose_order')
  expect(String(done.text)).toContain('Coordinator')
})

test('without a station URL the mod stays silent', async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-9', 'C:/work/app')
  const calls: any[] = []
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    calls.push(e)
    return { result: { text: 'The document is now at version 1.' } } as any
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(calls.length).toBe(0)
})

test('without options from the app, the stations come from the user settings', async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-17', 'C:/work/app', { COMPUTERNAME: 'TESTPC', USERPROFILE: 'C:\\Users\\tester' })
  on('fs.read' as any, (_$: any, e: any) => {
    const path = String(e.path ?? e)
    if (path.toLowerCase().endsWith('\\.claude\\settings.json')) return { value: JSON.stringify({ pluginConfigs: { 'agent-station@some-marketplace': { options: { stations: OFFICE } } } }) }
    throw new Error('no such file')
  })
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(writes.find(w => w.collection === 'sessions')?.url).toBe(OFFICE)
})

test('each session reports the engine version it runs',{ options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-10', 'C:/work/app')
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(writes.find(w => w.collection === 'sessions')?.data?.modVersion).toMatch(/^\d+\.\d+\.\d+$/)
})

test('propose_order stores the order as proposed, never pending', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-5')
  on('tool.register' as any, () => ({ value: { tool: 'mcp__agent-station__propose_order' } }))
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: `The document is now at version ${writes.length}.` } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  const reply: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'Review issue 1', reason: 'Handoff A-8' } as any)
  await clock.advance(1_000)

  const order = writes.find(w => w.collection === 'orders' && w.action === 'set')
  expect(order?.data?.status).toBe('proposed')
  expect(order?.data?.folder).toBe('app')
  expect(order?.data?.proposedBy?.sessionId).toBe('test-session-5')
  expect(JSON.stringify(reply)).toContain('approves')
})

test('propose_order sends a reply back to the session whose order this session received', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-6')
  on('tool.register' as any, () => ({ value: { tool: 'mcp__agent-station__propose_order' } }))
  const sessions: Record<string, any> = {
    local_asker: { folder: 'app', machine: 'PC2', state: 'working', title: 'Last modified column' },
    local_old: { folder: 'app', machine: 'TESTPC', state: 'idle', title: 'Other' },
    local_ended: { folder: 'app', machine: 'TESTPC', state: 'ended', title: 'Closed' },
  }
  const received = [
    { id: 'o_old', data: { deliveredTo: 'test-session-6', deliveredAt: 1, proposedBy: { sessionId: 'local_old', folder: 'app' } }, version: 1 },
    { id: 'o_new', data: { deliveredTo: 'test-session-6', deliveredAt: 2, proposedBy: { sessionId: 'local_asker', folder: 'app' } }, version: 1 },
    { id: 'o_legal', data: { deliveredTo: 'test-session-6', deliveredAt: 3, proposedBy: { sessionId: 'local_legal', folder: 'legal' } }, version: 1 },
  ]
  const writes: any[] = []
  stubStation(on, e => {
    if (e.action === 'query' && e.collection === 'orders') return { result: { text: `${received.length} documents\n${received.map(d => JSON.stringify(d)).join('\n')}` } }
    if (e.action === 'get' && e.collection === 'sessions') {
      const data = sessions[e.doc_id]
      return { result: { text: data ? `1 document\n${JSON.stringify({ id: e.doc_id, data, version: 1 })}` : 'No documents matched' } }
    }
    writes.push(e)
    return { result: { text: `The document is now at version ${writes.length}.` } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  const reply: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'It is done', reason: 'Reply' } as any)
  await clock.advance(1_000)
  const order = writes.filter(w => w.collection === 'orders').pop()
  expect(order?.data?.sessionId).toBe('local_asker')
  expect(order?.data?.machine).toBe('PC2')
  expect(order?.data?.replyTo?.title).toBe('Last modified column')
  expect(JSON.stringify(reply)).toContain('Last modified column')

  await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'Something else', reason: 'New', mode: 'new' } as any)
  await clock.advance(1_000)
  expect(writes.filter(w => w.collection === 'orders').pop()?.data?.sessionId).toBeNull()

  await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'For you', reason: 'Chosen', session_id: 'local_old' } as any)
  await clock.advance(1_000)
  expect(writes.filter(w => w.collection === 'orders').pop()?.data?.sessionId).toBe('local_old')

  const count = writes.filter(w => w.collection === 'orders').length
  const ended: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'For you', reason: 'Closed', session_id: 'local_ended' } as any)
  const wrong: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'legal', text: 'For you', reason: 'Other room', session_id: 'local_old' } as any)
  await clock.advance(1_000)
  expect(JSON.stringify(ended)).toContain('has ended')
  expect(JSON.stringify(wrong)).toContain('no session')
  expect(writes.filter(w => w.collection === 'orders').length).toBe(count)

  // The asker is gone: the reply goes to the room, says whom it answered, and the agent is told.
  sessions.local_asker = { ...sessions.local_asker, state: 'ended' }
  const orphan: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'It is done', reason: 'Reply' } as any)
  await clock.advance(1_000)
  const last = writes.filter(w => w.collection === 'orders').pop()
  expect(last?.data?.sessionId).toBeNull()
  expect(last?.data?.replyTo).toBeNull()
  expect(last?.data?.replyGone).toEqual({ sessionId: 'local_asker', title: 'Last modified column' })
  expect(JSON.stringify(orphan)).toContain('which no longer exists')
})

test('propose_order with no order received from that department lets the station choose', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-7')
  on('tool.register' as any, () => ({ value: { tool: 'mcp__agent-station__propose_order' } }))
  const writes: any[] = []
  stubStation(on, e => {
    if (e.action === 'query' && e.collection === 'orders') return { result: { text: 'No documents matched' } }
    writes.push(e)
    return { result: { text: `The document is now at version ${writes.length}.` } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'Review', reason: 'Handoff' } as any)
  await clock.advance(1_000)
  const order = writes.find(w => w.collection === 'orders')
  expect(order?.data?.sessionId).toBeNull()
  expect(order?.data?.replyTo).toBeNull()
})

test('a station that answers late still gets the session reported, and its dispatcher started', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-late', 'C:/work/app')
  let configReads = 0
  const writes: any[] = []
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    if (e.action === 'get' && e.collection === 'config' && e.doc_id === 'departments') {
      configReads++
      if (configReads === 1) throw new Error('station timed out')
      return { result: { text: `1 document\n${JSON.stringify({ id: 'departments', data: STATION, version: 1 })}` } } as any
    }
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } } as any
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(configReads).toBeGreaterThan(1)
  expect(writes.find(w => w.collection === 'sessions')?.data?.folder).toBe('app')
})

test('a station that never answers is not asked again on every tool call', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-down2', 'C:/work/other')
  let configReads = 0
  on('tool.call', { tool: 'ArtifactData' }, () => { configReads++; throw new Error('station down') })

  for (let i = 0; i < 6; i++) {
    await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
    await clock.advance(1_000)
  }

  expect(configReads).toBeLessThanOrEqual(2)
})

test('a station that does not exist or cannot be read is asked only once', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-gone', 'C:/work/app')
  let configReads = 0
  on('tool.call', { tool: 'ArtifactData' }, () => {
    configReads++
    return { result: { text: 'db read failed (invalid_argument): no such artifact, collection, or document (or no access)' } } as any
  })

  for (let i = 0; i < 4; i++) {
    await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
    await clock.advance(1_000)
  }

  expect(configReads).toBe(1)
})

test('while the first station has not answered, a later one that lists the repo does not take the session', { options: { stations: `${OTHER};${OFFICE}` } }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-order', 'C:/work/app')
  const writes: any[] = []
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    if (e.action === 'get' && e.collection === 'config') {
      if (e.url === OTHER) throw new Error('first station timed out')
      return { result: { text: `1 document\n${JSON.stringify({ id: 'departments', data: STATION, version: 1 })}` } } as any
    }
    writes.push(e)
    return { result: { text: 'The document is now at version 1.' } } as any
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(writes.some(w => w.collection === 'sessions')).toBe(false)
})

test('a report that fails once is sent again without waiting for the next event', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-retry', 'C:/work/app')
  let sessionWrites = 0
  const states: string[] = []
  stubStation(on, e => {
    if (e.collection !== 'sessions') return { result: { text: 'The document is now at version 1.' } }
    sessionWrites++
    if (sessionWrites === 2) throw new Error('write timed out')
    states.push(e.data.state)
    return { result: { text: `The document is now at version ${sessionWrites}.` } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { text: 'answered' } }) as any)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(1_000)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
  await clock.advance(60_000)

  expect(sessionWrites).toBeGreaterThan(2)
  expect(states.at(-1)).toBe('working')
})

test('a station that stays down is retried less often, shows its error, and the session recovers by itself', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const statuses: Array<string | undefined> = []
  stubSession(on, 'test-session-offline', 'C:/work/app', { COMPUTERNAME: 'TESTPC', USERPROFILE: 'C:\\Users\\tester' }, statuses)
  let log = ''
  on('fs.read' as any, (_$: any, e: any) => {
    if (String(e.path).includes('\\.claude\\agent-station-logs\\') && log) return { value: log }
    throw new Error('no such file')
  })
  on('fs.write' as any, (_$: any, e: any) => {
    if (String(e.path).includes('\\.claude\\agent-station-logs\\')) log = e.text
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { text: 'answered' } }) as any)
  let isDown = true
  const writeTimes: number[] = []
  stubStation(on, e => {
    if (e.collection !== 'sessions') return { result: { text: 'The document is now at version 1.' } }
    writeTimes.push(clock.now())
    if (isDown) return { result: { text: 'db write failed (network error)' } }
    return { result: { text: `The document is now at version ${writeTimes.length}.` } }
  })

  // Three failed writes, 20 s apart, and the status line says why.
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(45_000)
  expect(writeTimes.length).toBe(3)
  expect(statuses.at(-1)).toBe('station: no connection (db write failed (network error))')

  // Offline, an urgent event does not write at once: the next try waits 30 s.
  await clock.advance(10_000)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
  await clock.advance(1_000)
  expect(writeTimes.length).toBe(3)
  await clock.advance(25_000)
  expect(writeTimes.length).toBe(4)
  // Then 1 min, 2 min and every 5 min: a dozen tries in half an hour, no more.
  await clock.advance(30 * 60_000)
  const gapsInSeconds = writeTimes.slice(3).map((t, i) => Math.round((t - writeTimes[i + 2]) / 1000))
  expect(gapsInSeconds.slice(0, 4)).toEqual([30, 60, 120, 300])
  expect(writeTimes.length).toBeLessThan(15)

  // The station comes back: the next try goes through and clears the status.
  isDown = false
  await clock.advance(5 * 60_000)
  expect(statuses.at(-1)).toBeUndefined()
  const sentBefore = writeTimes.length
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
  await clock.advance(1_000)
  expect(writeTimes.length).toBeGreaterThan(sentBefore)

  // Every failure and the reconnection are in the log, one line each.
  const lines = log.trim().split('\n')
  // The join comes first; then the failures and the reconnection.
  expect(lines[0]).toContain('action=join cwd C:/work/app; remote https://github.com/acme/app-repo.git')
  expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\dT\S+ session=test-session-offline folder=app action=set failure 1: db write failed \(network error\)$/)
  expect(lines.at(-1)).toContain('reconnected after')
})

test('the station log keeps only its last lines', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-log', 'C:/work/app', { COMPUTERNAME: 'TESTPC', USERPROFILE: 'C:\\Users\\tester' })
  let log = Array.from({ length: 250 }, (_, i) => `old line ${i}`).join('\n') + '\n'
  on('fs.read' as any, (_$: any, e: any) => {
    if (String(e.path).includes('\\.claude\\agent-station-logs\\')) return { value: log }
    throw new Error('no such file')
  })
  on('fs.write' as any, (_$: any, e: any) => { log = e.text; return { value: undefined } })
  stubStation(on, e => {
    if (e.collection !== 'sessions') return { result: { text: 'The document is now at version 1.' } }
    throw new Error('station timed out')
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  const lines = log.trim().split('\n')
  expect(lines.length).toBe(200)
  // Two lines were added (the join and the failure), so the two oldest left past the last 200.
  expect(lines[0]).toBe('old line 52')
  expect(lines.at(-2)).toContain('action=join')
  expect(lines.at(-1)).toContain('session=test-session-log folder=app action=set failure 1:')
})

test('a session reloaded mid-life takes its existing document over instead of going quiet', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-reloaded', 'C:/work/app')
  let version = 7
  const writes: any[] = []
  stubStation(on, e => {
    if (e.collection !== 'sessions') return { result: { text: 'The document is now at version 1.' } }
    if (e.action === 'get') return { result: { text: `1 document\n${JSON.stringify({ id: e.doc_id, data: {}, version })}` } }
    if (e.if_version === undefined) return { result: { text: `db write failed (version_mismatch): sessions/${e.doc_id} already exists and this write carried no if_version — nothing was written.` } }
    writes.push(e)
    version++
    return { result: { text: `The document is now at version ${version}.` } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  expect(writes.length).toBeGreaterThan(0)
  expect(writes[0].if_version).toBe(7)
})

test('an agent may not republish or delete a station page; another page is fine', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-page', 'C:/work/app')
  stubStation(on)
  const published: any[] = []
  on('tool.call', { tool: 'Artifact' }, (_$: any, e: any) => { published.push(e); return { result: { text: 'Published' } } as any })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  const publish: any = await $.tool.call({ tool: 'Artifact', url: OFFICE, file_path: 'C:/evil.html' } as any)
  const remove: any = await $.tool.call({ tool: 'Artifact', action: 'delete', url: OFFICE + '/' } as any)
  await $.tool.call({ tool: 'Artifact', url: 'https://claude.ai/artifact/somebody-elses-page', file_path: 'C:/page.html' } as any)

  expect(JSON.stringify(publish)).toContain('station page')
  expect(JSON.stringify(remove)).toContain('station page')
  expect(published.map(p => p.url)).toEqual(['https://claude.ai/artifact/somebody-elses-page'])
})

test('the coordination session may republish its own station page', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-coordpage', 'C:/work/coord')
  stubStation(on)
  const published: any[] = []
  on('tool.call', { tool: 'Artifact' }, (_$: any, e: any) => { published.push(e); return { result: { text: 'Published' } } as any })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  await $.tool.call({ tool: 'Artifact', url: OFFICE, file_path: 'C:/office.html' } as any)

  expect(published.length).toBe(1)
})
test('the first message of a session carries the map of its station, and again after /clear', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-map', 'C:/work/app')
  stubStation(on)
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))
  on('session.end' as any, (_$: any, e: any) => ({ sessionId: e.sessionId }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const first: any = await ($ as any).prompt.submit({ text: 'hello' })
  const second: any = await ($ as any).prompt.submit({ text: 'go on' })
  await ($ as any).session.end({ reason: 'clear', sessionId: 'test-session-map' })
  const afterClear: any = await ($ as any).prompt.submit({ text: 'again' })

  const map = String((first.context ?? []).join('\n'))
  expect(map).toContain('`app` (this session) | App | Builds the mobile app')
  expect(map).toContain('| `legal` | Legal | Drafts legal texts |')
  expect(map).not.toContain('Subagents')
  expect(map).toContain('is for the room that takes it to decide')
  expect(map).not.toContain('only in its repo')
  expect(map).toContain('gitlab.com/group/*')
  expect(map).toContain('propose_order')
  expect(map).toContain('returns the result of an order you received from another room')
  expect(map).toContain('no go-between for the rooms')
  expect(map).not.toContain('which session to answer')
  expect(map).not.toContain('| `coord`')
  expect(second.context ?? []).toEqual([])
  expect(String((afterClear.context ?? []).join('\n'))).toContain('# Agent station')
})

test('a session outside every station gets no map', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-nomap', 'C:/work/other')
  stubStation(on)
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const result: any = await ($ as any).prompt.submit({ text: 'hello' })

  expect(result.context ?? []).toEqual([])
})

// A station with its repos listed one by one, no group pattern.
const LISTED_STATION = { ...STATION, repos: STATION.repos.filter(r => !r.remote.endsWith('/*')) }
function stubListedStation(on: any, writes: any[]) {
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    if (e.action === 'get' && e.collection === 'config' && e.doc_id === 'departments') {
      return { result: { text: `1 document${String.fromCharCode(10)}${JSON.stringify({ id: 'departments', data: LISTED_STATION, version: 1 })}` } } as any
    }
    writes.push(e)
    return { result: { text: `The document is now at version ${writes.length}.` } } as any
  })
}

test('propose_order names the station rooms and refuses one that does not exist', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-rooms', 'C:/work/app')
  const registered: any[] = []
  on('tool.register' as any, (_$: any, e: any) => { registered.push(e); return { value: { tool: 'mcp__agent-station__propose_order' } } })
  const writes: any[] = []
  stubListedStation(on, writes)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const refused: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'backend', text: 'Do something', reason: 'Test' } as any)
  const accepted: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'legal', text: 'Review the text', reason: 'Test' } as any)
  await clock.advance(1_000)

  const spec = registered.find(r => String(r.name ?? r.spec?.name ?? '').includes('propose_order')) ?? registered[0]
  expect(JSON.stringify(spec)).toContain('Rooms of this station, by folder: `app` (App), `legal` (Legal)')
  expect(JSON.stringify(spec)).toContain('This session is in the room `app`')
  expect(JSON.stringify(spec)).toContain('to return the result of an order this session received')
  expect(JSON.stringify(spec)).not.toContain('which session to answer')
  expect(JSON.stringify(refused)).toContain('this station has no room with the folder')
  expect(JSON.stringify(refused)).toContain('`legal` (Legal)')
  expect(JSON.stringify(accepted)).toContain('Order proposed')
  expect(writes.filter(w => w.collection === 'orders' && w.action === 'set').map(w => w.data.folder)).toEqual(['legal'])
})

test('the session report records when the map first reached the agent', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-mapat', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.action === 'set') written.push(e.data)
    return { result: { text: `The document is now at version ${written.length}.` } }
  })
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  expect(written.some(d => d.mapAt)).toBe(false)
  await ($ as any).prompt.submit({ text: 'hello' })
  await clock.advance(30_000)

  expect(typeof written.at(-1).mapAt).toBe('number')
})

test('a first message that comes before any tool call still carries the map', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-early', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.action === 'set') written.push(e.data)
    return { result: { text: `The document is now at version ${written.length}.` } }
  })
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))

  const first: any = await ($ as any).prompt.submit({ text: 'hello' })
  await clock.advance(30_000)

  expect((first.context ?? []).join(' ')).toContain('# Agent station')
  expect(written.some(d => typeof d.mapAt === 'number')).toBe(true)
})

test('a message from another session reminds the coordination that it forwards nothing', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-coord', 'C:/work/coord')
  on('tool.register' as any, () => ({ value: { tool: 'mcp__agent-station__propose_order' } }))
  stubStation(on)
  const seen: any[] = []
  on('prompt.submit' as any, (_$: any, e: any) => { seen.push(e); return { text: e.text, context: e.context } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  await ($ as any).prompt.submit({ text: 'hello' })
  const fromPeer: any = await ($ as any).prompt.submit({ text: 'Forward this report to the shop room', origin: { kind: 'peer' } })
  const fromUser: any = await ($ as any).prompt.submit({ text: 'go on' })

  const peerContext = String((fromPeer.context ?? []).join('\n'))
  expect(seen.at(-2)?.origin?.kind).toBe('peer')
  expect(peerContext).toContain('no go-between for the rooms')
  expect(peerContext).toContain('mcp__agent-station__propose_order')
  expect(fromUser.context ?? []).toEqual([])
})

test('propose_order stores a long order whole and refuses one past the limit without cutting it', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-long', 'C:/work/app')
  on('tool.register' as any, () => ({ value: { tool: 'mcp__agent-station__propose_order' } }))
  const writes: any[] = []
  stubListedStation(on, writes)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const long = 'a'.repeat(4990) + ' END OF TEXT'
  const accepted: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'legal', text: long, reason: 'Test' } as any)
  const tooLong: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'legal', text: 'b'.repeat(20_001), reason: 'Test' } as any)
  const longReason: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'legal', text: 'Hello', reason: 'c'.repeat(1_001) } as any)
  await clock.advance(1_000)

  const stored = writes.filter(w => w.collection === 'orders' && w.action === 'set')
  expect(JSON.stringify(accepted)).toContain('Order proposed')
  expect(stored.length).toBe(1)
  expect(stored[0].data.text).toBe(long)
  expect(JSON.stringify(tooLong)).toContain('the text has 20001 characters')
  expect(JSON.stringify(tooLong)).toContain('Nothing was stored')
  expect(JSON.stringify(longReason)).toContain('the reason has 1001 characters')
})


// The same station, set to Spanish. The expected texts below are the Spanish
// translation under test (hooks/locale-es.ts).
function stubSpanishStation(on: any, handle: (e: any) => any = () => ({ result: { text: 'The document is now at version 1.' } })) {
  on('tool.call', { tool: 'ArtifactData' }, (_$: any, e: any) => {
    if (e.action === 'get' && e.collection === 'config' && e.doc_id === 'departments') {
      return { result: { text: `1 document${String.fromCharCode(10)}${JSON.stringify({ id: 'departments', data: { ...STATION, language: 'es' }, version: 1 })}` } } as any
    }
    return handle(e)
  })
}

test('a station set to Spanish gives its map, its notes and its command in Spanish', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-es', 'C:/work/coord')
  const commands: any[] = []
  on('command.register' as any, (_$: any, e: any) => { commands.push(e); return { value: undefined } })
  on('tool.register' as any, () => ({ value: { tool: 'mcp__agent-station__propose_order' } }))
  stubSpanishStation(on)
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const first: any = await ($ as any).prompt.submit({ text: 'hello' })
  const fromPeer: any = await ($ as any).prompt.submit({ text: 'Forward this', origin: { kind: 'peer' } })
  const empty: any = await $.command.run({ command: 'coordinador', args: '' } as any)

  const map = String((first.context ?? []).join('\n'))
  expect(map).toContain('# Estación de agentes: TEST STATION')
  expect(map).toContain('| Carpeta | Sala | Qué hace |')
  expect(map).toContain('Esta sesión es de la sala «Coordination» (carpeta `coord`)')
  expect(map).toContain('| `legal` | Legal | Drafts legal texts |')
  expect(map).not.toContain('This session belongs')
  expect(String((fromPeer.context ?? []).join('\n'))).toContain('no hace de intermediaria entre salas')
  expect(String((fromPeer.context ?? []).join('\n'))).toContain('/coordinador')
  expect(JSON.stringify(commands)).toContain('"coordinador"')
  expect(String(empty.text)).toContain('/coordinador')
})


// The guard asks the user before an agent writes to another session of the
// app; the test runner has no PreToolUse, so this checks what it recognises.
test('a message to another Claude Code session is told apart from one to a subagent', async () => {
  expect(isDirectSessionMessage('SendMessage', { to: 'local_123', message: 'do this for me' })).toBe(true)
  expect(isDirectSessionMessage('mcp__ccd_session_mgmt__send_message', { session_id: 'local_123' })).toBe(true)
  expect(isDirectSessionMessage('SendMessage', { to: 'my-reviewer', message: 'go on' })).toBe(false)
  expect(isDirectSessionMessage('Read', { file_path: 'x' })).toBe(false)
})

// The session a new-session order's card opens finds the order's mark in its
// first message and records it, so the dispatcher can hand it that order. A
// session of another room records it too, and is told not to carry it out.
test('a session records the order its card carries, and is warned when it is for another room', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-card', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.collection === 'sessions' && e.action === 'set') written.push(e.data)
    return { result: { text: `The document is now at version ${written.length}.` } }
  })
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const own: any = await ($ as any).prompt.submit({ text: 'Remove the TLS keys.\n\n[agent-station order n1 for app]' })
  await clock.advance(30_000)
  const other: any = await ($ as any).prompt.submit({ text: 'Fix the docs.\n\n[agent-station order n2 for legal]' })
  await clock.advance(30_000)

  expect(written.some(d => d.fromOrder === 'n1')).toBe(true)
  expect(written.some(d => d.fromOrder === 'n2')).toBe(true)
  const resent: any = await ($ as any).prompt.submit({ text: 'Remove the TLS keys.\n\n[agent-station order n1#3 for app]' })
  await clock.advance(30_000)
  expect(written.some(d => d.fromOrder === 'n1#3')).toBe(true)
  expect(String((resent.context ?? []).join('\n'))).not.toContain('Do not carry it out')
  expect(String((own.context ?? []).join('\n'))).not.toContain('Do not carry it out')
  expect(String((other.context ?? []).join('\n'))).toContain('which is for the room legal, not for this session (room app)')
})

test('a mark quoted inside a message does not claim an order', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-quoted', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.collection === 'sessions' && e.action === 'set') written.push(e.data)
    return { result: { text: `The document is now at version ${written.length}.` } }
  })
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  await ($ as any).prompt.submit({ text: 'Look at this: [agent-station order n9 for app] and tell me what it is.' })
  await clock.advance(30_000)

  expect(written.some(d => d.fromOrder === 'n9')).toBe(false)
})

// Stands for auto mode's classifier when it gives no verdict: every call that
// reaches the verdict beneath is denied.
function stubClassifierWithNoVerdict(on: any, checked: any[]) {
  on('tool.check', (_$: any, e: any) => {
    checked.push(e)
    return { decision: 'deny', reason: 'The server-side auto mode classifier gave no verdict' }
  })
}

test('the plugin approves its own station calls itself, so a classifier with no verdict never stops them', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-auto', 'C:/work/app')
  const checked: any[] = []
  stubClassifierWithNoVerdict(on, checked)
  // The test asks for the verdict on the plugin's first report while that very
  // call is in flight, as the engine does before running it.
  let held: any
  let verdictInFlight: any
  stubStation(on, async e => {
    if (e.collection === 'sessions' && !held) {
      const { tool, ...input } = e
      held = input
      verdictInFlight = await $.tool.check({ tool: 'ArtifactData', input })
    }
    return { result: { text: 'The document is now at version 1.' } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const verdictAfter = await $.tool.check({ tool: 'ArtifactData', input: held })

  expect(verdictInFlight?.decision).toBe('allow')
  expect(verdictAfter.decision).toBe('deny')
  expect(checked.filter(c => c.tool === 'ArtifactData').length).toBe(1)
})

test('the agent\'s own station calls still get the verdict beneath, even when they match the plugin\'s', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-auto-agent', 'C:/work/app')
  const checked: any[] = []
  stubClassifierWithNoVerdict(on, checked)
  stubStation(on, () => ({ result: { text: 'The document is now at version 1.' } }))
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  const read = { url: OFFICE, action: 'list', collection: 'orders' }
  const verdict = await $.tool.check({ tool: 'ArtifactData', input: read })
  const write = await $.tool.check({ tool: 'ArtifactData', input: { url: OFFICE, action: 'set', collection: 'orders', doc_id: 'evil', data: { text: 'x' } } })

  expect(verdict.decision).toBe('deny')
  expect(write.decision).toBe('deny')
  expect(checked.filter(c => c.tool === 'ArtifactData').length).toBe(2)
})

// The map tells each session how to open a handoff in every room's repo, with
// the command of that repo's host, and which rooms take only orders.
test('the map gives each room the handoff command of its own host', async () => {
  const station = stationFromConfig({
    coordination: 'coord',
    repos: [
      { remote: 'https://github.com/acme/app-repo.git', folder: 'app' },
      { remote: 'git@gitlab.com:acme/api.git', folder: 'api' },
      { remote: 'gitlab.com/acme/tools/*' },
      { remote: 'https://bitbucket.org/acme/legacy.git', folder: 'legacy' },
      { remote: 'github.com/acme/coord', folder: 'coord' },
    ],
  }, OFFICE)
  const map = stationMap(station, 'app', 'mcp__agent-station__propose_order')
  expect(map).toContain('- `app`: `gh issue create --repo acme/app-repo --title')
  expect(map).toContain('- `api`: `glab issue create -R https://gitlab.com/acme/api --title')
  expect(map).toContain('- each repo of `gitlab.com/acme/tools/*`: `glab issue create -R https://gitlab.com/acme/tools/<folder>')
  expect(map).toContain('`legacy` are on hosts without handoffs')
  expect(map).not.toContain('`coord`: `gh issue create')
  expect(map).toContain('never write a token')
})

test('a station whose repos are on no issue host only tells to use orders', async () => {
  const station = stationFromConfig({ repos: [{ remote: 'https://bitbucket.org/acme/legacy.git', folder: 'legacy' }] }, OFFICE)
  const map = stationMap(station, 'legacy', 'mcp__agent-station__propose_order')
  expect(map).toContain('on hosts without handoffs: ask the rooms for work only with `mcp__agent-station__propose_order`')
  expect(map).not.toContain('issue create')
})

// Installed with no station at all, the plugin says once how to create one.
test('a plugin with no station tells once to run the setup', { options: {} }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-none', 'C:/work/app', { COMPUTERNAME: 'TESTPC', USERPROFILE: 'C:/Users/me' })
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Read', file_path: 'C:/y.md' } as any)
  await clock.advance(5_000)

  expect(toasts.filter(t => t.includes('/agent-station:setup')).length).toBe(1)
})

test('a plugin with a station says nothing about the setup', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-some', 'C:/work/app')
  stubStation(on)
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)

  expect(toasts.some(t => t.includes('/agent-station:setup'))).toBe(false)
  await clock.advance(60_000)
})

test('propose_order keeps a valid base branch and refuses one that is not a branch name', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-base')
  on('tool.register' as any, () => ({ value: { tool: 'mcp__agent-station__propose_order' } }))
  const writes: any[] = []
  stubStation(on, e => {
    writes.push(e)
    return { result: { text: `The document is now at version ${writes.length}.` } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  const refused: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'Fix it', reason: 'Bug', base: 'main; rm -rf /' } as any)
  await clock.advance(1_000)
  expect(JSON.stringify(refused)).toContain('is not a branch name')
  expect(writes.some(w => w.collection === 'orders' && w.action === 'set')).toBe(false)

  const kept: any = await $.tool.call({ tool: 'mcp__agent-station__propose_order', folder: 'app', text: 'Fix it', reason: 'Bug', base: 'feature/translation-hub' } as any)
  await clock.advance(1_000)
  expect(JSON.stringify(kept)).toContain('Order proposed')
  expect(writes.find(w => w.collection === 'orders' && w.action === 'set')?.data?.base).toBe('feature/translation-hub')
})

test('the map says that a new session of an order may work in a worktree', async () => {
  const station = stationFromConfig({ repos: [{ remote: 'github.com/acme/app-repo', folder: 'app' }] }, OFFICE)
  expect(stationMap(station, 'app', 'mcp__agent-station__propose_order')).toContain('may work in a git worktree of its repo')
})

// The app repo's worktrees, in both path forms, have the app repo's remote.
REMOTES['C:\\work\\app\\.claude\\worktrees\\hungry-0c57bc'] = REMOTES['C:/work/app']
REMOTES['/work/app/.claude/worktrees/hungry-0c57bc'] = REMOTES['C:/work/app']
for (const [cwd, inWorktree] of [['C:\\work\\app\\.claude\\worktrees\\hungry-0c57bc', true], ['/work/app/.claude/worktrees/hungry-0c57bc', true], ['C:/work/app', false]] as const) {
  test(`a session reports whether it runs in a worktree (${cwd})`, { options }, async ($, on) => {
    const clock = mock.clock(on)
    stubSession(on, 'test-session-wt', cwd)
    const written: any[] = []
    stubStation(on, e => {
      if (e.collection === 'sessions' && e.action === 'set') written.push(e.data)
      return { result: { text: `The document is now at version ${written.length}.` } }
    })

    await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
    await clock.advance(30_000)

    expect(written.at(-1)?.inWorktree).toBe(inWorktree)
    await clock.advance(60_000)
  })
}

// git answers the remote after `failures` failed reads (an exit that is no
// clear answer, as when it is killed), or never when failures is Infinity.
function stubFlakyGit(on: any, failures: number) {
  let reads = 0
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    if (argv[0] === 'git' && argv[3] === 'remote') {
      reads++
      if (reads <= failures) return { value: { exitCode: 1, stdout: '', stderr: 'git was killed' } }
      return { value: { exitCode: 0, stdout: REMOTES['C:/work/app'] + '\n' } }
    }
    return { value: { exitCode: 128, stdout: '' } }
  })
}

test('a session whose remote git could not read at first joins its station by itself later', { options }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { COMPUTERNAME: 'TESTPC' })
  on('session.cwd' as any, () => ({ value: 'C:/work/app' }))
  on('session.id' as any, () => ({ value: 'test-session-flaky' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  stubFlakyGit(on, 1)
  const officeCalls: any[] = []
  stubStation(on, e => {
    officeCalls.push(e)
    return { result: { text: `The document is now at version ${officeCalls.length}.` } }
  })
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  expect(officeCalls.some(c => c.collection === 'sessions')).toBe(false)

  // No further step from the agent: the session tries again on its own.
  await clock.advance(2 * 60_000)
  expect(officeCalls.some(c => c.collection === 'sessions' && c.data?.folder === 'app')).toBe(true)
  expect(toasts.filter(t => t.includes('could not join')).length).toBe(0)
})

test('a session that keeps failing to read its remote says so once', { options }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { COMPUTERNAME: 'TESTPC' })
  on('session.cwd' as any, () => ({ value: 'C:/work/app' }))
  on('session.id' as any, () => ({ value: 'test-session-broken' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  stubFlakyGit(on, Infinity)
  stubStation(on)
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  expect(toasts.length).toBe(0)
  await clock.advance(10 * 60_000)
  const told = toasts.filter(t => t.includes('could not join its station yet'))
  expect(told.length).toBe(1)
  expect(told[0]).toContain('git could not read the remote')
  expect(told[0]).toContain('/reload-plugins')
})

test('a folder git says has no origin is left alone, with no notice', { options }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { COMPUTERNAME: 'TESTPC' })
  on('session.cwd' as any, () => ({ value: 'C:/work/loose' }))
  on('session.id' as any, () => ({ value: 'test-session-loose' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  let reads = 0
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    if (argv[0] === 'git' && argv[3] === 'remote') reads++
    return { value: { exitCode: 2, stdout: '', stderr: "error: No such remote 'origin'" } }
  })
  stubStation(on)
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(10 * 60_000)
  await $.tool.call({ tool: 'Read', file_path: 'C:/y.md' } as any)
  await clock.advance(5_000)
  expect(reads).toBe(1)
  expect(toasts.length).toBe(0)
})

test('a branch name is accepted only as git would take it', () => {
  for (const name of ['main', 'feature/translation-hub', 'release/2.4', 'fix_1-a']) expect(isBranchName(name)).toBe(true)
  for (const name of ['.hidden', 'feat//x', 'feat/.x', 'x.', 'x.lock', 'a..b', '-x', 'x/', '/x', 'main; rm -rf /', '']) expect(isBranchName(name)).toBe(false)
})

test('a remote with characters no plain remote has gives no issue commands', () => {
  expect(issueRepoOf('github.com/acme/app')?.kind).toBe('github')
  expect(issueRepoOf('gitlab.acme.test:8443/team/sub/app')?.kind).toBe('gitlab')
  for (const remote of ['github.com/acme/app;rm -rf ~', 'gitlab.com/acme/$(curl x)/app', 'github.com/acme/a b', 'gitlab.com/acme/app&&id']) expect(issueRepoOf(remote)).toBeUndefined()
})

test('a session whose stations cannot be read logs why under its app id and says so', { options }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { COMPUTERNAME: 'TESTPC', USERPROFILE: 'C:/Users/me' })
  on('session.cwd' as any, () => ({ value: 'C:/work/app' }))
  on('session.id' as any, () => ({ value: 'engine-id' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  on('mcp.call' as any, (_$: any, e: any) => ({ value: { content: [{ type: 'text', text: e.tool === 'get_session' ? JSON.stringify({ sessionId: 'local_app_9f' }) : '' }] } }))
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    return { value: argv[0] === 'git' && argv[3] === 'remote' ? { exitCode: 0, stdout: 'https://github.com/acme/app-repo.git' } : { exitCode: 128, stdout: '' } }
  })
  on('tool.call', { tool: 'ArtifactData' }, () => ({ deny: 'The server-side auto mode classifier gave no verdict for ArtifactData' }) as any)
  const files: Record<string, string> = {}
  on('fs.read' as any, (_$: any, e: any) => ({ value: files[String(e.path)] ?? '' }))
  on('fs.write' as any, (_$: any, e: any) => { files[String(e.path)] = e.text; return { value: undefined } })
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(3 * 60_000)

  const log = Object.entries(files).find(([path]) => path.endsWith('local_app_9f.log'))?.[1] ?? ''
  expect(log).toContain('action=join cwd C:/work/app; remote https://github.com/acme/app-repo.git; https://claude.ai/artifact/test-station: did not answer (The server-side auto mode classifier')
  expect(toasts.filter(t => t.includes('could not be read: The server-side auto mode classifier')).length).toBe(1)
})

test('a station reply that is neither its configuration nor "there is none" is no answer', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-odd', 'C:/work/app')
  const toasts: string[] = []
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: null } })
  on('tool.call', { tool: 'ArtifactData' }, () => ({ result: { text: 'Something unexpected happened' } }) as any)

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(3 * 60_000)
  expect(toasts.filter(t => t.includes('could not be read: Something unexpected happened')).length).toBe(1)
})

// A session the app starts in one folder and moves to another a moment later.
function stubMovingSession(on: any, id: string, folders: { cwd: string }) {
  mock.env(on, { COMPUTERNAME: 'TESTPC' })
  on('session.cwd' as any, () => ({ value: folders.cwd }))
  on('session.id' as any, () => ({ value: id }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'ok' } }) as any)
  on('process.run' as any, (_$: any, e: any) => {
    const argv: string[] = e.argv ?? e
    const remote = argv[0] === 'git' && argv[3] === 'remote' ? REMOTES[argv[2]] : undefined
    return { value: remote ? { exitCode: 0, stdout: remote + '\n' } : { exitCode: 128, stdout: '' } }
  })
}

test('a session started in a spare folder joins its station once the app moves it to its project', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const folders = { cwd: 'C:/Users/me/.claude-spares/spare-1a2b' }
  stubMovingSession(on, 'test-session-spare', folders)
  const writes: any[] = []
  stubStation(on, e => { writes.push(e); return { result: { text: `The document is now at version ${writes.length}.` } } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  expect(writes.some(w => w.collection === 'sessions')).toBe(false)

  folders.cwd = 'C:/work/app'
  await $.tool.call({ tool: 'Read', file_path: 'C:/y.md' } as any)
  await clock.advance(5_000)
  expect(writes.some(w => w.collection === 'sessions' && w.data?.folder === 'app')).toBe(true)
})

test('a session that was in no repo joins when it moves to one', { options }, async ($, on) => {
  const clock = mock.clock(on)
  const folders = { cwd: 'C:/Users/me/Desktop' }
  stubMovingSession(on, 'test-session-moved', folders)
  const writes: any[] = []
  stubStation(on, e => { writes.push(e); return { result: { text: `The document is now at version ${writes.length}.` } } })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(5_000)
  expect(writes.some(w => w.collection === 'sessions')).toBe(false)

  folders.cwd = 'C:/work/legal'
  await $.tool.call({ tool: 'Read', file_path: 'C:/y.md' } as any)
  await clock.advance(5_000)
  expect(writes.some(w => w.collection === 'sessions' && w.data?.folder === 'legal')).toBe(true)
})

test('where the app runs PreToolUse, a confirmation is asked there and never again as a question', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-noquestion', 'C:/work/coord')
  stubStation(on)
  const asked: any[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => { asked.push(e); return { result: { text: 'Allow' } } as any })
  const published: any[] = []
  on('tool.call', { tool: 'Artifact' }, (_$: any, e: any) => { published.push(e); return { result: { text: 'Published' } } as any })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)

  await $.tool.call({ tool: 'Artifact', url: OFFICE, file_path: 'C:/office.html' } as any)

  expect(asked.length).toBe(0)
  expect(published.length).toBe(1)
})

test('a compaction, seen as fewer prompts in the session, sends the map again', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-turns', 'C:/work/app')
  stubStation(on)
  const turns = [1, 2, 1]
  on('session.turns' as any, () => ({ value: turns.shift() ?? 1 }))
  on('prompt.submit' as any, (_$: any, e: any) => ({ text: e.text, context: e.context }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  const first: any = await ($ as any).prompt.submit({ text: 'hello' })
  const second: any = await ($ as any).prompt.submit({ text: 'go on' })
  const afterCompaction: any = await ($ as any).prompt.submit({ text: 'and now' })

  expect(String((first.context ?? []).join('\n'))).toContain('propose_order')
  expect(String((second.context ?? []).join('\n'))).not.toContain('propose_order')
  expect(String((afterCompaction.context ?? []).join('\n'))).toContain('propose_order')
})

test('the end of the session marks its report ended', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-end', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.collection === 'sessions' && (e.action === 'set' || e.action === 'update')) written.push(e.data)
    return { result: { text: `The document is now at version ${written.length + 1}.` } }
  })
  on('session.end' as any, (_$: any, e: any) => ({ sessionId: e.sessionId }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  await ($ as any).session.end({ reason: 'prompt_input_exit', sessionId: 'test-session-end' })
  await clock.advance(30_000)

  expect(written.some(d => d.state === 'ended' && typeof d.endedAt === 'number')).toBe(true)
})

test('a /clear does not end the session', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-clear', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.collection === 'sessions' && (e.action === 'set' || e.action === 'update')) written.push(e.data)
    return { result: { text: `The document is now at version ${written.length + 1}.` } }
  })
  on('session.end' as any, (_$: any, e: any) => ({ sessionId: e.sessionId }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  await ($ as any).session.end({ reason: 'clear', sessionId: 'test-session-clear' })
  await clock.advance(30_000)

  expect(written.some(d => d.state === 'ended')).toBe(false)
})

test('a session whose row was deleted meanwhile writes it anew', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-reborn', 'C:/work/app')
  let isDeleted = false
  const writes: any[] = []
  stubStation(on, e => {
    if (e.collection !== 'sessions') return { result: { text: 'The document is now at version 1.' } }
    if (e.action === 'get') return { result: { text: isDeleted ? `No document "${e.doc_id}" in collection "sessions".` : '0 documents' } }
    writes.push(e)
    if (isDeleted && e.if_version !== undefined) return { result: { text: `db write failed (not_found): sessions/${e.doc_id} does not exist.` } }
    return { result: { text: `The document is now at version ${writes.length}.` } }
  })

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  isDeleted = true
  const before = writes.length
  await $.tool.call({ tool: 'Read', file_path: 'C:/y.md' } as any)
  await clock.advance(30_000)

  const after = writes.slice(before)
  expect(after.some(w => w.action === 'set' && w.if_version === undefined)).toBe(true)
})

test('the map tells a room that its handoffs are its repo\'s open issues, how to list them and how to mark one', async () => {
  const station = stationFromConfig({
    coordination: 'coord',
    repos: [
      { remote: 'github.com/acme/app-repo', folder: 'app' },
      { remote: 'gitlab.com/group/*' },
      { remote: 'github.com/acme/quiet', issues: false },
      { remote: 'github.com/acme/coord' },
    ],
    departments: {},
  })
  const app = stationMap(station, 'app', 'mcp__agent-station__propose_order')
  expect(app).toContain("Your room's handoffs are the open issues of its repo, `github.com/acme/app-repo`")
  expect(app).toContain('`gh issue list --repo acme/app-repo`')
  expect(app).toContain('gh issue edit <n> --repo acme/app-repo --add-label "in progress"')
  const shop = stationMap(station, 'shop', 'mcp__agent-station__propose_order')
  expect(shop).toContain('`glab issue list -R https://gitlab.com/group/shop`')
  expect(stationMap(station, 'quiet', 'mcp__agent-station__propose_order')).not.toContain("Your room's handoffs")
  expect(stationMap(station, 'coord', 'mcp__agent-station__propose_order')).not.toContain("Your room's handoffs")
  const es = stationMap(stationFromConfig({ language: 'es', repos: [{ remote: 'github.com/acme/app-repo', folder: 'app' }], departments: {} }), 'app', 'mcp__agent-station__propose_order')
  expect(es).toContain('Los encargos de tu sala son las issues abiertas de su repo, `github.com/acme/app-repo`')
  expect(es).toContain('márcalo en curso (`<n>` es su número)')
})

test('a subagent finishing its turn leaves the session working; the session finishing leaves it idle', { options }, async ($, on) => {
  const clock = mock.clock(on)
  stubSession(on, 'test-session-subturn', 'C:/work/app')
  const written: any[] = []
  stubStation(on, e => {
    if (e.collection === 'sessions' && e.action === 'set') written.push(e.data)
    return { result: { text: `The document is now at version ${written.length + 1}.` } }
  })
  on('turn.complete' as any, (_$: any, e: any) => ({ text: e.answer ?? '' }))

  await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as any)
  await clock.advance(30_000)
  await ($ as any).turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'sub-1', agentId: 'agent-1', reason: 'answer' })
  await clock.advance(30_000)
  expect(written.at(-1)?.state).toBe('working')

  await ($ as any).turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'main-1', reason: 'answer' })
  await clock.advance(30_000)
  expect(written.at(-1)?.state).toBe('idle')
})
