import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { acknowledge, conversationShown, FLASH_MS, flashing, unreadSince } from '../src/flash.ts'
import type { Frame } from '../src/frame.ts'
import {
  type AppState,
  initialState,
  notice,
  ORCHESTRATOR_TAB,
  withProjects,
  withTerminals,
  withTranscript,
} from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { fromThinker, tadeDid } from '../src/transcript.ts'
import { draw } from '../src/view.ts'

// What the window says back where you are looking: a flash for a press that
// worked, the conversation for anything that went wrong, and a mark on the
// conversation's tab for what landed in it while you were looking elsewhere.

const TERMINAL = 'app/terminals/1'

const window = (): AppState =>
  withTerminals(withProjects(initialState(), ['app']), [
    { id: TERMINAL, project: 'app', name: 'tests' },
  ])

const frame = (width: number, over: Partial<Frame> = {}): Frame => ({
  width,
  height: 30,
  screen: '',
  now: 1_000,
  ...over,
})

describe('an acknowledgement', () => {
  it('is said where you are looking, and never in the conversation', () => {
    const state = acknowledge(window(), 'copied ~/app/README.md', 1_000)
    expect(flashing(state, 1_000)).toBe('copied ~/app/README.md')
    expect(state.transcript.entries).toEqual([])
    // Still the last thing Tade said, for whoever asks what that was.
    expect(state.notice).toBe('copied ~/app/README.md')
  })

  it('goes after a moment, and a newer one takes its place', () => {
    const first = acknowledge(window(), 'approved: rm -rf dist', 1_000)
    expect(flashing(first, 1_000 + FLASH_MS - 1)).toBe('approved: rm -rf dist')
    expect(flashing(first, 1_000 + FLASH_MS)).toBeNull()
    const second = acknowledge(first, 'opened app', 2_000)
    expect(flashing(second, 2_000)).toBe('opened app')
  })

  it('is not what went wrong: that stays in the conversation, and nothing flashes', () => {
    const state = notice(window(), 'the worktree is gone', 1_000)
    expect(flashing(state, 1_000)).toBeNull()
    expect(state.transcript.entries).toEqual([
      { kind: 'tade', text: 'the worktree is gone', at: 1_000 },
    ])
  })

  it('is drawn in the rule over the foot, covering nothing and moving nothing', () => {
    for (const width of [24, 60, 120, 200]) {
      for (const skin of [undefined, COLOUR]) {
        const at = { ...frame(width), ...(skin ? { skin } : {}) }
        const plain = draw(window(), at)
        const flashed = draw(window(), { ...at, flash: 'copied ~/app/packages/web/src/index.ts' })
        expect(flashed.rows).toHaveLength(plain.rows.length)
        const wide = visibleWidth(plain.rows[0] ?? '')
        for (const row of flashed.rows) expect(visibleWidth(row)).toBe(wide)
        // Only the rule is different, and nothing on it is a control.
        const changed = flashed.rows.flatMap((row, i) => (row === plain.rows[i] ? [] : [i]))
        expect(changed).toEqual([plain.rows.length - 2])
        expect(flashed.hits).toEqual(plain.hits)
      }
    }
    const rule = stripTerminalSequences(
      draw(window(), frame(120, { flash: 'copied ~/app/README.md' })).rows.at(-2) ?? '',
    )
    expect(rule).toMatch(/^── {2}copied ~\/app\/README\.md {2}─+$/)
  })

  it('says as much of itself as fits, and says that it was cut', () => {
    const long = `copied ${'~/a/very/long/path/'.repeat(10)}README.md`
    const rule = stripTerminalSequences(
      draw(window(), frame(60, { flash: long })).rows.at(-2) ?? '',
    )
    expect(rule).toContain('copied ~/a/very')
    expect(rule).toContain('…')
    expect(rule.endsWith('─')).toBe(true)
  })
})

describe('the conversation, unread', () => {
  const answered = (state: AppState, text: string, at: number): AppState =>
    withTranscript(state, fromThinker(state.transcript, { type: 'message', text }, at))

  it('is read while it is in front, and unread when something lands behind a terminal', () => {
    const before = answered(window(), 'Refunds has an agent on it.', 1_000)
    expect(conversationShown(before)).toBe(true)
    const seen = before.transcript.entries.at(-1) ?? null
    // Looking at it is reading it.
    expect(unreadSince(before, null)).toBe(false)
    // A terminal in front, and nothing new: nothing to come back for.
    const elsewhere = { ...before, bottom: TERMINAL }
    expect(unreadSince(elsewhere, seen)).toBe(false)
    // The answer lands while you are in the terminal.
    const landed = answered(elsewhere, 'The build is green.', 2_000)
    expect(unreadSince(landed, seen)).toBe(true)
    // And going back to it is what clears it.
    expect(unreadSince({ ...landed, bottom: ORCHESTRATOR_TAB }, seen)).toBe(false)
  })

  it('counts a folded panel as not in front, though its tab is', () => {
    const folded: AppState = { ...window(), bottomMode: 'min' }
    expect(conversationShown(folded)).toBe(false)
    expect(unreadSince(answered(folded, 'Done.', 1_000), null)).toBe(true)
  })

  it('is not lit again by a warning dropped as a repeat', () => {
    const said = withTranscript(window(), tadeDid(window().transcript, 'status cannot say', 0))
    const seen = said.transcript.entries.at(-1) ?? null
    const elsewhere = { ...said, bottom: TERMINAL }
    const again = withTranscript(
      elsewhere,
      tadeDid(elsewhere.transcript, 'status cannot say', 2_000),
    )
    expect(unreadSince(again, seen)).toBe(false)
  })
})
