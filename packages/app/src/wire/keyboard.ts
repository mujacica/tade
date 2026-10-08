import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Editor,
  isKeyRelease,
  parseKey,
  type TuiAltScreen,
  type TuiInputListenerResult,
} from '@earendil-works/pi-tui'
import type { LaneId } from '@tade/core'
import { matchActions } from '../commands.ts'
import type { Frame } from '../frame.ts'
import { filePaths, imagePaths, pasted } from '../images.ts'
import {
  asPaste,
  caretOf,
  clickedSpan,
  cutSpan,
  type LineKey,
  lineKey,
  putCaret,
  type RowStart,
  rowStarts,
  type Selection,
  type Span,
  sequenceFor,
  spanOf,
  withSelection,
} from '../input.ts'
import { appKey, normalKey } from '../keys.ts'
import {
  activeTerminal,
  focusBy,
  focusNumber,
  keyAction,
  leaveLine,
  notice,
  ORCHESTRATOR_TAB,
  openLine,
  projectNumber,
  searchKey,
  setDictation,
  setListening,
  startHistorySearch,
} from '../model.ts'
import type { PanelOutcome } from '../panels/outcome.ts'
import { type PanelInputs, panelKey } from '../panels.ts'
import type { Skin } from '../skin.ts'
import { terminalSplitShown, typingLane } from '../split.ts'
import type { Subject, Wiring } from './context.ts'

// Where a keystroke goes, and what it does when it gets there.
//
// `onInput` is the whole of the first half of that, and its order *is* the
// behaviour: a panel takes the keyboard before anything else, a paste is read
// before it is typed, a shortcut is spent before a terminal sees it, and only
// what nothing above claimed reaches the agent you are watching. Moving a
// branch past another one here changes what a key does without changing a
// line of what it does — so read it top to bottom before touching it.
//
// The second half is the line itself: pi's editor holds the text and the
// caret, and what is *selected* on it is Tade's own, because the editor has no
// idea there is a selection. Every change to the line is still made by pressing
// the keys a person would press, never by reaching into the editor's state.

/** How much of what you said up and ctrl+r reach back through. */
const HISTORY_MAX = 1_000

/**
 * The column of ground pi's editor leaves either side of the line's text.
 * What is selected is laid on the rows it drew, so where its text starts in
 * them has to be the same number it was given.
 */
const INPUT_PAD = 1

/** A printable key, which is somebody starting to type rather than a shortcut. */
function printable(data: string): boolean {
  return data.length === 1 && data >= ' ' && data !== '\x7f'
}

/** What this subject needs from the rest of the window. */
export interface KeyboardDeps {
  /** The window's own TUI: pi's editor is a component of it. */
  tui: TuiAltScreen
  /** How big the terminal is, for the click the editor is handed. */
  size(): { columns: number; rows: number }
  /** Whether this terminal reports key releases, which is what holding a key needs. */
  kitty(): boolean
  /** What the window looks like, for the line's own border and its selection. */
  skin: Skin
  /** The window is closing, or has closed: nothing typed matters any more. */
  stopped(): boolean
  /** ctrl+c pressed again at an open question: close anyway. */
  stop(): void
  /** What an open panel answers a key against. */
  panelInputs(): PanelInputs
  /** What that answer changes. */
  applyPanel(outcome: PanelOutcome): void
  /** A picture taken off the clipboard, and paths dropped on the window. */
  attachFromClipboard(): void
  askWhereImagesGo(paths: string[]): void
  /** Push-to-talk, held or toggled. */
  talkStart(): void
  talkStop(): void
  /** Answering the agent in front: allowed, or not. */
  decide(allow: boolean): void
  /** ctrl+k: the box that finds anything. */
  openSearch(): void
  /** A named action, as a button would run it. */
  run(action: string): void
  /** Escape with a turn in flight: stop it, and nothing else. */
  interrupt(): void
  /** ctrl+c with nothing left to clear. */
  quit(): void
  /** A lane was typed into: look at it sooner than the next beat. */
  soonTick(): void
  /** Everything the window did not keep goes to the agent you are watching. */
  toLane(data: string): void
  /** A slash command, carried out. */
  act(said: string): void
  /** Anything else: a sentence for Tade, handed to the surface. */
  say(said: string): void
}

