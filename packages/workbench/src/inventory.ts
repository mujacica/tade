import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type Config,
  type Inventory,
  type InventoryItem,
  ITEMS_MOST,
  inventoryIn,
  keyDigest,
  machineDir,
  type RunResult,
  runProgram,
  textOf,
} from '@tade/core'
import { PROVIDER_ENV_KEYS } from '@tade/harnesses-pi'
import type { AccountView } from './accounts.ts'
import { harnessesInUse } from './carry.ts'
import type { EnvPlace, EnvScan } from './env-scan.ts'

// This machine's inventory (`@tade/core`'s `inventory.ts`): looked at here,
// out of what Tade already knows — its config, its harnesses' own word on
// their sign-ins, its extensions' declared keys — and a few small looks it
// does not keep: `gh auth status`, `git config user.email`, whether origin
// answers each project with this machine's credentials, and the scan of the
// files that set its environment (`env-scan.ts`).
//
// **Every look has a deadline, and every parser returns null rather than
// throwing.** A `gh` that hangs, an origin that never answers, a harness whose
// status command changed its words: each is `unknown` with the reason, never
// a look that stops the rest and never a `missing`.
//
// **Digests, never values.** A key is hashed where it is read
// (`keyDigest`, the one `carry.ts` compares keys by) and the value is let go;
// the inventory holds where each key comes from and its digest, which is what
// two machines compare.

/** How long each look may take. */
export const GH_MS = 10_000
export const GIT_MS = 5_000
export const ORIGIN_MS = 20_000

/** A key a person may have declared, as the inventory reads it: the extensions' (`DeclaredSecret`). */
export interface SecretDeclared {
  path: string
  /** Whose: the extension's title. */
  title: string
  /** What it is called: `API key`. */
  label: string
  variables: readonly string[]
  /** What the config holds, as written. */
  value: string
  /** Where the one in use comes from: `$VAR`, `config.yaml`, or null for none. */
  from: string | null
}

/** An MCP server, as declared here. */
export interface McpDeclared {
  name: string
  enabled: boolean
  /** Its settings as written, compared by digest across machines. */
  settings: unknown
  variables: readonly string[]
}

/** How a look is run: `runProgram`, unless a test hands its own. */
export type Look = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs: number; env?: Readonly<Record<string, string | undefined>> },
) => Promise<RunResult>

export interface InventoryOpts {
  config: Config
  /** What this machine calls itself. */
  machine: string
  /** Who it is (`machine.json`'s id); absent, the inventory does not say. */
  id?: string
  now: number
  env: Readonly<Record<string, string | undefined>>
  /** Every account, as each harness says it stands (`listAccounts`). */
  accounts: readonly AccountView[] | null
  /** Why the harnesses could not say, where `accounts` is null. */
  accountsUnsaid?: string
  secrets: readonly SecretDeclared[]
  mcp: readonly McpDeclared[]
  /** The open projects and their roots, for origin. */
  projects: readonly { name: string; root: string }[]
  /** Where each environment key is set, or null where nobody looked. */
  scan: EnvScan | null
  /** Ask origin about each project now; otherwise `origins` is what was found last. */
  askOrigins: boolean
  origins?: readonly InventoryItem[]
  /** Whether caddy is installed here, for a machine with a public name. */
  caddy: boolean
  look?: Look
}

const run: Look = (command, args, opts) =>
  runProgram(command, args, { ...opts, maxBuffer: 256 * 1024 })

/** This machine's inventory, now. Never throws: what could not be looked at is `unknown`, and says why. */
export async function inventoryHere(opts: InventoryOpts): Promise<Inventory> {
  const look = opts.look ?? run
  const env = opts.env
  const [git, gh, origins] = await Promise.all([
    gitIdentity(look, env),
    githubSignIn(look, env),
    opts.askOrigins
      ? Promise.all(opts.projects.map((one) => originItem(look, env, one)))
      : Promise.resolve(
          (opts.origins ?? []).filter((item) =>
            opts.projects.some((one) => `origin:${one.name}` === item.id),
          ),
        ),
  ])
  const items: InventoryItem[] = [
    ...signIns(opts),
    ...secrets(opts),
    ...envKeys(opts),
    ...mcp(opts),
    git,
    gh,
    ...origins.filter((one): one is InventoryItem => one !== null),
    ...apps(opts.config),
    ...publicName(opts),
  ]
  return {
    machine: opts.machine,
    ...(opts.id === undefined ? {} : { id: opts.id }),
    at: new Date(opts.now).toISOString(),
    items: items.slice(0, ITEMS_MOST),
    shell: shellName(env.SHELL),
    service: opts.scan?.unit ?? false,
  }
}

