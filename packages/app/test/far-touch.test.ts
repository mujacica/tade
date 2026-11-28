import { describe, expect, it } from 'vitest'
import { ownOf } from '../src/faces.ts'
import { farFrame, farHeart, farWhole } from '../src/far.ts'
import { FarFace } from '../src/far-face.ts'
import type { Hit, Target } from '../src/hits.ts'
import { PLAIN } from '../src/skin.ts'
import { base, frame } from './screens/scenarios/fixtures.ts'

// A phone's touch on its own copy of the window (§10 T4 of the Duo plan): a
// tap is a click looked up in the hit map the drawing returned, a swipe is the
// one move every surface makes, and on the large screen sideways the sidebar's
// edge is put on the fold. What only moves where the phone looks is done on the
// phone at once; what only the machine can answer goes as a `click` intent.

const size = { width: 120, height: 34, skin: PLAIN }

/** A phone holding the golden scenarios' window, drawn once so it has hits. */
function holding(): { face: FarFace; hits: () => readonly Hit[] } {
  const face = new FarFace({ machine: 'the Mac' })
  const state = base()
  face.take(farWhole(1, farHeart(state), farFrame(frame()), ownOf(state)).message)
  let hits: readonly Hit[] = []
  const draw = () => {
    hits = face.draw({ ...size, now: 0 })?.hits ?? []
  }
  draw()
  return {
    face,
    hits: () => {
      draw()
      return hits
    },
  }
}

/** The first cell drawn for a target that passes `which`. */
function cellOf(
  hits: readonly Hit[],
  which: (target: Target) => boolean,
): { x: number; y: number } {
  const hit = hits.find((one) => which(one.target))
  if (hit === undefined) throw new Error('nothing drawn like that')
  return { x: hit.from, y: hit.row }
}

describe('a tap on the phone', () => {
  it('looks at another agent at once and asks the machine nothing, where the agent is running', () => {
    const { face, hits } = holding()
    const at = cellOf(hits(), (t) => t.kind === 'task' && t.task === 'checkout/refunds')
    const tapped = face.tap(at.x, at.y)
    expect(tapped.intents).toEqual([])
    expect(tapped.looked, 'the machine is told where the phone looks').toBe(true)
    expect(face.state()?.focused).toBe('checkout/refunds')
  })

  it('stands in another project at once, from its tab', () => {
    const { face, hits } = holding()
    const at = cellOf(hits(), (t) => t.kind === 'project' && t.project === 'search')
    expect(face.tap(at.x, at.y).intents).toEqual([])
    expect(face.state()?.project).toBe('search')
  })

  it('sends what only the machine can do as the window’s own click, with where it landed', () => {
    const { face, hits } = holding()
    const drawn = hits()
    const hit = drawn.find((one) => one.target.kind === 'action')
    expect(hit, 'a button drawn somewhere').toBeDefined()
    if (hit === undefined) return
    const tapped = face.tap(hit.from + 1, hit.row)
    expect(tapped.intents).toEqual([
      {
        kind: 'click',
        target: hit.target,
        button: 'left',
        at: { x: hit.from + 1, y: hit.row, cell: 1, clicks: 1 },
      },
    ])
  })

  it('hands a link back for the page to open, and never sends it', () => {
    const face = new FarFace()
    const state = base()
    face.take(farWhole(1, farHeart(state), farFrame(frame()), ownOf(state)).message)
    face.draw({ ...size, now: 0 })
    // The drawing's own hits, with a link laid over one cell as an agent's screen draws one.
    const linked = face as unknown as { hits: Hit[] }
    linked.hits = [
      ...linked.hits,
      { row: 5, from: 40, to: 60, target: { kind: 'link', url: 'https://example.com/x' } },
    ]
    const tapped = face.tap(45, 5)
    expect(tapped.link).toBe('https://example.com/x')
    expect(tapped.intents).toEqual([])
  })

  it('does nothing on a cell nothing was drawn for', () => {
    const { face } = holding()
    expect(face.tap(119, 33 + 10).intents).toEqual([])
  })
})

describe('an agent opened from the overview', () => {
  it('is looked at at once where it is running, as a tap on its row would', () => {
    const { face } = holding()
    const opened = face.open('checkout/refunds')
    expect(opened.intents).toEqual([])
    expect(opened.looked, 'the machine is told where the phone looks').toBe(true)
    expect(face.state()?.focused).toBe('checkout/refunds')
  })

  it('is the same row’s click where only the machine can open it', () => {
    const { face } = holding()
    const resting = face
      .state()
      ?.panes.find((one) => !one.queued && !one.lane && one.state !== 'parked')
    expect(resting, 'an agent whose session would be resumed').toBeDefined()
    if (resting === undefined) return
    const opened = face.open(resting.task)
    expect(opened.intents).toEqual([
      {
        kind: 'click',
        target: { kind: 'task', task: resting.task },
        button: 'left',
        at: { x: 0, y: 0, cell: 0, clicks: 1 },
      },
    ])
    expect(face.state()?.focused).toBe(resting.task)
  })

  it('does nothing for an agent the window has no pane for, and nothing before a window', () => {
    const { face } = holding()
    expect(face.open('nowhere/at-all')).toEqual({ intents: [], looked: false, draw: false })
    expect(new FarFace().open('checkout/refunds')).toEqual({
      intents: [],
      looked: false,
      draw: false,
    })
  })
})

describe('a swipe on the phone', () => {
  it('moves nothing and asks nothing where nothing scrolls', () => {
    const { face, hits } = holding()
    hits()
    expect(face.swipe(0, 1000, 3)).toEqual({ intents: [], looked: false, draw: false })
  })

  it('moves a region that has more than it shows, as the wheel would, on the phone alone', () => {
    const { face, hits } = holding()
    // The sidebar holds more rows than it shows in the scenarios' window.
    const bar = hits().find(
      (one) => one.target.kind === 'scrollbar' && one.target.area === 'sidebar',
    )
    expect(bar?.target).toMatchObject({ total: 35, shown: 21 })
    const at = cellOf(hits(), (t) => t.kind === 'scroll' && t.area === 'sidebar')
    const before = face.draw({ ...size, now: 0 })?.rows.join('\n')
    const moved = face.swipe(at.x, at.y, 3)
    expect(moved).toEqual({ intents: [], looked: true, draw: true })
    expect(face.draw({ ...size, now: 0 })?.rows.join('\n')).not.toBe(before)
    // And back up past the top goes no further than the top.
    face.swipe(at.x, at.y, -10)
    expect(face.swipe(at.x, at.y, -1).draw).toBe(false)
  })
})

describe('the sidebar’s edge on the fold', () => {
  it('is drawn at the column the page holds it at, and given back', () => {
    const { face } = holding()
    const divider = (rows: readonly Hit[]) =>
      rows.find((one) => one.target.kind === 'divider' && one.target.edge === 'sidebar')?.from
    const own = divider(face.draw({ ...size, now: 0 })?.hits ?? [])
    face.holdSidebar(59)
    expect(divider(face.draw({ ...size, now: 0 })?.hits ?? [])).toBe(59)
    face.holdSidebar(null)
    expect(divider(face.draw({ ...size, now: 0 })?.hits ?? [])).toBe(own)
    expect(own).not.toBe(59)
  })
})
