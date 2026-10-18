import type { IncomingMessage } from 'node:http'
import { type AttachAnswer, attachHere } from './attached.ts'
import { type Answering, type CarryAnswer, carryHere } from './carried.ts'
import type { Device } from './devices.ts'
import { type DocumentAnswer, documentHere } from './document.ts'
import type { Refusal } from './errors.ts'
import { carryLooking } from './looking.ts'
import { type MachineAnswer, machineHere } from './machine.ts'
import { type OpenAnswer, openHere } from './opened.ts'
import { carryPresence } from './presence.ts'
import { type RecordsAnswer, recordsHere } from './records.ts'
import { type RepositoriesAnswer, repositoriesHere } from './repositories.ts'
import type { ServerOptions } from './serving.ts'
import { type NotesShareAnswer, shareHere } from './shared-notes.ts'
import { type SinceAnswer, sinceHereFor } from './since.ts'
import { type TakeAnswer, takeHere } from './taken.ts'
import { type ToolReadAnswer, toolHere } from './tool-read.ts'

// What only an owner device may ask of this machine, and only at its own door
// (`here` in `routes.ts`): that the person is at another of their screens
// (`presence.ts`), another machine's setup carried here (`carried.ts`), what
// to run here to be shown one of its agents (`attached.ts`), what they missed
// while they were away (`since.ts`), their notes shared with another of their
// machines (`shared-notes.ts`), where each project's work is, for a fetch
// over the same SSH (`repositories.ts`), and what this machine is, one of its
// documents and one of its tools that only reads (`machine.ts`, `document.ts`,
// `tool-read.ts`), its public name's records looked at now (`records.ts`),
// work it hands this machine to start here (`taken.ts`), and
// a project it is moving here, opened (`opened.ts`). One door in `server.ts` for all of them (`OWNED_DOOR`),
// because each is the SSH key's word and nothing an ordinary phone's session
// is ever answered — but the person's own phone, on the ones `Route.theirs`
// marks (`ownsOrTheirs` in each handler), because they decided it may do what
// they can.
//
// And through the same door, one word **any** device may say, because it is
// the same kind of word as the first — a device's own about the person holding
// it — and asks nothing an owner has: that its page is being looked at
// (`looking.ts`), which only ever quiets what that one device is sent.

/** Every route this door answers, by name: `server.ts` sends each of them here. */
export const OWNED_DOOR: ReadonlySet<string> = new Set([
  'presence',
  'looking',
  'attach',
  'since',
  'share notes',
  'repositories',
  'carry',
  'machine',
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
    | 'looking'
    | 'carrying'
    | 'attaching'
    | 'since'
    | 'notes'
    | 'repositories'
    | 'machine'
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
        | RepositoriesAnswer
        | MachineAnswer
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
  if (route === 'repositories') return repositoriesHere(req, device, opts.repositories)
  if (route === 'machine') return machineHere(req, device, opts.machine)
  if (route === 'document') return documentHere(req, device, opts.document)
  if (route === 'tool') return toolHere(req, device, opts.tool)
  if (route === 'records') return recordsHere(req, device, opts.records)
  if (route === 'take') return takeHere(req, device, opts.taking)
  if (route === 'open') return openHere(req, device, opts.opening)
  if (route === 'looking') return carryLooking(req, device, now, opts.looking)
  return carryPresence(req, device, now, opts.present)
}
