import { artifactKey, callOffice, parseDocs, type EngineIo } from './office'
import { ENGINE_VERSION } from './version'
import { tx } from './locale-es'

// Which stations this plugin serves and which of their departments a folder
// belongs to. The plugin is the same for every station and knows only their
// URLs, from its `stations` option. Everything that tells one station from
// another lives in the station's own database, in config/departments.

export type RepoRule = { remote: string; folder?: string }

// What an agent is told about a room: its name and what its agent does.
export type RoomInfo = { name?: string; description?: string }

// The language of everything the station says to people and agents: the page,
// the map, the orders delivered and the coordination's notes. English unless the
// station's config/departments sets `language` to "es".
export type Lang = 'es' | 'en'
export const LANGS: Lang[] = ['en', 'es']
export const langOf = (value: unknown): Lang => (value === 'es' ? 'es' : 'en')

export type StationConfig = {
  title: string
  language: Lang
  coordination: string
  repos: RepoRule[]
  rooms: Record<string, RoomInfo>
  // The station artifact's ids: its URL and the aliases in config/departments
  // (the same artifact also answers at claude.ai/code/artifact/<uuid>).
  officeKeys: Set<string>
}

export type Station = StationConfig & { officeUrl: string; modVersion: string }

// The station URLs, separated by ";".
export function stationUrls(options: Record<string, unknown>): string[] {
  const text = String(options.stations ?? '')
  return [...new Set(text.split(/[;\s]+/).map(url => url.trim()).filter(url => !!artifactKey(url)))]
}

// undefined when the station did not answer (worth retrying later). A station
// that answers without a usable config/departments gives an empty one, and so
// does one that does not exist or that this account cannot read: asking it
// again would never change the answer.
export async function readStationConfig(io: EngineIo, officeUrl: string): Promise<Station | undefined> {
  const reply = await callOffice(io, officeUrl, { action: 'get', collection: 'config', doc_id: 'departments' })
  const isUnreachableForGood = !reply.isOk && /no such artifact|no access|not found|forbidden/i.test(reply.text)
  if (!reply.isOk && !isUnreachableForGood) return undefined
  return stationFromConfig((reply.isOk ? parseDocs(reply.text)[0]?.data : undefined) ?? {}, officeUrl)
}

// A station as the plugin uses it, from its config/departments document.
export function stationFromConfig(config: Record<string, any>, officeUrl: string): Station {
  const aliases: unknown[] = Array.isArray(config.aliases) ? config.aliases : []
  return {
    officeUrl,
    modVersion: ENGINE_VERSION,
    title: typeof config.title === 'string' ? config.title : '',
    language: langOf(config.language),
    coordination: typeof config.coordination === 'string' ? config.coordination : '',
    repos: Array.isArray(config.repos) ? config.repos.filter((r: any) => r && typeof r.remote === 'string') : [],
    rooms: roomsOf(config.departments),
    officeKeys: new Set([officeUrl, ...aliases].map(artifactKey).filter((key): key is string => !!key)),
  }
}

function roomsOf(departments: unknown): Record<string, RoomInfo> {
  const rooms: Record<string, RoomInfo> = {}
  if (!departments || typeof departments !== 'object') return rooms
  for (const [folder, room] of Object.entries(departments as Record<string, any>)) {
    if (!room || typeof room !== 'object') continue
    rooms[folder] = {
      name: typeof room.name === 'string' && room.name.trim() ? room.name.trim() : undefined,
      description: typeof room.description === 'string' && room.description.trim() ? room.description.trim().slice(0, 400) : undefined,
    }
  }
  return rooms
}

