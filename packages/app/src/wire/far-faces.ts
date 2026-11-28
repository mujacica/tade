import { NotOffered, type Outcome } from '@tade/web'
import { FACE_OWN, type FaceCapabilities, type FaceOwn, ownOf } from '../faces.ts'
import {
  type FarExtras,
  type FarFrame,
  type FarMessage,
  type FarSent,
  farChange,
  farFrame,
  farHeart,
  farWhole,
} from '../far.ts'
import type { Frame } from '../frame.ts'
import type { AttachedFace, FaceSpec } from '../heart.ts'
import type { Intent } from '../keymap.ts'
import { type AppState, paneLane } from '../model.ts'
import type { Panel } from '../panels.ts'
import type { Skin } from '../skin.ts'
import { timing } from '../timing.ts'
import type { Subject } from './context.ts'
import { frameOf, panelInputsOf } from './frame.ts'
import { doIntent, type IntentTargets } from './intents.ts'

// The machine's end of a phone that draws its own copy of the window (§10 T3
// of the Duo plan): one face on the heart per device with the full view open,
// and what that face is sent and carries out.
//
// **Out: state, never a frame drawn.** On every frame the heart asks for, each
// phone's face is folded as that face sees the window (`frameOf` under
// `AttachedFace.as`) and sent as what moved since what *that phone* holds
// (`far.ts`). The machine draws nothing for a phone: the phone runs `draw` at
// its own size. A phone looking where another looks, at the same size, is
// folded once for both (`fold`), and a beat on which nothing moved sends
// nothing. Frames are made at most once every `SOON_MS`, so a burst of draws
// on the machine is one message.
//
// **The lane it watches.** The machine reads the lanes its own window is in
// front of, and a face that does not front draws a lane's last kept screen
// (`Lanes.inFront`, `Screens.seen`). A phone looking at an agent the window is
// not is sent that agent's screen as the away view reads it while somebody
// looks (`web-lanes.ts`): read on the beat while this phone looks, the keys and
// credentials taken out (`screen.ts`, as T1 kept for the overview), and
// nothing read for an agent nobody away is looking at.
//
// **In: intents, carried out as that phone's face**, through the doors the
// machine's own keyboard reaches (`doIntent`). Where the phone was looking when
// it pressed is laid on its face first, so "the agent in front" is the one the
// phone had in front. What a door writes after an await is still that face's
// (`Heart.as` carries it). Two things a phone cannot ask: the machine's
// microphone and closing the machine's window.
//
// A look runs out after `LOOK_MS` unless renewed, and the face goes with it:
// nothing is folded for a phone in a drawer.

/** How long a look keeps a phone's face, without another. */
export const LOOK_MS = 20_000

/** The least time between two frames made for the phones. */
export const SOON_MS = 150

/** Named on the probe, so the phones' folds are counted apart from the window's own frame. */
export const FAR_FRAME = 'far:frame'

/** What the far faces need of the window. */
export interface FarFacesDeps {
  /** The heart they come to. */
  attach(spec: FaceSpec): AttachedFace
  /** The subjects whose facts every face draws, as the window holds them. */
  subjects(): readonly Subject[]
  /** The window's colours: what a subject paints into what it hands over is painted in them. */
  skin: Skin
  /** The doors an intent reaches, as the machine's own keyboard reaches them. */
  targets(): IntentTargets
  /** One message to one device's streams. */
  send(device: string, message: FarMessage): void
  /** The lane the machine's own window has in front of its pane, which it reads itself. */
  front(): string | null
  /** Keep this agent's screen read for this device, a while longer (`web-lanes.ts`). */
  watch(device: string, task: string): void
  /** That agent's screen as last read for away, cleaned; null for nothing read yet. */
  screen(task: string): string | null
  /** A screen's keys and credentials taken out, as the overview's are (`screen.ts`). */
  scrub(text: string): string
  /** The window's keys as the person set them, for a phone that answers its own. */
  keys(): FarExtras['keys']
  now(): number
}

