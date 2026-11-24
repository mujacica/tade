import type { InboxRow } from '@tade/core'
import type { MachineActs } from './acts.ts'
import type { FleetConversation } from './conversation.ts'
import type { Waking } from './doorbell.ts'
import type { FleetFeeds } from './feeds.ts'
import type { Inventories } from './inventory.ts'
import type { LinearTokens } from './linear-tokens.ts'
import type { MachinesSeen } from './machines-seen.ts'
import type { WaitingThere } from './notes-shared.ts'
import type { Settings } from './settings.ts'
import type { Talking } from './web-asking.ts'
import type { FactoryHeld } from './web-beat.ts'
import type { Lifecycle } from './web-lifecycle.ts'
import type { MachinesHeld } from './web-machines.ts'

// What the away subject (`web.ts`) needs of the rest of the window, in a file
// of its own so the list can be read without the subject: each one a method or
// two of another subject, never the subject itself, and the argument for each
// beside it.

/** What the away subject needs of the rest of the window. */
export interface AwayDeps {
  /**
   * The person's other machines (`machines-seen.ts`): what one that links here
   * said of itself (`/api/seen`), every one as the projection draws it, and
   * this machine's own figures. Three methods, never the subject. Absent, the
   * route is the `404` of a path nobody wired and the projection names no
   * machine and no figures.
   */
  machines?: Pick<MachinesSeen, 'heard' | 'rows' | 'host'>
  /**
   * What this machine has, as its last look found it, for `/api/machine`; and
   * what another machine of the person's tells it it has, kept here
   * (`/api/inventory`); and the Machines page the person's own phone draws and
   * presses (`web-machines.ts`, `MachinesHeld`). Methods, never the subject.
   * Absent, `/api/machine` says nothing of it and the told door and the page's
   * two are the `404` of a path nobody wired.
   */
  inventory?: Pick<Inventories, 'latest' | 'heard'> & MachinesHeld
  /**
   * What each other machine holds of this one's changes to notes taken there,
   * for a press there (`notes-shared.ts`), drawn on the Machines page. Absent,
   * the page knows only what machines that share with this one tell its door.
   */
  waiting?: WaitingThere
  /**
   * Every machine's journal kept here and handed on (`feeds.ts`): the far half
   * of `/api/feeds/share`, and where each machine stands for the phone's
   * Machines page. Two methods, never the subject. Absent, the route is the
   * `404` of a path nobody wired.
   */
  feeds?: Pick<FleetFeeds, 'web' | 'synced'>
  /**
   * The orchestrator's conversation, one on every machine (`conversation.ts`):
   * the far half of `/api/conversation`, the exchange and the turn lease this
   * machine keeps as the hub. Absent, the route is the `404` of a path nobody
   * wired.
   */
  conversation?: Pick<FleetConversation, 'web'>
  /**
   * Another machine of the person's acting here through this machine's own
   * gate (`acts.ts`): `/api/acts`, and the outbox a machine that links here
   * asks for what this one's orchestrator wants done there. Absent, both are
   * the `404` of a path nobody wired.
   */
  acts?: Pick<MachineActs, 'take' | 'outboxFor'>
  /** What the approve/deny keys do when no device is waiting to be let in. */
  decided(allow: boolean): void | Promise<void>
  /** Said in the strip, where somebody who was not looking at the panel sees it. */
  news(said: string): void
  /**
   * What the away view is allowed to know of the conversation: five methods,
   * and the orchestrator subject happens to have all five.
   *
   * **Named one by one rather than taking that subject**, which is the same
   * decision `ActingDeps` makes about the workbench: a parameter typed as the
   * subject would put `say` — the one function that writes a `said` line —
   * one property access away from a route.
   *
   * The transcript is **not** here, because it is not the subject's to answer:
   * it is in `AppState`, which this subject already holds. A sixth method for
   * it would be a second way to read one value.
   */
  talk: Talking
  /**
   * Read the page of the conversation before what the window holds, out of
   * the orchestrator's record (`Earlier.more`), for a page scrolled up past
   * what it holds. False is a record that could not be read. Absent, a page
   * reads only what the window holds.
   */
  earlier?: () => Promise<boolean>
  /**
   * Why work that came from outside this machine may not go ahead now, or
   * null — the queue's own question (`intakeStands`), asked at the moment a
   * paired device asks to approve one.
   *
   * Handed in rather than asked here, because answering it needs the
   * extension host that can reach the watch, and the subject that already
   * does is the queue. **A throw holds**: a source nobody could ask has not
   * said yes.
   */
  stands(row: InboxRow): Promise<string | null>
  /**
   * The factory floor, as the subject that folds the inbox already holds it.
   *
   * Handed in for `stands`' reason and one more: the away view may start no
   * work to answer a request, so everything it reads has to be a value the
   * window keeps — and the inbox, the request bodies and the stored workflows
   * are three reads that belong to the subject which already does them. This
   * file knows nothing about any of the three.
   */
  factory(): FactoryHeld
  /**
   * A draft was saved from away, so whatever folds the templates reads them
   * again rather than waiting out its own clock.
   *
   * One method and no argument: the fold reads every template anyway, and a
   * name here would be a second thing to keep in step for no gain.
   */
  saved(): void
  /** Three methods of `Settings`, never the subject: the generated key, what a granted device
   * reads, and the one change it may make (`web-settings.ts`). */
  settings: Pick<Settings, 'rows' | 'write' | 'writeKey'>
  /** The agents and projects subjects, for stopping and closing from away (`web-lifecycle.ts`). */
  lifecycle: Lifecycle
  /** The window's clipboard, for the pairing link's `Copy` (`web-link.ts`). */
  copy(text: string): Promise<boolean>
  /**
   * How many lanes starting the window again would end (`Window.reloadStops`),
   * for a restart from the person's own phone (`web-restart.ts`): the face's,
   * because only a window starts again. Absent with no screen, where the
   * phone is told this Tade cannot start itself again.
   */
  reloadStops?: () => number
  /**
   * Start the orchestrator again once any turn it is in is over, on what it is
   * signed in as now (`Orchestrator.moveAccount`), for `/login` on this
   * machine's tab on another machine (`web-restart.ts`). Absent, it is said
   * that there is no orchestrator here to start again.
   */
  restartOrchestrator?: () => void
  /**
   * The schedules subject, for a webhook delivery to make a watch look now
   * (`wire/doorbell.ts`): its one method that does, never the subject, for
   * `talk`'s reason — a route is one property access from whatever it holds.
   * Absent, every delivery is the `404` of a path nobody wired.
   */
  doorbell?: Waking
  /**
   * The Linear app's tokens as the window holds them (`linear-tokens.ts`), for
   * connecting Linear to hand a new one to. Absent, the connect page holds one
   * of its own, which nothing else reads with.
   */
  linear?: LinearTokens
}
