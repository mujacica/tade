import { describe, expect, it } from 'vitest'
import { REPAINT_MS } from '../../src/pace.ts'
import { Repaint } from '../../src/wire/paint.ts'
import { FakeTerminal, until, windowUnderTest } from './harness.ts'

// What the window spends keeping a screen somebody else might wipe.
//
// The repaint is the one thing on the beat that writes every row whether or
// not anything changed, because the wipe it recovers from is a thing nobody
// tells us about. That made it unconditional, and unconditional meant a
// full-sized window's worth of styled rows down the same pipe the frames go,
// every two seconds, for as long as Tade is open — including the hours it
// spends in a terminal nobody has in front of them.
//
// ⌘K goes to the window with the keyboard, so a terminal that reported losing
// focus cannot have its screen wiped under us. Both halves are asserted here,
// and the second is the one that matters: a saving that costs a dark screen is
// not a saving. So the floor is that the repaint still happens — on the beat
// while you are looking, and *at once* when the focus comes back, which is
// sooner than the beat would have reached it.

/** The focus reports, as a terminal in DEC mode 1004 sends them. */
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

/**
 * How many times the whole screen has been written over itself.
 *
 * Synchronized output followed by a saved cursor is this one write's own
 * signature: pi-tui brackets its frames with `?2026` too, but it never saves
 * the cursor, so the pair of them is nobody else's.
 */
function repaints(written: string): number {
  return written.split('\x1b[?2026h\x1b7').length - 1
}

describe('when the whole screen is worth writing again', () => {
  /** A `Repaint` watching a terminal a TUI has taken, and what that TUI heard. */
  function watched() {
    const terminal = new FakeTerminal()
    const repaint = new Repaint()
    const heard: string[] = []
    repaint.watch(terminal)
    const take = () =>
      terminal.start(
        (data) => heard.push(data),
        () => {},
      )
    take()
    return { terminal, repaint, heard, take }
  }

  it('keeps every repaint a terminal that says nothing about focus has today', () => {
    const { repaint } = watched()

    // A terminal that cannot report focus reports nothing, and nothing is
    // never read as "nobody is looking": the beat is the whole behaviour.
    expect(repaint.dueAt(1_000)).toBe(true)
    expect(repaint.dueAt(1_000 + REPAINT_MS - 1)).toBe(false)
    expect(repaint.dueAt(1_000 + REPAINT_MS)).toBe(true)
    expect(repaint.dueAt(1_000 + REPAINT_MS * 2)).toBe(true)
  })

  it('owes nothing to a terminal that reported losing the keyboard', () => {
    const { terminal, repaint, heard } = watched()
    repaint.dueAt(1_000)

    terminal.press(FOCUS_OUT)
    // However long nobody looks. The clock here is ten beats past due.
    expect(repaint.dueAt(1_000 + REPAINT_MS * 10)).toBe(false)
    // And the report went on to the TUI untouched: this watches, it never eats.
    expect(heard).toEqual([FOCUS_OUT])
  })

  it('owes one the moment the keyboard comes back, rather than on the next beat', () => {
    const { terminal, repaint } = watched()
    repaint.dueAt(1_000)
    terminal.press(FOCUS_OUT)
    expect(repaint.dueAt(1_000 + REPAINT_MS * 10)).toBe(false)

    terminal.press(FOCUS_IN)
    // The same instant the last look refused: owed now, not two seconds from
    // now, so coming back to the window never shows you the wipe.
    expect(repaint.dueAt(1_000 + REPAINT_MS * 10)).toBe(true)
    // Then it is back on the beat like anything else.
    expect(repaint.dueAt(1_000 + REPAINT_MS * 10 + 1)).toBe(false)
  })

  it('owes one to a TUI handed the terminal back, which heard no focus at all', () => {
    const { terminal, repaint, take } = watched()
    repaint.dueAt(1_000)
    terminal.press(FOCUS_OUT)
    expect(repaint.dueAt(1_000 + REPAINT_MS)).toBe(false)

    // Another screen had the terminal — the orchestrator borrows it — and
    // whatever the focus did while it was away was reported to that screen,
    // not to us. A terminal only ever says its focus *changed*, so believing
    // it still unfocused is believing it forever. Starting is the safe answer.
    take()
    expect(repaint.dueAt(1_000 + REPAINT_MS)).toBe(true)
  })
})

describe('what the window spends on the repaint', () => {
  let terminal: FakeTerminal
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
  })

  it('writes the screen again on the beat, not at all unfocused, and at once on focus', async () => {
    // The window's own clock, so the beat is crossed by moving it rather than
    // by waiting out two seconds of somebody's CI.
    const clock = { at: Date.parse('2026-10-11T09:00:00.000Z') }
    // Every read of it, which the loop does at least once a look: the evidence
    // that the loop ran, for the assertion that nothing happened while it did.
    let asked = 0
    await start({
      now: () => {
        asked++
        return clock.at
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // The premise of all of it: pi-tui asks for focus reports with the mouse,
    // and Tade leaves the mouse on. Without this the rest means nothing.
    expect(terminal.written).toContain('\x1b[?1004h')

    /** Wait for the loop to have gone round several times, whatever it costs here. */
    const looked = async () => {
      const mark = asked
      await until('the window to look again', () => asked > mark + 8)
    }

    // Focused, which a terminal that has said nothing is: the beat alone. The
    // first look's turn goes on an empty `previousScreen` — the renderer has
    // not drawn yet — so the beat it is counted from is the one after that.
    clock.at += REPAINT_MS
    await until('the screen written again on the beat', () => repaints(terminal.written) > 0)
    const onTheBeat = repaints(terminal.written)
    clock.at += REPAINT_MS
    await until('the screen written again on the next beat', () => {
      return repaints(terminal.written) > onTheBeat
    })

    // Focus gone, and the clock ten beats past due. Nothing, over as many
    // looks as it takes to prove the loop is still going round.
    terminal.press(FOCUS_OUT)
    const away = repaints(terminal.written)
    clock.at += REPAINT_MS * 10
    await looked()
    await looked()
    expect(repaints(terminal.written), 'the screen was written again unfocused').toBe(away)

    // Focus back. Not in two seconds — now.
    terminal.press(FOCUS_IN)
    await until('the screen written again on the focus coming back', () => {
      return repaints(terminal.written) > away
    })
  })
})
