import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StillDocument, type StillElement } from '../scripts/still-dom.ts'
import { deskParts } from '../src/assets/desk.js'
import { atFoot } from '../src/assets/follow.js'
import { toolNamed } from '../src/assets/glyphs.js'
import { applySnapshot, emptyStore } from '../src/assets/store.js'
import { callDoing, doingOf, lineMark, talkScreen } from '../src/assets/talk.js'
import type { ChatIn } from '../src/input.ts'
import { projector } from '../src/reading.ts'
import { input, NOW, reach, talk } from './fixtures.ts'

// The conversation with Tade drawn as the window's strip draws it — on the
// conversation's own screen and in the dock at the foot of every other, with
// one renderer — and the field that sends to it.
//
// **What a line is, is said by its mark and its colour, and never by colour
// alone**: `●` Tade's news, `◆` the orchestrator's answer, `✓` a call that
// worked, `✗` one that failed or something gone wrong, each in the tone the
// window paints it. So every case here asks the glyph, the tone class and the
// word a screen reader hears, in both places a line is drawn.
//
// In the stand-in document (`scripts/still-dom.ts`): the layout — whether the
// Send press is as tall as the field, whether the newest line is in view — is
// the browser harness's (`scripts/browser.ts`).

const was = {
  document: Reflect.get(globalThis, 'document'),
  raf: Reflect.get(globalThis, 'requestAnimationFrame'),
}
let doc: StillDocument

beforeEach(() => {
  doc = new StillDocument()
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
  // A frame is drawn at once: what follows the newest line waits on one.
  Reflect.set(globalThis, 'requestAnimationFrame', (run: (at: number) => void) => {
    run(0)
    return 0
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    value: was.document,
    configurable: true,
    writable: true,
  })
  Reflect.set(globalThis, 'requestAnimationFrame', was.raf)
})

/** One line of the conversation, as the window hands it over. */
function line(n: number, over: Partial<ChatIn>): ChatIn {
  const at = Date.parse('2026-10-08T14:00:00.000Z') + n * 1000
  return {
    id: `${new Date(at).toISOString()}#0`,
    at,
    kind: 'tade',
    from: '',
    text: '',
    tool: '',
    outcome: '',
    call: null,
    streaming: false,
    ...over,
  }
}

/** The four a person asked to tell apart: news, a call that worked, one that failed, an answer. */
const FOUR: ChatIn[] = [
  line(0, { kind: 'tade', text: 'started tade/one: there was room for it' }),
  line(1, {
    kind: 'tool',
    tool: 'tade_plan',
    outcome: 'ok',
    call: { input: { project: 'tade', prompt: 'the agent on one' }, result: 'planned' },
  }),
  line(2, {
    kind: 'tool',
    tool: 'Bash',
    outcome: 'failed',
    call: { input: { command: 'git log --oneline' }, result: 'fatal: not a git repository' },
  }),
  line(3, { kind: 'reply', text: 'Successful tool calls now **show** what they returned.' }),
]

/** A store holding these lines, as a device granted the conversation and the calls reads them. */
function storeOf(lines: ChatIn[], over: Parameters<typeof talk>[0] = {}) {
  const store = emptyStore()
  const made = projector(
    input({ talk: talk({ lines, ...over }), reach: reach(['talk', 'lanes']) }),
    NOW,
  )
  expect(applySnapshot(store, made.snapshot())).toBeNull()
  return store
}

const ctx = {
  ask: () => Promise.resolve({ ok: true, status: 200, body: { did: true, said: '' } }),
  sentence: () => '',
  revOf: () => 0,
}

/** The marks the lines under a node were drawn with: glyph, tone and the word said for it. */
function marksIn(list: StillElement) {
  return list.children.map((li: StillElement) => {
    const tool = li.classList.contains('is-tool')
    const mark = tool
      ? li.querySelector('.ui-call-press:not([hidden]) .glyph, .ui-call-press.is-still .glyph')
      : li.querySelector('.line-mark')
    return {
      kind: ['tade', 'tool', 'reply', 'asked', 'problem'].find((k) =>
        li.classList.contains(`is-${k}`),
      ),
      glyph: tool ? mark?.textContent : mark?.children[0]?.textContent,
      tone: ['t-working', 't-done', 't-failed', 't-quiet'].find((t) => mark?.classList.contains(t)),
      failed: li.classList.contains('is-failed'),
    }
  })
}

