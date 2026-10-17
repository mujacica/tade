import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// A project another machine of the person's is moving here (REMOTE-TADE.md
// §9.2): "moving a whole project is closing it on one machine and opening it
// on the other", and this is the opening — the repository checked out here,
// cloned with **this machine's own credentials** where there is no checkout of
// it yet, and opened as a project through the window's own door
// (`Projects.openAt`), exactly as somebody at this keyboard would open it.
//
// **An owner's, and only at this machine's own door** (`here` in
// `routes.ts`), for the reason the take is: whoever holds the SSH key can
// already `git clone` here and open the project at the window in tmux. A
// phone's session is refused it however much it was granted.
//
// **What it is asked for is a repository, not a path.** The asking machine
// says what the repository is called (`repositoryNamed`'s answer, no
// credential in it) and the URL it would clone from with any credential taken
// out; this machine chooses where — beside the projects it already has, or in
// its home — and never writes over anything: a folder already there is opened
// only where it is a checkout of that same repository. The URL is one git
// reads as a URL and nothing else: `https://`, `ssh://` or `user@host:path`,
// never one that starts with `-` or names another transport.

/** A project's name, as the config holds one. */
const NAME = /^[a-z0-9][a-z0-9-]{0,99}$/

/** What names a repository wherever it is checked out: `github.com/owner/name`. */
const REPOSITORY = /^[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~-]+)+$/

/**
 * A URL git clones from and reads as nothing else: https, ssh, or the
 * `user@host:path` form — no option, no `ext::`, no `file://`, no space.
 */
export const CLONE_URL =
  /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^\s@]+|ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d+)?\/\S+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+)$/

export const OpenSchema = z.strictObject({
  /** What the machine asking calls itself, for the line written here. */
  from: z.string().min(1).max(120),
  /** What to call it here: its name on the asking machine, unless that is taken here. */
  name: z.string().regex(NAME),
  repository: z.string().max(400).regex(REPOSITORY),
  /** Where to clone it from, with no credential in it. */
  clone: z.string().max(2_000).regex(CLONE_URL),
})
export type Open = z.infer<typeof OpenSchema>

/** The answer: open here, as which project and where, or why not — in this machine's own words. */
export const OpenAnswerSchema = z.union([
  z.object({
    opened: z.literal(true),
    /** Its name here, which may be one it already had. */
    project: z.string().max(200),
    /** Where it is checked out here. */
    root: z.string().max(4_096),
    said: z.string().max(2_000),
  }),
  z.object({ opened: z.literal(false), said: z.string().max(2_000) }),
])
export type OpenAnswer = z.infer<typeof OpenAnswerSchema>

/** The window's half: the project open here, or why not. `device` is who asked, for the journal. */
export type WebOpening = (open: Open, device: string) => Promise<OpenAnswer>

/** The route. `opening` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function openHere(
  req: IncomingMessage,
  device: Device,
  opening: WebOpening | undefined,
): Promise<{ body: OpenAnswer } | { refusal: Refusal }> {
  if (opening === undefined) return { refusal: refuse('no_such') }
  if (!device.owner) return { refusal: refuse('out_of_scope') }
  // An owner narrowed to some projects is narrowed away from opening another.
  if (device.projects !== null) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const asked = OpenSchema.safeParse(got.body)
  if (!asked.success) return { refusal: refuse('malformed') }
  return { body: await opening(asked.data, device.id) }
}
