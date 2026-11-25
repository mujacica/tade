import { HARNESS_CHOICES, type LaneId, orchestratorAccount, ownSignInName } from '@tade/core'
import type { SignInKey, SignInStanding, WebSigningIn } from '@tade/web'
import { notify, type Wiring } from './context.ts'
import { COLS, LOOK_MS, SignInLane } from './sign-in-lane.ts'

// The orchestrator's own sign-in, driven from the person's own phone
// (`@tade/web`'s `signing-in.ts`): `/login` typed on the away view's line,
// carried out rather than pointed back at the machine.
//
// What `/login` at the machine runs in a terminal over the window
// (`Machine.logIn`), run instead in a lane of its own for a machine nobody is
// at (`sign-in-lane.ts`, which an account's sign-in from the phone runs in
// too). When it ends signed in, the orchestrator starts again on it, as
// `/login` at the machine does.

export { COLS, LOOK_MS }

/**
 * The lane it runs in: one at a time, beside the orchestrator's own task
 * (`ORCHESTRATOR_TASK`, `tade/orchestrator`), under one with no task file.
 */
const TASK = 'tade/orchestrator-sign-in'
export const LANE = `${TASK}/shell` as LaneId

/** Said where it is ended from the phone. */
export const CANCELLED = 'Cancelled: the orchestrator is as it was.'

/** What the window gives it. */
export interface SigningDeps {
  /** Start the orchestrator again on its sign-in now, once any turn is over; absent, there is none. */
  restart?: () => void
  /** The keys a screen is scrubbed of (`knownHere`). */
  known: () => string[]
}

export class OrchestratorSignIn implements WebSigningIn {
  private readonly wire: Wiring
  private readonly deps: SigningDeps
  private readonly lane: SignInLane

  constructor(wire: Wiring, deps: SigningDeps) {
    this.wire = wire
    this.deps = deps
    this.lane = new SignInLane(wire, {
      task: TASK,
      title: 'orchestrator sign-in',
      verb: 'orchestrator sign-in',
      cancelled: CANCELLED,
      known: deps.known,
    })
  }

  look(_device: string): SignInStanding {
    return this.lane.look()
  }

  start(device: string): SignInStanding {
    return this.lane.start(
      device,
      () => {
        const config = this.wire.opts.config
        const harness = config.orchestrator.harness
        const account = orchestratorAccount(config)
        const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
        const who = account ?? ownSignInName(config, harness) ?? `${title}'s own sign-in`
        const signing = this.wire.opts.client.signInFor(harness, account, { browser: false })
        return {
          key: `${harness}:${account ?? ''}`,
          who,
          how: signing.how,
          launch: signing.launch,
          couldNotStart: (why) => `The orchestrator's sign-in could not start here: ${why}`,
          failed: `${who}'s sign-in ended before it finished: the orchestrator is as it was.`,
          done: () => this.signedIn(who),
        }
      },
      (why) => `The orchestrator cannot be signed in here: ${why}`,
    )
  }

  type(_device: string, text: string): SignInStanding {
    return this.lane.type(text)
  }

  key(_device: string, key: SignInKey): SignInStanding {
    return this.lane.key(key)
  }

  cancel(device: string): SignInStanding {
    return this.lane.cancel(device)
  }

  beat(now: number): void {
    this.lane.beat(now)
  }

  /** Signed in: the orchestrator started again on it, where something can. */
  private signedIn(who: string): string {
    if (this.deps.restart === undefined || this.wire.opts.restartThinker === undefined) {
      return `Signed in as ${who}: the orchestrator runs on it the next time Tade starts.`
    }
    notify(this.wire, `the orchestrator was signed in from away as ${who}`)
    this.deps.restart()
    return `Signed in as ${who}: the orchestrator starts again on it once any turn it is in is over.`
  }
}