const WANTED = [
  { kind: 'tade', glyph: '●', tone: 't-working', failed: false },
  { kind: 'tool', glyph: '✓', tone: 't-done', failed: false },
  { kind: 'tool', glyph: '✗', tone: 't-failed', failed: true },
  { kind: 'reply', glyph: '◆', tone: 't-working', failed: false },
]

const view = (store: ReturnType<typeof storeOf>, where = '/talk') => ({
  store,
  where,
  asOf: NOW,
  frozen: false,
})

describe('a line of the conversation', () => {
  it('takes the window’s mark and colour for each kind, as one rule', () => {
    expect(FOUR.map((one) => lineMark(one).glyph)).toEqual(['●', '✓', '✗', '◆'])
    expect(lineMark(line(9, { kind: 'problem', text: 'it stopped' }))).toMatchObject({
      glyph: '✗',
      tone: 't-failed',
    })
    expect(lineMark(line(9, { kind: 'asked', text: 'hi' })).glyph).toBe('❯')
    // A call still going is the spinner, never a tick.
    expect(lineMark(line(9, { kind: 'tool', outcome: 'running' })).glyph).not.toBe('✓')
  })

  it('on the conversation’s screen: news, a call that worked, one that failed, an answer', () => {
    const screen = talkScreen(ctx)
    screen.update(view(storeOf(FOUR)))
    const list = screen.node.querySelector('ul.chat') as StillElement
    expect(marksIn(list)).toEqual(WANTED)
    // The words a screen reader hears in place of a glyph: never the glyph alone.
    const reply = list.children[3] as StillElement
    expect(reply.querySelector('.line-mark .sr-only')?.textContent).toBe(' Tade')
    // A tool's row names the call as the window does: `plan · tade · "…"`.
    const ok = list.children[1] as StillElement
    expect(ok.querySelector('.ui-call-name')?.textContent).toBe('plan')
    expect(ok.querySelector('.ui-call-brief')?.textContent).toContain('tade')
    // Tade's news is not a card with a name over it, and neither is the answer.
    expect((list.children[0] as StillElement).querySelector('.aside')?.hidden).toBe(true)
  })

  it('in the dock, the same lines with the same marks — and folded, the last one’s', () => {
    const parts = deskParts(ctx)
    parts.update(view(storeOf(FOUR), '/'))
    const lines = parts.dock.querySelector('ul.lines') as StillElement
    expect(lines.classList.contains('chat')).toBe(true)
    expect(marksIn(lines)).toEqual(WANTED)
    const last = parts.dock.querySelector('.dock-last') as StillElement
    expect(last.querySelector('.line-mark')?.textContent).toBe('◆')
    expect(last.querySelector('.line-mark')?.classList.contains('t-working')).toBe(true)
    expect(last.classList.contains('is-reply')).toBe(true)
  })

  it('folded on a call that failed, says so in red', () => {
    const parts = deskParts(ctx)
    parts.update(view(storeOf(FOUR.slice(0, 3)), '/'))
    const last = parts.dock.querySelector('.dock-last') as StillElement
    expect(last.querySelector('.line-mark')?.textContent).toBe('✗')
    expect(last.querySelector('.line-mark')?.classList.contains('t-failed')).toBe(true)
    expect(last.textContent).toContain('Bash')
    expect(last.textContent).toContain('git log --oneline')
  })

  it('never draws the earlier lines as a line over the box', () => {
    const many = Array.from({ length: 140 }, (_, n) => line(n, { kind: 'tade', text: `line ${n}` }))
    const screen = talkScreen(ctx)
    screen.update(view(storeOf(many)))
    const dock = screen.node.querySelector('.composer-dock') as StillElement
    expect(dock.textContent).not.toMatch(/earlier/)
    // Said once, at the top of the conversation, where scrolling up reaches it.
    const older = screen.node.querySelector('.chat-earlier') as StillElement
    expect(older.hidden).toBe(false)
    expect(older.textContent).toMatch(/^↑ \d+ earlier/)
  })
})

