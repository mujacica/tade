// The agent page's pure half (`src/assets/pages/agent-shape.js`), declared for
// `task-client.test.ts` — beside `assets.d.ts` rather than in it, so the page
// that owns the module owns its declaration (the pages are redesigned one at a
// time, often by several agents in one checkout). Loose for `assets.d.ts`'s
// reason: a second typed description of a projected row would be a second
// schema that nothing holds to `protocol.ts`.

declare module '*/assets/pages/agent-shape.js' {
  type Mark = { glyph: string; word: string; tone: string }
  type Cell = { label: string; value: string | null; under?: string | null }
  type Mark_ = { at: number; tone: string; said: string }
  type Span = { from: number; to: number | null; tone: string; said: string }
  /** One tree's record of runs, as the projection sends it. */
  type Tree = { task: string | null; checks: readonly unknown[] } | null
  export const DOTS: number
  export const SPAN_MIN: number
  export const ANSWERS: Record<'fail' | 'pass' | 'none', Mark>
  export const CELLS: Record<'pass' | 'fail' | 'other', string>
  export const MOMENTS: Record<string, { glyph: string; tone: string; lane: string | null }>
  export const LANES: readonly { key: string; label: string }[]
  export const DONE_SAID: Record<string, string>
  export function stateOf(
    kind: string,
    title: string,
    line?: string | null,
    icon?: string,
  ): { kind: string; title: string; line: string | null; icon: string | undefined }
  export function nowOf(
    task: unknown,
    asOf: number,
    frozen?: boolean,
  ): {
    mark: Mark
    said: string
    loud: 'wants' | 'failed' | null
    stalled: boolean
    runsOn: string
    moved: string | null
    movedSaid: string
    waiting: {
      tool: string
      for: string | null
      command: { text: string; notShown: number } | null
    } | null
  }
  export function treeOf(task: unknown, store: unknown): { read: boolean; tree: Tree; own: boolean }
  export function stripSaid(name: string, runs: readonly { state: string }[]): string
  export function tracksOf(
    tree: Tree,
    asOf: number,
    frozen?: boolean,
  ): {
    key: string
    check: string
    required: boolean
    answer: 'fail' | 'pass' | 'none'
    mark: Mark
    forSaid: string | null
    row: number
    typical: string | null
    cells: { tone: string }[]
    said: string
  }[]
  export function headOf(task: unknown): { mark: Mark; line: string; overruled: boolean }
  export function recentOf(tree: Tree): {
    cells: { tone: string }[]
    said: string
    line: string | null
  }
  export function branchOf(task: unknown): {
    name: string | null
    value: string | null
    under: string | null
    ahead: number
    behind: number
    moreAhead: number
    moreBehind: number
    review: Mark | null
    where: string
  }
  export function spendOf(
    task: unknown,
    store: unknown,
  ): {
    value: string | null
    why: string
    tokens: string | null
    since: string | null
    share: number | null
    shareSaid: string | null
  }
  export function runOf(
    task: unknown,
    store: unknown,
  ): {
    name: string
    href: string
    value: string | null
    share: number | null
    steps: { key: string; label: string; state: string; under: string; mine: boolean }[]
  } | null
  export function aboutOf(task: unknown, store: unknown, asOf: number, frozen?: boolean): Cell[]
  export function findingsOf(
    task: unknown,
    store: unknown,
  ): { may: boolean; n: number; said: string | null }
  export function whenSaid(at: string, asOf: number): string
  export function timelineOf(
    answer: unknown,
    task: unknown,
    tree: Tree,
    own: boolean,
    asOf: number,
  ): {
    from: number
    to: number
    now: number
    ticks: { at: number; said: string }[]
    lanes: { key: string; label: string; spans: Span[]; marks: Mark_[]; n: number }[]
    moments: number
    span: string
  }
  export function momentsOf(
    answer: unknown,
  ): { key: string; at: string; said: string; glyph: string; tone: string }[]
  type Moment = { id: string; at: string; kind: string; said: string }
  export function momentsKept(): {
    newest(answer: { activity: Moment[]; earlier: string | null } | null): void
    older(page: { activity: Moment[]; earlier: string | null }): void
    held(): { activity: Moment[]; earlier: string | null }
    readonly earlier: string | null
  }
}

declare module '*/assets/pages/agent-said.js' {
  /** A heading and what to do, per word of `CONVERSATION_WHY`. */
  export const UNREAD_SAID: Readonly<Record<string, readonly [string, string | null]>>
  export const FOLD_AT: number
  // biome-ignore lint/suspicious/noExplicitAny: nodes of whichever document a test installs
  export function conversationView(): { node: any; update(heard: unknown, view: unknown): void }
}

declare module '*/assets/pages/agent-pane.js' {
  /** One sentence per word of `SCREEN_WHY`. */
  export const WHY_SAID: Readonly<Record<string, string>>
  /** An answer, with the conversation the page holds kept where the machine said it has not moved. */
  // biome-ignore lint/suspicious/noExplicitAny: the answer's own shape
  export function withHeld(was: any, next: any): any
  /** Why there is no screen, as the card's state. */
  export function whyOf(word: string | null | undefined): {
    kind: 'empty' | 'error'
    icon: string
    title: string
    line: string | null
  }
}
