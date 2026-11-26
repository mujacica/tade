import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Machine, NO_DETAIL, type RemoteLine, type RemoteTalk } from '../../src/machines.ts'
import { initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { ANSWER_MOST, answerIn, RemoteTalks, TELL_WAIT_MS } from '../../src/wire/remote-talk.ts'

// `tade_remote_tell` hands back what the other machine's orchestrator said:
// the replies after the line this machine asked, a problem there said as one,
// cut to a reply's length — and past the wait, where the answer will be
// instead of a tool call that never comes back.

const NOW = Date.UTC(2026, 10, 22, 9, 0)
/** This machine, as vps's conversation names who asked. */
const OWN = 'device a1'

let n = 0
function line(kind: RemoteLine['kind'], text: string, over: Partial<RemoteLine> = {}): RemoteLine {
  n += 1
  return {
    id: `l${n}`,
    at: null,
    kind,
    from: kind === 'asked' ? OWN : null,
    text,
    tool: null,
    outcome: null,
    streaming: false,
    there: null,
    read: false,
    call: null,
    ...over,
  }
}

function talk(lines: readonly RemoteLine[], busy = false): RemoteTalk {
  return { lines, rev: 'b0', busy, whose: busy ? OWN : null, mine: true, more: 0 }
}

describe('the answer to what this machine asked', () => {
  it('is nothing before this machine’s own line is there', () => {
    const earlier = [line('asked', 'how is it going'), line('reply', 'fine')]
    const before = new Set(earlier.map((one) => one.id))
    expect(answerIn(talk(earlier), before, OWN)).toBeNull()
    // Somebody else's question since is not this machine's.
    const theirs = [...earlier, line('asked', 'deploy it', { from: 'device b2' })]
    expect(answerIn(talk(theirs), before, OWN)).toBeNull()
  })

  it('says a problem there as one', () => {
    const lines = [line('asked', 'run the tests'), line('problem', 'the model refused')]
    expect(answerIn(talk(lines), new Set(), OWN)).toEqual({
      text: '(problem there: the model refused)',
      replied: true,
      streaming: false,
    })
  })

  it('is cut at a reply’s length', () => {
    const lines = [line('asked', 'tell me everything'), line('reply', 'x'.repeat(ANSWER_MOST * 2))]
    const came = answerIn(talk(lines), new Set(), OWN)
    expect(came?.text).toHaveLength(ANSWER_MOST)
    expect(came?.text.endsWith('…')).toBe(true)
  })
})

/**
 * A window linked to vps, whose conversation is `vps.talk`: what it asks is
 * resolved into `sent`, and `move` is vps's link saying its projection moved.
 */
function linkedToVps() {
  let vps: Machine = {
    name: 'vps',
    link: 'live',
    rev: 3,
    said: null,
    asOf: NOW,
    heard: true,
    closed: false,
    seen: [],
    projects: [],
    spend: null,
    talk: talk([line('asked', 'how is it going'), line('reply', 'an old answer')]),
    detail: NO_DETAIL,
  }
  let state = initialState()
  const wire = {
    opts: {
      client: {
        events: async () => [{ detail: { text: 'ask the vps what it is running' } }],
      },
    },
    get state() {
      return state
    },
    put: (next: typeof state) => {
      state = next
    },
    now: () => NOW,
    draw: () => {},
  } as unknown as Wiring
  const listeners: Array<(name: string) => void> = []
  let sent: (said: string) => void = () => {}
  const asked = new Promise<string>((resolve) => {
    sent = resolve
  })
  const talks = new RemoteTalks(wire, {
    reach: () => ({
      link: {
        request: async (_name: string, path: string, body: { said: string }) => {
          if (path === '/api/ask/ask') sent(body.said)
          return { status: 200, body: {} }
        },
        watch: (listener: (name: string) => void) => {
          listeners.push(listener)
          return () => listeners.splice(listeners.indexOf(listener), 1)
        },
      } as never,
      remote: { session: { device: 'a1' } } as never,
      live: true,
    }),
    machines: () => ({ here: 'this Mac', remotes: [vps] }),
    skew: () => 0,
  })
  /** vps's conversation moved to `next`, as its link says. */
  const move = (next: RemoteTalk) => {
    vps = { ...vps, talk: next }
    for (const listener of [...listeners]) listener('vps')
  }
  return { talks, asked, move, lines: () => vps.talk?.lines ?? [] }
}

describe('passing something on to another machine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('comes back with the replies after this machine’s own line, once that turn is over', async () => {
    const { talks, asked, move, lines } = linkedToVps()
    const told = talks.tell({ machine: 'vps', said: 'what is running?', asked: 'ask the vps' })
    expect(await asked).toContain('what is running?')

    const theirs = [
      line('asked', 'deploy it', { from: 'device b2' }),
      line('reply', 'deploying, for b2'),
    ]
    const ours = line('asked', 'what is running?')
    move(talk([...lines(), ...theirs, ours], true))
    move(talk([...lines(), line('reply', 'refunds and', { streaming: true })], true))
    move(talk([...lines().slice(0, -1), line('reply', 'refunds and the docs site')]))

    const answer = await told
    expect(answer).toContain('in its words')
    expect(answer.endsWith('\n\nrefunds and the docs site')).toBe(true)
    expect(answer).not.toContain('an old answer')
    expect(answer).not.toContain('for b2')
  })

  it('says where the answer will be once the wait is over, rather than waiting on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { talks, asked, move, lines } = linkedToVps()
    let answer: string | null = null
    void talks
      .tell({ machine: 'vps', said: 'rebuild everything', asked: 'ask the vps' })
      .then((said) => {
        answer = said
      })
    await asked
    // Its turn starts, and is still going when the wait runs out.
    move(talk([...lines(), line('asked', 'rebuild everything')], true))

    await vi.advanceTimersByTimeAsync(TELL_WAIT_MS - 1)
    expect(answer).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBe(
      `Passed on to the orchestrator on vps, which had not finished answering within ${TELL_WAIT_MS / 60_000} minutes: it answers in its own conversation, and they can read it on vps's tab in this window.`,
    )
  })
})
