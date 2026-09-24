// Whether Tade can actually do anything yet, and what would fix it.
//
// A fresh machine has no config and no model, and the difference
// between a tool people keep and one they delete is whether that first minute
// tells them what to do or shows them an empty screen.
//
// Pure: facts in, an ordered list of steps out. Gathering the facts touches the
// filesystem and the network; deciding what they mean does not, so the deciding
// is here and exhaustively testable.

import type { InstallCommand } from './programs.ts'

// A judge is a Tade concept with a port and a registry behind it, and Jev is
// one implementation of it — so the step is `judge`, never a vendor's name.
export type StepId =
  | 'native'
  | 'programs'
  | 'project'
  | 'model'
  | 'workspace'
  | 'voice'
  | 'talk'
  | 'judge'
  | 'extensions'
  | 'keys'
  /** The closing check, which is an act rather than a fact: see `worksStep`. */
  | 'works'

/**
 * A binary Tade is built on that did not load, or cannot be run.
 *
 * node-pty is every terminal Tade opens and better-sqlite3 is the index over
 * the journal, and a native module is the one thing an install can get
 * half-right: the JavaScript arrives and the binary does not. Left to be
 * found at the first lane it is `posix_spawnp failed.` and nothing else, so
 * the words are made where the trouble is and carried here whole.
 */
export interface NativeTrouble {
  /** The module: `node-pty`, `better-sqlite3`. */
  module: string
  /** What is wrong, as a clause a checklist can hold. */
  clause: string
  /** All of it, with the commands that fix it. Said, never run. */
  fix: string
  /**
   * Whether Tade can work at all with it like this. node-pty is every lane
   * there is, so a helper that cannot be run stops everything; better-sqlite3
   * is an index over the journal that the journal works without, so a broken
   * one is said and is never a reason to stop.
   */
  blocking: boolean
}

/** A program something Tade is set up to use needs, and this machine has not got. */
export interface MissingProgram {
  /** As it is run: `tmux`, `gh`. */
  command: string
  title: string
  /** What needs it and what for, in its own words. */
  why: string
  /** Nothing Tade is set up to use needs it, so it never blocks. */
  optional: boolean
  /** The exact command that would install it here, or why there is none. */
  install: InstallCommand
}

/** A credential an extension that is on says it still needs. */
export interface WantedKey {
  /** The extension it belongs to, as the config names it. */
  extension: string
  title: string
  /** What it needs, in the extension's own words. */
  problem: string
}

/** What opening a lane, running a command in it and closing it actually did. */
export interface LaneProof {
  ok: boolean
  /** The driver the lane was opened with. */
  driver: string
  /** What happened, in one sentence, whether it worked or not. */
  says: string
}

export interface ReadinessFacts {
  /** `~/.tade/config.yaml` exists and parses. */
  configExists: boolean
  /** Projects named in the config. */
  projects: string[]
  /** The directory Tade was started in, and whether it is a git repo. */
  cwd: string
  cwdIsRepo: boolean
  /** The harness has a provider logged in. */
  loggedIn: boolean
  /** Provider API keys visible in the environment, by variable name. */
  apiKeys: string[]
  /** A model named for the orchestrator. */
  orchestratorModel: string | null
  /** The configured workspace driver, and whether this machine can run it. */
  driver: string
  driverOk: boolean
  /**
   * Whether the config actually names one. Without this, the most consequential
   * choice there is — whether agents survive you closing the window — is made
   * by a default nobody was shown.
   */
  driverChosen: boolean
  /**
   * Whether the config names the key you talk with. Like the driver: the
   * default works, but a key you will press a hundred times a day is worth
   * being shown once.
   */
  talkChosen?: boolean
  /** Speech, which is never required. */
  micOk: boolean
  speechOk: boolean
  speechReason: string | null
  /**
   * A judge's key is in the environment. Never required, and never asked for
   * before Tade works: it is the only step that costs money and the only one
   * that sends anything anywhere.
   */
  judgeKey?: boolean
  /**
   * Somebody has answered the question, either way. "Not now" is a finished
   * step, not a nag, and this reads whatever records that an extension is on
   * or off rather than keeping a second answer of its own.
   */
  judgeChosen?: boolean
  /**
   * The extensions this machine has, and which of them somebody has decided
   * about. Nothing Tade or you wrote is on until it is picked, so the last
   * question of setting up is which ones to use — and one already answered,
   * here or in the window, is never asked again.
   */
  extensions?: readonly { name: string; title: string; chosen: boolean }[]
  /**
   * The native binaries that did not load or cannot be run.
   *
   * Absent means nobody looked, which is what the window's own reading of
   * readiness does — it happens on every open and must stay cheap. Absent is
   * read as nothing wrong, for the same reason every other optional fact is:
   * a step can only ever report what somebody went and found out.
   */
  native?: readonly NativeTrouble[]
  /** Programs that are needed here and not installed. Absent where nobody looked. */
  missing?: readonly MissingProgram[]
  /**
   * Why the configured driver cannot run here, in the driver's own words.
   * Without it `driverOk: false` is reported as “not installed”, which is the
   * wrong sentence for a helper whose permission bit is wrong.
   */
  driverReason?: string | null
  /** Keys the extensions that are on say they still need. Absent where nobody looked. */
  keysWanted?: readonly WantedKey[]
}

