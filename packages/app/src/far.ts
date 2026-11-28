import { FACE_SHARED, type FaceOwn } from './faces.ts'
import type { Frame } from './frame.ts'
import type { AppState } from './model.ts'
import type { PanelInputs } from './panels.ts'

// The window's state as it crosses the away door to a phone that draws its own
// copy of the window (§10 T3 of the Duo plan): the machine sends what the
// window draws *from* — the facts of the state, and the subjects' frame — and
// draws nothing for the phone, which runs the same `draw` at its own size.
//
// Two messages. A `whole` is everything, sent when a phone first looks, when it
// says it lost the thread, and after the stream came back. A `change` is what
// moved since the revision the phone holds (`base`): a top-level field of the
// state or the frame replaced, or — for a list that grew or changed at its end,
// the conversation above all — only its tail from where it first differs, so a
// line said is a line sent, not the whole conversation again. A beat on which
// nothing moved sends nothing (`farChange` answers null), as the projection's
// deltas never do (`@tade/web`'s `delta.ts`).
//
// What does not cross, and why:
// - `width`, `height` and `skin` are the phone's own: it draws at its size and
//   in its colours;
// - `clock` and `date` are functions, and `now` is the moment the frame was
//   folded, all of which the page supplies itself: a frame that carried the
//   machine's `now` would differ on every fold, and an idle window would send
//   a change every time it was asked for one;
// - `input` is the machine's own line as pi's editor drew it at the machine's
//   width: the phone types on a line of its own (`far-face.ts`);
// - `held`, a `Map`, crosses as its entries.
//
// The face's own fields (`faces.ts`) cross only where the *machine* moved them
// — a panel an act opened, a focus the beat moved off an agent that went — as
// `own`, field by field: where a phone is looking is the phone's, and the
// machine never sends it back what it said.
//
// Pure: no `node:` import, no clock, nothing async, and loadable in a browser
// (`browser.ts`).

/** The facts of the state, which every face shares: what the machine sends of `AppState`. */
export type FarHeart = Pick<AppState, (typeof FACE_SHARED)[number]>

/** What the machine adds to the frame for a face that answers its own keys. */
export interface FarExtras {
  /** What an open panel answers a key against (`panelInputsOf`), as the machine holds it. */
  readonly inputs?: PanelInputs
  /** The window's keys as the person set them (`surfaces.window.keys`), and the one held to talk. */
  readonly keys?: { readonly bindings?: Readonly<Record<string, string>>; readonly talk?: string }
}

/** The frame as it crosses: everything but what the phone has of its own, and the extras. */
export type FarFrame = Omit<
  Frame,
  'width' | 'height' | 'skin' | 'clock' | 'date' | 'now' | 'input' | 'held'
> &
  FarExtras & {
    held?: [string, unknown][]
  }

/** What a phone holds of the window: the facts, the frame, and the revision they are at. */
export interface FarWindow {
  readonly rev: number
  readonly heart: FarHeart
  readonly frame: FarFrame
}

/** One field moved: replaced whole, or — a list — its tail replaced from `at`. */
export type FarPart = { v: unknown } | { at: number; v: unknown[] }

/** Everything, for a phone that holds nothing it can build on. */
export interface FarWhole {
  readonly kind: 'whole'
  readonly rev: number
  readonly heart: FarHeart
  readonly frame: FarFrame
  /** Where the machine has this face looking: all of its own fields, as the machine holds them. */
  readonly own: Partial<FaceOwn>
}

/** What moved since `base`, which the phone must hold for this to mean anything. */
export interface FarChange {
  readonly kind: 'change'
  readonly rev: number
  readonly base: number
  readonly heart?: Readonly<Record<string, FarPart>>
  readonly frame?: Readonly<Record<string, FarPart>>
  /** Frame fields that were there and are not any more. */
  readonly gone?: readonly string[]
  /** The face's own fields the machine moved. */
  readonly own?: Partial<FaceOwn>
}

export type FarMessage = FarWhole | FarChange

/** The frame's fields that never cross (see the top of this file). */
const LOCAL = new Set(['width', 'height', 'skin', 'clock', 'date', 'now', 'input'])

/** The frame as it crosses. */
export function farFrame(frame: Frame): FarFrame {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frame)) {
    if (LOCAL.has(key) || value === undefined) continue
    out[key] = key === 'held' && value instanceof Map ? [...value.entries()] : value
  }
  return out as unknown as FarFrame
}

/** The facts of a state: its shared fields. */
export function farHeart(state: AppState): FarHeart {
  const out: Partial<Record<keyof FarHeart, unknown>> = {}
  for (const key of FACE_SHARED) out[key] = state[key]
  return out as FarHeart
}

/**
 * The frame a phone draws, out of what it holds and its own size and skin.
 * `held` becomes a `Map` again; the clocks are the page's to hand in.
 */
export function frameFrom(
  window: FarWindow,
  base: Pick<Frame, 'width' | 'height' | 'skin'> &
    Partial<Pick<Frame, 'clock' | 'date' | 'now' | 'input'>>,
): Frame {
  const { held, inputs: _inputs, keys: _keys, ...rest } = window.frame
  return {
    ...(rest as Omit<Frame, 'width' | 'height' | 'skin'>),
    ...(held && { held: new Map(held) as Frame['held'] }),
    ...base,
  }
}

