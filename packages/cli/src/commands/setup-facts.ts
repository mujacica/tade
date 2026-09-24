import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Config,
  defaultConfigPath,
  type InstallersHere,
  loadConfig,
  type MissingProgram,
  type NativeTrouble,
  type ReadinessFacts,
  tadeHome,
  type WantedKey,
} from '@tade/core'
import type { DeclaredSecret } from '@tade/extensions-core'
import { loggedInProviders } from '@tade/harnesses-pi'
import { loadExtensions } from '@tade/orchestrator'
import { makeRecorder, makeTranscriber } from '@tade/voice-stt'
import { drivers } from '@tade/workbench'
import {
  type HarnessHere,
  installersHere,
  lookAtHarnesses,
  missingFrom,
  nativeProblems,
} from '@tade/workbench/machine'
import { lookAtPrograms, type ProgramLook, programsNeeded } from '@tade/workbench/programs'
import { nativeTrouble } from '../native.ts'

// What setting up reads about this machine, and nothing about what it then
// asks.
//
// Two depths, on purpose. The window reads readiness on every open to decide
// whether to lead somebody through setting up, and that must cost nothing — so
// `gather()` on its own is config, a file or two, and no process. Everything
// that spawns something or walks PATH is `lookHere()`, which is the wizard's
// and `--check`'s, and is handed back in so a step that changed the machine
// can be answered by looking again rather than by guessing what changed.
//
// Every list here is read off a declaration: the programs from what the
// drivers, harnesses and forges say they need, the sign-ins from the harnesses
// themselves, the keys from what each extension says it is missing. Nothing in
// this file knows that tmux is a thing.

/** Provider keys the harness can use without being signed in. */
const API_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
]

/** What this machine has, as far as anybody went and looked. */
export interface Look {
  /** Every program anything declared, as this machine has it. */
  programs: readonly ProgramLook[]
  /** The ones that are not here, with the exact command for each. */
  missing: readonly MissingProgram[]
  /** The native binaries Tade is built on, where one cannot be run. */
  native: readonly NativeTrouble[]
  /** Every harness, whether it runs here, and who it is signed in as. */
  harnesses: readonly HarnessHere[]
  /** Extensions that are on and say they still need a key. */
  keysWanted: readonly WantedKey[]
  /** Every credential the extensions declare, for pasting one in. */
  secrets: readonly DeclaredSecret[]
  /** The extensions this machine has, and which somebody has decided about. */
  extensions: readonly { name: string; title: string; chosen: boolean }[]
  /** What this machine installs with. */
  installers: InstallersHere
}

/**
 * Everything that costs a process: what is installed, what is signed in, what
 * still wants a key.
 *
 * Never throws. A machine where nothing can be asked is a machine somebody is
 * still trying to set up, and an empty answer that says so is worth more than
 * a stack trace in place of the first screen.
 */
export async function lookHere(home = tadeHome()): Promise<Look> {
  const loaded = await loadConfig(defaultConfigPath())
  const config = loaded.ok ? loaded.config : null
  const installers = installersHere()
  const [programs, native, harnesses, extensions] = await Promise.all([
    config
      ? programsNeeded(config, home)
          .then((needs) => lookAtPrograms(needs))
          .catch(() => [])
      : Promise.resolve([]),
    nativeTroubles(home),
    config ? lookAtHarnesses(config, home).catch(() => []) : Promise.resolve([]),
    extensionsHere(config),
  ])
  return {
    programs,
    missing: missingFrom(programs, installers),
    native,
    harnesses,
    keysWanted: extensions.keysWanted,
    secrets: extensions.secrets,
    extensions: extensions.listed,
    installers,
  }
}

/**
 * The binaries Tade is built on, and whether they can be run here.
 *
 * Not whether they loaded: a module that did not load never got this far, and
 * `nativeTrouble` in `bin.ts` has already said so. What is left is the half an
 * install gets wrong silently — node-pty's helper arriving without its
 * executable bit, which is every lane failing with five words that name
 * neither the file nor the reason, and better-sqlite3 not being there at all,
 * which only costs the journal its index.
 */
export async function nativeTroubles(home = tadeHome()): Promise<NativeTrouble[]> {
  return (await nativeProblems(home)).map((problem) => ({
    module: problem.module,
    clause: problem.clause,
    // A driver's reason is already the whole of it, with the two commands in
    // it. A loader's error is not, so it is turned into the same advice
    // `bin.ts` gives when one of these fails to load at all.
    fix:
      problem.error === undefined
        ? problem.said
        : (nativeTrouble(problem.error) ?? `${problem.module} did not load: ${problem.said}`),
    blocking: problem.blocking,
  }))
}

/**
 * The facts, as deep as somebody looked.
 *
 * With no look it is the cheap half and the machine's part of readiness is
 * simply absent, which every step reads as nothing to do — the same way an
 * optional fact has always been read. That is what keeps opening the window
 * free: it asks this on every open.
 */
