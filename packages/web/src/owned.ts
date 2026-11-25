import type { IncomingMessage } from 'node:http'
import type { DutiesAnswer } from '@tade/core'
import {
  type AccountSignInStanding,
  type AccountsAnswer,
  accountSignInHere,
  accountsHere,
} from './accounts.ts'
import { type AttachAnswer, attachHere } from './attached.ts'
import { type Answering, type CarryAnswer, carryHere } from './carried.ts'
import type { Device } from './devices.ts'
import { type DocumentAnswer, documentHere } from './document.ts'
import { dutiesHere } from './duties.ts'
import type { Refusal } from './errors.ts'
import { type InventoryToldAnswer, inventoryToldHere } from './inventory-told.ts'
import { carryLooking } from './looking.ts'
import { type MachineAnswer, machineHere } from './machine.ts'
import { type MachinesAnswer, machinesHere, machinesPressHere } from './machines.ts'
import { type OpenAnswer, openHere } from './opened.ts'
import { carryPresence } from './presence.ts'
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
// (`side.ts`), and what this machine is, one of its
// documents and one of its tools that only reads (`machine.ts`, `document.ts`,
// `tool-read.ts`), every machine's inventory and the press that moves the keys
// into one file (`machines.ts`), Tade started again on the code on disk now
// (`restarted.ts`) or its orchestrator alone, its orchestrator's sign-in driven
// from the phone (`signing-in.ts`), Settings › Accounts for this machine and
// every one it links to, with an account's own sign-in (`accounts.ts`), what another machine of theirs has (`inventory-told.ts`), what one of its watches has already found (`watch-seen.ts`), its public name's records looked at now (`records.ts`),
// work it hands this machine to start here (`taken.ts`), and
// a project it is moving here, opened (`opened.ts`). One door in `server.ts` for all of them (`OWNED_DOOR`),
// because each is the SSH key's word and nothing an ordinary phone's session
// is ever answered — but the person's own phone, on every one of them
// (`Route.theirs`, `ownsOrTheirs` in each handler), because they decided it
// may do what they can.
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
  'repositories',
  'side',
  'carry',
  'machine',
  'machines',
  'machines press',
  'restart',
  'orchestrator restart',
  'orchestrator sign-in',
  'accounts',
  'accounts sign-in',
  'inventory',
  'watch seen',
  'duties',
  'document',
  'tool',
  'records',
  'take',
  'open',
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
    | 'repositories'
    | 'side'
    | 'machine'
    | 'machines'
    | 'restarting'
    | 'orchestratorRestart'
    | 'orchestratorSignIn'
    | 'accounts'
    | 'inventoryTold'
    | 'document'
    | 'tool'
    | 'records'
    | 'taking'
    | 'opening'
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
        | RepositoriesAnswer
        | SideAnswer
        | MachineAnswer
        | MachinesAnswer
        | RestartAnswer
        | OrchestratorRestartAnswer
        | SignInStanding
        | AccountsAnswer
        | AccountSignInStanding
        | InventoryToldAnswer
        | WatchSeenAnswer
        | DutiesAnswer
        | DocumentAnswer
        | ToolReadAnswer
        | RecordsAnswer
        | TakeAnswer
        | OpenAnswer
    }
  | { refusal: Refusal }
> {
  if (route === 'carry') return carryHere(req, device, opts.carrying, res)
  if (route === 'attach') return attachHere(req, device, opts.attaching)
  if (route === 'since') return sinceHereFor(req, device, now, opts.since)
  if (route === 'share notes') return shareHere(req, device, opts.notes)
  if (route === 'share feeds') return feedsHere(req, device, opts.feeds)
  if (route === 'conversation') return conversationHere(req, device, opts.conversation)
  if (route === 'acts') return actHere(req, device, opts.acts)
  if (route === 'acts outbox') return outboxHere(req, device, opts.acts)
  if (route === 'repositories') return repositoriesHere(req, device, opts.repositories)
  if (route === 'side') return sideHere(req, device, opts.side)
  if (route === 'machine') return machineHere(req, device, opts.machine)
  if (route === 'machines') return machinesHere(req, device, opts.machines)
  if (route === 'machines press') return machinesPressHere(req, device, opts.machines)
  if (route === 'restart') return restartHere(req, device, opts.restarting)
  if (route === 'orchestrator restart') {
    return orchestratorRestartHere(req, device, opts.orchestratorRestart)
  }
  if (route === 'orchestrator sign-in') return signInHere(req, device, opts.orchestratorSignIn)
  if (route === 'accounts') return accountsHere(req, device, opts.accounts)
  if (route === 'accounts sign-in') return accountSignInHere(req, device, opts.accounts)
  if (route === 'inventory') return inventoryToldHere(req, device, opts.inventoryTold, now)
  if (route === 'watch seen') return watchSeenHere(req, device, opts.watchSeen)
  if (route === 'duties') return dutiesHere(req, device, opts.duties)
  if (route === 'seen') return seenHere(req, device, now, opts.seen)
  if (route === 'document') return documentHere(req, device, opts.document)
  if (route === 'tool') return toolHere(req, device, opts.tool)
  if (route === 'records') return recordsHere(req, device, opts.records)
  if (route === 'take') return takeHere(req, device, opts.taking)
  if (route === 'open') return openHere(req, device, opts.opening)
  if (route === 'looking') return carryLooking(req, device, now, opts.looking)
  return carryPresence(req, device, now, opts.present)
}
