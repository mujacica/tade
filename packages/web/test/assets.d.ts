// The contract the browser's copy of a rule must satisfy.
//
// `tsc` has no declarations for a `.js` file and `allowJs` is off — turning it
// on would pull the away view's modules into the program, and they reach
// `document`, `location` and `EventSource`, none of which are in this
// repository's `lib`. A `.d.ts` beside the asset is not an option either:
// `src/assets/` is served, and a file of a kind nothing can serve fails
// `assets.test.ts`.
//
// So the shape lives here, in the test folder, which is the right place for
// it: it is not a type the program uses, it is the **contract a test holds two
// copies of one rule to**. `client.test.ts` runs the same table through this
// and through `src/stream.ts` and asserts they agree, so a change to either
// copy that does not change the other fails.
//
// Only the modules a test imports are declared. The ones that build DOM are
// not declared and not imported: what they do is checked in a browser
// (`scripts/browser.ts`) and over their own text (`design.test.ts`), because a
// type declaration for a renderer is a second description of it that nothing
// holds to the first.

type Connection =
  | { kind: 'live'; sinceAt: number }
  | { kind: 'stale'; sinceAt: number }
  | { kind: 'unreachable'; sinceAt: number }
  | { kind: 'closed'; why: string }

declare module '*/assets/live.js' {
  export const STALE_AFTER_MS: number
  export const BACKOFF_MS: readonly number[]
  export const GIVEN_UP_AFTER: number
  export function backoffAt(tries: number): number
  export function connectionOf(
    seen: { open: boolean; lastAt: number; ended: string | null },
    now: number,
  ): Connection
  /** `live | stale | reconnecting | unreachable | closed`. */
  export function standingOf(connection: unknown, tries?: number): string
  /** How a page with no session stands, out of what `/api/devices` answered: `unpaired | unreachable`. */
  export function outsideOf(status: number): string
  export function partsOf(
    standing: string,
    connection: unknown,
    at: string,
    now: number,
    tight?: boolean,
  ): { glyph: string; words: string }
}

declare module '*/assets/figures.js' {
  export const PLAN_WARM: number
  export const PLAN_TIGHT: number
  export const SEGMENTS: number
  export function planPressure(used: number): string
  export function duration(ms: number): string
  export function pricedOf(spend: unknown): string
  export function onPlanOf(spend: unknown): string
  export function money(
    spend: unknown,
    granted?: boolean,
  ): { said: string; mark: string; why: string }
  export function onPlan(spend: unknown): { said: string; floor: boolean; why: string } | null
  export function tokens(count: number): string
  export function tokensSaid(spend: unknown): { said: string; unpriced: string } | null
  export function planBar(used: number): { bar: string; said: string; pressure: string }
  export function count(n: number): string
  export function ageSaid(at: string | null, asOf: number, frozen?: boolean): string | null
  export function clockOf(at: string): string
  export function shortClockOf(at: string): string
  export function untilSaid(at: string | null, now: number): string | null
  export function sinceSaid(at: string | null): string | null
}

interface Mark {
  glyph: string
  word: string
  tone: string
}

declare module '*/assets/access.js' {
  export const WITHHOLDS: Readonly<Record<string, readonly string[]>>
  export function grantOf(path: string): string | null
  export function mayFor(store: Record<string, any>, path: string): boolean
}

declare module '*/assets/glyphs.js' {
  export const TASK_STATES: Readonly<Record<string, Mark>>
  export const CHECK_STATES: Readonly<Record<string, Mark>>
  export const REVIEW_STATES: Readonly<Record<string, Mark>>
  export const FRESH_MARKS: Readonly<Record<string, Mark>>
  export function taskMark(state: string): Mark
  export const AGENT_MARKS: Readonly<Record<string, Mark>>
  export function rowMark(task: { state?: string; mark?: string }): Mark
  export function checkMark(state: string): Mark
  export function reviewMark(state: string): Mark
  export function findingMark(finding: unknown): Mark
  export function queueMark(state: unknown): Mark
  export function freshMark(kind: string): Mark
  export function joined(items: readonly string[]): string
  export function queueSaid(state: unknown, clock: (at: string) => string): string
  export function originSaid(origin: { kind: string; name: string }): string
  export const INTAKE_STATES: Readonly<Record<string, Mark>>
  export const SOURCE_STATES: Readonly<Record<string, Mark>>
  export function intakeMark(row: { state: string; work: readonly { finished: boolean }[] }): Mark
  export function sourceMark(state: string): Mark
  export function stepMark(step: { state: string; finished: boolean; active: boolean }): Mark
}

