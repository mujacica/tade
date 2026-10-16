import { describe, expect, it } from 'vitest'
import {
  drawn,
  emptyScreen,
  entryLines,
  frame,
  paintFor,
  type Screen,
  signalled,
  wrapped,
} from '../src/draw.ts'

// What an ACP agent's lane shows, held without a terminal: the strip's marks,
// what is finished printed once, and only what still moves drawn again.

const plain = paintFor(false)

function play(steps: ((screen: Screen) => Screen)[]): Screen {
  return steps.reduce((screen, step) => step(screen), emptyScreen())
}

describe('an ACP lane', () => {
  it('draws the conversation with the orchestrator strip’s marks', () => {
    const screen = play([
      (s) => drawn(s, { kind: 'you', text: 'fix the login test' }),
      (s) => signalled(s, { type: 'turn_started' }, 0),
      (s) => signalled(s, { type: 'message_delta', text: 'Looking' }, 0),
      (s) =>
        signalled(
          s,
          { type: 'tool_call', callId: 'c1', tool: 'execute', input: { command: 'pnpm test' } },
          0,
        ),
      (s) => signalled(s, { type: 'tool_result', callId: 'c1', ok: false, summary: '1 failed' }, 0),
      (s) => signalled(s, { type: 'message', text: 'Found it.' }, 0),
      (s) => drawn(s, { kind: 'problem', text: 'the agent refused to go on' }),
      (s) => signalled(s, { type: 'idle' }, 0),
    ])
    const { print, live } = frame(screen, 60, 40, plain, 0)
    expect(print).toEqual([
      '❯ fix the login test',
      '◆ Looking',
      '  ✗ pnpm test',
      '    1 failed',
      '◆ Found it.',
      '✗ the agent refused to go on',
    ])
    expect(live).toEqual(['❯ '])
  })

  it('draws again only what is still moving, and prints the rest once', () => {
    let screen = play([
      (s) => drawn(s, { kind: 'you', text: 'go' }),
      (s) => signalled(s, { type: 'turn_started' }, 0),
      (s) => signalled(s, { type: 'message_delta', text: 'Half' }, 0),
    ])
    let next = frame(screen, 60, 40, plain, 0)
    expect(next.print).toEqual(['❯ go'])
    expect(next.live).toEqual(['◆ Half▍', '❯ '])
    screen = { ...screen, printed: next.printed }
    screen = signalled(screen, { type: 'message_delta', text: ' done' }, 0)
    next = frame(screen, 60, 40, plain, 0)
    expect(next.print).toEqual([])
    expect(next.live).toEqual(['◆ Half done▍', '❯ '])
  })

  it('says it is thinking, for how long and how to stop it, while nothing else moves', () => {
    const screen = play([
      (s) => drawn(s, { kind: 'you', text: 'go' }),
      (s) => signalled(s, { type: 'turn_started' }, 1_000),
      (s) => ({ ...s, draft: 'and then' }),
    ])
    const { live } = frame(screen, 60, 40, plain, 5_500)
    expect(live).toHaveLength(2)
    expect(live[0]).toMatch(/^ {2}. thinking · 4s · esc stops it$/)
    expect(live[1]).toBe('❯ and then')
  })

  it('says what it is waiting on Tade to allow, word for word', () => {
    const screen = play([
      (s) => signalled(s, { type: 'turn_started' }, 0),
      (s) =>
        signalled(
          s,
          {
            type: 'permission_request',
            requestId: 'r',
            tool: 'execute',
            input: {},
            summary: 'git push --force',
          },
          0,
        ),
    ])
    expect(frame(screen, 60, 40, plain, 0).live[0]).toBe(
      '  ◇ waiting for Tade to allow: git push --force',
    )
    const after = signalled(
      screen,
      { type: 'permission_resolved', requestId: 'r', allowed: true },
      0,
    )
    expect(after.held).toBeNull()
  })

  it('prints the oldest of what moves for good when there is no room, and says later how it went', () => {
    let screen = play([
      (s) => signalled(s, { type: 'turn_started' }, 0),
      ...[1, 2, 3, 4, 5].map(
        (n) => (s: Screen) =>
          signalled(
            s,
            { type: 'tool_call', callId: `c${n}`, tool: 'read', input: { title: `read ${n}` } },
            0,
          ),
      ),
    ])
    const next = frame(screen, 60, 5, plain, 0)
    expect(next.live.length).toBeLessThanOrEqual(4)
    expect(next.print.length).toBeGreaterThan(0)
    screen = { ...screen, printed: next.printed }
    screen = signalled(screen, { type: 'tool_result', callId: 'c1', ok: true, summary: '' }, 0)
    // c1 was printed while running, so how it went is a line of its own.
    expect(screen.entries.at(-1)).toMatchObject({ kind: 'tool', id: 'c1', state: 'ok' })
  })

  it('wraps a long line at a word, and never loses any of it', () => {
    const text = 'the quick brown fox jumps over the lazy dog and keeps on running far away'
    const lines = wrapped(text, 24, '◆ ', 2)
    expect(lines.every((line) => [...line].length <= 24)).toBe(true)
    expect(lines.map((line) => line.slice(2)).join(' ')).toBe(text)
    expect(wrapped('x'.repeat(30), 12, '  ', 2).join('').replace(/ /g, '')).toBe('x'.repeat(30))
  })

  it('paints in the window’s tones, and not at all without colour', () => {
    const colour = paintFor(true)
    const [line] = entryLines({ kind: 'problem', text: 'gone' }, 40, colour, 0)
    expect(line).toContain('\x1b[38;5;203m')
    expect(entryLines({ kind: 'problem', text: 'gone' }, 40, plain, 0)).toEqual(['✗ gone'])
  })
})
