import { describe, expect, it } from 'vitest'
import {
  handOver,
  KEPT,
  ordered,
  POINTS,
  quantile,
  Timings,
  table,
  timing,
  timingFlag,
  timingsFrom,
} from '../src/timing.ts'

// The instrument, against numbers somebody wrote down.
//
// A probe is the one kind of code that cannot be checked by using it: a
// histogram with the quantiles the wrong way round still prints a plausible
// table, and a reader of that table would go and memoise the wrong subject.
// `Timings.sample` exists partly for this — it takes a measurement already
// made, so the arithmetic can be asked about 1..100 rather than about how fast
// this machine happened to be.

/** 1..100, in order, so every quantile of them is its own index. */
const HUNDRED = Array.from({ length: 100 }, (_, i) => i + 1)

describe('quantiles', () => {
  it('answers with a sample that really happened', () => {
    // Nearest rank, never interpolated: the p99 frame is a frame somebody can
    // go and look at, which is the whole use of it.
    expect(quantile(HUNDRED, 0.5)).toBe(50)
    expect(quantile(HUNDRED, 0.95)).toBe(95)
    expect(quantile(HUNDRED, 0.99)).toBe(99)
    expect(quantile(HUNDRED, 1)).toBe(100)
    expect(quantile(HUNDRED, 0)).toBe(1)
  })

  it('has no answer where there are no samples', () => {
    // `unknown` is a first-class answer here as everywhere: a point nothing
    // reached is not a point that cost nothing.
    expect(quantile([], 0.5)).toBeNull()
  })

  it('clamps a quantile nobody should have asked for', () => {
    expect(quantile(HUNDRED, -1)).toBe(1)
    expect(quantile(HUNDRED, 2)).toBe(100)
  })

  it('answers about one sample with that sample', () => {
    expect(quantile([7], 0.99)).toBe(7)
  })
})

describe('what a point cost', () => {
  it('reports the quantiles of what it was given', () => {
    const timings = new Timings(true)
    for (const ms of HUNDRED) timings.sample('draw', ms)
    expect(timings.span('draw')).toEqual({
      count: 100,
      kept: 100,
      best: 1,
      p50: 50,
      p95: 95,
      p99: 99,
      worst: 100,
    })
  })

  it('has nothing to say about a point nothing reached', () => {
    expect(new Timings(true).span('draw')).toBeNull()
    expect(new Timings(true).spans()).toEqual({})
  })

  it('keeps the count and both ends past the end of the ring', () => {
    // The ring is bounded because a window left open all day at sixty frames a
    // second is twenty million samples. What it must not do is lose the three
    // things that are not about the recent past: how much has happened, the
    // worst it ever was — the frame somebody is complaining about — and the
    // best, which is the only figure about the code on a loaded machine.
    const timings = new Timings(true)
    timings.sample('draw', 9_999)
    timings.sample('draw', 0.25)
    for (let i = 0; i < KEPT + 500; i++) timings.sample('draw', 1)
    const span = timings.span('draw')
    expect(span?.count).toBe(KEPT + 502)
    expect(span?.kept).toBe(KEPT)
    expect(span?.worst).toBe(9_999)
    expect(span?.best).toBe(0.25)
    // And the quantiles are about what is still in the ring, which no longer
    // holds either of the first two samples.
    expect(span?.p99).toBe(1)
  })

  it('goes on taking samples after the ring has wrapped twice', () => {
    const timings = new Timings(true)
    for (let i = 0; i < KEPT * 2; i++) timings.sample('draw', 1)
    for (let i = 0; i < 10; i++) timings.sample('draw', 50)
    expect(timings.span('draw')?.count).toBe(KEPT * 2 + 10)
    expect(timings.span('draw')?.worst).toBe(50)
    expect(timings.span('draw')?.best).toBe(1)
  })

  it('forgets everything when asked, and stays on', () => {
    const timings = new Timings(true)
    timings.sample('draw', 1)
    timings.clear()
    expect(timings.spans()).toEqual({})
    timings.sample('draw', 2)
    expect(timings.span('draw')?.count).toBe(1)
  })
})

describe('probes that are off', () => {
  it('read no clock and record nothing', () => {
    const timings = new Timings(false)
    expect(timings.start()).toBe(0)
    timings.took('draw', 0)
    timings.sample('draw', 5)
    expect(timings.points()).toEqual([])
    expect(timings.spans()).toEqual({})
  })

  it('are what the window has unless the flag says otherwise', () => {
    // The default everybody runs. A probe on by default would be measuring
    // sixty frames a second on every machine Tade is installed on, for nobody.
    expect(timing().on).toBe(false)
  })
})