export class Keyboard implements Subject {
  private readonly wire: Wiring
  private readonly deps: KeyboardDeps
  /** pi's own editor, for the orchestrator's line. */
  private readonly editor: Editor
  /**
   * What is selected on that line: where the selection was started, and where
   * the caret has since taken it. The editor holds the text and the caret —
   * this is the one thing it has no idea about, so the head is read back out
   * of it rather than remembered, and only the anchor is kept.
   */
  private anchor: number | null = null
  /**
   * The line's rows as they were last drawn, and where each starts in the
   * text: what a click on a row and a selection up or down a row are counted
   * in. Read back out of what was drawn, because the editor wraps and scrolls
   * the text its own way.
   */
  private inputRows: RowStart[] = []
  /** What you said to Tade, oldest first. */
  private history: string[] = []

  constructor(wire: Wiring, deps: KeyboardDeps) {
    this.wire = wire
    this.deps = deps
    const plain = (text: string) => text
    this.editor = new Editor(
      deps.tui,
      {
        borderColor: plain,
        selectList: {
          selectedPrefix: plain,
          selectedText: plain,
          description: plain,
          scrollInfo: plain,
          noMatch: plain,
        },
      },
      { paddingX: INPUT_PAD },
    )
  }

  /**
   * Every keystroke lands here first. The shell claims the few it needs and
   * everything else is typed into the agent you are watching, so an agent's
   * own keybindings keep working.
   */
  onInput(data: string): TuiInputListenerResult {
    if (this.deps.stopped()) return undefined
    // A panel has the keyboard while it is open: nothing typed into a form
    // should reach an agent. ctrl+c still closes Tade, as it does everywhere.
    if (this.wire.state.panel) {
      const key = parseKey(data)
      if (key === 'ctrl+c') {
        // Pressed again at the question, it is the answer: close anyway.
        this.deps.stop()
        return { consume: true }
      }
      // Releases are protocol noise to a form — except while choosing a key,
      // where the key is all that matters and a release is not a key.
      if (isKeyRelease(data)) return { consume: true }
      this.deps.applyPanel(panelKey(this.wire.state.panel, key, data, this.deps.panelInputs()))
      return { consume: true }
    }
    // A picture dropped on the window arrives as its path, pasted. Where it
    // landed is not something a terminal says, so ask who it is for.
    const paste = pasted(data)
    if (paste !== null) {
      // A paste with nothing in it is a terminal pasting a clipboard that holds
      // only a picture: at the orchestrator, attach it; at pi, ctrl+v is how it
      // takes a picture off the clipboard itself.
      if (
        paste === '' &&
        !(this.wire.state.keyboard === 'terminal' && activeTerminal(this.wire.state))
      ) {
        const pane = this.wire.state.panes.find((one) => one.task === this.wire.state.focused)
        const lane = pane ? typingLane(this.wire.state, pane) : null
        if (this.wire.state.dictation !== null || !lane) this.deps.attachFromClipboard()
        else void this.wire.opts.client.write(lane as LaneId, '\x16').catch(() => {})
        return { consume: true }
      }
      const paths = imagePaths(paste)
      const files = filePaths(paste)
      if (paths.length > 0 || files.length > 0) {
        this.deps.askWhereImagesGo(paths.length > 0 ? paths : files)
        return { consume: true }
      }
      // Words pasted at the orchestrator's line are typed into it, on one line.
      if (
        this.wire.state.dictation !== null ||
        (this.wire.state.focused === null && !activeTerminal(this.wire.state))
      ) {
        this.wire.put(openLine(this.wire.state))
        this.sync()
        // Pasted over a selection, as typing over one: it replaces it.
        this.removeSelection()
        // As pi takes a paste: a long one becomes a marker, sent in full.
        this.editor.handleInput(asPaste(paste))
        this.wire.put(setDictation(this.wire.state, this.editor.getText()))
        this.wire.draw()
        return { consume: true }
      }
    }
    // ctrl+v at the orchestrator's line takes a screenshot off the clipboard;
    // an agent or a shell reads its own clipboard, so there it passes through.
    if (
      data === '\x16' &&
      (this.wire.state.dictation !== null || this.wire.state.focused === null)
    ) {
      this.deps.attachFromClipboard()
      return { consume: true }
    }
    const kitty = this.deps.kitty()
    const talk = this.wire.opts.config.surfaces.voice.talk
    const key = appKey(data, {
      kitty,
      listening: this.wire.state.listening,
      talk: talk.key,
      toggle: talk.mode === 'toggle',
      bindings: this.wire.opts.config.surfaces.window.keys,
    })
    const action = key ? keyAction(key, this.wire.state) : { kind: 'none' as const }

    switch (action.kind) {
      case 'focus-next':
        this.wire.put(focusBy(this.wire.state, 1))
        this.wire.draw()
        return { consume: true }
      case 'focus-previous':
        this.wire.put(focusBy(this.wire.state, -1))
        this.wire.draw()
        return { consume: true }
      case 'talk-start':
        // What you say goes to the orchestrator, so its tab comes to the front.
        if (this.wire.state.bottom !== ORCHESTRATOR_TAB)
          this.wire.put({ ...this.wire.state, bottom: ORCHESTRATOR_TAB })
        this.deps.talkStart()
        return { consume: true }
      case 'talk-stop':
        this.deps.talkStop()
        return { consume: true }
      case 'approve':
        this.deps.decide(true)
        return { consume: true }
      case 'deny':
        this.deps.decide(false)
        return { consume: true }
      case 'help':
        this.wire.put(
          notice(
            this.wire.state,
            'tab switches · ctrl+space talks · a/d answers · ctrl+c clears, then quits',
          ),
        )
        this.wire.draw()
        return { consume: true }
      case 'search':
        this.deps.openSearch()
        return { consume: true }
      case 'orchestrator':
        // Back to the line, on whatever was left on it.
        this.wire.put({ ...openLine(this.wire.state), bottom: ORCHESTRATOR_TAB })
        this.wire.draw()
        return { consume: true }
      case 'run':
        this.deps.run(action.action)
        return { consume: true }
      case 'complete': {
        // Tab on a command being typed finishes it, as a shell would.
        const [best] = matchActions(this.wire.state, this.wire.state.dictation ?? '')
        if (best) {
          this.anchor = null
          this.editor.setText(`${best.name} `)
          this.wire.put(setDictation(this.wire.state, `${best.name} `))
          this.wire.draw()
        }
        return { consume: true }
      }
      case 'agent-number':
        this.wire.put(focusNumber(this.wire.state, action.n))
        this.wire.draw()
        return { consume: true }
      case 'project-number':
        this.wire.put(projectNumber(this.wire.state, action.n))
        this.wire.draw()
        return { consume: true }
      case 'interrupt':
        this.deps.interrupt()
        return { consume: true }
      case 'leave-line':
        // Only ever reached with nothing on the line, so nothing is lost.
        this.anchor = null
        this.wire.put(setListening(leaveLine(this.wire.state), false))
        this.wire.draw()
        return { consume: true }
      case 'discard':
        this.discard()
        return { consume: true }
      case 'quit':
        this.deps.quit()
        return { consume: true }
      default:
        break
    }

    // A terminal with the keyboard gets every keystroke Tade did not keep.
    const terminal = activeTerminal(this.wire.state)
    if (terminal && this.wire.state.keyboard === 'terminal' && this.wire.state.dictation === null) {
      this.wire.put({ ...this.wire.state, terminalScroll: 0 })
      const split = terminalSplitShown(this.wire.state)
      const into = split && this.wire.state.splitFocus ? split.lane : terminal.id
      void this.wire.opts.client.write(into as LaneId, data).catch(() => {})
      this.deps.soonTick()
      return { consume: true }
    }
    // Dictating: the line is being typed, not the agent.
    if (this.wire.state.dictation !== null) {
      this.type(data)
      return { consume: true }
    }
    // Nothing focused means the orchestrator is, and it is a thing you type
    // at: a window with no agents used to swallow every keystroke.
    if (
      this.wire.state.focused === null &&
      (printable(data) || ['up', 'ctrl+r'].includes(parseKey(data) ?? ''))
    ) {
      this.wire.put(openLine(this.wire.state))
      this.sync()
      this.type(data)
      return { consume: true }
    }
    this.deps.toLane(data)
    return undefined
  }

