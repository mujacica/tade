import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  defaultConfigPath,
  ENV_FILE_SAID,
  type Inventory,
  ITEM_KINDS,
  KEYS_AND_AGENTS,
  loadConfig,
  tadeHome,
} from '@tade/core'
import { MachineAnswerSchema } from '@tade/web'
import { applyConsolidation, loginShellHas, planConsolidation } from '@tade/workbench/consolidate'
import { EventLog } from '@tade/workbench/events'
import {
  keptInventoryPath,
  machineFolder,
  namesThatMatter,
  placeSaid,
  pushCheck,
  readInventory,
} from '@tade/workbench/inventory'
import { HomeBusyError, lockHome } from '@tade/workbench/lock'
import { linkOf, REMOTE_LINKS, remoteOf } from '@tade/workbench/remotes'
import { setupWalk, walkLines } from '@tade/workbench/setup-walk'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { adapterFor } from './accounts.ts'
import { declaredHere, inventoryFromShell, scanHere } from './machine-here.ts'
import { type Asking, ttyAsking } from './remote-guide.ts'

// `tade machine` — what this machine has, by name: each harness's sign-in and
// until when, each key and where it comes from, each environment key and the
// file and line that sets it, MCP servers, the git identity, whether origin
// answers with this machine's credentials, per-machine apps and the public
// name (`@tade/core`'s `inventory.ts`). Never a value, and never a digest: what
// two machines compare by is theirs to compare, not a terminal's to print.
//
// **`env`** is the scan alone: every key the files that set an environment
// set, at `file:line`, and which of them `tade serve` never reads. **`env
// --move`** moves the ones it can into `~/.config/tade/env` — the diff first,
// every value hidden, a question, a copy of each file beside itself, a fresh
// login shell asked before and after, and every file put back byte for byte
// where anything differs (`@tade/workbench`'s `consolidate.ts`).
//
// **`setup --from <machine>`**, run on a new box, walks everything the other
// machine has against what this one has (`setup-walk.ts`): each sign-in
// through the harness's own flow here, in this terminal; each key with its
// three ways here; each environment key by name; MCP servers, per-machine
// apps, the git identity, and each project's origin checked with a dry-run
// push. The other machine's inventory is asked of it where it is a remote
// here, and otherwise read from what it told this machine when it linked.

export function registerMachine(program: Command, io: Io, setExit: (code: number) => void): void {
  const machine = program
    .command('machine')
    .description(
      'What this machine has — sign-ins, keys and where each is set, git and origin — and setting it up from another',
    )

  machine
    .command('show', { isDefault: true })
    .description(
      'Every sign-in, key, environment key, MCP server, git setting and origin here, by name',
    )
    .option('--json', 'machine-readable output (names and places, never a value or a digest)')
    .action(async (opts: { json?: boolean }) => {
      const config = await configOrSay(io, setExit)
      if (config === null) return
      const inventory = await inventoryFromShell(config, tadeHome())
      if (opts.json) {
        io.out(JSON.stringify(withoutDigests(inventory), null, 2))
        return
      }
      for (const line of inventoryLines(inventory)) io.out(line)
    })

  machine
    .command('env')
    .description(
      `Where each key your environment sets is set, by file and line, never its value; --move puts them in ${ENV_FILE_SAID}`,
    )
    .option(
      '--move',
      `move the keys your shell's files set into ${ENV_FILE_SAID}: a diff first, then a question`,
    )
    .option('--yes', 'with --move: move them without asking, having shown the diff')
    .option('--json', 'machine-readable output')
    .action(async (opts: { move?: boolean; yes?: boolean; json?: boolean }) => {
      const config = await configOrSay(io, setExit)
      if (config === null) return
      const declared = await declaredHere(config, tadeHome())
      if (opts.move) {
        await move(io, setExit, namesThatMatter(declared.secrets, declared.mcp), {
          yes: opts.yes === true,
          json: opts.json === true,
          asking: ttyAsking(opts.json === true),
        })
        return
      }
      const scan = await scanHere(config, declared)
      if (scan === null) {
        io.err('the files that set your environment could not be read in time')
        setExit(Exit.error)
        return
      }
      const rows = [...scan.places].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      if (opts.json) {
        io.out(
          JSON.stringify(
            {
              service: scan.unit,
              names: rows.map(([name, places]) => ({
                name,
                places: places.map((one) => ({
                  where: placeSaid(one),
                  state: one.state,
                  read: one.read,
                  movable: one.movable,
                  why: one.why,
                })),
              })),
              others: scan.others,
              problems: scan.problems,
            },
            null,
            2,
          ),
        )
        return
      }
      if (rows.length === 0) io.out('no key is set in the files that set your environment')
      for (const [name, places] of rows) {
        const where = places.map(
          (one) =>
            `${placeSaid(one)}${one.state === 'computed' ? ' (worked out at login)' : one.state === 'empty' ? ' (empty)' : ''}`,
        )
        io.out(`${name}  ${where.join(', ')}`)
        if (scan.unit && !places.some((one) => one.read === 'service')) {
          io.out(
            `  \`tade serve\` never reads ${[...new Set(places.map((one) => one.file))].join(' or ')}, so the service here does not have it`,
          )
        }
      }
      for (const one of scan.others)
        io.out(
          `${one.file} holds ${one.holds.join(', ')}: its own tool reads it, and Tade leaves it alone`,
        )
      for (const one of scan.problems) io.err(one)
      if (rows.some(([, places]) => places.some((one) => one.movable))) {
        io.out(
          `\`tade machine env --move\` shows what moving them into ${ENV_FILE_SAID} would do, and asks first`,
        )
      }
    })

  machine
    .command('setup')
    .description(
      'Set this machine up from another: walk every sign-in, key, environment key, MCP server, app, git identity and origin it has',
    )
    .requiredOption(
      '--from <machine>',
      'the machine to set up from: a remote here, or one that linked here',
    )
    .option('--json', 'machine-readable output')
    .action(async (opts: { from: string; json?: boolean }) => {
      await setupFrom(io, setExit, opts.from, {
        json: opts.json === true,
        asking: ttyAsking(opts.json === true),
      })
    })
}