declare module '*/assets/routes.js' {
  export const TITLES: Readonly<Record<string, string>>
  type Place = { view: string; icon: string; mark: string; label: string; counts: string | null }
  export const NAV: readonly Place[]
  export const MORE: readonly Place[]
  export const MORE_TAB: Place
  /** The menu's categories, and the places in each. */
  export const GROUPS: readonly { key: string; title: string; views: readonly string[] }[]
  /** The places that are the frame's own parts — the side and the dock — rather than menu entries. */
  export const DOCKED: readonly string[]
  /** Which page's own files (`pages/<page>.js`, `.css`) draw a view. */
  export const PAGE_OF: Readonly<Record<string, string>>
  export function viewOf(path: string): {
    view: string
    project?: string
    task?: string
    source?: string
    id?: string
    run?: string
    name?: string
  }
  export function pathOf(where: {
    view: string
    project?: string
    task?: string
    source?: string
    id?: string
    run?: string
    name?: string
  }): string
  export function taskPath(id: string): string
  /** Where an address from before a rename lives now: `/runs` is `/plans`. */
  export function movedFrom(path: string): string | null
  export function requestPath(item: string): string
  export function navFor(where: { view: string }): string
  export function safeHref(url: unknown): string | null
}

declare module '*/assets/store.js' {
  export const SPEAKS: number
  export const GRANTS: readonly string[]
  /**
   * Deliberately loose. These declarations exist so a test can *call* the
   * browser's copy of a rule; the shapes themselves are `protocol.ts`'s, and a
   * second typed description of them here would be a second schema that
   * nothing holds to the first.
   */
  export type Store = Record<string, any>
  export function emptyStore(): Store
  export function applySnapshot(store: Store, snapshot: unknown): string | null
  export function applyDelta(store: Store, delta: unknown): string | null
  export function rowsOf(store: Store, collection: string): readonly any[]
  export function wantsYou(store: Store): readonly any[]
  export function wantingIds(store: Store): Set<string>
  export function projectsOf(store: Store): readonly any[]
  export function tasksIn(store: Store, project: string): readonly any[]
  export function taskAt(store: Store, project: string, name: string): any
  export function projectAt(store: Store, name: string): any
  export function queueIn(store: Store, project: string | null): readonly any[]
  export function notesOf(store: Store): readonly any[]
  export function findingsOf(store: Store): readonly any[]
  export function plansOf(store: Store): readonly any[]
  export function spendFold(tasks: readonly any[], partial?: boolean): Record<string, any>
  export function checksFold(tasks: readonly any[]): Record<string, any>
  export function checksWord(fold: Record<string, any>): string
  export function reviewsOf(store: Store): { offered: readonly any[]; unoffered: readonly any[] }
  export function mayRead(store: Store, grant: string): boolean
  export function talkOf(store: Store): any
  export const WAITING: readonly string[]
  export function intakeOf(store: Store, project?: string | null): readonly any[]
  export function intakeAt(store: Store, item: string): any
  export function intakeWaiting(store: Store, project?: string | null): readonly any[]
  export function sourcesOf(store: Store): readonly any[]
  export function runsOf(store: Store, project?: string | null): readonly any[]
  export function runAt(store: Store, name: string): any
  export function workflowsOf(store: Store): readonly any[]
  export function workflowAt(store: Store, name: string): any
  export function omitted(store: Store, collection: string): number
  export function asOf(store: Store, kind: string, now: number): { at: number; frozen: boolean }
  export function spendSince(store: Store): string | null
}

declare module '*/assets/controls.js' {
  /**
   * Only `keyOf` is declared, because only `keyOf` is a rule rather than a
   * renderer: the key a press mints has to be one the server's own `KEY`
   * accepts, and two presses must never mint the same one. What the screens
   * *draw* is checked in a browser and over their own text.
   */
  export function keyOf(): string
}

declare module '*/assets/dom.js' {
  /**
   * Only `keyed` is declared, because only `keyed` is an algorithm. The rest of
   * `dom.js` makes elements, which is a thing to look at in a browser rather
   * than to describe twice.
   */
  export function keyed<R>(
    parent: unknown,
    rows: readonly R[],
    keyOf: (row: R) => string,
    create: (row: R) => unknown,
    fill: (node: never, row: R) => void,
  ): void
}