// The rooms another session can ask for work: every repo listed one by one,
// with the name the station gives it, but the coordination's. Repos taken by a
// group pattern (…/*) are rooms too, named after the repo: `groups` lists them.
export function stationRooms(station: Station): { rooms: Array<{ folder: string; name: string }>; groups: string[] } {
  const folders = [...new Set(station.repos
    .filter(rule => !normalizeRemote(rule.remote).endsWith('/*'))
    .map(rule => rule.folder || normalizeRemote(rule.remote).split('/').pop() || ''))]
    .filter(folder => folder && folder !== station.coordination)
  return {
    rooms: folders.map(folder => ({ folder, name: station.rooms[folder]?.name || folder })),
    groups: station.repos.map(rule => normalizeRemote(rule.remote)).filter(remote => remote.endsWith('/*')),
  }
}

// A line naming the rooms, for the propose_order tool's description and its
// answer when a room does not exist.
export function roomsLine(station: Station): string {
  const { rooms, groups } = stationRooms(station)
  const listed = rooms.map(room => room.name === room.folder ? `\`${room.folder}\`` : `\`${room.folder}\` (${room.name})`).join(', ')
  return `${listed}${groups.length ? `; and each repo of ${groups.join(', ')}, by its repo name` : ''}`
}

// The map a session of the station gets with its first message: which rooms there
// are, what each one's agent does, and how to ask a room for work. Built from
// the station's own config, so it is the same code for every station and is
// never kept by hand. It states no rule of its own on who may work where: that
// belongs to each team's own instructions. It leaves out the other rooms'
// subagents: how to do a task, and with which subagent, is for the room that
// takes it to decide.
export function stationMap(station: Station, ownFolder: string, proposeTool: string): string {
  const say = (text: string, vars?: Record<string, unknown>) => tx(station.language, text, vars)
  const cell = (text: string) => text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
  const nameOf = (folder: string) => station.rooms[folder]?.name || folder
  const { rooms, groups } = stationRooms(station)
  const folders = rooms.map(room => room.folder)
  const lines = [
    say('# Agent station{title}', { title: station.title ? `: ${station.title}` : '' }),
    '',
    say('This session belongs to the room "{room}" (folder `{folder}`). Each room is a repo with its own agent. When a task belongs to another room, you can ask its agent for it.', { room: nameOf(ownFolder), folder: ownFolder }),
    '',
    say('| Folder | Room | What it does |'),
    '|---|---|---|',
    ...folders.map(folder => `| \`${folder}\`${folder === ownFolder ? say(' (this session)') : ''} | ${cell(nameOf(folder))} | ${cell(station.rooms[folder]?.description || say('(not described)'))} |`),
  ]
  if (groups.length) lines.push('', say("Each repo of {groups} is also a room, with the repo's name as its folder.", { groups: groups.map(g => `\`${g}\``).join(', ') }))
  lines.push(
    '',
    say("To ask another room for work, use the tool `{tool}` with `folder` (the folder in the table), `text` (what you need and why, with the context it needs) and `reason` (why you ask). How to do it, and with which subagent, is for the room that takes it to decide; use `agent` only when the user asks for a particular subagent. The order stays proposed and is not delivered until the user approves it in the station. Your own room's subagents you launch directly with the Agent tool, without an order.", { tool: proposeTool }),
    '',
    say('The same tool returns the result of an order you received from another room: set `folder` to the room that asked, and the station delivers it to the session that sent it, without you naming it.'),
    '',
    say("Never write to another room's sessions directly (with SendMessage or a session tool): work between rooms goes only through `{tool}`, so that the user approves it.", { tool: proposeTool }),
  )
  if (station.coordination) lines.push('', say('The coordination session (`{coordination}`) runs the station and delivers the approved orders, but it is no go-between for the rooms: never write to it to ask for work, return a result or forward anything; that is what `{tool}` is for.', { coordination: station.coordination, tool: proposeTool }))
  return lines.join('\n')
}

