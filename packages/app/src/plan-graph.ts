import { visibleWidth } from '@earendil-works/pi-tui'

// A plan, drawn: which work comes first, what waits on what, and what can run
// side by side. Each column is a step — everything in it can run once the
// columns before have finished — and a line with an arrow is a wait. One path
// through a plan is drawn the same way, which is how a piece of queued work
// shows the whole chain it is in.
//
// Laid out the way layered graphs usually are: each task in the column after
// the last thing it waits on, a wait that skips columns carried through them as
// a line of its own so no line crosses a box, and each column ordered to sit
// near what it waits on. Pure: tasks and waits in, rows of characters out —
// each run saying which box it is part of, so the caller can make one clickable.

export interface PlanBox {
  task: string
  mark: string
  name: string
  /** Said quietly on its first line, at the right: what it cost, or when it starts. */
  right: string
  /** Its second line: what it is doing, or what it waits for. */
  note: string
  tone: PlanTone
  /** The one you are looking at: drawn in a heavier box, so it reads without colour. */
  here?: boolean
}

export interface PlanWait {
  from: string
  to: string
}

/** How a part of the drawing is painted, named by what it is rather than its colour. */
export type PlanTone =
  | 'busy'
  | 'hint'
  | 'waiting'
  | 'bad'
  | 'done'
  | 'faded'
  | 'line'
  | 'label'
  | 'here'

export interface PlanDrawing {
  /**
   * One entry per row: its text, cut into runs that share a tone and a box.
   * A run inside a box says whose it is, so a box can be clicked.
   */
  rows: { text: string; tone: PlanTone | null; task?: string }[][]
  /** How many columns the plan needed, when it was too wide to draw as columns. */
  tooWide: boolean
}

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8

const JOINS: Record<number, string> = {
  [LEFT | RIGHT]: '─',
  [LEFT]: '─',
  [RIGHT]: '─',
  [UP | DOWN]: '│',
  [UP]: '│',
  [DOWN]: '│',
  [DOWN | RIGHT]: '╭',
  [DOWN | LEFT]: '╮',
  [UP | RIGHT]: '╰',
  [UP | LEFT]: '╯',
  [UP | DOWN | RIGHT]: '├',
  [UP | DOWN | LEFT]: '┤',
  [LEFT | RIGHT | DOWN]: '┬',
  [LEFT | RIGHT | UP]: '┴',
  [UP | DOWN | LEFT | RIGHT]: '┼',
}

/**
 * Columns a box takes, and the room between two columns of them — roomiest
 * first. A chain of four is worth drawing narrower; drawing nothing is worth
 * less than a tight box, and lines through boxes are worth less than either.
 */
const SIZES: readonly { box: number; gap: number }[] = [
  { box: 24, gap: 6 },
  { box: 20, gap: 5 },
  { box: 16, gap: 4 },
]
/** What a box says at its right — a cost, or when it starts — needs this much box. */
const RIGHT_FITS = 20
/** Rows a box takes, with one of room under it. */
const SLOT = 5

/**
 * Which column each task goes in, and in what order down it: a task in the
 * column after the last thing it waits on. A wait across more than one column
 * gets a stand-in in each column between, which is drawn as a line.
 */
export function layoutPlan(
  tasks: readonly string[],
  waits: readonly PlanWait[],
): { columns: string[][]; through: Map<string, PlanWait> } {
  const known = new Set(tasks)
  const inside = waits.filter((wait) => known.has(wait.from) && known.has(wait.to))
  const depth = new Map<string, number>()
  const place = (task: string, seen: Set<string>): number => {
    const found = depth.get(task)
    if (found !== undefined) return found
    if (seen.has(task)) return 0
    seen.add(task)
    const before = inside.filter((wait) => wait.to === task)
    const at =
      before.length === 0 ? 0 : 1 + Math.max(...before.map((wait) => place(wait.from, seen)))
    depth.set(task, at)
    return at
  }
  for (const task of tasks) place(task, new Set())

  const columns: string[][] = []
  const put = (column: number, id: string) => {
    while (columns.length <= column) columns.push([])
    columns[column]?.push(id)
  }
  for (const task of tasks) put(depth.get(task) ?? 0, task)

  // A wait across columns is carried through each one between by a stand-in.
  const through = new Map<string, PlanWait>()
  const links: PlanWait[] = []
  for (const wait of inside) {
    const from = depth.get(wait.from) ?? 0
    const to = depth.get(wait.to) ?? 0
    let previous = wait.from
    for (let column = from + 1; column < to; column++) {
      const id = `⋯${wait.from}→${wait.to}@${column}`
      through.set(id, wait)
      put(column, id)
      links.push({ from: previous, to: id })
      previous = id
    }
    links.push({ from: previous, to: wait.to })
  }

  // Twice down and back: each column sorted by where what it waits on sits.
  const rowOf = new Map<string, number>()
  const note = () => {
    for (const column of columns) {
      for (const [i, id] of column.entries()) rowOf.set(id, i)
    }
  }
  note()
  for (let pass = 0; pass < 2; pass++) {
    for (const column of columns.slice(1)) {
      const weight = (id: string) => {
        const from = links.filter((link) => link.to === id).map((link) => rowOf.get(link.from) ?? 0)
        return from.length === 0
          ? (rowOf.get(id) ?? 0)
          : from.reduce((a, b) => a + b, 0) / from.length
      }
      column.sort((a, b) => weight(a) - weight(b) || (rowOf.get(a) ?? 0) - (rowOf.get(b) ?? 0))
      note()
    }
  }
  return { columns, through }
}