declare module '*/assets/shell.js' {
  export function barsFor(
    standing: string,
    connection: unknown,
    store: unknown,
    now: number,
    tries: number,
    extra?: readonly unknown[],
  ): { key: string; glyph: string; lead: string; under?: string; tone?: string }[]
  export const ENDING_WARNS_MS: number
  export function endingBar(
    until: string | undefined,
    now: number,
  ): { key: string; lead: string; under: string } | null
  export function crossing(was: Set<string> | null, is: Set<string>): string
  export function titleFor(where: { view: string; project?: string; task?: string }): string
}

/**
 * The conversation screen, of which only the **decisions** are declared.
 *
 * `talkScreen` builds DOM and is deliberately absent, for the reason given at
 * the head of this file: a type declaration for a renderer is a second
 * description of it that nothing holds to the first. What is here is the three
 * questions that are functions — why there is no box, who said a line, what a
 * line says — and the draft, which is the one piece of state a navigation
 * would otherwise take.
 */
declare module '*/assets/talk.js' {
  export function reasonFor(talk: unknown): string
  export function whoSaid(line: unknown): string
  export function saidOn(line: unknown): string
  export function draftStore(): { get(): string; set(said: unknown): void }
  export function reasonWord(talk: unknown): string
}

declare module '*/assets/icons.js' {
  export const ICONS: readonly string[]
  export const WORDS: readonly string[]
}

declare module '*/assets/charts.js' {
  /**
   * Only the geometry is declared: each is pure arithmetic a test can hold.
   * What the components *draw* is checked in a browser.
   */
  export const TONES: readonly string[]
  export function stopsOf(parts: readonly number[]): number[]
  export function sparkPath(
    values: readonly (number | null)[],
    w?: number,
    h?: number,
  ): { lines: string[]; areas: string[]; last: { x: number; y: number } | null }
  export function donutParts(
    parts: readonly (number | null)[],
    gap?: number,
  ): ({ start: number; length: number } | null)[]
  export function placeOf(at: number | null, from: number, to: number): number | null
  export function layered(
    nodes: readonly { id: string }[],
    edges: readonly { from: string; to: string }[],
  ): { at: Map<string, { layer: number; row: number }>; layers: number; rows: number }
  export function flowGeometry(
    nodes: readonly { id: string }[],
    edges: readonly { from: string; to: string }[],
    direction?: 'right' | 'down',
  ): {
    boxes: Map<string, { x: number; y: number }>
    paths: { from: string; to: string; d: string; head: string }[]
    width: number
    height: number
    size: { w: number; h: number; gapX: number; gapY: number }
  }
  export function levelsOf(values: readonly (number | null)[], levels?: number): (number | null)[]
}

declare module '*/assets/commands.js' {
  export const GROUP_MOST: number
  export const RECENT_MOST: number
  export function matchOf(label: string, query: string): { score: number; at: number[] } | null
  export function scoreOf(label: string, query: string): number | null
  export function commandsFor(
    query: string,
    from: {
      talk?: { mine?: boolean; busy?: boolean } | null
      tasks?: readonly {
        id: string
        path: string
        title?: string | null
        icon?: string
        tone?: string
        wants?: boolean
        acts?: readonly { verb: string; word: string; typed?: object; icon: string }[]
      }[]
      projects?: readonly string[]
      screens?: readonly { label: string; icon: string; path: string; hint?: string }[]
      recent?: readonly { path: string; label: string; icon?: string }[]
    },
  ): {
    kind: 'ask' | 'go' | 'act' | 'tell'
    group: string
    label: string
    icon: string
    path?: string
    task?: string
    match: number[]
    key: string
  }[]
  export function movedTo(at: number, rows: number, by: number): number
  export function rememberedWith(
    recent: readonly { path: string; label: string; icon?: string }[],
    one: { path: string; label: string; icon?: string },
  ): { path: string; label: string; icon?: string }[]
  export function litOf(label: string, at: readonly number[]): { text: string; on: boolean }[]
}

declare module '*/assets/glance.js' {
  export function glanceOf(store: unknown): {
    wants: { n: number; blocked: number; failed: number; review: number }
    working: { n: number; stalled: number }
    queue: { n: number; ready: number }
    checks: { pass: number; fail: number; unknown: number }
    spend: { usd: number; partial: boolean; hasCost: boolean }
    plan: { used: number; label: string; harness: string } | null
  }
  export function projectShape(counts: {
    tasks?: number
    wantsYou?: number
    working?: number
    queued?: number
  }): number[]
}

