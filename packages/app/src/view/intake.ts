import type { InboxRow } from '@tade/core'
import { pointingIn, type Target } from '../hits.ts'
import { inboxMark, inboxSays } from '../intake-view.ts'
import type { AppState } from '../model.ts'
import type { Band, Skin } from '../skin.ts'
import { blank, type Pointer, Row } from '../ui.ts'
import { type ListItem, type Section, TAB_EDGES, TAB_ICONS, tabbed, tabList } from './rows.ts'
import { shortened, wrapWords } from './text.ts'

// INTAKE: what has been handed to this machine from outside, and which of it
// is waiting for you.
//
// A section of its own, between the work that is waiting and the work in front
// of you, and **always there** — the queue's own argument: a place you look is
// worth more than a row you save, and a request that arrived while you were
// out must be somewhere you can find without having set anything up first.
// With nothing in it, its heading is all it costs the side, and the heading
// says *which* of the three reasons there is nothing (`inboxEmptySays`).
//
// Two rows per request, like every other item down the side: its id and the
// word for where it stands on top, who asked and what it is stamped from
// under. The name is the one column that cannot be abbreviated without lying,
// so it keeps its columns and the state word at the right gives ground at its
// own left end.
//
// **Clicking one opens it; it never approves it.** Approving starts agents on
// somebody else's words, which is a button with its own confirmation on the
// page a click opens — the same rule the queue follows, where looking at
// queued work is never starting it.

/** What a row opens: the page for one request. Its own action, so a click is typed-equivalent. */
function opens(row: InboxRow): Target {
  return { kind: 'action', name: `intake-open:${row.item}` }
}

export function intakeSection(
  state: AppState,
  width: number,
  skin: Skin,
  pointer: Pointer,
  here: readonly InboxRow[],
  waiting: number,
  says: { short: string; long: string },
  now: number,
  open: boolean,
): Section {
  const quiet = here.length === 0
  return {
    id: 'intake',
    label: 'INTAKE',
    count: here.length,
    banded: true,
    quiet,
    // What is waiting on a person is the one thing a folded heading must still
    // say: the section is drawn at all so a request nobody has answered is
    // never invisible.
    ...(waiting > 0
      ? { note: `${waiting} waiting`, brief: `!${waiting}` }
      : quiet && !open
        ? { note: says.short, brief: 'none' }
        : {}),
    rows: (row) =>
      quiet
        ? [
            blank(width),
            ...wrapWords(says.long, Math.max(10, width - 6))
              .slice(0, 3)
              .map((text) => row().space(3).text(text, skin.hint).build()),
            blank(width),
          ]
        : tabList(
            here.map((one) => intakeRow(width, skin, pointer, one, state, now)),
            width,
          ),
  }
}

/** One request down the side: its id and where it stands, then who asked. */
function intakeRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  one: InboxRow,
  state: AppState,
  now: number,
): ListItem {
  const target = opens(one)
  const pointed = pointingIn(pointer.hover, [target])
  const chosen = state.panel?.kind === 'intake' && state.panel.item === one.item
  const band: Band | null = chosen ? 'selected' : pointed ? 'hovered' : null
  const mark = inboxMark(one, now)
  const tone = mark.tone === 'busy' ? skin.busy : toneOf(mark.tone, skin)
  const first = new Row(Math.max(0, width - TAB_EDGES), skin, pointer)
  first.space().text(mark.glyph, tone).space()
  const kept = TAB_ICONS
  const room = Math.max(1, first.width - first.used - kept)
  first.text(shortened(one.externalId, room), chosen ? skin.you : (text) => text, target)
  first.right((r) => r.text(mark.word, tone).space())
  const said = inboxSays(one)
  const second = new Row(Math.max(0, width - TAB_EDGES), skin, pointer)
  second.space(3).text(shortened(said, Math.max(1, second.width - 4)), skin.hint)
  return {
    rows: [
      tabbed(width, skin, band, first.build(), target),
      tabbed(width, skin, band, second.build(), target),
    ],
    band,
  }
}

/** A mark's tone as the skin paints it, for the five an inbox row can wear. */
function toneOf(
  tone: 'busy' | 'hint' | 'waiting' | 'bad' | 'done',
  skin: Skin,
): (text: string) => string {
  if (tone === 'waiting') return skin.waiting
  if (tone === 'bad') return skin.bad
  if (tone === 'done') return skin.done
  if (tone === 'busy') return skin.busy
  return skin.hint
}
