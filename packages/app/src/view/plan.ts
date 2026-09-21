import { type Hit, rowHit, type Target } from '../hits.ts'
import type { AppState } from '../model.ts'
import { type PlanRun, type PlanTone, planWidth } from '../plan-graph.ts'
import { barAcross } from '../scrollbar.ts'
import type { Skin } from '../skin.ts'
import { blank, type Pointer, Row, slid } from '../ui.ts'
import { isScrolling } from './rows.ts'

// The picture of a plan: boxes, arrows, and the tones they are painted in.
//
// `plan-graph.ts` lays a plan out — which box goes in which column, where the
// lines between them run — and this is what puts the result on the screen: in
// the room there is rather than the room it needs, scrolled sideways where
// those differ, because folding the indent back would put two pieces that
// cannot run together in one column.
//
// It knows nothing about queued work. What turns tasks into boxes is the
// queue's, and reads these tones on its way past.

/**
 * The picture of a plan where an agent's screen would be: the boxes and the
 * arrows, and the same tree again as the reason for every wait. Each part is
 * laid out in the room it needs and shown through the room there is, all of
 * them moving together, with a bar along the bottom where that is less than
 * all of it.
 *
 * A chain too wide for the pane is scrolled to, never folded into a list of
 * names: the columns and the arrows are the whole of what the picture says,
 * and a list says none of it. Each part keeps its heading where it is, so
 * what you are looking at is still named once you have moved along it.
 *
 * The bar goes under the first part rather than at the foot of the whole
 * thing: that is where the picture runs off the pane, and it is the part a
 * short pane still has room to show.
 */
export function planPicture(
  state: AppState,
  skin: Skin,
  pointer: Pointer,
  width: number,
  parts: readonly { label?: string; rows: readonly PlanRun[][] }[],
): { text: string; hits: Hit[] }[] {
  const room = Math.max(1, width - 4)
  const wide = Math.max(room, ...parts.map((part) => planWidth(part.rows)))
  const across = Math.min(Math.max(0, state.planAcross), Math.max(0, wide - room))
  const paint = planPaint(skin)
  const scrolls: Target = { kind: 'scroll', area: 'plan' }
  const out: { text: string; hits: Hit[] }[] = []
  let drawn = 0
  for (const part of parts) {
    if (part.rows.length === 0) continue
    if (part.label !== undefined) {
      const label = part.label
      out.push(blank(width))
      out.push(new Row(width, skin, pointer).space(2).text(label, skin.label).build())
    }
    const laid = part.rows.map((runs) => {
      const r = new Row(2 + wide, skin, pointer).space(2)
      for (const run of runs) {
        r.text(
          run.text,
          run.tone ? paint[run.tone] : (text) => text,
          run.task ? { kind: 'task', task: run.task } : undefined,
        )
      }
      return r.build()
    })
    for (const row of slid(laid, across, width)) {
      // The wheel over the picture moves it: the hit goes under what is drawn,
      // so a box on it is still what a click lands on.
      out.push({ ...row, hits: [rowHit(0, width, scrolls), ...row.hits] })
    }
    drawn++
    if (drawn === 1 && wide > room) {
      const bar: Target = {
        kind: 'scrollbar',
        area: 'plan',
        total: wide,
        shown: room,
        across: true,
      }
      // Under the picture and no wider than it: a bar that ran the width of
      // the pane would be saying it was about the pane.
      const track = barAcross(
        { total: wide, shown: room, offset: across, rows: room },
        skin,
        isScrolling(state, 'plan', true),
      )
      out.push({
        text: `  ${track}${' '.repeat(Math.max(0, width - room - 2))}`,
        hits: [{ row: 0, from: 2, to: Math.max(2, room + 1), target: bar }],
      })
    }
  }
  return out
}

/** A plan box's tone, from the name the skin's tones go by. */
export function planTone(tone: string): PlanTone {
  return tone === 'busy' ||
    tone === 'waiting' ||
    tone === 'bad' ||
    tone === 'done' ||
    tone === 'faded'
    ? tone
    : 'hint'
}

/** Which of the skin's tones each part of a drawn plan is painted in. */
export function planPaint(skin: Skin): Record<PlanTone, (text: string) => string> {
  return {
    busy: skin.busy,
    hint: skin.hint,
    waiting: skin.waiting,
    bad: skin.bad,
    done: skin.done,
    faded: skin.faded,
    line: skin.chrome,
    label: skin.label,
    here: skin.you,
  }
}
