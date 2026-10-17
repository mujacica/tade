import { basename, join } from 'node:path'
import { type LaneId, orchestratorAttachments, taskDir } from '@tade/core'
import type { Frame } from '../frame.ts'
import {
  asPaste,
  type ClipboardCopy,
  type ClipboardWatch,
  clipboardImage,
  clipboardText,
  handOffFiles,
  isImagePath,
  readImage,
  shellQuote,
  watchClipboard,
} from '../images.ts'
import {
  activeTerminal,
  focusTask,
  leaveLine,
  ORCHESTRATOR_TAB,
  openLine,
  removeAttachment,
  shownName,
} from '../model.ts'
import { imageMenuItems, type MenuItem, menuPanel } from '../panels/menu/state.ts'
import { typingAt } from '../pasting.ts'
import {
  type Actions,
  type Menus,
  notify,
  type Subject,
  type Wiring,
  type WorkerImageFile,
  why,
} from './context.ts'

// Pictures, and the clipboard they usually arrive on. A picture belongs to the
// message it came with: dropped or pasted, it is asked who it is for, and what
// goes to the orchestrator waits for the next thing you say and nothing after.

/** What this subject needs from the rest of the window. */
export interface ImagesDeps {
  /** Look at the lanes sooner than the next beat: something was just typed at one. */
  soonTick(): void
  /** The files attached to what the orchestrator is answering right now. */
  answering(): readonly string[]
}

/** `Send 3 pictures to`, or the one file's name. */
export function imagesTitle(paths: readonly string[]): string {
  const allImages = paths.every((path) => isImagePath(path))
  const noun = paths.length === 1 ? 'file' : allImages ? 'pictures' : 'files'
  return `Send ${paths.length === 1 ? basename(paths[0] ?? '') : `${paths.length} ${noun}`} to`
}

export class Images implements Subject {
  private readonly wire: Wiring
  private readonly deps: ImagesDeps
  /**
   * A picture on the clipboard, noticed while the orchestrator's line is open:
   * the copy offered, and the copy already taken or turned down.
   */
  private readonly clipboard: { offered: string | null; seen: string | null } = {
    offered: null,
    seen: null,
  }
  /** The clipboard being watched, which it is only while the orchestrator's line is open. */
  private watch: ClipboardWatch | null = null

