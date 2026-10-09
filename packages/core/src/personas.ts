import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { THINKING_LEVELS, type ThinkingLevel } from './config.ts'
import { DONE_RULES, type DoneRule } from './model.ts'
import { producesProblem } from './produces.ts'

// A persona: what an agent is told when its task starts, and nothing else.
//
// The useful question was never "what is a persona" but "what field does it
// set that does not already exist", and the answer is almost none: the prompt,
// the context, the done rule, what it produces, what it will touch, which
// model and how hard it thinks are all fields on a task already, and anybody
// who makes a task sets them. So a persona is a *named set of defaults for a
// task's start* — a thing you stamp out, resolved once when a template is
// published and never read again — and the one line to keep in your head is:
//
//   A persona may say what an agent is told; it may never say what an agent is
//   allowed.
//
// That is enforced by construction rather than by review. `Told` is a strict
// object, so a key nobody wired is an error; and the keys that would be
// authority — an account, approvals, extensions, MCP servers, a workspace, a
// root, a network, a credential, which tools it may call — are refused *by
// name*, with the reason, because "unknown key: account" teaches nobody why
// and somebody would add it. Every one of them is already in `reach.ts`'s
// `never` subtree, and the reason is the same one: these are what an injected
// sentence wants, so the answer has to be that there is no path.
//
// What a persona is not:
//
// - **not a runtime agent.** Nothing here runs. A persona is read at publish
//   time, folded into a template's snapshot, and the file could be deleted
//   afterwards without changing a single run.
// - **not a permission grant.** It grants nothing. A task made with one starts
//   with exactly the approvals, extensions, MCP servers and sign-in this
//   machine already has.
// - **not a model or a harness choice.** `model` here is a *wish* — a string
//   the harness resolves (`resolveModel`), refused if that harness cannot
//   offer it — and the account stays the person's.
//
// Pure: text in, a persona or the reasons it is not one out.

/** The one sentence, said once so every refusal and every recipe quotes it. */
export const PERSONA_RULE =
  'A persona may say what an agent is told; it may never say what an agent is allowed.'

/**
 * How an agent counts as finished, which may depend on where it works.
 *
 * `done: committed` and `done: merged` cannot be kept in a project whose
 * agents share one checkout — nothing there is any one agent's to commit — and
 * `checkPlan` refuses them. A persona is published before anybody knows which
 * project it will be stamped into, so it may give an answer per workspace and
 * the fill picks the one that project earns (`doneFor`). One value still means
 * one value everywhere.
 */
export const DoneByWorkspace = z
  .strictObject({
    checkout: z.enum(DONE_RULES).optional(),
    worktree: z.enum(DONE_RULES).optional(),
  })
  .refine((one) => one.checkout !== undefined || one.worktree !== undefined, {
    message: 'say a done rule for checkout, for worktree, or both',
  })

export const PersonaDone = z.union([z.enum(DONE_RULES), DoneByWorkspace])
export type PersonaDone = z.infer<typeof PersonaDone>

/** Which rule holds where an agent actually works. */
export function doneFor(
  done: PersonaDone | undefined,
  workspace: 'checkout' | 'worktree',
): DoneRule | undefined {
  if (done === undefined) return undefined
  if (typeof done === 'string') return done
  return done[workspace]
}

/**
 * Everything a persona may set: the told fields, and nothing else.
 *
 * Strict, and the same argument `ConfigSchema` makes — a typo has to be an
 * error rather than a setting silently ignored. `prompt` is not here because
 * it is the body of the file rather than a field in its block.
 */
export const Told = z.strictObject({
  persona: z.string(),
  title: z.string().optional(),
  done: PersonaDone.optional(),
  produces: z.string().optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  model: z.string().optional(),
  touches: z.array(z.string()).optional(),
})

export interface Persona {
  name: string
  /** What to call it in a list. Its name, when it did not say. */
  title: string
  done?: PersonaDone
  produces?: string
  thinking?: ThinkingLevel
  model?: string
  touches?: string[]
  /** What its agent is told first: the body of the file, verbatim. */
  prompt: string
}

/**
 * The fields that are authority rather than instruction, and why each is
 * refused — in the words a person is told when it is.
 *
 * Matched on the key as written and on the obvious spellings of it, because
 * the mistake this catches is somebody reaching for the field they wanted
 * rather than somebody smuggling one past: `account`, `accounts`, `approval`,
 * `approvals`. A key not on this list and not in `Told` is still refused — as
 * an unknown key — so this list is about the *message*, never about the gate.
 *
 * Every entry is in `settingReach`'s `never` subtree already, and the reason
 * given here is that one. If one ever stops being `never` there, it does not
 * follow that it becomes a persona's: a persona is stamped out by a template
 * nobody re-reads, and a field here would be authority arriving without
 * anybody deciding it that time.
 */
