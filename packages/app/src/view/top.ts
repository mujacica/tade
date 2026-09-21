import type { Frame } from '../frame.ts'
import { sameTarget, type Target } from '../hits.ts'
import { keyCaps } from '../keys.ts'
import { type AppState, markOf, projects, shownName, spinner } from '../model.ts'
import type { Skin } from '../skin.ts'
import { blank, box, type Drawn, type Pointer, Row, stack } from '../ui.ts'
import { clock } from './text.ts'

// Along the top: the projects you are in one of, the agent that needs you, and
// the key you talk with.
//
// A card for an agent you are not looking at appears here rather than in its
// own pane, because the point of it is that you are somewhere else.

/**
 * An agent you are not looking at needs you: a card under the tabs, answerable
 * where it appears. Only for what blocks an agent — news that does not need
 * you goes to the orchestrator's transcript.
 */
export function toastFor(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn | null {
  const shown = state.toasts
    .map((toast) => ({ toast, pane: state.panes.find((pane) => pane.task === toast.task) }))
    .filter(({ pane }) => pane?.waiting && pane.approval && pane.task !== state.focused)
    .at(-1)
  if (!shown?.pane?.approval || width < 70) return null
  const { toast, pane } = shown
  const approval = pane.approval
  if (!approval) return null
  const cardWidth = 52
  const inner = cardWidth - 2
  const seconds = Math.max(0, Math.floor(((frame.now ?? toast.at) - toast.at) / 1000))
  const card = box(
    `${skin.waiting('●')} ${pane.project} › ${shownName(pane)}`,
    [
      new Row(inner, skin)
        .space()
        .text('wants approval', skin.waiting)
        .right((r) => r.text(`${seconds}s`, skin.hint).space())
        .build(),
      new Row(inner, skin)
        .space()
        .text(approval.tool, skin.you)
        .space(2)
        .text(approval.summary)
        .build(),
      blank(inner),
      new Row(inner, skin, pointer)
        .space()
        .button('Allow once', { kind: 'action', name: `toast-allow:${pane.task}` }, 'attention')
        .space()
        .button('Deny', { kind: 'action', name: `toast-deny:${pane.task}` })
        .space()
        .button('Show', { kind: 'action', name: `toast-show:${pane.task}` })
        .build(),
    ],
    cardWidth,
    skin,
    { tone: skin.waiting, corner: '×' },
  )
  // The × in the corner closes it.
  card.hits.push({
    row: 0,
    from: cardWidth - 5,
    to: cardWidth - 3,
    target: { kind: 'action', name: `toast-close:${pane.task}` },
  })
  return card
}

export function renderTop(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const row = new Row(width, skin, pointer).space().mark('TADE').space(2)
  for (const project of projects(state)) {
    row.tab(project, { kind: 'project', project }, project === state.project)
  }
  row.space().button(' + ', { kind: 'action', name: 'open-project' }, 'add')

  // The same marks the list shows: an agent idle at its prompt is not waiting on you.
  const waiting = state.panes.filter((pane) => markOf(pane) === 'needs-you').length
  const working = state.panes.filter((pane) => markOf(pane) === 'working').length
  // The talk key is the one thing here that must survive a narrow terminal;
  // search is next, then what waits on you. The counts shorten, then go, first,
  // and the very last thing to go is the word beside the caps — never the caps.
  type Counts = 'full' | 'short' | 'waiting' | 'none'
  interface Fits {
    search: boolean
    counts: Counts
    word: boolean
  }
  const right = (show: Fits) => (r: Row) => {
    if (waiting > 0 && show.counts !== 'none') {
      const label = show.counts === 'full' ? `! ${waiting} waiting` : `! ${waiting}`
      r.text(label, skin.waiting, { kind: 'action', name: 'next-waiting' }).space(2)
    }
    if (working > 0 && (show.counts === 'full' || show.counts === 'short')) {
      const turning = spinner(frame.now ?? 0)
      r.text(
        show.counts === 'full' ? `${turning} ${working} working` : `${turning} ${working}`,
        skin.busy,
      ).space(3)
    }
    // Search, beside talking: the two keys that work from anywhere.
    if (show.search) {
      const search: Target = { kind: 'action', name: 'search' }
      r.keys(keyCaps(frame.bindings?.search ?? 'ctrl+k')).space()
      r.text('search', sameTarget(state.hover, search) ? skin.link : skin.hint, search).space(3)
    }
    talkChip(r, state, frame, skin, show.word)
    r.space()
  }
  const tries: Fits[] = [
    { search: true, counts: 'full', word: true },
    { search: true, counts: 'short', word: true },
    { search: true, counts: 'waiting', word: true },
    { search: false, counts: 'short', word: true },
    { search: false, counts: 'waiting', word: true },
    { search: false, counts: 'none', word: true },
    // Room for the caps and nothing else. Dropping the word is the last thing
    // left to drop, and it is the caps that say what to press — a bar that
    // gave up the talk key to keep the word `talk` would have it backwards.
    { search: false, counts: 'none', word: false },
  ]
  const fits = tries.find((show) => {
    const probe = new Row(width, skin)
    right(show)(probe)
    return row.used + 1 + probe.used <= width
  })
  row.right(right(fits ?? { search: false, counts: 'none', word: false }))
  return stack([row.build(), { text: skin.chrome('━'.repeat(width)), hits: [] }])
}

/**
 * The key you talk with, always on screen, in whatever state talking is in.
 * Red while the microphone is open: that is never something to have to infer.
 */
function talkChip(r: Row, state: AppState, frame: Frame, skin: Skin, word = true): void {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  const target: Target = { kind: 'action', name: 'voice' }
  if (state.talkingSince !== null && state.listening) {
    const seconds = Math.max(
      0,
      Math.floor(((frame.now ?? state.talkingSince) - state.talkingSince) / 1000),
    )
    r.text(` ● TX ${clock(seconds)} `, skin.transmit, target)
    return
  }
  if (state.hearing) {
    r.text('◌ transcribing…', skin.hint, target)
    return
  }
  if (frame.muted) {
    r.text('✕ muted', skin.bad, { kind: 'action', name: 'mute' }).space(2)
  }
  if (!voice.available) {
    // Said, not left to be discovered by holding a key that does nothing.
    r.text('× voice off', skin.bad, target).space()
    r.button('Set up', target)
    return
  }
  // Without the word the caps are the whole control, so they take the target:
  // a chip nobody can click is not a chip that survived.
  if (!word) return void r.keys(voice.keys, target)
  r.keys(voice.keys).space()
  r.text('talk', skin.hint, target)
}