  constructor(wire: Wiring, deps: ImagesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** A picture is on the clipboard, and has not been taken or turned down. */
  facts(): Partial<Frame> {
    return { clipboardImage: this.offered }
  }

  actions(): Actions {
    return {
      'attach-clipboard': () => this.attachFromClipboard(),
      'dismiss-clipboard': () => this.dismiss(),
      'detach-image:': (path) => {
        this.wire.put(removeAttachment(this.wire.state, path))
        this.wire.draw()
      },
    }
  }

  menus(): Menus {
    return {
      images: {
        title: (subject) => imagesTitle(subject.paths),
        items: () => this.whoFor(),
        choose: (subject, item) => this.give(subject.paths, item),
      },
    }
  }

  /** Who a picture could go to: the agents in this project, and the terminal in front. */
  private whoFor(): readonly MenuItem[] {
    return imageMenuItems({
      agents: this.wire.state.panes
        .filter((pane) => pane.project === this.wire.state.project)
        .map((pane) => ({
          task: pane.task,
          name: shownName(pane),
          running: pane.lane !== null,
          focused: pane.task === this.wire.state.focused,
        })),
      terminal: activeTerminal(this.wire.state),
    })
  }

  /** Whether there is a picture on the clipboard worth offering. */
  get offered(): boolean {
    return this.clipboard.offered !== null
  }

  /** Turned down: that copy is not offered again. */
  dismiss(): void {
    this.clipboard.seen = this.clipboard.offered
    this.clipboard.offered = null
    this.wire.draw()
  }

  /**
   * What goes with the prompt of an agent the orchestrator starts while
   * answering you: the files you attached, copied into the task's own folder.
   */
  handOff(task: string): Promise<{ note: string; images: WorkerImageFile[] }> {
    const dir = join(taskDir(this.wire.opts.home, task), 'attachments')
    return handOffFiles(this.deps.answering(), dir)
  }

  /**
   * Ask who dropped or pasted pictures are for. The keyboard starts on
   * whoever you were typing to, so enter is the likely answer.
   */
  askWhere(paths: string[]): void {
    const panel = menuPanel({ kind: 'images', paths }, imagesTitle(paths))
    const items = this.whoFor()
    const typingTo =
      this.wire.state.dictation !== null || this.wire.state.focused === null
        ? 'orchestrator'
        : this.wire.state.keyboard === 'terminal' && activeTerminal(this.wire.state)
          ? `terminal:${activeTerminal(this.wire.state)?.id}`
          : `agent:${this.wire.state.focused}`
    const index = Math.max(
      0,
      items.findIndex((item) => item.id === typingTo && !item.off),
    )
    this.wire.put({ ...this.wire.state, panel: { ...panel, index } })
    this.wire.draw()
  }

  /** Give pictures to whoever was picked: attached, pasted as paths, or typed. */
  async give(paths: string[], to: string): Promise<void> {
    if (to === 'orchestrator') {
      this.attach(paths)
      return
    }
    const [kind, ...rest] = to.split(':')
    const id = rest.join(':')
    if (kind === 'agent') {
      const pane = this.wire.state.panes.find((one) => one.task === id)
      if (!pane?.lane) {
        notify(this.wire, `open ${pane ? shownName(pane) : id}'s agent first`)
        this.wire.draw()
        return
      }
      // Pasted the way the terminal would have: the agent reads the picture
      // from its path, and you finish the sentence at its prompt.
      this.wire.put({ ...leaveLine(focusTask(this.wire.state, id)), keyboard: 'pane' })
      await this.wire.opts.client
        .write(pane.lane as LaneId, asPaste(paths.join(' ')))
        .catch((err) => notify(this.wire, why(err)))
    } else if (kind === 'terminal') {
      this.wire.put({ ...leaveLine(this.wire.state), bottom: id, keyboard: 'terminal' })
      await this.wire.opts.client
        .write(id as LaneId, paths.map(shellQuote).join(' '))
        .catch((err) => notify(this.wire, why(err)))
    }
    this.deps.soonTick()
    this.wire.draw()
  }

  /** Pictures waiting to go to the orchestrator with what you say next. */
  attach(paths: readonly string[]): void {
    const readable = paths.filter((path) => readImage(path) !== null)
    this.wire.put({
      ...openLine(this.wire.state),
      attached: [...new Set([...this.wire.state.attached, ...paths])],
      bottom: ORCHESTRATOR_TAB,
      notice:
        readable.length < paths.length
          ? `${paths.length - readable.length} could not be read as a picture: over 20 MB, or not an image`
          : paths.length === 1
            ? 'say or type what to do with it'
            : `say or type what to do with them`,
    })
    this.wire.draw()
  }

  /** The offer taken: the screenshot on the clipboard, attached. */
  async attachFromClipboard(): Promise<void> {
    if (await this.takePicture()) return
    notify(this.wire, 'no picture on the clipboard')
    this.wire.draw()
  }

  /**
   * The picture on the clipboard, attached, saved with the orchestrator's own
   * attachments since that is who it goes to. False only where there is none:
   * one that could not be saved is said, and is not a reason to paste text.
   */
  private async takePicture(): Promise<boolean> {
    const saving = (this.wire.opts.clipboard?.image ?? clipboardImage)(
      orchestratorAttachments(this.wire.opts.home),
    )
    const path = await saving.catch((err: unknown) => {
      notify(this.wire, `could not save the picture on the clipboard: ${why(err)}`)
      this.wire.draw()
      return undefined
    })
    // Said already: not a clipboard with nothing on it, so nothing else is pasted.
    if (path === undefined) return true
    if (!path) return false
    // That copy is taken: it is not offered again.
    if (this.clipboard.offered) this.clipboard.seen = this.clipboard.offered
    this.clipboard.offered = null
    this.attach([path])
    return true
  }

  /**
   * ctrl+v on one of Tade's own lines (`pasteGoes`): a picture first where one
   * can be attached, then the clipboard's text, handed to `type` as the
   * terminal's own paste — so every field takes it as it takes Cmd+V — and
   * only if the keyboard is still where it was when the clipboard was asked.
   */
  async paste(picture: boolean, type: (data: string) => void): Promise<void> {
    const at = typingAt(this.wire.state)
    if (picture && (await this.takePicture())) return
    const text = await (this.wire.opts.clipboard?.text ?? clipboardText)()
    if (text && typingAt(this.wire.state) === at) {
      type(asPaste(text))
      return
    }
    notify(
      this.wire,
      text
        ? 'not pasted: the keyboard moved before the clipboard answered'
        : text === null
          ? 'could not read the clipboard'
          : picture
            ? 'nothing on the clipboard to paste'
            : 'no text on the clipboard',
    )
    this.wire.draw()
  }

  /**
   * While the orchestrator's line is open, the clipboard is watched for a
   * picture to offer: pasting one with Cmd+V sends nothing a terminal can pass
   * on. Only then — opening the line starts the watch, and closing it or the
   * window stops it (`stop`), because what the watch costs is a process.
   */
  look(): void {
    if (this.wire.state.dictation === null) {
      this.clipboard.offered = null
      this.stop()
      return
    }
    if (this.watch) return
    this.watch = (this.wire.opts.clipboard?.watch ?? watchClipboard)((found) => this.heard(found))
  }

  /** Stop watching the clipboard: the line closed, or the window did. Twice is fine. */
  stop(): void {
    this.watch?.stop()
    this.watch = null
  }

  /** What is on the clipboard now: offered, unless it is the copy already taken or turned down. */
  private heard(found: ClipboardCopy | null): void {
    const open = this.wire.state.dictation !== null
    const offer = open && found?.image && found.copy !== this.clipboard.seen ? found.copy : null
    if (offer === this.clipboard.offered) return
    this.clipboard.offered = offer
    this.wire.draw()
  }
}