declare module '*/assets/palette.js' {
  export function actsOn(task: unknown, acts: unknown): { verb: string; word: string }[]
  export function jumpsOf(
    store: unknown,
    acts?: unknown,
  ): {
    tasks: { id: string; path: string; icon: string; tone: string }[]
    projects: string[]
    screens: { label: string; icon: string; path: string }[]
  }
}

declare module '*/assets/quick.js' {
  export const QUICK: readonly string[]
  export function quickWord(verb: string, row: unknown, asked?: boolean): string
}

declare module '*/assets/acts.js' {
  export const SHOWN: readonly string[]
  export const PROJECT_SHOWN: readonly string[]
  export const PAIRS: Readonly<Record<string, string>>
  export const NEEDS: Readonly<Record<string, string>>
  export const QUEUE_ASKS: readonly { change: string; said: string; ready?: boolean }[]
  export function asksFor(row: unknown): readonly { change: string; said: string }[]
  export function actsOf(session: unknown): {
    answer: boolean
    steer: boolean
    ask: boolean
    draft: boolean
    agents: boolean
    projects: boolean
    configure: boolean
  }
  export const SETTINGS_PATH: string
  export const CHANGE_PATH: string
  export function settingStanding(
    row: unknown,
    acts: { configure?: boolean } | null | undefined,
  ): { kind: 'off' | 'no' | 'yes'; why: string }
  export function changeBody(
    row: unknown,
    value: string,
    key: string,
    rev: number,
  ): Record<string, unknown>
  export function shownOf(row: unknown): string
  export function settingsSaid(answer: unknown): string
  export function askBody(
    talk: unknown,
    key: string,
    rev: number,
    said: string,
  ): Record<string, unknown>
  export function stopBody(talk: unknown, key: string, rev: number): Record<string, unknown>
  export function standingOf(
    verb: string,
    row: unknown,
    acts: { answer: boolean; steer: boolean },
  ): { kind: 'off' | 'no' | 'yes'; how?: string; why: string }
  export function controlsFor(
    row: unknown,
    acts: { answer: boolean; steer: boolean; agents?: boolean; projects?: boolean },
    verbs?: readonly string[],
  ): { verb: string; kind: string; how?: string; why: string }[]
  export function bodyFor(
    verb: string,
    row: unknown,
    key: string,
    rev: number,
    typed: Record<string, unknown>,
  ): Record<string, unknown>
  export function afterAnswer(
    answer: unknown,
    sentence: string,
  ): {
    ok: boolean
    clear: boolean
    said: string
    moved: boolean
    trouble: { title: string; fix: string } | null
  }
  export function confirms(verb: string): boolean
  export function wordsFor(verb: string, row: unknown): string
  export function headingFor(verb: string): string
  export function howSaid(how: string): string
}

declare module '*/assets/pages/inbox.js' {
  /**
   * Deliberately loose, for `store.js`' reason: these declarations exist so a
   * test can *call* the browser's own copy of a sentence, and a second typed
   * description of a projected row here would be a second schema that nothing
   * holds to `protocol.ts`.
   */
  export function emptySays(sources: readonly any[]): string
  export function factsOf(row: any, view: any): readonly [string, string][]
  export function materialIn(nodes: any, row: any, view: any): void
}

declare module '*/assets/pages/runs.js' {
  export function runSays(row: any, view: any): string
  export function stepSays(step: any, view: any): string
}

declare module '*/assets/pages/workflows.js' {
  export function workflowSays(row: any): string
}

declare module '*/assets/install.js' {
  export const CACHE_PREFIX: string
  export const NOT_SECURE: string
  export function installable(): boolean
  export function startInstall(
    shell: { install?: boolean; keepsView?: boolean } | null,
    told: (what: 'update' | 'gone') => void,
  ): Promise<'on' | 'off' | 'insecure' | 'cannot'>
  export function takeUpdate(): Promise<void>
  export function forget(): Promise<void>
}

