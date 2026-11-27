// The devices page's pure half (`src/assets/pages/devices-shape.js`), declared
// for `devices-client.test.ts` — beside `assets.d.ts` rather than in it, so the
// page that owns the module owns its declaration. Loose for `assets.d.ts`'s
// reason: a row is the wire's own type, never a second description of one.

declare module '*/assets/pages/devices-shape.js' {
  type Kind = 'phone' | 'tablet' | 'computer' | 'device'
  type Said = { words: string; more: boolean }
  type Session = {
    share: number
    said: string
    pressure: string
    ends: string | null
    endsOn: string | null
  }
  type Listed = { device: string; label: string; pairedAt: string; you: boolean }
  type Row = {
    key: string
    name: string
    named: boolean
    kind: Kind
    icon: string
    kindWord: string
    you: boolean
    fresh: boolean
    at: number | null
    ago: string | null
    when: string | null
  }
  type You = {
    device: string
    label: string
    clear: boolean
    until: string
  }
  type Moment = {
    key: string
    kind: 'asked' | 'note'
    icon: string
    said: Said
    at: string
    ago: string | null
    when: string | null
  }
  type Recent = { items: Moment[]; more: number; said: string }
  export const DAY: number
  export const SESSION_MS: number
  export const NEW_FOR: number
  export const RECENT: number
  export const KINDS: Record<Kind, { icon: string; word: string }>
  export function kindOf(label: string | null | undefined): Kind
  export function reachOf(
    hostname: string | null | undefined,
    protocol: string | null | undefined,
  ): {
    kind: 'machine' | 'tailscale' | 'network' | 'named' | 'unknown'
    word: string | null
    under: string | null
    plain: boolean
  }
  export function accessOf(
    you: Partial<You> | null | undefined,
  ): { value: string; under: string } | null
  export function daySaid(at: string | number | null | undefined, asOf: number): string | null
  export function dateSaid(at: string | number | null | undefined, asOf: number): string | null
  export function agoSaid(at: string | number | null | undefined, asOf: number): string | null
  export function sessionOf(until: string | null | undefined, asOf: number): Session | null
  export function listOf(rows: readonly Listed[] | null | undefined, asOf: number): Row[] | null
  export function listSaid(list: readonly Row[] | null): string
  export function thisOf(
    session: Partial<You> | null | undefined,
    rows: readonly Listed[] | null | undefined,
    asOf: number,
  ): {
    name: string
    kind: Kind
    icon: string
    kindWord: string
    ago: string | null
    when: string | null
    session: Session | null
  } | null
  export function liveOf(standing: string): { glyph: string; word: string; tone: string | null }
  export function leadState(
    session: unknown,
    asked: string,
  ): { kind: string; heading: string; line: string | null } | null
  type Box = { kind: string; heading: string; line: string; retry?: boolean; icon?: string }
  export function answered(before: unknown, after: unknown): 'done' | 'failed'
  export function listState(
    list: readonly Row[] | null | undefined,
    asked: string,
  ): { coming: boolean; box: Box | null; stale: boolean }
  export function tellingOf(standing: string | null | undefined): {
    drawn: boolean
    glyph: string
    word: string
    on: boolean
    said: string
    press: string | null
  }
  export function recentState(recent: Recent | null | undefined): Box | null
  export function recentOf(
    from: {
      chat: readonly import('../src/protocol.ts').ChatRow[] | null
      notes: readonly import('../src/protocol.ts').NoteRow[] | null
      device: string | null
    },
    asOf: number,
  ): Recent
}
