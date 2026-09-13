// Whether Wilco can actually do anything yet, and what would fix it.
//
// A fresh machine has no config and no model, and the difference
// between a tool people keep and one they delete is whether that first minute
// tells them what to do or shows them an empty screen.
//
// Pure: facts in, an ordered list of steps out. Gathering the facts touches the
// filesystem and the network; deciding what they mean does not, so the deciding
// is here and exhaustively testable.

export type StepId = 'project' | 'model' | 'workspace' | 'voice'

export interface ReadinessFacts {
  /** `~/.wilco/config.yaml` exists and parses. */
  configExists: boolean
  /** Projects named in the config. */
  projects: string[]
  /** The directory Wilco was started in, and whether it is a git repo. */
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
  /** Speech, which is never required. */
  micOk: boolean
  speechOk: boolean
  speechReason: string | null
}

export interface Step {
  id: StepId
  title: string
  done: boolean
  /**
   * What is missing, in words that say what to do about it. Empty when done.
   */
  detail: string
  /** Without this, Wilco cannot run an agent at all. */
  required: boolean
}

/** What a fresh machine still needs, in the order it should be done. */
export function readiness(facts: ReadinessFacts): Step[] {
  return [project(facts), model(facts), workspace(facts), voice(facts)]
}

/** Ready enough to be useful. Voice is a convenience and never blocks. */
export function isReady(steps: readonly Step[]): boolean {
  return steps.every((step) => step.done || !step.required)
}

/** The first thing still to do, for a prompt that asks one question at a time. */
export function nextStep(steps: readonly Step[]): Step | null {
  return steps.find((step) => !step.done) ?? null
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
      // Wilco holds no credentials of its own; this is the harness's business.
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
 * Somewhere for the agents to live. There is nothing to start — Wilco is the
 * window and it is already running — but a driver the machine cannot provide
 * is a spawn that fails later, with no clue why, so it is checked here.
 */
function workspace(facts: ReadinessFacts): Step {
  if (!facts.driverOk) {
    return {
      id: 'workspace',
      title: 'Somewhere to run agents',
      done: false,
      detail: `workspace.driver is ${facts.driver}, which is not installed`,
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
    detail: facts.driverChosen ? '' : `${facts.driver}, so agents stop when Wilco does`,
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