  /**
   * Type on the orchestrator's line. pi's own editor takes the keys — the
   * cursor, words, undo, a paste, lines that wrap, ↑ for what was said —
   * so the line behaves as pi's does. Enter sends it; escape stops whatever is
   * thinking and never touches it, and ctrl+c is what throws it away.
   *
   * What is selected is Tade's own, because the editor has no idea there is
   * a selection: the few keys a selection changes the meaning of are
   * answered here — backspace takes the selection rather than a character,
   * ctrl+a takes all of it, shift and an arrow reach further — and
   * everything that puts text in replaces what was selected first.
   */
  private type(data: string): void {
    if (isKeyRelease(data)) return
    const key = parseKey(data)
    // Searching back through what you said: the search has the keys until it ends.
    if (this.wire.state.historySearch) {
      const searched = searchKey(this.wire.state, this.history, key, data)
      this.wire.put(searched.state)
      if (!this.wire.state.historySearch) {
        this.editor.setText(this.wire.state.dictation ?? '')
        this.anchor = null
      }
      if (searched.send) this.submit()
      else this.wire.draw()
      return
    }
    if (key === 'ctrl+r') {
      this.anchor = null
      this.wire.put(
        startHistorySearch(setDictation(this.wire.state, this.editor.getText()), this.history),
      )
      this.wire.draw()
      return
    }
    if (key === 'enter') {
      this.submit()
      return
    }
    if (key === 'escape') {
      // Never the line. Escape is how every harness stops what is thinking —
      // pi, Claude Code and Codex all interrupt on it and all leave the editor
      // untouched — and `keyAction` has already spent it on the turn if there
      // was one to stop. Here there was not, so nothing happens: losing a
      // half-written message to the key you press when you want something to
      // stop is the worst version of this. ctrl+c is what throws it away.
      return
    }
    if (!this.selectionKey(key ?? null)) {
      // A letter, or a line break: what is selected is what it replaces.
      // Anything else the editor has its own mind about, and a selection
      // nobody can see the point of any more is let go of.
      if (printable(data) || key === 'shift+enter' || key === 'alt+enter') this.removeSelection()
      else this.anchor = null
      this.editor.handleInput(data)
    }
    this.wire.put(setDictation(this.wire.state, this.editor.getText()))
    this.wire.draw()
  }