/**
 * What the machine keeps of what it last sent one phone: what is compared
 * against, so a change is worked out from what *that phone* holds.
 */
export interface FarSent {
  readonly rev: number
  readonly heart: FarHeart
  readonly frame: FarFrame
  /** Each frame field as text, worked out once when it was sent. */
  readonly texts: Readonly<Record<string, string>>
}

/** A whole, and what is kept of it. */
export function farWhole(
  rev: number,
  heart: FarHeart,
  frame: FarFrame,
  own: Partial<FaceOwn>,
): { message: FarWhole; sent: FarSent } {
  return {
    message: { kind: 'whole', rev, heart, frame, own },
    sent: { rev, heart, frame, texts: textsOf(frame) },
  }
}

/**
 * What moved since `was`, as a change at `rev`, or null where nothing did.
 *
 * The facts are compared by identity first, field by field and a list's items
 * too: the state is only ever replaced, never changed in place, so what is the
 * same object is the same, and only what is not is compared as text — a beat
 * that made the same panes again sends nothing. The frame is made again every
 * time it is asked for, so its fields are compared as text, each made once.
 */
export function farChange(
  was: FarSent,
  rev: number,
  heart: FarHeart,
  frame: FarFrame,
  own: Partial<FaceOwn>,
): { message: FarChange; sent: FarSent } | null {
  const hearts: Record<string, FarPart> = {}
  for (const key of FACE_SHARED) {
    const part = partOf(was.heart[key], heart[key], sameValue)
    if (part) hearts[key] = part
  }
  const texts = textsOf(frame)
  const frames: Record<string, FarPart> = {}
  const gone: string[] = []
  for (const key of Object.keys(texts)) {
    if (was.texts[key] === texts[key]) continue
    const before = (was.frame as unknown as Record<string, unknown>)[key]
    const after = (frame as unknown as Record<string, unknown>)[key]
    frames[key] = partOf(before, after, sameValue) ?? { v: after }
  }
  for (const key of Object.keys(was.texts)) if (!(key in texts)) gone.push(key)
  const owned = Object.keys(own).length > 0
  if (
    Object.keys(hearts).length === 0 &&
    Object.keys(frames).length === 0 &&
    gone.length === 0 &&
    !owned
  )
    return null
  const message: FarChange = {
    kind: 'change',
    rev,
    base: was.rev,
    ...(Object.keys(hearts).length > 0 && { heart: hearts }),
    ...(Object.keys(frames).length > 0 && { frame: frames }),
    ...(gone.length > 0 && { gone }),
    ...(owned && { own }),
  }
  return { message, sent: { rev, heart, frame, texts } }
}

/**
 * What a phone holds once it has taken `message`, or null where the message
 * cannot be built on — a change against a revision it does not hold — and it
 * must ask for a whole again. The face's own fields are handed back beside it
 * for the phone to lay over its own.
 */
export function takeFar(
  held: FarWindow | null,
  message: FarMessage,
): { window: FarWindow; own: Partial<FaceOwn> } | null {
  if (message.kind === 'whole') {
    return {
      window: { rev: message.rev, heart: message.heart, frame: message.frame },
      own: message.own,
    }
  }
  if (held === null || held.rev !== message.base) return null
  const heart = { ...held.heart } as Record<string, unknown>
  for (const [key, part] of Object.entries(message.heart ?? {}))
    heart[key] = applied(heart[key], part)
  const frame = { ...held.frame } as unknown as Record<string, unknown>
  for (const key of message.gone ?? []) delete frame[key]
  for (const [key, part] of Object.entries(message.frame ?? {}))
    frame[key] = applied(frame[key], part)
  return {
    window: { rev: message.rev, heart: heart as FarHeart, frame: frame as unknown as FarFrame },
    own: message.own ?? {},
  }
}

/** One field as moved: whole, or a list's head kept and its tail replaced. */
function applied(was: unknown, part: FarPart): unknown {
  if (!('at' in part)) return part.v
  const head = Array.isArray(was) ? was.slice(0, part.at) : []
  return [...head, ...part.v]
}

/**
 * How one field moved, or null where it did not. A list that kept a head of
 * at least one item sends only what follows it; anything else is sent whole.
 */
function partOf(
  was: unknown,
  is: unknown,
  same: (a: unknown, b: unknown) => boolean,
): FarPart | null {
  if (was === is) return null
  if (Array.isArray(was) && Array.isArray(is)) {
    let at = 0
    const most = Math.min(was.length, is.length)
    while (at < most && same(was[at], is[at])) at += 1
    if (at === was.length && at === is.length) return null
    if (at > 0) return { at, v: is.slice(at) }
    return { v: is }
  }
  if (same(was, is)) return null
  return { v: is }
}

/** The same value: the same object, or the same as text. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** Each field of a frame as text. */
function textsOf(frame: FarFrame): Record<string, string> {
  const texts: Record<string, string> = {}
  for (const [key, value] of Object.entries(frame)) texts[key] = JSON.stringify(value) ?? 'null'
  return texts
}
