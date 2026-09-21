import { CATALOGUE, type CatalogueEntry, catalogued } from './catalogue.ts'
import { serverNameProblem } from './naming.ts'
import type { AuthKind, SandboxKind, ServerDeclaration, ServerScope } from './port.ts'

// What Tade has been told about, and what is wrong with each of them.
//
// Pure: a table in the config plus the catalogue in, declared servers out. No
// filesystem, no clock, no network — whether the program is actually on this
// machine and whether the credential is findable are a transport's `ready()`,
// asked later and answered from the machine.
//
// The merge rule is one sentence: **the catalogue fills in what you did not
// write.** A name that is in neither the catalogue nor complete in the config
// is a problem said in words, never a server quietly doing nothing.

/** `mcp.servers.<name>` as the config schema parsed it. */
export interface ServerSettings {
  enabled?: boolean | undefined
  transport?: string | undefined
  command?: string | undefined
  args?: readonly string[] | undefined
  url?: string | undefined
  env?: Readonly<Record<string, string>> | undefined
  header?: Readonly<Record<string, string>> | undefined
  auth?: AuthKind | undefined
  auth_name?: string | undefined
  key_env?: string | undefined
  tools?: readonly string[] | undefined
  scope?: ServerScope | undefined
  sandbox?: SandboxKind | undefined
  about?: string | undefined
}

/** One transport there is, as a declaration can be judged against it. */
export interface TransportKind {
  /** What a declaration names it: `stdio`, `http`. */
  id: string
  /** It starts a program, so a server of it needs a command and can be one per project. */
  spawns: boolean
  /** It reaches somewhere that is already running, so a server of it needs an address. */
  network: boolean
}

/** Where a declaration came from, for the page to say whose words these are. */
export type DeclaredFrom = 'catalogue' | 'yours' | 'both'

/** One server Tade has been told about, and what is wrong with it. */
export interface DeclaredServer {
  declaration: ServerDeclaration
  title: string
  description: string
  /** What somebody is doing when they reach for it: the catalogue's words, or none. */
  workflow: readonly string[]
  from: DeclaredFrom
  /**
   * What is wrong with it, or what has to happen before it can work — in
   * words somebody can act on. Null when there is nothing wrong.
   */
  problem: string | null
  /** What the catalogue says is true about it that nobody would guess. */
  note: string | null
  /** Which of its keys the person wrote themselves, so the page can say so. */
  yours: readonly string[]
}

export interface DeclareOptions {
  /** What `mcp.servers` says. */
  servers?: Readonly<Record<string, ServerSettings | undefined>> | undefined
  /** The servers Tade knows about. The shipped one unless a test says otherwise. */
  catalogue?: readonly CatalogueEntry[]
  /**
   * The transports there are, each with what a declaration can be judged
   * against: whether it starts a program, and whether it reaches one that is
   * already running. A server whose transport is not among them is declared
   * and said to be unreachable — which is what a catalogue entry for a kind
   * of server Tade cannot talk to yet honestly looks like.
   *
   * Capabilities, never a name (R3): "one per project" is only possible where
   * something is *started* in that project, and which transports those are is
   * theirs to declare rather than a list of ids kept here.
   */
  transports?: readonly TransportKind[]
}

/**
 * Every server Tade has been told about — the ones in the config, and the
 * catalogue's beside them — in name order, each with what is wrong with it.
 *
 * The catalogue's own are listed whether or not anybody has decided about
 * them: that is what makes them a list of things you could turn on. Only ones
 * whose `enabled` is `true` are ever opened, and nothing here opens anything.
 */
export function declared(options: DeclareOptions = {}): DeclaredServer[] {
  const catalogue = options.catalogue ?? CATALOGUE
  const written = options.servers ?? {}
  const names = [...new Set([...Object.keys(written), ...catalogue.map((one) => one.name)])].sort()
  return names.map((name) => one(name, written[name], catalogue, options.transports))
}

function one(
  name: string,
  settings: ServerSettings | undefined,
  catalogue: readonly CatalogueEntry[],
  transports: readonly TransportKind[] | undefined,
): DeclaredServer {
  const entry = catalogued(name, catalogue)
  const said = settings ?? {}
  const yours = Object.keys(said).filter(
    (key) => key !== 'enabled' && said[key as keyof ServerSettings] !== undefined,
  )
  const from: DeclaredFrom = entry ? (yours.length > 0 ? 'both' : 'catalogue') : 'yours'

  // What somebody named goes in front of what the catalogue names, so a
  // machine that already exports a variable goes on working exactly as it is.
  const variables = [
    ...(said.key_env ? [said.key_env] : []),
    ...(entry?.variables ?? []).filter((one) => one !== said.key_env),
  ]
  const declaration: ServerDeclaration = {
    name,
    transport: said.transport ?? entry?.transport ?? '',
    enabled: said.enabled === true,
    about: said.about ?? entry?.description ?? '',
    command: said.command ?? entry?.command ?? null,
    args: said.args ?? entry?.args ?? [],
    url: said.url ?? entry?.url ?? null,
    env: said.env ?? entry?.env ?? {},
    header: said.header ?? entry?.header ?? {},
    auth: said.auth ?? entry?.auth ?? 'none',
    authName: said.auth_name ?? entry?.authName ?? null,
    variables,
    tools: said.tools ?? [],
    scope: said.scope ?? entry?.scope ?? 'window',
    sandbox: said.sandbox ?? 'none',
    install: entry?.install ?? null,
  }
  return {
    declaration,
    title: entry?.title ?? name,
    description: said.about ?? entry?.description ?? '',
    workflow: entry?.workflow ?? [],
    from,
    problem: problemWith(declaration, entry, transports),
    note: entry?.note ?? null,
    yours,
  }
}

/** What is wrong with a declaration, in words somebody can act on. Null when nothing is. */
export function problemWith(
  server: ServerDeclaration,
  entry: CatalogueEntry | null,
  transports: readonly TransportKind[] | undefined,
): string | null {
  const named = serverNameProblem(server.name)
  if (named) return named
  if (server.transport === '') {
    return entry
      ? `${server.name} does not say how Tade talks to it`
      : `there is no server called ${server.name} in the catalogue: say its transport and where it is`
  }
  // A transport nothing implements is not a broken declaration, it is a kind
  // of server Tade cannot talk to yet — said as such, and it comes right on
  // its own the day that transport lands.
  const kind = transports?.find((one) => one.id === server.transport)
  if (transports && !kind) {
    return `Tade cannot talk to a server over ${server.transport} yet`
  }
  // What a declaration has to say is the transport's own to want: one that
  // starts a program needs to be told which, and one that reaches something
  // already running needs to be told where.
  if (kind?.spawns && !server.command) {
    return `${server.name} is a program Tade starts, and nothing says which`
  }
  if (kind?.network && !server.url) {
    return `${server.name} answers over ${server.transport}, and nothing says where`
  }
  if ((server.auth === 'env' || server.auth === 'header') && !server.authName) {
    const where = server.auth === 'env' ? 'environment variable' : 'header'
    return `${server.name} takes its credential in an ${where}, and nothing says which: set auth_name`
  }
  if (server.scope === 'project' && kind && !kind.spawns) {
    return `${server.name} is one per project, which only a server Tade starts can be`
  }
  return null
}

/** The ones a person has turned on and nothing is wrong with: the only ones ever opened. */
export function workable(servers: readonly DeclaredServer[]): DeclaredServer[] {
  return servers.filter((one) => one.declaration.enabled && one.problem === null)
}