  /**
   * The keys a selection changes the meaning of, answered against what is
   * selected. True when the key was spent here and the editor must not also
   * see it.
   */
  private selectionKey(key: string | null): boolean {
    const what: LineKey | null = lineKey(key === null ? null : normalKey(key))
    if (!what) return false
    const text = this.editor.getText()
    const selected = this.selectionSpan()
    switch (what.do) {
      case 'select all':
        this.anchor = 0
        this.moveCaretTo(text.length)
        return true
      case 'delete':
        // With nothing selected it is the editor's own backspace, a grapheme
        // or a whole paste marker at a time.
        if (!selected) {
          this.anchor = null
          return false
        }
        this.removeSelection()
        return true
      case 'move':
        return this.moveOrExtend(what, selected, text)
    }
  }

  /**
   * An arrow, home or end, with or without shift. Shift takes the selection
   * with the caret; without it a selection is let go of, and collapses to the
   * end the caret was sent towards rather than moving on from where it was.
   */
  private moveOrExtend(
    what: Extract<LineKey, { do: 'move' }>,
    selected: Span | null,
    text: string,
  ): boolean {
    if (!what.extend) {
      this.anchor = null
      if (!selected || what.by !== 'char') return false
      this.moveCaretTo(what.back ? selected.from : selected.to)
      return true
    }
    if (this.anchor === null) this.anchor = this.caretOffset()
    if (what.by === 'row') {
      this.moveCaretTo(this.rowStep(what.back, text))
      return true
    }
    // A page is more than this line has, however many rows it wraps to: it
    // reaches the end it was sent towards, which is what a text box shorter
    // than a page does.
    if (what.by === 'page') {
      this.moveCaretTo(what.back ? 0 : text.length)
      return true
    }
    const key =
      what.by === 'word'
        ? what.back
          ? 'alt+left'
          : 'alt+right'
        : what.by === 'line'
          ? what.back
            ? 'home'
            : 'end'
          : what.back
            ? 'left'
            : 'right'
    // The move itself is the editor's: it knows what a word is to it, and
    // where its own lines wrap.
    this.editor.handleInput(sequenceFor(key))
    return true
  }

  /**
   * Where the caret lands a row up or down: the same column of the row
   * before or after the one it is on, counted in the rows the line was last
   * drawn as — past the first is the very start, past the last is the very
   * end, which is what a text box does. The editor's own up and down are not
   * used here: on the first row up is how you reach what you said last, and
   * shift held is no reason to go looking through the history.
   */
  private rowStep(back: boolean, text: string): number {
    const at = this.caretOffset()
    const rows = this.inputRows.filter((row) => row.at !== null)
    let index = -1
    rows.forEach((row, i) => {
      if ((row.at ?? 0) <= at) index = i
    })
    const to = rows[index + (back ? -1 : 1)]
    if (index < 0 || !to || to.at === null) return back ? 0 : text.length
    const column = at - (rows[index]?.at ?? 0)
    return Math.min(to.at + column, to.at + to.length)
  }