/** What a phone's face can do on the machine: everything that happens there happens on the phone. */
export const ON_A_PHONE: FaceCapabilities = {
  links: false,
  clipboard: false,
  editor: false,
  fronts: false,
  why: {
    links: 'this face is a phone, which opens a link it is handed on its own screen',
    clipboard: 'this face is a phone, which copies onto its own clipboard',
    editor: 'an editor would take this machine’s screen, which nobody at the phone can see',
    fronts: 'the lanes are read for the machine’s own window; a phone is sent the one it looks at',
  },
}

/** One phone with the full view open. */
interface Far {
  readonly face: AttachedFace
  columns: number
  rows: number
  /** What it was last sent, which the next change is worked out against; null sends a whole. */
  sent: FarSent | null
  rev: number
  /** Where the phone last said it looks, so only what the machine moved is sent back. */
  said: FaceOwn
  /** Until when its look holds. */
  until: number
}

export class FarFaces {
  private readonly deps: FarFacesDeps
  private readonly fars = new Map<string, Far>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private madeAt = Number.NEGATIVE_INFINITY

  constructor(deps: FarFacesDeps) {
    this.deps = deps
  }

  /** How many phones have the full view open. */
  get count(): number {
    return this.fars.size
  }

  /**
   * A phone with the full view open says where it looks, how big it is, and
   * which revision it holds. The first look brings its face; a revision that
   * is not the one last sent — null, a lost frame, a stream opened again — is
   * sent the window whole.
   */
  look(
    device: string,
    look: { own?: Record<string, unknown>; columns: number; rows: number; rev: number | null },
  ): { rev: number | null } {
    let far = this.fars.get(device)
    if (far === undefined) {
      // Its panels are laid out to its own size, never the machine's terminal.
      const size = { columns: look.columns, rows: look.rows }
      const face = this.deps.attach({
        capabilities: ON_A_PHONE,
        draw: () => this.soon(),
        room: () => ({ columns: far?.columns ?? size.columns, rows: far?.rows ?? size.rows }),
      })
      far = {
        face,
        columns: look.columns,
        rows: look.rows,
        sent: null,
        rev: 0,
        said: ownOf(face.state),
        until: 0,
      }
      this.fars.set(device, far)
    }
    far.columns = look.columns
    far.rows = look.rows
    far.until = this.deps.now() + LOOK_MS
    if (look.own) this.place(far, look.own)
    if (look.rev === null || far.sent === null || look.rev !== far.sent.rev) far.sent = null
    this.soon()
    return { rev: far.sent?.rev ?? null }
  }

  /**
   * One intent from a phone, carried out as its face. Synchronous: what the
   * door starts goes on after this returns, still as that face.
   */
  act(device: string, intent: Intent, own: Record<string, unknown> | undefined): Outcome {
    const far = this.fars.get(device)
    if (far === undefined) {
      throw new NotOffered('the full view is not open on this device: look first')
    }
    if (intent.kind === 'talk') {
      throw new NotOffered('push-to-talk is this machine’s microphone, which a phone cannot hold')
    }
    if (intent.kind === 'quit') {
      throw new NotOffered('closing the window is for this machine’s own keyboard')
    }
    if (intent.kind === 'click' && intent.target.kind === 'link') {
      throw new NotOffered('a phone opens a link on its own screen, never this machine’s')
    }
    far.until = this.deps.now() + LOOK_MS
    if (own) this.place(far, own)
    const targets = this.deps.targets()
    far.face.as(() => doIntent(intent, targets))
    this.soon()
    // Tade's own words about what was done, never the words or bytes carried.
    return { did: true, rev: String(far.rev), said: `window ${intent.kind}` }
  }

  /** This phone closed the full view, or is no longer a device: its face goes. */
  leave(device: string): void {
    const far = this.fars.get(device)
    if (far === undefined) return
    this.fars.delete(device)
    far.face.detach()
  }

  /** The beat: looks not renewed run out, and the agents phones look at are kept read. */
  beat(): void {
    const now = this.deps.now()
    for (const [device, far] of [...this.fars]) {
      if (far.until <= now) this.leave(device)
    }
    if (this.fars.size > 0) this.soon()
  }