function item(
  fields: Partial<InventoryItem> & Pick<InventoryItem, 'id' | 'kind' | 'label' | 'state'>,
): InventoryItem {
  return {
    digest: null,
    until: null,
    where: [],
    said: null,
    variables: [],
    service: null,
    ...fields,
  }
}

/** Each harness this machine uses, and each named account beside it, as the harness says it stands. */
function signIns(opts: InventoryOpts): InventoryItem[] {
  const inUse = harnessesInUse(opts.config)
  if (opts.accounts === null) {
    return [...inUse].map((harness) =>
      item({
        id: `sign-in:${harness}`,
        kind: 'sign-in',
        label: harness,
        state: 'unknown',
        said: opts.accountsUnsaid ?? 'its harness did not say in time',
      }),
    )
  }
  return opts.accounts
    .filter((one) => one.kind === 'subscription' && one.canSignIn)
    .filter((one) => one.name !== null || inUse.has(one.harness))
    .map((one) => {
      const status = one.status
      const state = status.signedIn ? 'set' : signedOut(status.problem) ? 'missing' : 'unknown'
      return item({
        id: one.name === null ? `sign-in:${one.harness}` : `sign-in:${one.harness}:${one.name}`,
        kind: 'sign-in',
        label: one.name === null ? one.harness : `${one.harness} · ${one.name}`,
        state,
        until: status.signedIn ? (status.until ?? null) : null,
        said: status.signedIn ? null : (status.problem ?? 'not signed in'),
      })
    })
}

/**
 * Whether a harness's own words say it is signed out, as against could not
 * say: no problem at all, not signed in, not installed. Anything else — it
 * would not answer, it said something unreadable — is `unknown`.
 */
function signedOut(problem: string | null | undefined): boolean {
  return (
    problem === null ||
    problem === undefined ||
    /not signed in|not installed|no API key/i.test(problem)
  )
}

/** Each declared key, the api-key accounts' keys, and the backup's password: where each is, by digest. */
function secrets(opts: InventoryOpts): InventoryItem[] {
  const out: InventoryItem[] = []
  for (const one of opts.secrets) {
    const variable = one.from?.startsWith('$') ? one.from.slice(1) : null
    const value = variable ? opts.env[variable] : one.value
    const set = one.from !== null && typeof value === 'string' && value.trim() !== ''
    out.push(
      item({
        id: `secret:${one.path}`,
        kind: 'secret',
        label: `${one.title}'s ${one.label}`,
        state: set ? 'set' : 'missing',
        digest: set ? keyDigest(value.trim()) : null,
        where: one.from ? [one.from] : [],
        said: set ? null : `${one.title} turns off without it`,
        variables: [...one.variables],
      }),
    )
  }
  for (const [name, account] of Object.entries(opts.config.accounts)) {
    if (account.kind !== 'api-key') continue
    const value = typeof account.key === 'string' ? account.key.trim() : ''
    out.push(
      item({
        id: `secret:accounts.${name}.key`,
        kind: 'secret',
        label: `${account.harness} · ${name}'s API key`,
        state: value ? 'set' : 'missing',
        digest: value ? keyDigest(value) : null,
        where: value ? ['config.yaml'] : [],
        said: value ? null : `agents cannot run as ${name} without it`,
      }),
    )
  }
  const backup = opts.config.backup
  if (backup.repository.trim() !== '') {
    const variable = ['RESTIC_PASSWORD', 'RESTIC_PASSWORD_FILE', 'RESTIC_PASSWORD_COMMAND'].find(
      (one) => opts.env[one]?.trim(),
    )
    const value = variable ? (opts.env[variable] ?? '') : backup.password
    out.push(
      item({
        id: 'secret:backup.password',
        kind: 'secret',
        label: 'the backup’s password',
        state: value.trim() ? 'set' : 'missing',
        digest: value.trim() ? keyDigest(value.trim()) : null,
        where: variable ? [`$${variable}`] : value.trim() ? ['config.yaml'] : [],
        said: value.trim() ? null : 'this machine’s backup cannot be opened without it',
        variables: ['RESTIC_PASSWORD'],
      }),
    )
  }
  return out
}