/** A grid of characters, where lines join up by the directions they leave each cell in. */
class Grid {
  readonly width: number
  readonly height: number
  private readonly chars: (string | null)[][]
  private readonly joins: number[][]
  private readonly tones: (PlanTone | null)[][]
  private readonly whose: (string | null)[][]

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.chars = Array.from({ length: height }, () => Array<string | null>(width).fill(null))
    this.joins = Array.from({ length: height }, () => Array<number>(width).fill(0))
    this.tones = Array.from({ length: height }, () => Array<PlanTone | null>(width).fill(null))
    this.whose = Array.from({ length: height }, () => Array<string | null>(width).fill(null))
  }

  /** Say that a patch of the grid is a box's own, so what is drawn on it can be clicked. */
  claim(x: number, y: number, width: number, height: number, task: string): void {
    for (let row = y; row < y + height; row++) {
      const whose = this.whose[row]
      if (!whose) continue
      for (let at = x; at < x + width; at++) if (at >= 0 && at < this.width) whose[at] = task
    }
  }

  put(x: number, y: number, text: string, tone: PlanTone | null): void {
    let at = x
    for (const char of text) {
      if (y >= 0 && y < this.height && at >= 0 && at < this.width) {
        const row = this.chars[y]
        const tones = this.tones[y]
        if (row && tones) {
          row[at] = char
          tones[at] = tone
        }
      }
      at++
    }
  }

  join(x: number, y: number, directions: number): void {
    const row = this.joins[y]
    if (!row || x < 0 || x >= this.width) return
    row[x] = (row[x] ?? 0) | directions
    const tones = this.tones[y]
    if (tones && tones[x] === null) tones[x] = 'line'
  }

  rows(): { text: string; tone: PlanTone | null; task?: string }[][] {
    return this.chars.map((row, y) => {
      const runs: { text: string; tone: PlanTone | null; task?: string }[] = []
      row.forEach((char, x) => {
        const drawn = char ?? JOINS[this.joins[y]?.[x] ?? 0] ?? ' '
        const tone = drawn === ' ' ? null : (this.tones[y]?.[x] ?? null)
        const task = this.whose[y]?.[x] ?? undefined
        const last = runs.at(-1)
        if (last && last.tone === tone && last.task === task) last.text += drawn
        else runs.push({ text: drawn, tone, ...(task ? { task } : {}) })
      })
      return runs
    })
  }
}

/** Text cut to a width, ending in `…` when it had to be. */
function cut(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text
  return `${[...text].slice(0, Math.max(0, width - 1)).join('')}…`
}

/**
 * The plan in columns within a width, with the heading of each column above
 * it, in the roomiest boxes that fit. When not even the tight ones do, it says
 * so rather than drawing lines through boxes, and the caller says the plan
 * another way.
 */