export interface Step {
  id: StepId
  title: string
  done: boolean
  /**
   * What is missing, in words that say what to do about it. Empty when done.
   */
  detail: string
  /** Without this, Tade cannot run an agent at all. */
  required: boolean
}

/** What a fresh machine still needs, in the order it should be done. */
export function readiness(facts: ReadinessFacts): Step[] {
  return [
    // First, both of them, and in this order: what Tade is built on, then what
    // it shells out to. Everything below is answered by running something — a
    // sign-in, an installer, a download — and all of it runs in a lane, so a
    // node-pty that cannot spawn makes every question after this one fail with
    // five words about `posix_spawnp` that name neither the file nor the reason.
    native(facts),
    programs(facts),
    project(facts),
    model(facts),
    workspace(facts),
    voice(facts),
    talk(facts),
    judge(facts),
    extensions(facts),
    // After the extensions, because which keys are wanted is decided by which
    // of them are on, and that is the question just above.
    keys(facts),
  ]
}

/**
 * The closing check: a lane opened, a command run in it, the lane closed.
 *
 * Not one of the steps above, because it is an act and they are facts. A
 * wizard that says “all set” without ever starting a process is how
 * `posix_spawnp failed.` reaches a user, so this is run at the end of setting
 * up and by `--check`; and it is deliberately not part of what the window
 * reads before it opens, which happens every time and must cost nothing.
 */
export function worksStep(proof: LaneProof | null): Step {
  if (proof === null) {
    return { id: 'works', title: 'It works', done: false, detail: 'not tried yet', required: true }
  }
  return {
    id: 'works',
    title: 'It works',
    done: proof.ok,
    detail: proof.ok ? '' : proof.says,
    required: true,
  }
}

/** Ready enough to be useful. Voice is a convenience and never blocks. */
export function isReady(steps: readonly Step[]): boolean {
  return steps.every((step) => step.done || !step.required)
}

/** The first thing still to do, for a prompt that asks one question at a time. */
export function nextStep(steps: readonly Step[]): Step | null {
  return steps.find((step) => !step.done) ?? null
}

/**
 * The binaries Tade is built on, and whether they can be run.
 *
 * First of everything, and required: a Tade that cannot open a lane is not a
 * reduced Tade, it is one that cannot run an agent at all. Nothing here is
 * fixed by Tade — the two commands that fix it are said instead, because
 * chmod-ing a file inside somebody's node_modules would itself have to be
 * spawned through the thing that is broken.
 */
function native(facts: ReadinessFacts): Step {
  const troubles = facts.native ?? []
  return {
    id: 'native',
    title: 'What Tade is built on',
    done: troubles.length === 0,
    detail: troubles.map((one) => one.clause).join('; '),
    // Only what actually stops Tade may stop setting it up.
    required: troubles.length === 0 || troubles.some((one) => one.blocking),
  }
}

/**
 * The programs Tade shells out to, and which of them are not here.
 *
 * Which programs those are is nobody's list: every driver, harness and forge
 * declares what it needs, and what is missing is read off those declarations.
 * Only what something Tade is set up to use actually requires can hold this
 * up — tmux on a machine running the pty driver is a row on a page, not a
 * question, because installing what nobody asked for is the other way to get
 * this wrong.
 */
function programs(facts: ReadinessFacts): Step {
  const missing = facts.missing ?? []
  const needed = missing.filter((one) => !one.optional)
  return {
    id: 'programs',
    title: 'The programs Tade runs',
    done: needed.length === 0,
    detail: needed.map((one) => `${one.title} — ${one.why}`).join('; '),
    required: true,
  }
}

/**
 * The keys the extensions that are on say they still need.
 *
 * Asked of the extensions rather than of a list here, and only of the ones
 * somebody turned on: an extension nobody picked is off and needs nothing,
 * and one that is ready — the forge, where `gh` is already signed in — is not
 * asked for a token it would never read. Never required: what a key unlocks
 * is extra, and Tade works without every one of them.
 */
