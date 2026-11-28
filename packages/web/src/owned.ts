import type { IncomingMessage } from 'node:http'
import type { DutiesAnswer } from '@tade/core'
import { type AccountsAnswer, accountsHere } from './accounts.ts'
import { type AttachAnswer, attachHere } from './attached.ts'
import { type AwayAnswer, awayThereHere } from './away-there.ts'
import { type Answering, type CarryAnswer, carryHere } from './carried.ts'
import type { Device } from './devices.ts'
import { type DiskAnswer, diskHere } from './disk.ts'
import { type DocumentAnswer, documentHere } from './document.ts'
import { dutiesHere } from './duties.ts'
import type { Refusal } from './errors.ts'
import { type InventoryToldAnswer, inventoryToldHere } from './inventory-told.ts'
import { carryLooking } from './looking.ts'
import { type MachineAnswer, machineHere } from './machine.ts'
import { type OpenAnswer, openHere } from './opened.ts'
import { carryPresence } from './presence.ts'
import { type PressedThere, pressThereHere } from './pressed-there.ts'
import { type ProjectionAnswer, projectionHere } from './projection-told.ts'
import { type RecordsAnswer, recordsHere } from './records.ts'
import { type RepositoriesAnswer, repositoriesHere } from './repositories.ts'
import {
  type OrchestratorRestartAnswer,
  orchestratorRestartHere,
  type RestartAnswer,
  restartHere,
} from './restarted.ts'
import { seenHere } from './seen.ts'
import type { ServerOptions } from './serving.ts'
import { type ActBody, type ActDone, actHere, outboxHere } from './shared-acts.ts'
import { type ConversationShareAnswer, conversationHere } from './shared-conversation.ts'
import { type FeedsShareAnswer, feedsHere } from './shared-feeds.ts'
import { type NotesShareAnswer, shareHere } from './shared-notes.ts'
import { type SideAnswer, sideHere } from './side.ts'
import { type SignInStanding, signInHere } from './signing-in.ts'
import { type SinceAnswer, sinceHereFor } from './since.ts'
import { type TakeAnswer, takeHere } from './taken.ts'
import { type ToolReadAnswer, toolHere } from './tool-read.ts'
import { type WatchSeenAnswer, watchSeenHere } from './watch-seen.ts'

// What only an owner device may ask of this machine, and only at its own door
// (`here` in `routes.ts`): that the person is at another of their screens
// (`presence.ts`), that another machine is up or closing (`seen.ts`), another machine's setup carried here (`carried.ts`), what
// to run here to be shown one of its agents (`attached.ts`), what they missed
// while they were away (`since.ts`), their notes shared with another of their
// machines (`shared-notes.ts`), every machine's journal kept on every other
// (`shared-feeds.ts`), where each project's work is, for a fetch
// over the same SSH (`repositories.ts`), one project as its window draws it
// (`side.ts`) and what is on its disk, pressed there (`disk.ts`), and what this machine is, one of its
// documents and one of its tools that only reads (`machine.ts`, `document.ts`,
// `tool-read.ts`), Tade started again on the code on disk now
// (`restarted.ts`) or its orchestrator alone, its orchestrator's sign-in driven
// from the phone (`signing-in.ts`), Settings › Accounts for this machine and
// every one it links to (`accounts.ts`), what another machine of theirs has (`inventory-told.ts`), its whole projection for this machine's page to draw (`projection-told.ts`), what one of its watches has already found (`watch-seen.ts`), its public name's records looked at now (`records.ts`),
// work it hands this machine to start here (`taken.ts`), a press on another
// machine's row put in its outbox (`pressed-there.ts`), and
// a project it is moving here, opened (`opened.ts`). One door in `server.ts` for all of them (`OWNED_DOOR`),
// because each is the SSH key's word — and a paired phone's, on every one of
// them, because every paired device is the person's own and may do what they
// can.
//
// And through the same door, one word **any** device may say, because it is
// the same kind of word as the first — a device's own about the person holding
// it — and asks nothing an owner has: that its page is being looked at
// (`looking.ts`), which only ever quiets what that one device is sent.

