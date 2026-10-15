// Shared access to the office artifact's database through the ArtifactData
// tool, plus the engine closures the hooks hand to background work.

export type EngineIo = {
  callTool: (call: Record<string, unknown>) => Promise<unknown>
  sleep: (ms: number) => Promise<void>
  status: (text: string | undefined) => void
  callMcp: (server: string, tool: string, args?: Record<string, unknown>) => Promise<any>
  cwd: () => Promise<string>
  sessionId: () => Promise<string>
  computerName: () => Promise<string | undefined>
  listDir: (path: string) => Promise<Array<{ name: string; kind: string }>>
  readText: (path: string) => Promise<string>
  runCommand: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>
  userProfile: () => Promise<string | undefined>
  pluginName: () => Promise<string | undefined>
}

export type OfficeReply = {
  isOk: boolean
  text: string
  version: number | undefined
  isVersionMismatch: boolean
}

export type OfficeDoc = {
  id: string
  data: Record<string, any>
  version: number
}

const CALL_TIMEOUT_MS = 8_000

// An ArtifactData call on the station, whichever way its URL is written: the
// artifact is matched by its id (claude.ai/artifact/<id> or
// claude.ai/code/artifact/<uuid>, any case, any trailing part), never by text.
export function isOfficeCall(officeKeys: ReadonlySet<string>, tool: string, input: any): boolean {
  if (tool !== 'ArtifactData' || officeKeys.size === 0) return false
  const key = artifactKey(input?.url)
  return !!key && officeKeys.has(key)
}

export function artifactKey(url: unknown): string | undefined {
  try {
    const parsed = new URL(String(url ?? '').trim())
    if (!/(^|\.)claude\.ai$/i.test(parsed.hostname)) return undefined
    return parsed.pathname.match(/\/artifact\/([^/]+)/i)?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

// Identifies one ArtifactData call by what it does, so the mod can tell its own
// in-flight calls from the same tool called by the session's agent.
export function officeCallKey(input: any): string {
  return JSON.stringify([input?.action ?? null, input?.collection ?? null, input?.doc_id ?? null, input?.if_version ?? null, input?.data ?? null, input?.query ?? null, input?.writes ?? null])
}

export async function callOffice(io: EngineIo, officeUrl: string, args: Record<string, unknown>): Promise<OfficeReply> {
  const call = { tool: 'ArtifactData', url: officeUrl, ...withoutUndefined(args) }
  try {
    const outcome: any = await Promise.race([
      io.callTool(call),
      io.sleep(CALL_TIMEOUT_MS).then(() => ({ timedOut: true })),
    ])
    const text = String(outcome?.deny ?? outcome?.text ?? readResultText(outcome?.result) ?? JSON.stringify(outcome ?? ''))
    const isOk = !(outcome?.isError || outcome?.deny || outcome?.timedOut) && !/db (write|read) failed/i.test(text)
    return {
      isOk,
      text,
      version: isOk ? parseVersion(text) : undefined,
      isVersionMismatch: /version_mismatch/i.test(text),
    }
  } catch (error) {
    const text = String((error as Error)?.message ?? error)
    return { isOk: false, text, version: undefined, isVersionMismatch: /version_mismatch/i.test(text) }
  }
}

function readResultText(result: any): string | undefined {
  if (typeof result === 'string') return result
  if (typeof result?.text === 'string') return result.text
  if (Array.isArray(result?.content)) return mcpText(result)
  return result === undefined ? undefined : JSON.stringify(result)
}

export function parseDocs(text: string): OfficeDoc[] {
  const docs: OfficeDoc[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{"id"')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed?.id && parsed?.data) docs.push({ id: parsed.id, data: parsed.data, version: Number(parsed.version) })
    } catch {}
  }
  return docs
}

export function mcpText(result: any): string {
  return (result?.content ?? []).map((block: any) => block?.text ?? '').join('')
}

export function parseVersion(text: string): number | undefined {
  const match = text.match(/version\D{0,12}(\d+)/i)
  return match ? Number(match[1]) : undefined
}

export function withoutUndefined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

// A short line saying what a tool call is about, shown on the station next to
// the tool: a file's name (never its folder), a search pattern, a command's
// program and first plain word, a site's host. Command arguments that could
// carry a secret (flags, paths, quotes, values with = or :) are left out.
export function toolDetail(tool: string, input: any): string | null {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const short = (value: string, max = 40) => {
    const line = value.split(/\r?\n/)[0].trim()
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  const fileName = (path: string) => path.split(/[\/]/).filter(Boolean).pop() ?? ''
  let detail = ''
  if (FILE_TOOLS.has(tool)) detail = fileName(text(input?.file_path) || text(input?.notebook_path))
  else if (tool === 'Grep' || tool === 'Glob') detail = short(text(input?.pattern))
  else if (SHELL_TOOLS.has(tool)) {
    const words = text(input?.command).trim().split(/\s+/)
    const program = fileName(words[0] ?? '')
    const plain = words.slice(1).find(word => /^[A-Za-z][\w.-]*$/.test(word))
    detail = short([program, plain].filter(Boolean).join(' '), 30)
  } else if (tool === 'WebFetch') {
    try { detail = new URL(text(input?.url)).hostname } catch {}
  } else if (tool === 'WebSearch') detail = short(text(input?.query))
  else if (tool === 'Agent' || tool === 'Task') detail = short(text(input?.description) || text(input?.subagent_type))
  else if (tool === 'Skill') detail = short(text(input?.skill))
  else {
    const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
    if (mcp) detail = short(`${mcp[1]} · ${mcp[2]}`)
  }
  return detail || null
}