declare module '*/assets/offline.js' {
  export const KEPT: readonly string[]
  export const VIEW_KEY: string
  export const VIEW_CACHE: string
  /**
   * Deliberately loose, like `store.js`'s. What a test asks of these is that
   * the record is numbers and nothing else, which is a property rather than a
   * shape — and a typed shape here would be a second description of the
   * allow-list that nothing holds to the first.
   */
  export function countsOf(store: Record<string, any>, savedAt: number): Record<string, any>
  export function onlyKept(value: unknown): Record<string, any> | null
  export function saveView(counts: Record<string, any>): Promise<boolean>
  export function readView(): Promise<Record<string, any> | null>
  export function forgetView(): Promise<void>
}

/**
 * Notifications, from the page's side.
 *
 * The six words and the sentence for each are declared, because they are the
 * decisions: which of them this device is at, and what somebody reads about
 * it. The control that draws them is `pages.js` and is deliberately absent,
 * for the reason at the head of this file.
 */
declare module '*/assets/push.js' {
  export const NOT_OFFERED: string
  export const CANNOT: string
  export const INSECURE: string
  export const DENIED: string
  export const OFF: string
  export const ON: string
  export const NEEDS_HOME_SCREEN: string
  export const PUSH_SAID: Readonly<Record<string, string>>
  export function pushable(): boolean
  export function pushState(
    shell: { notifying?: { offered?: boolean; key?: string } } | null,
  ): Promise<string>
  export function subscribe(
    shell: { notifying?: { offered?: boolean; key?: string } } | null,
    ask: (method: string, path: string, body: unknown) => Promise<{ status: number }>,
  ): Promise<string>
  export function unsubscribe(
    ask: (method: string, path: string, body: unknown) => Promise<{ status: number }>,
  ): Promise<string>
  export function resend(
    shell: { notifying?: { offered?: boolean; key?: string } } | null,
    ask: (method: string, path: string, body: unknown) => Promise<{ status: number }>,
  ): Promise<boolean>
  export const LOOKING_MS: number
  export function looking(
    shell: { notifying?: { offered?: boolean; key?: string } } | null,
    ask: (method: string, path: string, body: unknown) => Promise<{ status: number }>,
    page?: {
      visibilityState: string
      addEventListener(kind: string, run: () => void, options?: unknown): void
    },
  ): void
  export function bodyOf(made: {
    toJSON(): { endpoint?: string; keys?: Record<string, string> }
  }): {
    endpoint: string
    p256dh: string
    auth: string
  }
  export function keyBytes(key: string): Uint8Array
}

declare module '*/assets/passkey.js' {
  type You = {
    scopes?: readonly string[]
    passkey?: {
      asks: boolean
      made: boolean
      proven: boolean
      until: string | null
      makeBy: string | null
      hours: number
    } | null
  } | null
  type Asker = (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: Record<string, unknown> | null }>
  export interface Bar {
    key: string
    tone?: string
    glyph: string
    lead: string
    under: string
    press?: { said: string; does: () => void }
  }
  export const FRESH_MS: number
  export const GIVE_UP_MS: number
  export const RETRY_MS: number
  export function actsAtAll(scopes: unknown): boolean
  export function passkeyNeed(you: You): 'make' | 'use' | 'missed' | null
  export function passkeyBar(
    need: 'make' | 'use' | 'missed' | null,
    you: You,
    now: number,
    state: { busy?: boolean; said?: string; does?: () => void },
  ): Bar | null
  export function passkeys(deps: {
    ask: Asker
    freshen: () => Promise<void>
    paint: () => void
    credentials?: () => {
      create(opts: { publicKey: Record<string, unknown>; signal?: unknown }): Promise<unknown>
      get(opts: { publicKey: Record<string, unknown>; signal?: unknown }): Promise<unknown>
    }
    now?: () => number
  }): { bars(you: You, at?: number): Bar[]; ready(): void; press(): Promise<void> }
  export function bytesOf(text: string): Uint8Array
  export function textOf(buffer: ArrayBuffer | Uint8Array): string
  export function creationIn(options: Record<string, unknown>): Record<string, unknown>
  export function requestIn(options: Record<string, unknown>): Record<string, unknown>
  export function answerOf(made: unknown, ceremony: string): Record<string, unknown>
  export function refusedBy(error: unknown): string
}