async function configOrSay(io: Io, setExit: (code: number) => void) {
  const loaded = await loadConfig(defaultConfigPath())
  if (!loaded.ok) {
    io.err(`${loaded.path} could not be read: \`tade config --check\` says what is wrong with it`)
    setExit(Exit.invalidInput)
    return null
  }
  return loaded.config
}

/** An inventory with every digest taken out, for a terminal. */
function withoutDigests(inventory: Inventory): Inventory {
  return { ...inventory, items: inventory.items.map((one) => ({ ...one, digest: null })) }
}

const MARK = { set: '✓', missing: '✗', unknown: '?' } as const

/** An inventory as a terminal says it: a heading per kind, a line per item, where and what is wrong under it. */
export function inventoryLines(inventory: Inventory): string[] {
  const lines: string[] = [`${inventory.machine}, as of ${inventory.at}`]
  for (const kind of ITEM_KINDS) {
    const items = inventory.items.filter((one) => one.kind === kind)
    if (items.length === 0) continue
    lines.push(KIND_HEAD[kind])
    for (const one of items) {
      const days =
        one.until === null ? '' : ` (until ${new Date(one.until).toISOString().slice(0, 10)})`
      lines.push(
        `  ${MARK[one.state]} ${one.label}${days}${one.where.length > 0 ? `  ${one.where.join(', ')}` : ''}`,
      )
      if (one.said) lines.push(`      ${one.said}`)
    }
  }
  return lines
}

const KIND_HEAD: Readonly<Record<(typeof ITEM_KINDS)[number], string>> = {
  'sign-in': 'sign-ins',
  secret: 'keys',
  env: 'environment keys',
  mcp: 'MCP servers',
  git: 'git',
  origin: 'origin, with this machine’s credentials',
  app: 'per-machine apps',
  public: 'public name',
}

