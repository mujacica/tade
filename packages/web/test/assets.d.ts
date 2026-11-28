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
  export function money(spend: unknown): { said: string; mark: string; why: string }
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
  export const CHAT_KINDS: Readonly<Record<string, Mark>>
  export function toolNamed(tool: unknown): string
}

declare module '*/assets/routes.js' {
  export const TITLES: Readonly<Record<string, string>>
  /** Which page's own files (`pages/<page>.js`, `.css`) draw a view. */
  export const PAGE_OF: Readonly<Record<string, string>>
  /** The screens with a path of their own, beside the overview's `/`. */
  export const PLAIN: readonly string[]
  export function viewOf(path: string): { view: string }
  export function pathOf(where: { view: string }): string
  /** The full view, opened on one agent: `machine` is `''` for this one. */
  export function agentPath(id: string, machine?: string): string
}

declare module '*/assets/store.js' {
  export const SPEAKS: number
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
  export function applyCopy(store: Store, frame: unknown): string | null
  export function copiesOf(store: Store): readonly { machine: string; copy: Store }[]
  export function streamPath(store: Store): string
  export function rowsOf(store: Store, collection: string): readonly any[]
  export function wantsYou(store: Store): readonly any[]
  export function wantingIds(store: Store): Set<string>
  export function projectsOf(store: Store): readonly any[]
  export function taskAt(store: Store, project: string, name: string): any
  export function queueIn(store: Store, project: string | null): readonly any[]
  export function chatOf(store: Store): readonly any[]
  export function talkOf(store: Store): any
  export const WAITING: readonly string[]
  export function intakeOf(store: Store, project?: string | null): readonly any[]
  export function intakeWaiting(store: Store, project?: string | null): readonly any[]
  export function omitted(store: Store, collection: string): number
  export function asOf(store: Store, kind: string, now: number): { at: number; frozen: boolean }
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
  /** Free text somebody wrote, drawn whole: a node, or null for nothing said. */
  export function proseOf(said: { words: string; more: boolean } | null, folded?: boolean): never
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
  export function titleFor(where: { view: string }): string
}

/**
 * The conversation screen, of which mostly the **decisions** are declared: why
 * there is no box, who said a line, what a line says and what mark it takes,
 * what Tade is doing while it answers — and the draft, which is the one piece
 * of state a navigation would otherwise take. The renderers are declared as
 * loosely as a node of a test's own document, for `talk-client.test.ts`,
 * which asks what they drew rather than trusting a type for it.
 */
declare module '*/assets/talk.js' {
  export function reasonFor(talk: unknown): string
  export function whoSaid(line: unknown): string
  export function saidOn(line: unknown): string
  export function draftStore(): { get(): string; set(said: unknown): void }
  export function reasonWord(talk: unknown): string
  // biome-ignore lint/suspicious/noExplicitAny: a node of whichever document a test installs
  export function createChatLine(): any
  export function fillChatLine(node: unknown, line: unknown, view: unknown): void
  export function lineMark(line: unknown): Mark
  export function doingOf(lines: readonly unknown[], talk?: unknown): string
  export function callDoing(tool: unknown, brief: string | null): string
  export function doingBlock(lines: readonly unknown[]): string
  // biome-ignore lint/suspicious/noExplicitAny: a node of whichever document a test installs
  export function talkPart(ctx: unknown): {
    // biome-ignore lint/suspicious/noExplicitAny: a node of whichever document a test installs
    node: any
    update(view: unknown): void
    leave(): void
  }
  export function offerToAsk(words: string): void
}

declare module '*/assets/earlier.js' {
  export const NEAR_TOP: number
  export function nearTop(scrollTop: number, slack?: number): boolean
  export function linesKept<T extends { id: string }>(
    order?: (a: T, b: T) => number,
  ): {
    newer(rows: readonly T[]): void
    older(rows: readonly T[]): void
    all(): T[]
    first(): T | null
    readonly size: number
  }
}

declare module '*/assets/follow.js' {
  export const FOOT_SLACK: number
  export function atFoot(
    scrollTop: number,
    clientHeight: number,
    scrollHeight: number,
    slack?: number,
  ): boolean
}