export const REFUSED: readonly (readonly [string, string])[] = [
  ['account', 'an account is a sign-in: whose money and whose permissions agents run with'],
  ['accounts', 'an account is a sign-in: whose money and whose permissions agents run with'],
  [
    'approval',
    'approvals decide what agents may do without asking, and a thing a template stamps out does not get to rewrite that loop',
  ],
  [
    'approvals',
    'approvals decide what agents may do without asking, and a thing a template stamps out does not get to rewrite that loop',
  ],
  ['permission', 'what an agent may do without asking is the approval policy, and a person’s'],
  ['permissions', 'what an agent may do without asking is the approval policy, and a person’s'],
  ['extension', 'an extension is code your agents call, and only a person turns one on'],
  ['extensions', 'an extension is code your agents call, and only a person turns one on'],
  [
    'mcp',
    'an MCP server is somebody else’s code with tools your agents call, and a person turns it on',
  ],
  ['tool', 'which tools an agent may call is not a start default'],
  ['tools', 'which tools an agent may call is not a start default'],
  ['credential', 'a key is a setting in the config, in plain sight, and never in a persona'],
  ['credentials', 'a key is a setting in the config, in plain sight, and never in a persona'],
  ['secret', 'a key is a setting in the config, in plain sight, and never in a persona'],
  ['secrets', 'a key is a setting in the config, in plain sight, and never in a persona'],
  ['key', 'a key is a setting in the config, in plain sight, and never in a persona'],
  ['token', 'a key is a setting in the config, in plain sight, and never in a persona'],
  ['workspace', 'where an agent works is the project’s answer (`workspaceFor`), never a task’s'],
  ['root', 'moving a root moves where every agent in it works'],
  ['network', 'what an agent may reach is not a start default'],
  ['push', 'whether finished work goes to a remote is the project’s, and nothing Tade runs pushes'],
  ['budget', 'what a project may spend in a day is the project’s'],
  ['sandbox', 'Tade does not sandbox anything, and a field here would say it does'],
  [
    'harness',
    'which harness an agent runs in is resolved by the harness it is for, and a task made from a template has no field for it yet',
  ],
]

const REFUSED_BY = new Map(REFUSED)

export type PersonaRead = { ok: true; persona: Persona } | { ok: false; problems: string[] }

/** `<name>.md`, the same shape a lesson's name has. */
export function isPersonaName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

/**
 * A persona from the file as written: a `---` block of fields, then the body.
 *
 * The block is YAML and is parsed as YAML, strictly. A lesson is hand-read
 * because a field it loses still leaves the lesson, and the lesson is the
 * point; a persona that lost `done` would quietly stamp out tasks with the
 * wrong finishing rule — so a block that will not parse is a **broken
 * persona**, listed as broken and never loaded with a field missing.
 */
export function parsePersona(name: string, text: string): PersonaRead {
  const problems: string[] = []
  if (!isPersonaName(name)) problems.push(`"${name}" is not a persona name: lowercase, digits, -`)
  const found = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text.trimStart())
  if (!found) {
    return {
      ok: false,
      problems: [
        ...problems,
        'no block at the top: a persona starts with --- , its fields, then --- , then what its agent is told',
      ],
    }
  }
  let block: unknown
  try {
    block = parseYaml(found[1] ?? '')
  } catch (err) {
    const first = (err as Error).message.split('\n')[0]
    return { ok: false, problems: [...problems, `its block is not readable: ${first}`] }
  }
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return { ok: false, problems: [...problems, 'its block is not a set of fields'] }
  }
  // Named before the schema sees them, so the answer is the rule rather than
  // "unrecognized key". This is the whole of what makes the rule teachable.
  for (const key of Object.keys(block)) {
    const because = REFUSED_BY.get(key.toLowerCase())
    if (because) problems.push(`${key} is not a persona's to set — ${because}. ${PERSONA_RULE}`)
  }
  const parsed = Told.safeParse(block)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.join('.')
      const key = String(issue.path[0] ?? '')
      // Already said, in the words of the rule.
      if (REFUSED_BY.has(key.toLowerCase())) continue
      problems.push(at ? `${at}: ${issue.message}` : issue.message)
    }
  }
  const told = parsed.success ? parsed.data : null
  if (told && told.persona !== name) {
    problems.push(`its block says persona: ${told.persona}, and the file is called ${name}.md`)
  }
  const produces = told?.produces === undefined ? null : producesProblem(told.produces)
  if (produces) problems.push(`produces: ${produces}`)
  const prompt = (found[2] ?? '').trim()
  if (!prompt) problems.push('it tells its agent nothing: write what it is told under the block')
  if (problems.length > 0 || !told) return { ok: false, problems }
  return {
    ok: true,
    persona: {
      name,
      title: told.title?.trim() || name,
      ...(told.done !== undefined ? { done: told.done } : {}),
      ...(told.produces !== undefined ? { produces: told.produces.trim() } : {}),
      ...(told.thinking !== undefined ? { thinking: told.thinking } : {}),
      ...(told.model !== undefined ? { model: told.model.trim() } : {}),
      ...(told.touches !== undefined ? { touches: told.touches } : {}),
      prompt,
    },
  }
}