describe('the field, while Tade answers', () => {
  it('says what it is doing from the call in flight, and how long it has been at it', () => {
    const reading = line(5, {
      kind: 'tool',
      tool: 'Read',
      outcome: 'running',
      call: { input: { file_path: 'docs/NAMES.md' }, result: null as unknown as string },
    })
    const store = storeOf([...FOUR, reading], { busy: true, whose: 'device aa' })
    const screen = talkScreen(ctx)
    screen.update(view(store))
    const field = screen.node.querySelector('.ask-field') as StillElement
    expect(field.classList.contains('is-busy')).toBe(true)
    expect(field.querySelector('textarea')?.hidden).toBe(true)
    const live = field.querySelector('.ask-live') as StillElement
    expect(live.hidden).toBe(false)
    expect(live.querySelector('.ask-spin')).not.toBeNull()
    expect(live.querySelector('.ask-doing')?.textContent).toBe('Reading NAMES.md…')
    // Stop is in the field where Send was, and Send is gone until it ends.
    expect(field.querySelector('.ask-stop')?.hidden).toBe(false)
    expect(field.querySelector('.ask-send')?.hidden).toBe(true)
  })

  it('counts from the moment the turn began, which the machine sends', () => {
    const began = Date.parse('2026-10-08T14:29:48.000Z')
    const store = storeOf(FOUR, { busy: true, whose: 'you', since: began })
    expect(store.you.talk.since).toBe('2026-10-08T14:29:48.000Z')
    const screen = talkScreen(ctx)
    screen.update({ ...view(store), frozen: true })
    expect(screen.node.querySelector('.ask-took')?.textContent).toBe('12s')
    // Nothing in flight, nothing to count from.
    expect(storeOf(FOUR, { busy: false, since: began }).you.talk.since).toBeNull()
  })

  it('puts Send back, and the box, the moment the turn ends', () => {
    const screen = talkScreen(ctx)
    screen.update(view(storeOf(FOUR, { busy: true, whose: 'you' })))
    screen.update(view(storeOf(FOUR, { busy: false, whose: '' })))
    const field = screen.node.querySelector('.ask-field') as StillElement
    expect(field.classList.contains('is-busy')).toBe(false)
    expect(field.querySelector('.ask-live')?.hidden).toBe(true)
    expect(field.querySelector('textarea')?.hidden).toBe(false)
    expect(field.querySelector('.ask-send')?.hidden).toBe(false)
    expect(field.querySelector('.ask-stop')?.hidden).toBe(true)
  })

  it('names the call in flight in words', () => {
    expect(callDoing('Read', '~/.tade/…/NAMES.md')).toBe('Reading NAMES.md')
    expect(callDoing('tade_task_create', 'tade · away-orchestrator')).toBe('Creating a task')
    expect(callDoing('Bash', '"git log --oneline -20" · "Show history"')).toBe(
      'Running git log --oneline -20',
    )
    expect(callDoing('tade_steer', 'tade/one · "and the dock"')).toBe('Steering tade/one')
    expect(callDoing('tade_deps_check', null)).toBe('Using deps check')
    expect(doingOf([line(1, { kind: 'reply', text: 'so', streaming: true })])).toBe(
      'Writing its answer…',
    )
    expect(doingOf([])).toBe('Thinking…')
    expect(doingOf([], { whose: 'you' })).toBe('Thinking… for you, at the machine')
    expect(toolNamed('tade_proposal_decide')).toBe('proposal decide')
  })
})

describe('following the newest line', () => {
  it('counts the foot as reached within a line of it, and nowhere else', () => {
    expect(atFoot(900, 100, 1000)).toBe(true)
    expect(atFoot(860, 100, 1000)).toBe(true)
    expect(atFoot(700, 100, 1000)).toBe(false)
    expect(atFoot(0, 400, 300)).toBe(true)
  })
})