  /** Where the editor's caret is, as one offset into the text. */
  private caretOffset(): number {
    return caretOf(this.editor)
  }

  /** What is selected on the line, in reading order, or nothing. */
  private selectionSpan(): Span | null {
    if (this.anchor === null) return null
    const length = this.editor.getText().length
    const selection: Selection = {
      anchor: Math.max(0, Math.min(this.anchor, length)),
      head: this.caretOffset(),
    }
    return spanOf(selection)
  }

  /** Put the editor's caret at an offset, by the keys that move it. */
  private moveCaretTo(offset: number): void {
    putCaret(this.editor, offset)
  }

  /** Take out what is selected, if anything is. */
  private removeSelection(): boolean {
    const selected = this.selectionSpan()
    this.anchor = null
    if (!selected) return false
    cutSpan(this.editor, selected)
    return true
  }

  /**
   * The caret where the pointer is, and the selection with it: a press starts
   * one where it landed, shift held reaches there from where the caret
   * already was, and every drag after the press takes it further.
   */
  selectTo(line: number, cell: number, extend: boolean, drag: boolean): void {
    const was = this.caretOffset()
    this.caretAt(line, cell)
    if (drag) this.anchor = this.anchor ?? was
    else this.anchor = extend ? (this.anchor ?? was) : this.caretOffset()
  }

  /**
   * The caret at a column of one of the line's rows. The editor works the
   * column out itself, from the same rows it drew: it knows where its own
   * padding and wrapping are — so `cell` is from the box's own left edge,
   * which is what a hit counts, and never the window's.
   */
  private caretAt(line: number, cell: number): void {
    const size = this.deps.size()
    this.editor.handleMouse({
      type: 'click',
      button: 'left',
      x: cell,
      // Its own rows: the rule it draws above the text, then the lines.
      y: line + 1,
      screenX: cell,
      screenY: 0,
      width: size.columns,
      height: size.rows,
      shift: false,
      alt: false,
      ctrl: false,
    })
  }

