import type { Config, InboxRow, Queued, TadeEvent } from '@tade/core'
import type { Device, ServerOptions, Surface, TaskFacts } from '@tade/web'
import { surfaceOf } from '@tade/web'
import type { Workbench } from '@tade/workbench'
import { webActing } from './web-acting.ts'
import { type Talking, webAsking } from './web-asking.ts'
import { steeringFor } from './web-beat.ts'
import { webDrafting } from './web-drafting.ts'

// The three halves of the away view the window hands over, and the one rule
// they share.
//
// **Each is handed over only where its own setting says so, and absence is the
// enforcement.** With a setting off there is no interface and no route: a
// crafted call meets the same `404` as a path nobody built, rather than a `403`
// naming a setting — because an off capability is not a thing to probe. And
// each one's `unlocked()` is read again at every act, every turn and every
// save, so turning a setting **off** takes authority away now while turning one
// **on** waits for the route table a restart builds. Asymmetric in the
// direction that takes authority away, and each setting's own words say so.
//
// **Its own file so the rule above is written once**, and so `web.ts`'s `open`
// reads as the listener coming up rather than as three nested conditionals.
// What each half does is `web-acting.ts`, `web-asking.ts` and
// `web-drafting.ts`; what is here is which of them exist.

/** What the three halves need of the window. Accessors, every one of them. */
export interface Halving {
  tade: Workbench
  home: string
  /** The window's own config, read **at** the act: a grant turned off a second ago counts. */
  config: () => Config
  /** The facts a task's row carried, out of the row itself (`factsOf`). */
  seen: (task: string) => TaskFacts | null
  /** Why work that came from outside may not go ahead now, or null. */
  stands: (row: InboxRow) => Promise<string | null>
  queue: () => { items: readonly Queued[]; events: readonly TadeEvent[] }
  talking: () => boolean
  /** The devices as they are **now**, so a grant narrowed a second ago counts. */
  devices: () => readonly Device[]
  conversation: () => { busy: boolean; whose: string }
  talk: Talking
  /** A draft was saved, so whatever folds the templates reads them again. */
  saved: () => void
  now: () => number
}

/** Which halves this surface hands over, and nothing about what they do. */
export function halvesFor(surface: Surface, deps: Halving): Partial<ServerOptions> {
  return {
    // **Handed over only where the setting says so**, so with acting off
    // there is no `WebActing` and no acting route — a crafted call meets the
    // same `404` as a path nobody built. `unlocked()` is read again at every
    // act, which is what makes turning the setting off take effect now
    // rather than at the next restart.
    ...(surface.acting
      ? {
          acting: webActing({
            tade: deps.tade,
            acting: () => surfaceOf(deps.config().surfaces.web).acting,
            // **The facts the row carried, out of the row itself.** What a
            // verb's `was` is compared against is built by `factsOf` from
            // the same projected task the device tapped, so a mismatch is
            // the world having moved and never two spellings of a
            // revision.
            seen: (task) => deps.seen(task),
            steering: (task) => steeringFor(deps.tade, task),
            // The queue's own rule asked of work that came from outside,
            // which needs the extension host: only a window can ask a
            // watch whether a request still stands.
            stands: (row) => deps.stands(row),
            queue: deps.queue,
            // The window's own config, read at the act: a grant somebody
            // turned off a second ago has to mean something before the next
            // restart.
            config: () => deps.config(),
            now: () => deps.now(),
          }),
        }
      : {}),
    // **Handed over only where the setting says so**, like acting and for
    // the same reason: with talking off there is no `WebAsking` and no
    // asking route, so a crafted call is the `404` of a path nobody built.
    // `unlocked()` is read again at every turn.
    ...(surface.talking
      ? {
          asking: webAsking({
            talking: () => deps.talking(),
            // The list as it is **now**, so a grant narrowed or a phone
            // disconnected a second ago means something before the next
            // restart.
            devices: () => deps.devices(),
            seen: () => deps.conversation(),
            ask: (said, arm) => deps.talk.askRemote(said, arm),
            stop: () => deps.talk.stopTurn(),
            said: (text, device) => deps.talk.remoteSaid(text, device),
            now: () => deps.now(),
          }),
        }
      : {}),
    // **Handed over only where the setting says so**, like the other two: with
    // drafting off there is no `WebDrafting` and no saving route, so a
    // crafted call is the `404` of a path nobody built.
    // `unlocked()` is read again at every save.
    ...(surface.drafting
      ? {
          drafting: webDrafting({
            home: deps.home,
            drafting: () => surfaceOf(deps.config().surfaces.web).drafting,
            // A save lands in a file, and a file edit writes no journal
            // line — so the fold that reads the templates is told rather
            // than left to find out on its own clock.
            saved: () => deps.saved(),
            now: () => deps.now(),
          }),
        }
      : {}),
  }
}