declare module '*/assets/markdown.js' {
  export const TAGS: readonly string[]
  export function hrefOf(address: unknown): string | null
  export function partsOf(text: string, from?: number): { start: number; src: string }[]
  // biome-ignore lint/suspicious/noExplicitAny: the blocks are the reader's own shapes
  export function blocksOf(text: string, depth?: number): any[]
  // biome-ignore lint/suspicious/noExplicitAny: the inline parts are the reader's own shapes
  export function inlineOf(text: string, depth?: number): any[]
  export function blockNodes(blocks: unknown[]): unknown[]
  export function markdownIn(node: unknown, text: unknown): void
  export const PLAIN_READ: number
  export function plainOf(text: unknown): string
}

declare module '*/assets/conversation.js' {
  export const CALL_STATES: Record<string, { glyph: string; word: string; tone: string }>
  export function wordsIn(node: unknown, said: unknown, markdown: boolean): void
  // biome-ignore lint/suspicious/noExplicitAny: a node of whichever document a test installs
  export function callRow(): any
  export function callIn(node: unknown, one: unknown, at?: string | null): void
  export function answersWith(
    ask: (method: string, path: string) => Promise<{ status: number; body: unknown }>,
  ): void
}

declare module '*/assets/icons.js' {
  export const ICONS: readonly string[]
  export const WORDS: readonly string[]
  export function icon(name: string, extra?: string): unknown
  export function iconIn(node: unknown, name: string): void
}

declare module '*/assets/charts.js' {
  /**
   * Only the geometry is declared: pure arithmetic a test can hold. What the
   * components *draw* is checked in a browser.
   */
  export const TONES: readonly string[]
  export function sparkPath(
    values: readonly (number | null)[],
    w?: number,
    h?: number,
  ): { lines: string[]; areas: string[]; last: { x: number; y: number } | null }
}

declare module '*/assets/shell-bars.js' {
  export function shellBars(
    standing: {
      refused: string | null
      restart: boolean
      restarting?: {
        theirs: boolean
        stops: number
        armed: boolean
        busy: boolean
        going: boolean
        said: string | null
        cannot: boolean
      }
      changed: boolean
      newer: boolean
    },
    does: { reload: () => void; update: () => void; restart?: () => void },
  ): readonly {
    key: string
    lead: string
    under: string
    press?: { said: string; does: () => void }
  }[]
}

declare module '*/assets/restart.js' {
  export const RESTART_PATH: string
  export const GONE_BY_MS: number
  export const DID_NOT_GO: string
  export function restarter(
    ctx: {
      ask: (
        method: string,
        path: string,
        body?: unknown,
      ) => Promise<{ status: number; body: unknown }>
      session: () => unknown
    },
    paint: () => void,
    later?: (fn: () => void, ms: number) => unknown,
  ): {
    standing(): {
      theirs: boolean
      stops: number
      armed: boolean
      busy: boolean
      going: boolean
      said: string | null
      cannot: boolean
    }
    press(): void
    going(): boolean
    ended(): void
    back(): void
  }
}

declare module '*/assets/sign-in.js' {
  export const SIGN_IN_PATH: string
  export const EVERY_MS: number
  export const SIGN_IN_KEYS: readonly (readonly [string, string, string])[]
  export function isLogin(said: unknown): boolean
  export function signInSaid(standing: unknown): string
  export function linkOf(standing: unknown): string | null
  export function signInSheet(
    ctx: unknown,
    later?: (run: () => void, ms: number) => unknown,
    unlater?: (timer: unknown) => void,
    options?: {
      path?: string
      heading?: string
      said?: (standing: unknown) => string
      id?: string
    },
  ): {
    node: unknown
    open(
      from?: unknown,
      opening?: {
        with?: Record<string, unknown>
        heading?: string
        ended?: (standing: unknown) => void
      },
    ): Promise<unknown>
    close(): void
  }
}

declare module '*/assets/quick.js' {
  export const QUICK: readonly string[]
  export function quickWord(verb: string, row: unknown, asked?: boolean): string
}