/** `env --move`: the diff, the question, the move, and what came of it — written down where it can be. */
async function move(
  io: Io,
  setExit: (code: number) => void,
  names: ReadonlySet<string>,
  opts: { yes: boolean; json: boolean; asking: Asking },
): Promise<void> {
  const plan = await planConsolidation({ homeDir: homedir(), names })
  const say = opts.json ? io.err : io.out
  for (const line of plan.diff) say(line)
  for (const one of plan.left) say(`left where it is: ${one.name} at ${one.where} — ${one.why}`)
  if (plan.moved.length === 0) {
    if (opts.json) io.out(JSON.stringify({ outcome: 'nothing', left: plan.left }, null, 2))
    else io.out(`nothing to move into ${ENV_FILE_SAID}`)
    return
  }
  io.err(KEYS_AND_AGENTS)
  const yes =
    opts.yes ||
    (opts.asking.interactive &&
      (await opts.asking.ask(
        `Move ${plan.moved.map((one) => one.name).join(', ')} into ${ENV_FILE_SAID}?`,
        false,
      )))
  if (!yes) {
    io.err(
      opts.asking.interactive
        ? 'nothing was moved'
        : 'nobody here to ask, so nothing was moved: run this in a terminal, or add --yes having read the diff',
    )
    return
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  const done = await applyConsolidation(plan, {
    verify: (asked) => loginShellHas(asked, { shell, homeDir: homedir(), env: process.env }),
  })
  if (done.outcome === 'moved' || done.outcome === 'rolled back') {
    const written = await writeDown({
      by: 'cli',
      names: plan.moved.map((one) => one.name).join(' '),
      files: plan.files.map((one) => one.said).join(' '),
      outcome: done.outcome,
      ...(done.why === null ? {} : { why: done.why }),
    })
    if (!written)
      io.err(
        'the window open on this home holds its journal, so this was not written down there; the copies beside each file are the record',
      )
  }
  if (opts.json)
    io.out(JSON.stringify({ outcome: done.outcome, why: done.why, backups: done.backups }, null, 2))
  else io.out(done.said)
  if (done.outcome !== 'moved') setExit(Exit.error)
}

/** An `env_consolidated` line, where no window holds the journal; whether it was written. */
async function writeDown(detail: Record<string, string>): Promise<boolean> {
  const home = tadeHome()
  try {
    const lock = await lockHome(home)
    try {
      const log = await EventLog.open({ path: join(home, 'events.jsonl') })
      try {
        await log.append({ type: 'env_consolidated', detail })
      } finally {
        await log.close()
      }
    } finally {
      await lock.release()
    }
    return true
  } catch (err) {
    if (err instanceof HomeBusyError) return false
    throw err
  }
}

/** The other machine's inventory: asked of it where it is a remote here, or what it told this one. */
async function sourceOf(
  name: string,
  home: string,
): Promise<{ inventory: Inventory; asked: boolean } | { said: string }> {
  const loaded = await loadConfig(defaultConfigPath())
  const remote = loaded.ok ? loaded.config.remotes[name] : undefined
  let unasked: string | null = null
  if (remote !== undefined) {
    const link = REMOTE_LINKS[linkOf(remote)]?.({ home })
    if (link !== undefined) {
      try {
        const answer = await link.call(remoteOf(name, remote), '/api/machine', {})
        const read = MachineAnswerSchema.safeParse(answer.body)
        if (answer.status === 200 && read.success && read.data.inventory) {
          return { inventory: read.data.inventory, asked: true }
        }
        unasked =
          answer.status === 200
            ? `${name} runs a Tade that does not say what it has yet`
            : `${name} answered ${answer.status}`
      } catch (err) {
        unasked = `${name} could not be asked (${err instanceof Error ? err.message : String(err)})`
      }
    }
  }
  for (const folder of [name, machineFolder(name)]) {
    if (folder === null) continue
    const path = keptInventoryPath(home, folder)
    const kept = path === null ? null : await readInventory(path)
    if (kept !== null) return { inventory: kept.inventory, asked: false }
  }
  return {
    said:
      unasked ??
      `${name} has never told this machine what it has: link this machine from ${name} (\`tade remote add\` there, with a window open here), or name a remote here`,
  }
}

/** `setup --from`: the walk, each sign-in offered here, each origin checked by a dry run, and the checklist. */
async function setupFrom(
  io: Io,
  setExit: (code: number) => void,
  from: string,
  opts: { json: boolean; asking: Asking },
): Promise<void> {
  const config = await configOrSay(io, setExit)
  if (config === null) return
  const home = tadeHome()
  const source = await sourceOf(from, home)
  if ('said' in source) {
    io.err(source.said)
    setExit(Exit.error)
    return
  }
  if (!source.asked) io.err(`what ${from} told this machine it has, as of ${source.inventory.at}`)
  let here = await inventoryFromShell(config, home)
  const how = {
    target: 'this machine',
    source: from,
    there: (command: string) => `\`${command}\``,
    sendKeys: `\`tade remote carry <this machine> --keys\` on ${from}`,
    connect: `this machine's own /connect (\`tade remote connect <this machine>\` from ${from})`,
  }
  let walk = setupWalk(source.inventory, here, how)

  // Each sign-in it lacks, through the harness's own flow in this terminal.
  if (opts.asking.interactive) {
    let signed = false
    for (const step of walk.steps.filter(
      (one) => one.kind === 'sign-in' && one.there !== 'different',
    )) {
      const [, harness = '', account] = step.item.split(':')
      if (account !== undefined && config.accounts[account] === undefined) continue
      if (!(await opts.asking.ask(`${step.label} is not signed in here. Sign it in now?`, true)))
        continue
      let signing: ReturnType<ReturnType<typeof adapterFor>['signIn']>
      try {
        signing = adapterFor(config, home, harness, account ?? null).signIn()
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        continue
      }
      if (signing === null) continue
      io.err(signing.how)
      await opts.asking.run(signing.launch.command, signing.launch.args)
      signed = true
    }
    if (signed) {
      here = await inventoryFromShell(config, home)
      walk = setupWalk(source.inventory, here, how)
    }
  }

  // Each project's origin, checked with a dry-run push: what hand-over and sync need.
  const pushes: { project: string; ok: boolean | null; said: string }[] = []
  for (const [project, one] of Object.entries(config.projects)) {
    const checked = await pushCheck(one.root, { env: process.env })
    pushes.push({ project, ...checked })
  }

  if (opts.json) {
    io.out(JSON.stringify({ from, asked: source.asked, walk, pushes }, null, 2))
  } else {
    for (const line of walkLines(walk, how)) io.out(line)
    for (const one of pushes)
      io.out(`${one.ok === true ? '✓' : one.ok === false ? '✗' : '?'} ${one.project}: ${one.said}`)
  }
}