function keys(facts: ReadinessFacts): Step {
  const wanted = facts.keysWanted ?? []
  return {
    id: 'keys',
    title: 'Keys, where something wants one',
    done: wanted.length === 0,
    detail: wanted.map((one) => `${one.title}: ${one.problem}`).join('; '),
    required: false,
  }
}

function project(facts: ReadinessFacts): Step {
  if (facts.projects.length > 0) {
    return {
      id: 'project',
      title: 'A project to work on',
      done: true,
      detail: '',
      required: true,
    }
  }
  return {
    id: 'project',
    title: 'A project to work on',
    done: false,
    // The repository someone is standing in is almost always the one they
    // meant, so the question is a confirmation rather than an interrogation.
    detail: facts.cwdIsRepo
      ? `add ${facts.cwd}, or name another repository`
      : `${facts.cwd} is not a git repository — name one`,
    required: true,
  }
}

function model(facts: ReadinessFacts): Step {
  const hasCredentials = facts.loggedIn || facts.apiKeys.length > 0
  if (hasCredentials && facts.orchestratorModel) {
    return { id: 'model', title: 'A model to think with', done: true, detail: '', required: true }
  }
  if (!hasCredentials) {
    return {
      id: 'model',
      title: 'A model to think with',
      done: false,
      // Tade holds no credentials of its own; this is the harness's business.
      detail: 'no provider is logged in and no API key is set',
      required: true,
    }
  }
  return {
    id: 'model',
    title: 'A model to think with',
    done: false,
    detail: `credentials found (${facts.apiKeys.join(', ') || 'logged in'}) but no model is named`,
    required: true,
  }
}

/**
 * Somewhere for the agents to live. There is nothing to start — Tade is the
 * window and it is already running — but a driver the machine cannot provide
 * is a spawn that fails later, with no clue why, so it is checked here.
 */
function workspace(facts: ReadinessFacts): Step {
  if (!facts.driverOk) {
    return {
      id: 'workspace',
      title: 'Somewhere to run agents',
      done: false,
      // The driver's own reason where there is one: “not installed” is the
      // wrong sentence for a driver that is installed and cannot spawn.
      detail: facts.driverReason ?? `workspace.driver is ${facts.driver}, which is not installed`,
      required: true,
    }
  }
  return {
    id: 'workspace',
    title: 'Somewhere to run agents',
    // A driver that works is enough to run, so this never blocks. But until
    // somebody has actually chosen, the wizard still asks: whether agents
    // outlive the window is not a thing to decide by default and never mention.
    done: facts.driverChosen,
    detail: facts.driverChosen ? '' : `${facts.driver}, so agents stop when Tade does`,
    required: false,
  }
}

function voice(facts: ReadinessFacts): Step {
  const done = facts.micOk && facts.speechOk
  return {
    id: 'voice',
    title: 'Speech, if you want it',
    done,
    detail: done ? '' : (facts.speechReason ?? 'no microphone'),
    // Typing works perfectly well; this is never a reason to stop.
    required: false,
  }
}

/**
 * A second opinion, if you want one. Last of all: Tade works with no judge —
 * not in a reduced mode, exactly as it does today, on the path every test
 * exercises — so nobody should meet this before Tade works, and saying no
 * costs them nothing and is never asked again.
 */
function judge(facts: ReadinessFacts): Step {
  const done = facts.judgeKey === true || facts.judgeChosen === true
  return {
    id: 'judge',
    title: 'A second opinion, if you want one',
    done,
    detail: done ? '' : 'a small model that reads diffs and logs; nothing runs without it',
    required: false,
  }
}

/**
 * Which extensions to use. Last, and never required: an extension nobody has
 * picked is listed and off, so the worst that comes of skipping this is that
 * Tade does exactly what it does without any of them. Only the ones nobody
 * has decided about are counted — a step that asks again about something you
 * turned on last week is a step people learn to skip.
 */
function extensions(facts: ReadinessFacts): Step {
  const all = facts.extensions ?? []
  const waiting = all.filter((one) => !one.chosen)
  return {
    id: 'extensions',
    title: 'Which extensions to use',
    done: waiting.length === 0,
    detail:
      waiting.length === 0
        ? ''
        : `${waiting.length} of ${all.length} not picked yet: ${waiting.map((one) => one.title).join(', ')}`,
    required: false,
  }
}

/** The key you hold to talk. */
function talk(facts: ReadinessFacts): Step {
  const done = facts.talkChosen === true
  return {
    id: 'talk',
    title: 'Push to talk',
    done,
    detail: done ? '' : 'ctrl+space, unless you choose another',
    required: false,
  }
}