/** Every route this door answers, by name: `server.ts` sends each of them here. */
export const OWNED_DOOR: ReadonlySet<string> = new Set([
  'presence',
  'seen',
  'looking',
  'attach',
  'since',
  'share notes',
  'share feeds',
  'conversation',
  'acts',
  'acts outbox',
  'press there',
  'repositories',
  'side',
  'disk',
  'carry',
  'machine',
  'restart',
  'orchestrator restart',
  'orchestrator sign-in',
  'accounts',
  'inventory',
  'projection',
  'watch seen',
  'duties',
  'document',
  'tool',
  'records',
  'take',
  'open',
  'away',
])

export async function carryOwned(
  route: string,
  req: IncomingMessage,
  device: Device,
  now: number,
  opts: Pick<
    ServerOptions,
    | 'present'
    | 'seen'
    | 'watchSeen'
    | 'duties'
    | 'looking'
    | 'carrying'
    | 'attaching'
    | 'since'
    | 'notes'
    | 'feeds'
    | 'conversation'
    | 'acts'
    | 'pressThere'
    | 'repositories'
    | 'side'
    | 'disk'
    | 'machine'
    | 'restarting'
    | 'orchestratorRestart'
    | 'orchestratorSignIn'
    | 'accounts'
    | 'inventoryTold'
    | 'projectionTold'
    | 'document'
    | 'tool'
    | 'records'
    | 'taking'
    | 'opening'
    | 'awayThere'
  >,
  res: Answering,
): Promise<
  | {
      body:
        | { at: string }
        | CarryAnswer
        | AttachAnswer
        | SinceAnswer
        | NotesShareAnswer
        | FeedsShareAnswer
        | ConversationShareAnswer
        | ActDone
        | { acts: ActBody[] }
        | PressedThere
        | RepositoriesAnswer
        | SideAnswer
        | DiskAnswer
        | MachineAnswer
        | RestartAnswer
        | OrchestratorRestartAnswer
        | SignInStanding
        | AccountsAnswer
        | InventoryToldAnswer
        | ProjectionAnswer
        | WatchSeenAnswer
        | DutiesAnswer
        | DocumentAnswer
        | ToolReadAnswer
        | RecordsAnswer
        | TakeAnswer
        | OpenAnswer
        | AwayAnswer
    }
  | { refusal: Refusal }
> {
  if (route === 'carry') return carryHere(req, device, opts.carrying, res)
  if (route === 'attach') return attachHere(req, opts.attaching)
  if (route === 'since') return sinceHereFor(req, now, opts.since)
  if (route === 'share notes') return shareHere(req, device, opts.notes)
  if (route === 'share feeds') return feedsHere(req, device, opts.feeds)
  if (route === 'conversation') return conversationHere(req, opts.conversation)
  if (route === 'acts') return actHere(req, device, opts.acts)
  if (route === 'acts outbox') return outboxHere(req, device, opts.acts)
  if (route === 'press there') return pressThereHere(req, device, opts.pressThere)
  if (route === 'repositories') return repositoriesHere(req, opts.repositories)
  if (route === 'side') return sideHere(req, opts.side)
  if (route === 'disk') return diskHere(req, opts.disk)
  if (route === 'machine') return machineHere(req, opts.machine)
  if (route === 'restart') return restartHere(req, device, opts.restarting)
  if (route === 'orchestrator restart') {
    return orchestratorRestartHere(req, device, opts.orchestratorRestart)
  }
  if (route === 'orchestrator sign-in') return signInHere(req, device, opts.orchestratorSignIn)
  if (route === 'accounts') return accountsHere(req, device, opts.accounts)
  if (route === 'inventory') return inventoryToldHere(req, device, opts.inventoryTold, now)
  if (route === 'projection') return projectionHere(req, device, opts.projectionTold)
  if (route === 'watch seen') return watchSeenHere(req, opts.watchSeen)
  if (route === 'duties') return dutiesHere(req, opts.duties)
  if (route === 'seen') return seenHere(req, device, now, opts.seen)
  if (route === 'document') return documentHere(req, opts.document)
  if (route === 'tool') return toolHere(req, device, opts.tool)
  if (route === 'records') return recordsHere(req, opts.records)
  if (route === 'take') return takeHere(req, device, opts.taking)
  if (route === 'open') return openHere(req, device, opts.opening)
  if (route === 'away') return awayThereHere(req, device.id, opts.awayThere)
  if (route === 'looking') return carryLooking(req, device, now, opts.looking)
  return carryPresence(req, device, now, opts.present)
}
