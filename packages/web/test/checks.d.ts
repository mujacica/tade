// The checks page's pure half (`src/assets/pages/checks-shape.js`), declared for
// `checks-client.test.ts` — beside `assets.d.ts` rather than in it, so the page
// that owns the module owns its declaration. Loose for `assets.d.ts`'s reason:
// a second typed description of a projected row would be a second schema that
// nothing holds to `protocol.ts`.

declare module '*/assets/pages/checks-shape.js' {
  type Mark = { glyph: string; word: string; tone: string }
  type Track = {
    key: string
    project: string
    tree: string
    task: string | null
    check: string
    required: boolean
    answer: 'fail' | 'pass' | 'none'
    mark: Mark
    since: string | null
    sinceSaid: string | null
    forSaid: string | null
    row: number
    atLeast: boolean
    last: string | null
    lastSaid: string | null
    typical: string | null
    by: { name: string; href: string | null } | null
    cells: { tone: string }[]
    said: string
  }
  type Heads = {
    red: { id: string; name: string; href: string; failed: string[] }[]
    pass: number
    unknown: number
    overruled: number
    total: number
  }
  type Project = {
    name: string
    href: string
    groups: {
      key: string
      name: string
      task: string | null
      href: string | null
      tracks: Track[]
      quiet: number
    }[]
    counts: { fail: number; pass: number; none: number }
    standing: 'unread' | 'empty' | 'fail' | 'none' | 'pass'
    heads: Heads
  }
  type Page = {
    projects: Project[]
    red: Track[]
    totals: { fail: number; pass: number; none: number }
    read: boolean
    unread: number
    oldest: Track | null
    newest: Track | null
    optional: number
  }
  export const ANSWERS: Record<'fail' | 'pass' | 'none', Mark>
  export const CELLS: Record<'pass' | 'fail' | 'other', { tone: string; word: string }>
  export function answerOf(track: any): 'fail' | 'pass' | 'none'
  export function treeName(tree: any): string
  export function whenSaid(at: string, asOf: number): string
  export function forSaid(streak: any, asOf: number, frozen?: boolean): string | null
  export function typicalMs(track: any): number | null
  export function stripSaid(track: any): string
  export function byOf(track: any): { name: string; href: string | null } | null
  export function trackOf(
    project: string,
    tree: any,
    track: any,
    asOf: number,
    frozen?: boolean,
  ): Track
  export function isQuiet(track: Track): boolean
  export function projectOf(
    row: any,
    tasks: readonly any[],
    asOf: number,
    frozen?: boolean,
  ): Project
  export function standingSaid(project: Project): { word: string; tone: string | null }
  export function headsOf(tasks: readonly any[]): Heads
  export function headsSaid(heads: Heads): string
  export function checksOf(
    projects: readonly any[],
    tasksOf: (name: string) => readonly any[],
    asOf: number,
    frozen?: boolean,
  ): Page
  export function figuresOf(page: Page): {
    key: string
    label: string
    value: string | null
    tone: string | null
    under: string | null
  }[]
  export function redLine(track: Track): string
  export function quietSaid(n: number, open: boolean): string
  export function noneSaid(track: Track): string
  export function answerSaid(track: Track): string
  export function sinceLine(track: Track): string
}