declare module '*/assets/tree.js' {
  interface Piece {
    task: string
    project: string
    state: { kind: string; [field: string]: unknown }
    order: number | null
    waitsOn: readonly { task: string; why: unknown }[]
  }
  interface Node<R> {
    row: R
    depth: number
    children: Node<R>[]
  }
  export function queueTree<R extends Piece>(rows: readonly R[]): Node<R>[]
  export function queueAt(state: unknown, clock: (at: string) => string): string
  export function queueLine(state: unknown, project: string): string
  export function queuePaused(rows: readonly { state: unknown }[]): boolean
  export function sideAgents<
    T extends { state: string; name: string; createdAt?: string; agents?: number; lanes?: number },
  >(tasks: readonly T[]): T[]
  export function agentGroups<T extends { effort?: string | null }>(
    agents: readonly T[],
  ): { effort: string | null; agents: T[] }[]
  export const FOLDS: readonly string[]
  export function foldsFrom(kept: unknown): Record<string, boolean>
  export function foldsTo(folds: Record<string, boolean>): string
}

declare module '*/assets/desk.js' {
  export function noAgentsSaid(store: unknown): string
}

declare module '*/assets/agents.js' {
  export function byProject<T extends { project: string }>(
    agents: readonly T[],
  ): { project: string; agents: T[] }[]
  export function runsOn(task: {
    project: string
    harness: string | null
    model: string | null
    account: { words: string } | null
  }): string
}

declare module '*/assets/toasts.js' {
  export const MOST: number
  export const LOG_MOST: number
  export function loggedWith(
    log: readonly { id: string; kind: string; at: number; key: string }[],
    changes: readonly { id: string; kind: string }[],
    at: number,
    most?: number,
  ): { id: string; kind: string; at: number; key: string }[]
  export const STANDS_MS: number
  export function statesOf(
    tasks: readonly { id: string; state: string; agents?: number }[],
  ): Map<string, { state: string; running: boolean }>
  export function transitionsOf(
    was: Map<string, { state: string; running: boolean }> | null,
    is: Map<string, { state: string; running: boolean }>,
  ): { id: string; kind: string }[]
  export function shownOf(
    changes: readonly { id: string; kind: string }[],
  ): { id: string; kind: string; word: string; icon: string; tone: string }[]
}

declare module '*/assets/pair.js' {
  type Step = { key: string; title: string; sub: string; icon: string }
  export const FLOWS: { handheld: readonly Step[]; computer: readonly Step[] }
  export const STEP_COUNT: number
  export const IN_AFTER_MS: number
  export function formOf(agent: string | undefined, coarse: boolean | undefined): string
  export function stepOf(ticket: boolean, phase: string): number
  export function deviceWord(agent: string | undefined): string
}

declare module '*/assets/trouble.js' {
  export interface Trouble {
    title: string
    fix: string
  }
  export const TROUBLES: Record<string, Trouble>
  export const UNKNOWN_TROUBLE: Trouble
  export function troubleOf(
    answer: { status: number; body: unknown } | null | undefined,
    where?: string,
  ): Trouble | null
  export function troubleSaid(trouble: Trouble): string
}

declare module '*/assets/pages/overview-figures.js' {
  /**
   * The landing screen's figures: pure folds over the store, so a test holds
   * every count and word the board, the money, the plan windows and the
   * projects' grid say. How they are drawn is the browser's to check.
   */
  type Dots = { dots: { tone: string; hollow: boolean }[]; more: number }
  type Cell = { n: number; under: string; dots: Dots }
  export const DOTS: number
  export const TOP: number
  export function boardOf(store: Record<string, any>): {
    wants: Cell & { approvals: number; questions: number; deciding: number; requests: number }
    working: Cell & { stalled: number }
    queue: Cell & { ready: number }
    checks: Cell & { pass: number; unknown: number }
  }
  export function dotsOf(
    parts: readonly { n: number; tone: string; hollow?: boolean }[],
    most?: number,
  ): Dots
  export function moneyOf(store: Record<string, any>): {
    value: string | null
    under: string
    top: { key: string; label: string; value: number; said: string; href: string; tone: string }[]
  }
  export function gaugesOf(
    store: Record<string, any>,
    now: number,
  ): {
    key: string
    label: string
    window: string | null
    who: string
    share: number | null
    said: string | null
    under: string
    pressure: string | null
  }[]
  export function projectRowsOf(store: Record<string, any>): {
    name: string
    href: string
    shape: number[]
    wants: number
    working: number
    queued: number
    checks: { parts: number[]; said: string; tone: string }
    spend: string | null
    spendWhy: string
  }[]
  export function failedOf(store: Record<string, any>): readonly any[]
  export function workingOf(store: Record<string, any>): readonly any[]
}
