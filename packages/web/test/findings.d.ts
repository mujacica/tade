// The findings page's pure half (`src/assets/pages/findings-shape.js`), declared
// for `findings-client.test.ts` — beside `assets.d.ts` rather than in it, so the
// page that owns the module owns its declaration. Loose for `assets.d.ts`'s
// reason: a second typed description of a projected row would be a second
// schema that nothing holds to `protocol.ts`.

declare module '*/assets/pages/findings-shape.js' {
  type Whose = 'yours' | 'agent' | 'confirmed' | 'wrong'
  type Mark = { glyph: string; word: string; tone: string }
  type Said = { words: string; more: boolean }
  type Row = {
    key: string
    question: string
    project: string
    projectHref: string
    whose: Whose
    mark: Mark
    task: string | null
    name: string | null
    href: string | null
    others: number
    file: string
    moved: boolean
    p: string
    pShare: number | null
    did: string | null
    said: Said | null
    since: string | null
    waited: number | null
    waitedSaid: string
  }
  type Group = {
    project: string
    href: string
    n: number
    oldest: number | null
    oldestSaid: string
    cards: Row[]
  }
  type Part = { key: string; label: string; tone: string; n: number }
  type Question = {
    question: string
    fired: number
    judged: number
    confirmed: number
    wrong: number
    open: number
    yours: number
    precision: number | null
    enough: boolean
    figure: string
    under: string
    parts: Part[]
  }
  type Page = {
    total: number
    counts: Record<Whose, number>
    oldest: { yours: string | null; agent: string | null }
    parts: Part[]
    groups: Group[]
    agent: Row[]
    read: Row[]
    questions: Question[]
  }
  export const ENOUGH: number
  export const WHOSE: Record<Whose, { label: string; tone: string }>
  export const VERDICTS: Record<'confirmed' | 'wrong' | 'open', { label: string; tone: string }>
  export function whoseOf(finding: any): Whose
  export function sinceOf(finding: any): string | null
  export function probabilityOf(finding: any): { said: string; share: number | null }
  export function didSaid(account: any): string | null
  export function findingOf(finding: any, asOf: number, known: (id: string) => boolean): Row
  export function groupsOf(cards: readonly Row[]): Group[]
  export function questionOf(question: string, rows: readonly Row[]): Question
  export function precisionSaid(confirmed: number, judged: number): string
  export function precisionLine(confirmed: number, judged: number): string
  export function questionsOf(rows: readonly Row[]): Question[]
  export function findingsPage(
    findings: readonly any[],
    asOf: number,
    known?: (id: string) => boolean,
  ): Page
  export function figureSaid(page: Page | null): { word: string; tone: string | null }
  export function tallyUnder(page: Page, key: string): string
  export function rowLine(row: Row): string
  export function readSaid(n: number, open: boolean): string
  export function verdictAside(row: Row): string
}

/**
 * The screen itself, declared only so a test can build it in the stills'
 * stand-in document and ask where each region landed: what it draws is the
 * page's, and a second description of it here would be nobody's.
 */
declare module '*/assets/pages/findings.js' {
  export function findingsScreen(): { node: any; update(view: any): void }
}