  /** Every phone gone: the window is closing. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const device of [...this.fars.keys()]) this.leave(device)
  }

  /** A frame for the phones, soon: now if the last was long enough ago, or once the gap is up. */
  soon(): void {
    if (this.fars.size === 0 || this.timer !== null) return
    const wait = this.madeAt + SOON_MS - this.deps.now()
    if (wait <= 0) {
      this.make()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.make()
    }, wait)
    this.timer.unref?.()
  }

  /** Fold every phone's face and send each what moved. */
  make(): void {
    this.madeAt = this.deps.now()
    const timings = timing()
    const at = timings.start()
    const folded = new Map<string, { frame: FarFrame; heart: ReturnType<typeof farHeart> }>()
    for (const [device, far] of this.fars) {
      const state = far.face.state
      const own = ownOf(state)
      const key = `${far.columns}x${far.rows}\n${JSON.stringify(own)}`
      let fold = folded.get(key)
      if (fold === undefined) {
        fold = this.fold(device, far, state)
        folded.set(key, fold)
      } else this.watch(device, state)
      // What the machine moved of where this phone looks: only that is sent back.
      const moved: Partial<Record<keyof FaceOwn, unknown>> = {}
      for (const field of FACE_OWN) {
        if (!sameValue(far.said[field], own[field])) moved[field] = own[field]
      }
      far.said = own
      far.rev += 1
      const made =
        far.sent === null
          ? farWhole(far.rev, fold.heart, fold.frame, own)
          : farChange(far.sent, far.rev, fold.heart, fold.frame, moved as Partial<FaceOwn>)
      if (made === null) {
        far.rev -= 1
        continue
      }
      far.sent = made.sent
      this.deps.send(device, made.message)
    }
    timings.took(FAR_FRAME, at)
  }

  /** Lay where the phone says it looks on its face; a panel it opened is opened as the window opens one. */
  private place(far: Far, said: Record<string, unknown>): void {
    const own: Partial<Record<keyof FaceOwn, unknown>> = {}
    for (const field of FACE_OWN) if (field in said) own[field] = said[field]
    far.face.as(() => {
      const state = far.face.state
      // A panel the phone closed is `null`, which is something it said.
      const said = 'panel' in own
      const panel = (said ? own.panel : state.panel) as Panel | null
      const opened = said && !sameValue(panel, state.panel)
      far.face.put({ ...state, ...own, panel: state.panel } as AppState)
      // Through the window's own door, so what opening it starts — a diff
      // read, a file's changes asked, Settings › Updates looking — starts.
      if (opened) this.deps.targets().applyPanel({ panel, submit: false })
    })
    far.said = { ...far.said, ...(own as Partial<FaceOwn>) }
  }

  /** One phone's face folded: its frame with the lane it watches, and the facts. */
  private fold(
    device: string,
    far: Far,
    state: AppState,
  ): { frame: FarFrame; heart: ReturnType<typeof farHeart> } {
    const skin = this.deps.skin
    const { frame, inputs } = far.face.as(() => ({
      frame: frameOf(
        this.deps.subjects(),
        { width: far.columns, height: far.rows, skin },
        state.panel,
      ),
      inputs: state.panel ? panelInputsOf(this.deps.subjects(), state.panel) : undefined,
    }))
    // The lane's screen this phone looks at: read for it where the window is
    // not reading it, and either way with the keys taken out, as every screen
    // that leaves the machine is — the bottom terminal's too.
    const screen = this.watch(device, state)
    const scrub = (text: string) => this.deps.scrub(text)
    const watched: Frame = {
      ...frame,
      ...(screen === null ? { screen: scrub(frame.screen) } : { screen, paneScreen: null }),
      ...(frame.terminal && {
        terminal: { ...frame.terminal, screen: scrub(frame.terminal.screen) },
      }),
    }
    const keys = this.deps.keys()
    return {
      frame: { ...farFrame(watched), ...(inputs && { inputs }), ...(keys && { keys }) },
      heart: farHeart(state),
    }
  }

  /**
   * The agent this phone has in front, kept read for it where the machine's
   * own window is not reading it, and its screen as last read; null where the
   * window's own reading serves (the same lane) or nothing was read yet.
   */
  private watch(device: string, state: AppState): string | null {
    const lane = paneLane(state)
    if (lane === null || !lane.endsWith('/agent') || lane === this.deps.front()) return null
    const task = lane.slice(0, -'/agent'.length)
    this.deps.watch(device, task)
    return this.deps.screen(task)
  }
}

/** The same value: the same object, or the same as text. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
