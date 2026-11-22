import {
  ENV_FILE_SAID,
  type Inventory,
  type InventoryItem,
  type ItemKind,
  UNIT_ENVIRONMENT_FILE,
  type Versus,
  versusOf,
} from '@tade/core'

// The guided setup of one machine from another (`tade machine setup --from`,
// run on the new box, and `tade remote add`, run on the Mac): the source's
// inventory walked item by item against the target's, in the order the steps
// go — sign-ins, keys, environment keys, MCP servers, per-machine apps, the git
// identity and origin — each with what to do on the target, said as the
// command to type.
//
// **Nothing here moves a key.** A sign-in is the harness's own, in a terminal
// the person watches; a key is sent on a press from the source, or set in the
// target's environment by the person; an environment key's value is never read
// on the source, so the only thing to say is its name and where to set it.
//
// Pure: two inventories and how to say a command there, in; steps and lines out.

/** How the walk says a command on the target and on the source. */
export interface WalkHow {
  /** The target as said: `this machine`, `vps`. */
  target: string
  /** The source as said: `mac`. */
  source: string
  /** A command as typed on the target: itself here, `ssh -t vps …` from the Mac. */
  there: (command: string) => string
  /** What sends keys from the source on a press, as typed where it runs; null where nothing can. */
  sendKeys: string | null
  /** What opens the target's connect pages, as typed; null for its own `/connect`. */
  connect: string | null
}

/** One item the target lacks, and what to do about it there. */
export interface WalkStep {
  kind: ItemKind
  item: string
  label: string
  there: Versus['there']
  /** What to do, a line each: the first says what it is, the rest how. */
  lines: string[]
}

/** The walk: each step, and what already stands. */
export interface Walk {
  steps: WalkStep[]
  /** How many of the source's items the target already has. */
  set: number
  /** The target never said what it has: everything is `unknown`. */
  unanswered: boolean
}

/** The source's inventory walked against the target's. */
export function setupWalk(source: Inventory, target: Inventory | null, how: WalkHow): Walk {
  const versus = versusOf(source, target)
  const steps: WalkStep[] = []
  let set = 0
  for (const one of versus) {
    if (one.there === 'set') {
      set++
      continue
    }
    if (one.item.kind === 'origin' && target !== null && one.theirs === null) continue
    steps.push({
      kind: one.item.kind,
      item: one.item.id,
      label: one.item.label,
      there: one.there,
      lines: linesFor(one, how),
    })
  }
  return { steps, set, unanswered: target === null }
}

/** What standing a step's item has there, in words. */
function standing(one: Versus, how: WalkHow): string {
  if (one.there === 'different') return `${how.target} has a different one`
  if (one.there === 'unknown')
    return `${how.target} cannot tell${one.theirs?.said ? ` (${one.theirs.said})` : ''}`
  return `${how.target} does not have it`
}

function linesFor(one: Versus, how: WalkHow): string[] {
  const item = one.item
  const head = `${item.label}: ${standing(one, how)}`
  switch (item.kind) {
    case 'sign-in': {
      const [, harness = '', account] = item.id.split(':')
      const words = `tade accounts sign-in ${harness}${account ? ` ${account}` : ''}`
      return [
        head,
        ...(account
          ? [
              `  add the account there first if it is not: ${how.there(`tade accounts add ${harness} ${account}`)}`,
            ]
          : []),
        `  sign in through ${harness}'s own flow, in a terminal you watch: ${how.there(words)}`,
      ]
    }
    case 'secret':
      return [head, ...keyWays(item, how)]
    case 'env':
      if (item.id.startsWith('file:')) {
        return [
          head,
          `  ${item.said ?? 'its own tool reads it'}: copy ${item.where[0] ?? 'it'} there yourself if that machine needs it`,
        ]
      }
      return [
        head,
        `  set on ${how.source} in ${item.where.join(', ') || 'its environment'}, never in Tade's config, so only you can set it there`,
        `  add ${item.label}='…' to ${ENV_FILE_SAID} on ${how.target}: its login shell reads it, and \`tade serve\` does through ${UNIT_ENVIRONMENT_FILE}`,
      ]
    case 'mcp':
      return [
        head,
        how.sendKeys
          ? `  sent on a press from ${how.source}, with what it is handed: ${how.sendKeys}`
          : `  turn it on there: Settings › Extensions, or \`tade mcp\``,
      ]
    case 'app':
      return [
        head,
        `  never copied: it is made for each machine's own public name — connect it there: ${how.connect ?? '/connect on that machine'}`,
      ]
    case 'public':
      return [
        head,
        `  ${how.there('tade host domain')} says what the name needs there, and ${how.there('tade host caddy')} how to answer it`,
      ]
    case 'git':
      return item.id === 'git:github'
        ? [head, `  sign gh in there: ${how.there('gh auth login')}`]
        : [
            head,
            `  name who commits there: ${how.there('git config --global user.email <you@example.com>')}`,
          ]
    case 'origin':
      return [
        head,
        `  give ${how.target} a credential origin takes — a deploy key, or \`gh auth login\` — then check it with a dry run: ${how.there('git push --dry-run origin HEAD')}`,
        '  without it, handing work over and keeping the project in step cannot work there',
      ]
  }
}

/** The three ways a key gets to the target, `KEYS_TO_REMOTE`'s choices. */
function keyWays(item: InventoryItem, how: WalkHow): string[] {
  const variable = item.variables[0]
  return [
    ...(how.sendKeys
      ? [
          `  send it on a press from ${how.source} (it asks first, and says what that means): ${how.sendKeys}`,
        ]
      : []),
    ...(variable
      ? [
          `  or export it on ${how.target}, which wins over any config: ${variable}='…' in ${ENV_FILE_SAID}, which ${UNIT_ENVIRONMENT_FILE} gives \`tade serve\``,
        ]
      : []),
    `  or leave it unset: ${item.said ?? 'what needs it says so there'}`,
  ]
}

/** The walk as a terminal says it, ending with the checklist. */
export function walkLines(walk: Walk, how: WalkHow): string[] {
  if (walk.unanswered) {
    return [
      `${how.target} did not say what it has, so nothing could be compared: open Tade there (\`tade app\`, or \`tade serve\` under its unit) and ask again`,
    ]
  }
  const lines: string[] = []
  for (const step of walk.steps) lines.push(...step.lines)
  const by = new Map<ItemKind, number>()
  for (const step of walk.steps) by.set(step.kind, (by.get(step.kind) ?? 0) + 1)
  const left = [...by].map(([kind, n]) => `${n} ${KIND_SAID[kind]}`)
  lines.push(
    walk.steps.length === 0
      ? `${how.target} has everything ${how.source} has: ${walk.set} item${walk.set === 1 ? '' : 's'}`
      : `checklist: ${walk.set} of ${walk.set + walk.steps.length} of ${how.source}'s items are on ${how.target}; left: ${left.join(', ')} — Settings › Machines keeps this list`,
  )
  return lines
}

const KIND_SAID: Readonly<Record<ItemKind, string>> = {
  'sign-in': 'sign-in(s)',
  secret: 'key(s)',
  env: 'environment key(s)',
  mcp: 'MCP server(s)',
  git: 'git setting(s)',
  origin: 'origin credential(s)',
  app: 'per-machine app(s)',
  public: 'public name',
}
