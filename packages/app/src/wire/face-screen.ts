import type { Component, Terminal } from '@earendil-works/pi-tui'
import type { FaceCapabilities } from '../faces.ts'
import type { AttachedFace, FaceSpec } from '../heart.ts'
import type { Skin } from '../skin.ts'
import { timing } from '../timing.ts'
import { LastFrame } from '../view/last-frame.ts'
import { draw } from '../view.ts'
import type { Subject } from './context.ts'
import { frameOf } from './frame.ts'
import { type Screen, screenFor } from './paint.ts'

// A face over a terminal that is not the machine's own window's: the window
// drawn again, at that terminal's size, from where that face is looking, over
// the heart the window already beats (`Heart.attach`).
//
// It shares everything that is a fact — the subjects and what they hold, the
// lanes they read, the conversation — and holds only what is its own: its
// place in the window (`faces.ts`), its terminal and the regions it last drew
// (`LastFrame`, one per face, or two faces at two sizes would each throw away
// what the other kept). Nothing is read, looked at or polled for it: it is
// drawn when the heart draws, and costs its frames.
//
// What it does not take yet is keys: what is typed on it goes nowhere, and a
// press is the next piece of work (§10 T3, the away door's input).

/** Named on the probe, so a second face's frames are counted apart from the window's own. */
export const FACE_FRAME = 'face:frame'

/** What a face over a terminal is made with. */
export interface FaceScreenDeps {
  /** The heart it comes to. */
  attach(spec: FaceSpec): AttachedFace
  /** The subjects whose facts every face draws, as the window holds them. */
  subjects(): readonly Subject[]
  /** The terminal it draws on, at whatever size that is. */
  terminal: Terminal
  /** How it is coloured: its terminal's own, declared by whoever made it. */
  skin: Skin
  /** What it can do on its machine. */
  capabilities: FaceCapabilities
}

export class FaceScreen {
  private readonly deps: FaceScreenDeps
  private readonly tui: Screen
  /** The regions this face last drew, kept for its next frame where they did not move. */
  private readonly last = new LastFrame()
  /** Its place on the heart, until it goes. */
  readonly face: AttachedFace
  private stopped = false

  constructor(deps: FaceScreenDeps) {
    this.deps = deps
    this.tui = screenFor(deps.terminal)
    this.face = deps.attach({ capabilities: deps.capabilities, draw: () => this.draw() })
    const component: Component = {
      render: (width) => this.frame(width),
      invalidate: () => {},
    }
    this.tui.addChild(component)
    this.tui.start()
    this.draw()
  }

  /** The rows of one frame at `width`, as this face sees the window. */
  frame(width: number): string[] {
    const timings = timing()
    const at = timings.start()
    const rows = this.face.as(() => {
      const state = this.face.state
      const frame = frameOf(
        this.deps.subjects(),
        { width, height: Math.max(6, this.deps.terminal.rows), skin: this.deps.skin },
        state.panel,
      )
      return draw(state, frame, this.last).rows
    })
    timings.took(FACE_FRAME, at)
    return rows
  }

  /** Ask for a frame, which pi-tui draws only the changed rows of. */
  draw(): void {
    if (!this.stopped) this.tui.requestRender()
  }

  /** Gone from the heart, and its terminal handed back as it was found. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    // The screen first: stopping it draws its last frame once more, as this face.
    this.tui.stop()
    this.face.detach()
    this.deps.terminal.clearScreen()
  }
}