// What the coordination session reads beside a message from another session:
// it does not pass work or results between rooms, and points the sender to
// propose_order instead. The user's own coordinator notices are for it.
export function coordinationPeerNote(proposeTool: string, language: Lang = 'en', command = '/coordinator'): string {
  return [
    tx(language, 'This message comes from another session, not from the user.'),
    tx(language, 'The coordination session runs the station and delivers the approved orders, but it is no go-between for the rooms. If the message asks you to forward something to another room, pass it a result or give it work, do not do it: answer the sender to use the tool `{tool}` with `folder` set to the room it is meant for. That tool leaves the order proposed in the station and, once the user approves it, delivers it to the right session, also when it answers an order received.', { tool: proposeTool }),
    tx(language, 'The notices the user sends with {command} from another session are for you.', { command }),
  ].join('\n\n')
}

// A message to another Claude Code session of the app: SendMessage to a
// session id (local_…), or the app's own send_message tool. SendMessage to the
// session's own subagents or teammates is not one.
export function isDirectSessionMessage(tool: string, input: any): boolean {
  if (tool === 'SendMessage') return /^local_/.test(String(input?.to ?? ''))
  return /ccd_session_mgmt__send_message$/.test(tool)
}

// The department of a repo, from its origin remote: an exact remote names its
// folder (or the repo's own name), and a remote ending in /* takes every repo
// under that path, each as a department named after the repo.
export function folderForRemote(remote: string, repos: RepoRule[]): string | undefined {
  const normalized = normalizeRemote(remote)
  if (!normalized) return undefined
  for (const rule of repos) {
    const pattern = normalizeRemote(rule.remote)
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1)
      const rest = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : ''
      if (rest && !rest.includes('/')) return rule.folder || rest
    } else if (pattern === normalized) {
      return rule.folder || normalized.split('/').pop()
    }
  }
  return undefined
}

// github.com/owner/repo, whatever the protocol, user, port or .git suffix.
export function normalizeRemote(remote: string): string {
  let text = String(remote ?? '').trim().toLowerCase()
  const scp = text.match(/^[^@/]+@([^:/]+):(.+)$/)
  if (scp) text = `${scp[1]}/${scp[2]}`
  return text
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):\d+\//, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

export async function readOriginRemote(io: EngineIo, path: string): Promise<string | undefined> {
  try {
    const reply = await io.runCommand(['git', '-C', path, 'remote', 'get-url', 'origin'])
    return reply.exitCode === 0 ? reply.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

// The main checkout of the repo at path, also when path is one of its
// worktrees (which the app opens inside the repo, under .claude/worktrees):
// the folder that holds its shared .git. Its neighbours are the user's other
// repos; a worktree's neighbours are only other worktrees.
export async function readMainRepoTop(io: EngineIo, path: string): Promise<string | undefined> {
  try {
    const reply = await io.runCommand(['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const commonDir = reply.exitCode === 0 ? toLocalPath(reply.stdout.trim()) : ''
    if (/[\\/]\.git$/.test(commonDir)) return parentOf(commonDir)
  } catch {}
  return readRepoTop(io, path)
}

export async function readRepoTop(io: EngineIo, path: string): Promise<string | undefined> {
  try {
    const reply = await io.runCommand(['git', '-C', path, 'rev-parse', '--show-toplevel'])
    return reply.exitCode === 0 ? toLocalPath(reply.stdout.trim()) || undefined : undefined
  } catch {
    return undefined
  }
}

// A path in its machine's own form: a Windows path (with a drive letter) takes
// backslashes, as git prints it with slashes; any other path keeps its slashes.
const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path)
export function toLocalPath(path: string): string {
  const text = String(path ?? '').trim()
  if (isWindowsPath(text)) return text.replace(/\//g, '\\').replace(/\\+$/, '')
  return text.replace(/\/+$/, '') || text
}

// Joins path parts with the separator of the path they start from.
export function joinPath(base: string, ...parts: string[]): string {
  const separator = isWindowsPath(base) || base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(separator)
}

export function parentOf(path: string): string {
  const clean = toLocalPath(path)
  const cut = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'))
  return cut > 0 ? clean.slice(0, cut) : clean
}