declare module '*/assets/acts.js' {
  export const SHOWN: readonly string[]
  export const MENU_SHOWN: readonly string[]
  export const PROJECT_SHOWN: readonly string[]
  export const NEEDS: Readonly<Record<string, string>>
  export const QUEUE_ASKS: readonly { change: string; said: string; ready?: boolean }[]
  export function asksFor(row: unknown): readonly { change: string; said: string }[]
  export function actsOf(session: unknown): {
    steer: boolean
    ask: boolean
    agents: boolean
    projects: boolean
  }
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
    acts: { steer: boolean; agents?: boolean; projects?: boolean },
  ): { kind: 'off' | 'no' | 'yes'; how?: string; why: string }
  export function controlsFor(
    row: unknown,
    acts: { steer: boolean; agents?: boolean; projects?: boolean },
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
    clear?: boolean
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
  export function actsAtAll(you: unknown): boolean
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
    /** The cause, in one sentence. */
    why?: string
    fix: string
    /** The *how to fix this* list, in the order the steps are done. */
    steps?: readonly string[]
  }
  type Answer = { status: number; body: unknown } | null | undefined
  export const AWAY_PLACE: string
  export const TROUBLES: Record<string, Required<Trouble>>
  export const TOO_OLD: Required<Trouble>
  export const UNKNOWN_TROUBLE: Required<Trouble>
  export function needsOf(body: unknown): string[]
  export function troubleOf(answer: Answer, where?: string): Required<Trouble> | null
  export function theirsTrouble(answer: Answer): Required<Trouble> | null
  export function troubleSaid(trouble: Trouble): string
}

declare module '*/assets/pages/overview-figures.js' {
  /**
   * The overview's figures: pure folds over the store, so a test holds every
   * count and word the tiles and the two lists say. How they are drawn is the
   * browser's to check.
   */
  type Dots = { dots: { tone: string; hollow: boolean }[]; more: number }
  type Tile = { n: number; under: string; dots: Dots }
  export const DOTS: number
  export function sameDay(at: string | null, now: number): boolean
  export function tilesOf(
    store: Record<string, any>,
    now: number,
  ): { working: Tile; wants: Tile; queue: Tile; finished: Tile }
  export function waitingOf(store: Record<string, any>): { machine: string; task: any }[]
  export function workingOf(store: Record<string, any>): { machine: string; task: any }[]
  export function dotsOf(
    parts: readonly { n: number; tone: string; hollow?: boolean }[],
    most?: number,
  ): Dots
}

declare module '*/assets/machines.js' {
  interface MachineRowIn {
    name: string
    way: 'to' | 'from' | 'here'
    state: 'up' | 'asleep' | 'closed' | 'lost'
    since: string | null
  }
  type Seen = { machines?: readonly MachineRowIn[]; copies?: Map<string, unknown> } | null
  export function machinesOf(store: { machines?: readonly MachineRowIn[] } | null): MachineRowIn[]
  export function machineSaid(row: MachineRowIn): string
  export function machineTone(row: MachineRowIn): string
  export function machinesUpOf(
    store: Seen | Record<string, unknown>,
    live: boolean,
  ): { key: string; name: string; up: boolean; said: string; short: string; tone: string }[]
  export const HERE: string
  export function storesDrawn(
    store: Seen | Record<string, unknown>,
    picked?: string | null,
  ): { machine: string; store: Record<string, any>; up: boolean }[]
  export function wantsElsewhere(store: Seen): { machine: string; task: { id: string } }[]
  export function wantsAnywhere(store: Seen | Record<string, unknown>): number
}

declare module '*/assets/there.js' {
  export const THERE_VERBS: string[]
  export function thereCtx(ctx: any, machine: string): any
}

declare module '*/assets/room.js' {
  interface RoomRoot {
    classList: { toggle: (name: string, on: boolean) => boolean }
    style: {
      setProperty: (name: string, value: string) => void
      removeProperty: (name: string) => string
    }
  }
  export function roomOn(root?: RoomRoot): void
}

declare module '*/assets/pages/overview.js' {
  export function nowScreen(ctx?: unknown): {
    node: any
    update(view: unknown): void
    leave(): void
  }
}
