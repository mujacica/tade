import type { ListRow, ListSection, RowSummary } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Rows } from '../../src/wire/rows.ts'

// Clicking a row an extension keeps: which of the two things a click is, and
// what happens to an answer that arrives late.
//
// Built by hand rather than through the harness, like `checks.test.ts`: the
// whole of this subject is *what it asks the host for* and *what it puts in
// front of you*, and `extensions.test.ts` is already where a real click on a
// real row reaches it through a real window.

const row = (over: Partial<ListRow> = {}): ListRow => ({
  id: 'github.com/acme/api#412',
  label: '#412',
  title: 'retry refunds once',
  links: [{ title: 'PR #412', url: 'https://example.com/412' }],
  opens: { tool: 'review_show', input: { review: 'https://example.com/412' } },
  ...over,
})

const summary: RowSummary = { title: 'PR #412 — retry refunds once' }

function world(
  over: {
    summarises?: boolean
    rows?: readonly ListRow[]
    /** What `summary` answers, or nothing to leave the ask hanging. */
    answers?: RowSummary | null
    fails?: string
    /** Ids whose ask hangs until released: the answer that arrives late. */
    slow?: readonly string[]
  } = {},
) {
  const asked: string[] = []
  const opened: string[] = []
  const calls: { tool: string; caller: unknown }[] = []
  let release = (): void => {}
  let state: AppState = initialState()
  const host = {
    async summary(section: string, id: string): Promise<RowSummary | null> {
      asked.push(`${section} ${id}`)
      if ((over.slow ?? []).includes(id)) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      if (over.fails) throw new Error(over.fails)
      return over.answers === undefined ? summary : over.answers
    },
    async call(tool: string, _input: unknown, ctx: { caller: unknown }) {
      calls.push({ tool, caller: ctx.caller })
      return { text: 'done' }
    },
  }
  const wire = {
    opts: { extensions: host, extensionWorkbench: { pid: 1 } },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    now: () => 1_000,
    openedAt: 0,
    draw: () => {},
  } as unknown as Wiring
  const sections = (): readonly ListSection[] =>
    [
      {
        id: 'review.open',
        extension: 'review',
        title: 'REVIEWS',
        filters: [],
        filter: '',
        rows: over.rows ?? [row()],
        problem: null,
        summarises: over.summarises !== false,
        at: 0,
      },
    ] as ListSection[]
  const rows = new Rows(wire, {
    sections,
    openLink: async (url) => void opened.push(url),
    ask: async (one) => void (await host.call(one.opens?.tool ?? '', {}, { caller: 'you' })),
  })
  return { rows, asked, opened, calls, at: () => state, release: () => release() }
}

describe('a row an extension keeps, clicked', () => {
  it('puts it in front of you and fills the window in when the answer lands', async () => {
    const it_ = world()
    await it_.rows.open('review.open', 'github.com/acme/api#412')
    expect(it_.asked).toEqual(['review.open github.com/acme/api#412'])
    const panel = it_.at().panel
    expect(panel).toMatchObject({ kind: 'row-summary', busy: false, problem: null })
    expect(it_.rows.panel()).toEqual({ summary })
    // Looking at it is not putting it to the conversation: that is a button on
    // the window now, rather than the only thing a click could do.
    expect(it_.calls).toEqual([])
  })

  it('says it is looking from the first frame, before the ask comes back', async () => {
    const it_ = world({ slow: ['github.com/acme/api#412'] })
    const going = it_.rows.open('review.open', 'github.com/acme/api#412')
    expect(it_.at().panel).toMatchObject({
      kind: 'row-summary',
      busy: true,
      title: '#412  retry refunds once',
    })
    it_.release()
    await going
  })

  it('says why there is nothing rather than leaving the window empty', async () => {
    const failed = world({ fails: 'github.com would not say' })
    await failed.rows.open('review.open', 'github.com/acme/api#412')
    expect(failed.at().panel).toMatchObject({ busy: false, problem: 'github.com would not say' })
    expect(failed.rows.panel()).toEqual({ summary: null })

    const nothing = world({ answers: null })
    await nothing.rows.open('review.open', 'github.com/acme/api#412')
    expect(nothing.at().panel).toMatchObject({
      busy: false,
      problem: 'Nothing more is known about it.',
    })
  })

  it('drops an answer that arrives after the panel has moved on, answer and all', async () => {
    // Two clicks in a row, the slower ask landing second. A late answer drawn
    // under the second row's name is the wrong review under the right one —
    // and a late answer merely *kept* is as bad, because it is then the held
    // answer for a panel that has already answered for itself.
    const it_ = world({
      slow: ['github.com/acme/api#412'],
      rows: [row(), row({ id: 'github.com/acme/api#77', label: '#77', title: 'bump zod' })],
    })
    const slow = it_.rows.open('review.open', 'github.com/acme/api#412')
    await it_.rows.open('review.open', 'github.com/acme/api#77')
    expect(it_.at().panel).toMatchObject({ row: 'github.com/acme/api#77', busy: false })
    expect(it_.rows.panel()).toEqual({ summary })
    it_.release()
    await slow
    // The second row's own answer is still what is drawn under it.
    expect(it_.at().panel).toMatchObject({ row: 'github.com/acme/api#77', busy: false })
    expect(it_.rows.panel()).toEqual({ summary })
  })

  it('leaves a list that says nothing in full exactly as clicking one always worked', async () => {
    const tool = world({ summarises: false })
    await tool.rows.open('review.open', 'github.com/acme/api#412')
    expect(tool.asked).toEqual([])
    expect(tool.calls).toEqual([{ tool: 'review_show', caller: 'you' }])
    expect(tool.at().panel).toBeNull()

    // And a row with no tool opens where it lives, as it always did.
    const link = world({ summarises: false, rows: [row({ opens: undefined })] })
    await link.rows.open('review.open', 'github.com/acme/api#412')
    expect(link.opened).toEqual(['https://example.com/412'])
  })

  it('does nothing at all about a row no list has', async () => {
    const it_ = world()
    await it_.rows.open('review.open', 'github.com/acme/api#999')
    expect(it_.asked).toEqual([])
    expect(it_.at().panel).toBeNull()
  })

  it('carries out its two acts, and neither needs the answer to have landed', async () => {
    const it_ = world()
    await it_.rows.open('review.open', 'github.com/acme/api#412')
    const panel = it_.at().panel
    if (panel?.kind !== 'row-summary') throw new Error('the panel is not the one')
    await it_.rows.from(panel, 'open')
    expect(it_.opened).toEqual(['https://example.com/412'])
    await it_.rows.from(panel, 'ask')
    expect(it_.calls).toEqual([{ tool: 'review_show', caller: 'you' }])
  })
})