describe('timing a piece of work', () => {
  it('counts what happened since it started', () => {
    const timings = new Timings(true)
    const at = timings.start()
    expect(at).toBeGreaterThan(0)
    timings.took('draw', at)
    const span = timings.span('draw')
    expect(span?.count).toBe(1)
    // Never a rate the machine has to hit: that it is a number of milliseconds
    // at all is the property, and a starved runner makes it bigger.
    expect(span?.p50).toBeGreaterThanOrEqual(0)
  })
})

describe('the flag', () => {
  it('is off when nothing says otherwise', () => {
    expect(timingFlag({})).toEqual({ on: false, to: null })
    expect(timingFlag({ TADE_TIMING: '' })).toEqual({ on: false, to: null })
    expect(timingFlag({ TADE_TIMING: '  ' })).toEqual({ on: false, to: null })
  })

  it('can be turned off by saying so, not only by being unset', () => {
    // A flag whose only off switch is unsetting it is a flag somebody leaves
    // on — and `TADE_TIMING=0` meaning "write to a file called 0" is the kind
    // of surprise an instrument must not have.
    for (const said of ['0', 'false', 'off', 'no', 'OFF'])
      expect(timingFlag({ TADE_TIMING: said }), said).toEqual({ on: false, to: null })
  })

  it('says a table where it is a plain yes', () => {
    for (const said of ['1', 'true', 'on', 'yes', 'ON'])
      expect(timingFlag({ TADE_TIMING: said }), said).toEqual({ on: true, to: null })
  })

  it('takes anything else as where the JSON goes', () => {
    expect(timingFlag({ TADE_TIMING: '/tmp/frames.json' })).toEqual({
      on: true,
      to: '/tmp/frames.json',
    })
  })

  it('makes the probes the environment asked for', () => {
    expect(timingsFrom({}).on).toBe(false)
    expect(timingsFrom({ TADE_TIMING: '1' }).on).toBe(true)
  })
})

describe('reading the four points', () => {
  it('puts them in the order a frame passes them, dearest of the rest first', () => {
    const timings = new Timings(true)
    timings.sample('write', 1)
    timings.sample('subject:Lanes', 3)
    timings.sample('draw', 1)
    timings.sample('subject:Spend', 9)
    timings.sample('frameOf', 1)
    // The four first, in the order of the frame rather than of what arrived or
    // of the alphabet; then the subjects, dearest p99 first, because which
    // three to memoise is the question that ordering is for.
    expect(ordered(timings.spans())).toEqual([
      'frameOf',
      'draw',
      'write',
      'subject:Spend',
      'subject:Lanes',
    ])
  })

  it('leaves out a point nothing reached', () => {
    const timings = new Timings(true)
    timings.sample('draw', 1)
    expect(ordered(timings.spans())).toEqual(['draw'])
    expect(POINTS).toContain('draw')
  })

  it('draws a row for every point and a heading over them', () => {
    const timings = new Timings(true)
    for (const ms of HUNDRED) timings.sample('draw', ms)
    const printed = table(timings.spans())
    expect(printed.split('\n')[0]).toContain('p99')
    expect(printed.split('\n')[0]).toContain('best')
    expect(printed).toContain('draw')
    expect(printed).toContain('100')
  })

  it('says so rather than drawing an empty table', () => {
    expect(table({})).toBe('nothing was measured\n')
  })
})

describe('handing the summary over', () => {
  it('prints a table where no file was named', () => {
    const timings = new Timings(true)
    timings.sample('draw', 2)
    const said: string[] = []
    const saved: string[] = []
    handOver(
      timings,
      null,
      (text) => said.push(text),
      (path) => saved.push(path),
    )
    expect(said.join('')).toContain('draw')
    expect(saved).toEqual([])
  })

  it('writes JSON where one was', () => {
    const timings = new Timings(true)
    timings.sample('draw', 2)
    const saved: { path: string; text: string }[] = []
    handOver(
      timings,
      '/tmp/frames.json',
      () => {
        throw new Error('said it as well as saving it')
      },
      (path, text) => saved.push({ path, text }),
    )
    expect(saved[0]?.path).toBe('/tmp/frames.json')
    const read = JSON.parse(saved[0]?.text ?? '{}')
    expect(read.spans.draw.count).toBe(1)
    expect(read.order).toEqual(['draw'])
  })

  it('says nothing at all where nothing was measured', () => {
    // The ordinary close of a window nobody was measuring, and the close of one
    // somebody was measuring that never drew a frame: both are silence, not an
    // empty table and not an empty file.
    const quiet = (timings: Timings) => {
      let anything = false
      handOver(
        timings,
        null,
        () => {
          anything = true
        },
        () => {
          anything = true
        },
      )
      return !anything
    }
    expect(quiet(new Timings(false))).toBe(true)
    expect(quiet(new Timings(true))).toBe(true)
  })
})