/** The variables a harness reads a provider's key from: pi's declared list, and Claude Code's and Codex's own. */
export const HARNESS_KEYS: readonly string[] = [
  ...new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', ...PROVIDER_ENV_KEYS]),
]

/** Which environment variable names matter to this machine, beyond any named like a credential. */
export function namesThatMatter(
  secrets: readonly SecretDeclared[],
  mcpServers: readonly McpDeclared[],
): Set<string> {
  return new Set([
    ...HARNESS_KEYS,
    ...secrets.flatMap((one) => one.variables),
    ...mcpServers.flatMap((one) => one.variables),
  ])
}

/**
 * Each environment key set anywhere on this machine — Tade's own environment,
 * or a file the scan read — with every place, and whether `tade serve` reads
 * it where a unit runs it. A key set nowhere is not listed: on another machine
 * that has it, it reads `✗` here.
 */
function envKeys(opts: InventoryOpts): InventoryItem[] {
  const scan = opts.scan
  const names = new Set<string>([...(scan?.places.keys() ?? [])])
  const declared = namesThatMatter(opts.secrets, opts.mcp)
  for (const [name, value] of Object.entries(opts.env)) {
    if (value === undefined || value === '') continue
    if (declared.has(name) || scan?.places.has(name)) names.add(name)
    else if (/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)) names.add(name)
  }
  const out: InventoryItem[] = []
  for (const name of [...names].sort()) {
    const places = scan?.places.get(name) ?? []
    const live = opts.env[name]
    const setHere = typeof live === 'string' && live !== ''
    const literal = places.filter((one) => one.state === 'literal')
    const set = setHere || places.some((one) => one.state !== 'empty')
    const digests = new Set(literal.map((one) => one.digest))
    const digest = setHere
      ? keyDigest(live.trim())
      : literal.length > 0
        ? (literal[0]?.digest ?? null)
        : null
    const where = [...(setHere ? ['Tade’s environment'] : []), ...places.map(placeSaid)]
    const service = scan?.unit ? places.some((one) => one.read === 'service') : null
    const said =
      digests.size > 1
        ? `it is set to different values in ${literal.map(placeSaid).join(' and ')}`
        : service === false && set
          ? `\`tade serve\` never reads ${
              places
                .map((one) => one.file)
                .filter(unique)
                .join(' or ') || 'a shell’s files'
            }, so the service here does not have it`
          : null
    out.push(
      item({
        id: `env:${name}`,
        kind: 'env',
        label: name,
        state: set ? 'set' : 'missing',
        digest,
        where: where.slice(0, 16),
        said,
        variables: [name],
        service,
      }),
    )
  }
  for (const other of scan?.others ?? []) {
    out.push(
      item({
        id: `file:${other.file}`,
        kind: 'env',
        label: `${other.file} (${other.holds.join(', ')})`,
        state: 'set',
        where: [other.file],
        said: 'its own tool reads it as it is, so Tade names it and leaves it alone',
      }),
    )
  }
  return out
}

function unique<T>(value: T, at: number, all: readonly T[]): boolean {
  return all.indexOf(value) === at
}

/** A place as a person reads it: `~/.zshenv:14`, `launchctl`. */
export function placeSaid(place: Pick<EnvPlace, 'file' | 'line'>): string {
  return place.line === null ? place.file : `${place.file}:${place.line}`
}

/** Each MCP server written here: on or off, and its settings by digest. */
function mcp(opts: InventoryOpts): InventoryItem[] {
  return opts.mcp.map((one) =>
    item({
      id: `mcp:${one.name}`,
      kind: 'mcp',
      label: `MCP server ${one.name}`,
      state: one.enabled ? 'set' : 'missing',
      digest: keyDigest(textOf(one.settings)),
      said: one.enabled ? null : 'it is off here',
      variables: [...one.variables],
    }),
  )
}

/** The git identity commits are made with here: by digest, never the address itself. */
async function gitIdentity(look: Look, env: InventoryOpts['env']): Promise<InventoryItem> {
  const base = { id: 'git:identity', kind: 'git' as const, label: 'git identity (user.email)' }
  const ran = await look('git', ['config', '--global', 'user.email'], { timeoutMs: GIT_MS, env })
  if (ran.missing) return item({ ...base, state: 'missing', said: 'git is not installed' })
  if (ran.timedOut) return item({ ...base, state: 'unknown', said: 'git did not answer in time' })
  const email = emailIn(ran.stdout)
  return email === null
    ? item({ ...base, state: 'missing', said: 'no user.email: commits here would have no author' })
    : item({ ...base, state: 'set', digest: keyDigest(email), where: ['~/.gitconfig'] })
}

