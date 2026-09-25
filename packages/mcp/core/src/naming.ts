import { createHash } from 'node:crypto'
import type { OfferedTool } from './port.ts'

// What a brokered tool is called, and what it may never be called.
//
// A server may call a tool `searchIssues`, `search-issues` or `Search.Issues`;
// Tade's tool names are `[a-z0-9_]+`, and the name a model reaches for has to
// be the same today as it was yesterday. So this is a pure function of the
// list a server offered, sorted by the server's own names — nothing here reads
// a clock, a file or an order somebody happened to receive things in.
//
// Four layers keep a brokered tool from shadowing Tade's own, and three of
// them are already load-bearing elsewhere: Tade's own tools are registered
// first, `shapeProblem` refuses an extension whose tool does not start with
// its name, and the host refuses a second extension with a name already
// taken. `nameProblem` here is the fourth, which cannot fire given the other
// three — it is here so that a change to one of them cannot quietly open it.

/**
 * How long a brokered tool's name may be.
 *
 * `mcp__tade__` plus this stays inside the 64 characters several providers
 * cap a tool name at, and a name a provider silently truncates is a tool a
 * model cannot call.
 */
export const NAME_CAP = 53

/** How long a server's own name may be, so the prefix leaves room for the tool. */
export const SERVER_NAME_CAP = 16

/**
 * Names Tade's own surfaces use, which a brokered tool may never be.
 *
 * Every tool the orchestrator has starts with `tade_`, so the prefix rule is
 * what actually answers; these are the bare words the same verbs are known by
 * elsewhere — in the window, out loud, in what a person types. A test in the
 * orchestrator holds this list to the first word of every tool in
 * `orchestratorTools()`, so a verb added there cannot come loose from here.
 */
export const RESERVED: readonly string[] = [
  'agent',
  'approvals',
  'approve',
  'deny',
  'done',
  'logs',
  'mcp',
  'notes',
  'orchestrator',
  'park',
  'plan',
  'project',
  'propose',
  'queue',
  'remember',
  'resume',
  'run',
  'schedule',
  'setting',
  'settings',
  'status',
  'steer',
  'tade',
  'task',
  'terminal',
  'updates',
  'watch',
  'watches',
  'write',
]

/** Whether a server may be called this, and if not, why not. Null when it may. */
export function serverNameProblem(name: string): string | null {
  if (typeof name !== 'string' || name === '') return 'a server needs a name'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return `"${name}" is not a usable name for a server: lowercase letters, digits and dashes`
  }
  if (name.length > SERVER_NAME_CAP) {
    return `"${name}" is longer than ${SERVER_NAME_CAP} characters, which leaves no room for its tools' names`
  }
  return null
}

/** What every tool of this server is called before its own name: `mcp_linear_`. */
export function prefixFor(server: string): string {
  return `mcp_${server.replace(/-/g, '_')}_`
}

/**
 * Whether a produced name may be offered, and if not, why not.
 *
 * Nothing Tade hands a harness may be one of its own verbs, and nothing may
 * start with `tade_`: a duplicate never wins where Tade's own are registered
 * first, and a tool that quietly never wins is worse than one that was never
 * offered.
 */
export function nameProblem(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9_]*$/.test(name)) {
    return `"${name}" is not a usable tool name: lowercase letters, digits and underscores`
  }
  if (name.length > NAME_CAP) return `"${name}" is longer than ${NAME_CAP} characters`
  if (name.startsWith('tade_')) return `"${name}" is one of Tade's own names`
  if (RESERVED.includes(name)) return `"${name}" is one of Tade's own names`
  return null
}

/** A server's own tool name, as the letters Tade can use: `Search.Issues` → `search_issues`. */
export function slugOf(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug === '' ? 'tool' : slug
}

/** Four characters of the server's own name, so two that truncate the same stay apart. */
function digest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 4)
}

/** One of a server's tools, with the name Tade gives it — or why it was left out. */
export interface NamedTool {
  /** As the server offered it. */
  offered: OfferedTool
  /** What agents call it: `mcp_linear_search_issues`. Null when it was dropped. */
  name: string | null
  /** Why it was left out, for the page to say. Null when it was not. */
  dropped: string | null
}

/**
 * What each of a server's tools is called here, and which of them are not
 * offered at all.
 *
 * A tool whose parameters are not an object is dropped rather than allowed to
 * break the server: `shapeProblem` would refuse the whole extension for one,
 * and a server losing nine good tools to one bad one is not an answer. What
 * was dropped is said on the page, never swallowed.
 *
 * Two tools that slug the same keep the server's own order: sorted by the
 * name the server gave them, the first keeps the slug and the rest get `_2`,
 * `_3`. Overflow past the cap cuts the tool part and puts a digest of the
 * server's own name on the end, so two long names that cut the same stay two.
 */
export function namesFor(server: string, tools: readonly OfferedTool[]): NamedTool[] {
  const prefix = prefixFor(server)
  // Code points, never `localeCompare`: how a locale orders two strings
  // depends on which ICU the machine has, and a name that moves between two
  // machines is a tool an agent reaches for and misses.
  const sorted = [...tools].sort((a, b) => {
    const one = String(a.name)
    const other = String(b.name)
    return one < other ? -1 : one > other ? 1 : 0
  })
  const used = new Map<string, number>()
  return sorted.map((offered) => {
    const out = (dropped: string): NamedTool => ({ offered, name: null, dropped })
    if (typeof offered.name !== 'string' || offered.name.trim() === '') {
      return out('it has no name')
    }
    if (typeof offered.description !== 'string' || offered.description.trim() === '') {
      return out('it says nothing about when to use it')
    }
    // Not an object means no harness can register it: pi, Claude Code and
    // Codex all hand a model JSON Schema parameters, and a schema that is not
    // an object has no properties to fill in.
    if (!offered.input || (offered.input as { type?: unknown }).type !== 'object') {
      return out('its parameters are not an object')
    }
    const slug = slugOf(offered.name)
    const seen = used.get(slug) ?? 0
    used.set(slug, seen + 1)
    const suffixed = seen === 0 ? slug : `${slug}_${seen + 1}`
    const name = capped(prefix, suffixed, offered.name)
    const problem = nameProblem(name)
    return problem ? out(problem) : { offered, name, dropped: null }
  })
}

/** The whole name, cut to the cap with a digest on the end when it does not fit. */
function capped(prefix: string, tool: string, original: string): string {
  const whole = `${prefix}${tool}`
  if (whole.length <= NAME_CAP) return whole
  const mark = digest(original)
  const room = NAME_CAP - prefix.length - mark.length - 1
  // A prefix that leaves no room at all is a server name the schema refuses,
  // so this never happens — but a name cut to nothing would be every tool
  // called the same thing, which is the one outcome worse than a long name.
  if (room < 1) return `${prefix}${mark}`.slice(0, NAME_CAP)
  return `${prefix}${tool.slice(0, room).replace(/_+$/, '')}_${mark}`
}

/** What a server offered, narrowed to what it was turned on for. Empty offers all. */
export function narrowed(named: readonly NamedTool[], only: readonly string[]): NamedTool[] {
  if (only.length === 0) return [...named]
  const wanted = new Set(only)
  return named.map((one) =>
    one.name === null || wanted.has(one.name)
      ? one
      : { offered: one.offered, name: null, dropped: 'not one of the tools it was turned on for' },
  )
}