export async function gather(
  cwd = process.cwd(),
  look: Look | null = null,
): Promise<ReadinessFacts> {
  const loaded = await loadConfig(defaultConfigPath())
  const config = loaded.ok ? loaded.config : null
  const voice = config?.surfaces.voice
  const driver = config?.workspace.driver ?? 'pty'
  const [mic, speech, workspace] = await Promise.all([
    makeRecorder(voice?.mic ?? {}).available(),
    makeTranscriber(voice?.stt ?? {}).available(),
    driverAvailability(driver),
  ])
  const text = readConfigText()
  return {
    configExists: loaded.ok && loaded.exists,
    projects: Object.keys(config?.projects ?? {}),
    cwd,
    cwdIsRepo: existsSync(join(cwd, '.git')),
    // With a look, every harness has answered for itself. Without one the
    // question is only whether Tade can start talking at all, and that is
    // pi's own answer — the same function pi's adapter gives.
    loggedIn: look
      ? look.harnesses.some((one) => one.signedIn)
      : (await loggedInProviders().catch(() => [])).length > 0,
    apiKeys: API_KEYS.filter((name) => (process.env[name] ?? '').length > 0),
    orchestratorModel: config?.orchestrator.model ?? null,
    driver,
    driverOk: workspace.ok,
    // The first line of it: a checklist holds one line per step, and node-pty's
    // own answer to this is a paragraph with two commands in it, which the
    // native step says whole.
    driverReason: workspace.ok ? null : firstLine(workspace.reason),
    // Read from the file rather than the parsed config, which supplies a
    // default: the question is whether a person chose, not what is in effect.
    driverChosen: /^\s*driver:/m.test(text),
    talkChosen: /^\s*talk:/m.test(text),
    micOk: mic.ok,
    speechOk: speech.ok,
    speechReason: speech.ok ? null : speech.reason,
    judgeKey: (process.env[judgeKeyVariable(config?.extensions?.jev)] ?? '').length > 0,
    // Whatever records that the extension is on or off is the answer: two
    // places saying whether a judge is on is the bug this avoids.
    judgeChosen: config?.extensions?.jev?.enabled !== undefined,
    ...(look
      ? {
          extensions: look.extensions,
          native: look.native,
          missing: look.missing,
          keysWanted: look.keysWanted,
        }
      : {}),
  }
}

/** The first line of something, for a place that holds one line. */
function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

/** Where a judge's key lives unless the config says another variable. */
function judgeKeyVariable(settings: Record<string, unknown> | undefined): string {
  const said = settings?.key_env
  return typeof said === 'string' && said !== '' ? said : 'TYPESAFE_API_KEY'
}

/** The config as written, for telling a choice apart from a default. */
function readConfigText(): string {
  try {
    return readFileSync(defaultConfigPath(), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Whether this machine can provide the configured driver, in the driver's own
 * words. Asked of the driver itself, so `tade setup --check` cannot drift from
 * what opening the workbench will actually do.
 */
async function driverAvailability(driver: string): Promise<{ ok: boolean; reason: string }> {
  const make = drivers[driver]
  if (!make) return { ok: false, reason: `there is no driver called ${driver}` }
  const made = make(tadeHome())
  try {
    const can = await made.available()
    return can.ok ? { ok: true, reason: '' } : { ok: false, reason: can.reason }
  } finally {
    // Made only to be asked, so it is let go of again.
    await made.detach().catch(() => {})
  }
}

/**
 * What the extensions say: which of them are here, which somebody has decided
 * about, and which are on and still want a key.
 *
 * Asked of the host rather than a list written here, so the ones Tade ships
 * with and the ones in your extensions folder are offered the same way — and
 * what a key is *for* is the extension's own sentence, which is why nothing
 * here has an opinion about Sentry. Never throws: nothing to offer is an empty
 * list, not a failed setup.
 */
async function extensionsHere(config: Config | null): Promise<{
  listed: { name: string; title: string; chosen: boolean }[]
  keysWanted: WantedKey[]
  secrets: DeclaredSecret[]
}> {
  if (!config) return { listed: [], keysWanted: [], secrets: [] }
  try {
    const host = await loadExtensions({
      config,
      home: tadeHome(),
      configPath: defaultConfigPath(),
    })
    const secrets = host.secrets()
    const listed = host.list()
    return {
      listed: listed.map((one) => ({
        name: one.name,
        title: one.title,
        chosen: config.extensions[one.name]?.enabled !== undefined,
      })),
      // Only the ones that are on, say something is missing, and have a
      // declared key that is nowhere yet. Three conditions and each of them
      // stops a question nobody should be asked: one nobody turned on is off
      // and needs nothing; one that is ready — the forge, where `gh` is
      // already signed in — is never asked for a token it would not read; and
      // one whose key is set and which wants something else instead (Sentry,
      // waiting to be told which organization) is left to its own page, which
      // has a field for whatever that is. So a key is asked for exactly once,
      // and skipping it is answered by asking again next time — which is
      // right, because a key is the one thing nothing else can supply.
      keysWanted: listed
        .filter((one) => one.state === 'needs setup')
        .filter((one) =>
          secrets.some((secret) => secret.extension === one.name && secret.from === null),
        )
        .map((one) => ({
          extension: one.name,
          title: one.title,
          problem: one.problem ?? 'it needs a key',
        })),
      secrets,
    }
  } catch {
    return { listed: [], keysWanted: [], secrets: [] }
  }
}