  /**
   * Kept, verbatim, for up and ctrl+r: in this window at once, and in the
   * journal so the next window has it too.
   */
  remember(said: string): void {
    if (this.history.at(-1) !== said) this.history.push(said)
    this.editor.addToHistory(said)
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX)
    void this.wire.opts.client.log
      .append({ type: 'said', task: null, detail: { text: said } })
      .catch(() => {})
  }

  /** What was said in windows before this one, oldest first, for up and ctrl+r. */
  async load(): Promise<void> {
    const events = await this.wire.opts.client
      .events({ types: ['said'], limit: HISTORY_MAX })
      .catch(() => [])
    const before: string[] = []
    const keep = (text: unknown) => {
      if (typeof text === 'string' && text !== '' && before.at(-1) !== text) before.push(text)
    }
    for (const event of events) keep(event.detail.text)
    // Before lines were journaled, what you asked the orchestrator is still in
    // its own sessions, where pi keeps the conversation.
    if (before.length === 0)
      for (const text of sessionPrompts(join(this.wire.opts.home, 'orchestrator', 'sessions')))
        keep(text)
    // Anything said while this was loading is newer than all of it.
    this.history = [...before, ...this.history]
    for (const line of this.history.slice(-100)) this.editor.addToHistory(line)
  }

  /**
   * Throw away what you were about to send: the line, the pictures going with
   * it, and a search you were part-way through. The keyboard stays where it
   * is, so the next thing you type lands on the same line.
   *
   * Pressed again there is nothing left to throw away, and ctrl+c does what
   * it does everywhere else in Tade and closes it — which is pi's, Claude
   * Code's and Codex's "clear input, then quit", without a timer deciding
   * whether your second press counted.
   */
  private discard(): void {
    this.anchor = null
    this.editor.setText('')
    // Emptied, never closed: only ever reached with the line open, and the
    // keyboard stays on it.
    this.wire.put(setDictation({ ...this.wire.state, attached: [], historySearch: null }, ''))
    // Nothing is said about it: the line says what ctrl+c does next, and
    // clearing your own line is not something the conversation should record.
    this.wire.draw()
  }

  /**
   * Hand what was said to the surface, which works out who you meant.
   *
   * Sending empties the line; it never closes it. The keyboard is on the
   * orchestrator because you put it there, and one message is rarely all you
   * have to say — a line that closed itself dropped the next sentence into
   * whichever agent happened to be in front of you. Escape is what leaves an
   * empty one, and ctrl+c is what empties it.
   */
  submit(): void {
    this.sync()
    const said = this.editor.getExpandedText().trim()
    this.editor.setText('')
    this.anchor = null
    // Emptied where it was open. Closed only where it never was: push-to-talk
    // that ends with nothing to transcribe comes through here too, and that
    // is not you typing.
    const open = this.wire.state.dictation !== null
    this.wire.put(
      setListening(
        setDictation({ ...this.wire.state, historySearch: null }, open ? '' : null),
        false,
      ),
    )
    this.wire.draw()
    // A command is carried out here; anything else is a sentence for Tade.
    if (said.startsWith('/')) {
      this.remember(said)
      this.deps.act(said)
      return
    }
    this.deps.say(said)
  }

  /**
   * Carry out a slash command.
   *
   * Work happens in the window. Starting a task used to throw the whole screen
   * away for a form, which is a strange thing for a window whose entire job is
   * to show you what is running: you said what you wanted, so it is done, and
   * what you get back is the agent working on it. Only the two commands that
   * edit configuration — which is neither urgent nor about a task — borrow the
   * terminal, because a YAML editor does not fit in three rows.
   */

  /** Put a half-written command back on the line, ready to be finished. */
  prefill(line: string): void {
    this.wire.put(setDictation(this.wire.state, line))
    this.wire.draw()
  }

  /**
   * The line, as pi's editor draws it at this width, while it is open. What
   * something else put there — a transcript, a command to finish — is taken
   * into the editor first, so there is only ever one line.
   */
  facts(width: number): Partial<Frame> {
    return this.input(width)
  }

  input(width: number): Pick<Frame, 'input'> {
    // A closed line is not drawn and is not emptied: the editor keeps the
    // text, the caret and what is selected on it, so coming back finds the
    // half-written message exactly where it was left. Syncing a closed line
    // would set it to '', which is the window throwing your words away.
    if (this.wire.state.dictation === null) return {}
    this.sync()
    this.editor.focused = true
    this.editor.borderColor = this.deps.skin.signal
    const drawn = this.editor.render(width)
    // The rules it draws above and below the text are not text: the rows
    // between them are what a selection is in, and what a click counts in.
    const body = drawn.slice(1, -1)
    const text = this.editor.getText()
    this.inputRows = rowStarts(body, text, INPUT_PAD)
    const selected = this.selectionSpan()
    if (!selected) return { input: { lines: drawn } }
    const lit = withSelection(body, text, selected, this.deps.skin, INPUT_PAD, width)
    return { input: { lines: [drawn[0] ?? '', ...lit, ...drawn.slice(body.length + 1)] } }
  }

  /** The editor holds what an open line says it holds; a closed one is left alone. */
  private sync(): void {
    const wanted = this.wire.state.dictation ?? ''
    if (this.editor.getText() === wanted) return
    // Text put there by something else — a transcript, a command finished for
    // you — is a new line, and nothing of the old one is still selected.
    this.editor.setText(wanted)
    this.anchor = null
  }

  /**
   * What is selected on the line, as its text. A drag let go of is copied,
   * as a drag anywhere else on the window is.
   */
  selectedText(): string | null {
    const selected = this.selectionSpan()
    if (!selected) return null
    return this.editor.getText().slice(selected.from, selected.to)
  }

  /**
   * A click in what you have typed puts the caret there, as it does in any
   * text box; a second press takes the word it is in and a third the whole
   * line, which is what every other text box does too.
   */
  clickedOn(line: number, cell: number, clicks: number): void {
    this.caretAt(line, cell)
    const taken = clickedSpan(this.editor.getText(), this.caretOffset(), clicks)
    this.anchor = taken.to > taken.from ? taken.from : null
    if (taken.to > taken.from) this.moveCaretTo(taken.to)
  }
}

/** What was typed to the orchestrator in its pi sessions, oldest first; nothing when there are none. */
export function sessionPrompts(dir: string, most = 1_000): string[] {
  let files: string[] = []
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
  const out: string[] = []
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"role":"user"')) continue
      try {
        const entry = JSON.parse(line) as {
          type?: string
          message?: { role?: string; content?: unknown }
        }
        if (entry.type !== 'message' || entry.message?.role !== 'user') continue
        const content = entry.message.content
        const said =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .map((part: { type?: string; text?: string }) =>
                    part?.type === 'text' ? (part.text ?? '') : '',
                  )
                  .join('')
              : ''
        if (said.trim()) out.push(said.trim())
      } catch {
        // A line pi is still writing, or not ours to read.
      }
    }
  }
  return out.slice(-most)
}
