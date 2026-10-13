// The notes page's pure half (`src/assets/pages/notes-shape.js`), declared for
// `notes-client.test.ts` — beside `assets.d.ts` rather than in it, so the page
// that owns the module owns its declaration. Loose for `assets.d.ts`'s reason:
// a second typed description of a projected row would be a second schema that
// nothing holds to `protocol.ts`, which is why a row is `protocol.ts`'s own.

declare module '*/assets/pages/notes-shape.js' {
  /** The projected row itself, so this is not a second description of one. */
  type Row = import('../src/protocol.ts').NoteRow
  type Kind = 'everywhere' | 'project' | 'task'
  type Band = 'day' | 'week' | 'month' | 'older' | 'unknown'
  type Said = { words: string; more: boolean }
  type Scope = { kind: Kind; project: string | null; task: string | null }
  type Place = { kind: Kind; word: string; of: string | null; href: string | null }
  type Places = { project: (name: string) => boolean; task: (id: string) => boolean }
  type Card = {
    id: string
    at: number | null
    age: string | null
    fresh: boolean
    band: Band
    headline: Said | null
    words: Said | null
    long: boolean
    scope: Scope
    chip: Place | null
    place: Place
    by: string | null
    when: string | null
  }
  type Group = {
    key: string
    kind: Kind
    name: string
    href: string | null
    n: number
    newest: number | null
    under: string
    cards: Card[]
    own?: number
    tasks?: number
  }
  type Mark = { at: number; tone: string; said: string }
  type Lane = { key: string; label: string; href: string | null; marks: Mark[] }
  type Chart = {
    from: number
    to: number
    now: number
    said: string
    ticks: { at: number; said: string }[]
    lanes: Lane[]
    more: number
    left: number
    unplaced: number
  }
  type Where = { everywhere: Group; projects: Group[] }
  type When = { key: Band; heading: string; n: number; cards: Card[] }
  type Page = {
    total: number
    counts: Record<Kind, number>
    fresh: number
    newest: number | null
    newestSaid: string | null
    where: Where
    when: When[]
    chart: Chart
  }
  type Whole = { kind: string; icon: string; heading: string; line: string }
  export const DAY: number
  export const FRESH: number
  export const FOLD: number
  export const LONG: number
  export const LANES: number
  export const BY_SAID: Record<string, string>
  export const BANDS: { key: Band; heading: string; most: number | null }[]
  export const WINDOWS: { span: number; said: string; ticks: [number, string][] }[]
  export const PLACES: { key: Kind; label: string }[]
  export function scopeOf(scope: string | null): Scope
  export function bySaid(by: string | null): string | null
  export function bandOf(at: number | null, asOf: number): Band
  export function whenSaid(at: number | null, asOf: number): string | null
  export function placeOf(scope: Scope, places: Places, inGroup: boolean): Place | null
  export function noteOf(row: Row, asOf: number, places?: Places): Card
  export function whereOf(cards: readonly Card[], places?: Places): Where
  export function projectUnder(own: number, tasks: number, distinct: number): string
  export function whenOf(cards: readonly Card[]): When[]
  export function chartOf(where: Where, asOf: number): Chart
  export function notesPage(rows: readonly Row[], asOf: number, places?: Places): Page
  export function leadLine(page: Page): string
  export function tallyOf(page: Page): { key: Kind; label: string; n: number }[]
  export function chartFoot(chart: Chart): string
  export function shownOf(
    group: { cards: readonly Card[] },
    open: boolean,
  ): { cards: Card[]; hidden: number }
  export function foldSaid(group: { cards: readonly Card[] }, open: boolean): string | null
  export function wholeOf(
    had: boolean,
    shut: boolean,
    may: boolean,
    total: number,
    withheld: number,
  ): Whole | null
  export function asOfLine(frozen: boolean, clock: string, notHere: number): string
  type Walk = { held: Row[]; cursor: string | null; walked: boolean; restarted?: boolean }
  export const UNWALKED: Walk
  export function rowsWith(sent: readonly Row[], held: readonly Row[]): Row[]
  export function olderAfter(
    walk: Walk,
    page: { rows: readonly Row[]; next: string | null; restarted: boolean },
  ): Walk & { restarted: boolean }
  export function olderOffered(
    walk: Walk,
    left: number,
    next: string | null,
    canAsk: boolean,
  ): { cursor: string | null; offered: boolean }
}