export function drawPlan(
  boxes: readonly PlanBox[],
  waits: readonly PlanWait[],
  width: number,
  headings: (column: number) => string,
): PlanDrawing {
  const { columns, through } = layoutPlan(
    boxes.map((box) => box.task),
    waits,
  )
  const fits = SIZES.find(
    (size) => columns.length * size.box + Math.max(0, columns.length - 1) * size.gap <= width,
  )
  if (!fits) return { rows: [], tooWide: true }
  const { box: BOX, gap: GAP } = fits
  const tall = Math.max(1, ...columns.map((column) => column.length)) * SLOT
  const grid = new Grid(width, tall + 1)
  const byTask = new Map(boxes.map((box) => [box.task, box]))
  const where = new Map<string, { x: number; y: number }>()

  columns.forEach((column, c) => {
    const x = c * (BOX + GAP)
    grid.put(x, 0, cut(headings(c), BOX), 'label')
    column.forEach((id, r) => {
      const y = 1 + r * SLOT
      where.set(id, { x, y })
      const box = byTask.get(id)
      if (!box) {
        // A wait passing through: a line where a box would be.
        for (let i = 0; i < BOX; i++) grid.join(x + i, y + 1, LEFT | RIGHT)
        return
      }
      // The one you are on is drawn heavier, and in its own tone: which box is
      // the subject has to read with the colour off.
      const here = box.here === true
      const edge = here ? 'here' : box.tone === 'done' || box.tone === 'busy' ? box.tone : 'line'
      grid.claim(x, y, BOX, 4, box.task)
      grid.put(x, y, here ? `┏${'━'.repeat(BOX - 2)}┓` : `╭${'─'.repeat(BOX - 2)}╮`, edge)
      grid.put(x, y + 3, here ? `┗${'━'.repeat(BOX - 2)}┛` : `╰${'─'.repeat(BOX - 2)}╯`, edge)
      for (const line of [1, 2]) {
        grid.put(x, y + line, here ? '┃' : '│', edge)
        grid.put(x + BOX - 1, y + line, here ? '┃' : '│', edge)
      }
      const inner = BOX - 4
      const right = box.right && BOX >= RIGHT_FITS ? cut(box.right, 8) : ''
      const name = cut(box.name, inner - 2 - (right ? visibleWidth(right) + 1 : 0))
      grid.put(x + 2, y + 1, box.mark, box.tone)
      grid.put(x + 4, y + 1, name, null)
      if (right) grid.put(x + BOX - 2 - visibleWidth(right), y + 1, right, 'hint')
      grid.put(x + 4, y + 2, cut(box.note, inner - 2), 'hint')
    })
  })

  // Lines between neighbouring columns: out of what is waited on, along to a
  // channel of the target's own, and in with an arrow.
  const links: PlanWait[] = []
  for (const wait of waits) {
    if (!byTask.has(wait.from) || !byTask.has(wait.to)) continue
    const chain = [...through.entries()]
      .filter(([, passing]) => passing.from === wait.from && passing.to === wait.to)
      .map(([id]) => id)
      .sort((a, b) => (where.get(a)?.x ?? 0) - (where.get(b)?.x ?? 0))
    const hops = [wait.from, ...chain, wait.to]
    for (let i = 0; i < hops.length - 1; i++) {
      links.push({ from: hops[i] ?? '', to: hops[i + 1] ?? '' })
    }
  }
  const targets = [...new Set(links.map((link) => link.to))]
  for (const link of links) {
    const from = where.get(link.from)
    const to = where.get(link.to)
    if (!from || !to) continue
    const sy = from.y + 1
    const ty = to.y + 1
    const start = from.x + BOX
    const end = to.x - 1
    // Each target its own channel in the gap, so two waits never share a line.
    const lane = targets.filter((id) => where.get(id)?.x === to.x).indexOf(link.to)
    const cx = Math.min(end - 1, start + 1 + (Math.max(0, lane) % Math.max(1, GAP - 3)))
    for (let x = start; x < cx; x++) grid.join(x, sy, LEFT | RIGHT)
    if (sy === ty) {
      for (let x = cx; x < end; x++) grid.join(x, sy, LEFT | RIGHT)
    } else {
      const down = ty > sy
      grid.join(cx, sy, LEFT | (down ? DOWN : UP))
      for (let y = Math.min(sy, ty) + 1; y < Math.max(sy, ty); y++) grid.join(cx, y, UP | DOWN)
      grid.join(cx, ty, (down ? UP : DOWN) | RIGHT)
      for (let x = cx + 1; x < end; x++) grid.join(x, ty, LEFT | RIGHT)
    }
    if (byTask.has(link.to)) grid.put(end, ty, '▶', 'line')
    else grid.join(end, ty, LEFT | RIGHT)
  }
  return { rows: grid.rows(), tooWide: false }
}