/** An address out of `git config user.email`, or null for none. */
export function emailIn(stdout: string): string | null {
  const said = stdout.trim().split(/\r?\n/)[0]?.trim() ?? ''
  return said === '' || said.length > 320 ? null : said
}

/** Whether `gh` is signed in to GitHub here. */
async function githubSignIn(look: Look, env: InventoryOpts['env']): Promise<InventoryItem> {
  const base = { id: 'git:github', kind: 'git' as const, label: 'GitHub CLI (gh auth)' }
  const ran = await look('gh', ['auth', 'status', '--hostname', 'github.com'], {
    timeoutMs: GH_MS,
    env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  })
  if (ran.missing) return item({ ...base, state: 'missing', said: 'gh is not installed' })
  if (ran.timedOut) return item({ ...base, state: 'unknown', said: 'gh did not answer in time' })
  const status = ghStatusIn(ran.code, `${ran.stdout}\n${ran.stderr}`)
  if (status === null)
    return item({ ...base, state: 'unknown', said: 'gh said something this Tade cannot read' })
  return status.signedIn
    ? item({ ...base, state: 'set', where: ['gh'] })
    : item({ ...base, state: 'missing', said: 'gh is not signed in: `gh auth login`' })
}

/**
 * What `gh auth status` said: signed in where it says it is logged in and
 * exits 0, signed out where it says it is not, and null for anything else —
 * a `gh` whose words moved on is `unknown`, never signed out.
 */
export function ghStatusIn(code: number, said: string): { signedIn: boolean } | null {
  if (/not logged in|no oauth token|gh auth login/i.test(said) && code !== 0)
    return { signedIn: false }
  if (code === 0 && /logged in to/i.test(said)) return { signedIn: true }
  if (code === 0) return null
  return /authentication failed|token .*invalid|expired/i.test(said) ? { signedIn: false } : null
}

/** Whether origin answers one project with this machine's credentials: `git ls-remote`, asked nothing. */
async function originItem(
  look: Look,
  env: InventoryOpts['env'],
  project: { name: string; root: string },
): Promise<InventoryItem | null> {
  const base = {
    id: `origin:${project.name}`,
    kind: 'origin' as const,
    label: `origin of ${project.name}`,
  }
  const quiet = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    ...(env.GIT_SSH_COMMAND
      ? {}
      : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' }),
  }
  const remote = await look('git', ['remote', 'get-url', 'origin'], {
    cwd: project.root,
    timeoutMs: GIT_MS,
    env: quiet,
  })
  if (remote.missing || remote.timedOut) {
    return item({ ...base, state: 'unknown', said: 'git did not answer in time' })
  }
  // A project with no origin has nothing to ask.
  if (remote.code !== 0) return null
  const ran = await look('git', ['ls-remote', '--exit-code', 'origin', 'HEAD'], {
    cwd: project.root,
    timeoutMs: ORIGIN_MS,
    env: quiet,
  })
  if (ran.timedOut)
    return item({ ...base, state: 'unknown', said: 'origin did not answer in time' })
  // 2 is `--exit-code` finding no HEAD there: it answered, which is what is asked.
  if (ran.code === 0 || ran.code === 2) return item({ ...base, state: 'set', where: ['origin'] })
  return item({
    ...base,
    state: 'missing',
    said: `origin would not answer with this machine’s credentials${firstLine(ran.stderr)}`,
  })
}

/** The first line git said, with anything that could be a credential in a URL taken out. */
function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (line === '') return ''
  const plain = line.replace(/\/\/[^/@\s]*@/g, '//').slice(0, 200)
  return `: ${plain}`
}

/**
 * Whether this machine could push to one project's origin: `git push
 * --dry-run`, which asks origin for what pushing needs — its credentials
 * included — and writes nothing there or here. What the guided setup checks a
 * new machine with, because hand-over and project sync need it.
 */
export async function pushCheck(
  root: string,
  opts: { env: Readonly<Record<string, string | undefined>>; look?: Look; timeoutMs?: number },
): Promise<{ ok: boolean | null; said: string }> {
  const look = opts.look ?? run
  const ran = await look(
    'git',
    ['push', '--dry-run', '--porcelain', 'origin', 'HEAD:refs/heads/tade-push-check'],
    {
      cwd: root,
      timeoutMs: opts.timeoutMs ?? ORIGIN_MS,
      env: {
        ...opts.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(opts.env.GIT_SSH_COMMAND
          ? {}
          : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' }),
      },
    },
  )
  if (ran.missing) return { ok: false, said: 'git is not installed' }
  if (ran.timedOut) return { ok: null, said: 'origin did not answer in time' }
  return ran.code === 0
    ? { ok: true, said: 'this machine can push to origin' }
    : { ok: false, said: `this machine cannot push to origin${firstLine(ran.stderr)}` }
}

/** The per-machine apps intake connects: each set here or not, never its secrets. */
function apps(config: Config): InventoryItem[] {
  const intake = (config.extensions.intake ?? {}) as Record<string, unknown>
  const has = (key: string) => {
    const value = intake[key]
    return (typeof value === 'string' && value.trim() !== '') || typeof value === 'number'
  }
  const out: InventoryItem[] = []
  const one = (id: string, label: string, keys: readonly string[]) => {
    const some = keys.some(has)
    if (!some) return
    const all = keys.every(has)
    out.push(
      item({
        id: `app:${id}`,
        kind: 'app',
        label,
        state: all ? 'set' : 'missing',
        said: all
          ? 'made for this machine’s public name, so never copied'
          : 'only partly connected: /connect finishes it',
      }),
    )
  }
  one('github', 'GitHub App', ['github_app_id', 'github_app_key'])
  one('slack', 'Slack app', ['slack_client_id', 'slack_client_secret'])
  one('linear', 'Linear app', ['linear_client_id', 'linear_refresh_token'])
  return out
}

/** The public name, and whether caddy is here to answer it. */
function publicName(opts: InventoryOpts): InventoryItem[] {
  const web = opts.config.surfaces.web as { public?: unknown }
  const name = typeof web.public === 'string' ? web.public.trim() : ''
  if (name === '') return []
  return [
    item({
      id: 'public',
      kind: 'public',
      label: 'a public name',
      state: opts.caddy ? 'set' : 'missing',
      where: [name],
      said: opts.caddy ? null : 'caddy is not installed here, so nothing answers it',
    }),
  ]
}

/** The login shell by its name: `zsh` out of `/bin/zsh`. */
export function shellName(shell: string | undefined): string | null {
  const name = shell?.split('/').at(-1)?.trim() ?? ''
  return /^[a-z][a-z0-9.-]{0,30}$/.test(name) ? name : null
}

/** A label another machine called itself, as a name a folder in this home can have, or null. */
export function machineFolder(label: string): string | null {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return /^[a-z0-9][a-z0-9-]{0,23}$/.test(name) ? name : null
}

const KEPT = 'inventory.json'

/** Where this machine's own last inventory is kept: in its home, beside the config. */
export function ownInventoryPath(home: string): string {
  return join(home, KEPT)
}

/** Where another machine's last inventory is kept, by its name here; null for a name no folder has. */
export function keptInventoryPath(home: string, name: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,23}$/.test(name) ? join(machineDir(home, name), KEPT) : null
}

/**
 * An inventory kept at `path`, with when it was heard; null where there is
 * none or it is not one. A copy of what a machine said, read for its shape,
 * and always safe to delete. A file that is there and could not be read
 * throws: a copy nobody can read is said, never passed off as none.
 */
export async function readInventory(
  path: string,
): Promise<{ inventory: Inventory; heardAt: number } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const value = JSON.parse(text) as { inventory?: unknown; heardAt?: unknown }
    const inventory = inventoryIn(value.inventory)
    const heardAt = value.heardAt
    return inventory !== null && typeof heardAt === 'number' && Number.isFinite(heardAt)
      ? { inventory, heardAt }
      : null
  } catch (err) {
    // Not JSON is not an inventory; anything else is a fault, and thrown on.
    if (err instanceof SyntaxError) return null
    throw err
  }
}

/** Keep an inventory at `path`: `0600`, written beside itself and renamed over, so a reader never sees half. */
export async function keepInventory(
  path: string,
  inventory: Inventory,
  heardAt: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify({ inventory, heardAt })}\n`, { mode: 0o600 })
  await rename(temp, path)
}
