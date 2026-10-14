// The settings page's pure half (`src/assets/pages/settings-shape.js`),
// declared for `settings-client.test.ts` — beside `assets.d.ts` rather than in
// it, so the page that owns the module owns its declaration. A row and a group
// are `configuring.ts`'s own, so this is not a second description of the wire.

declare module '*/assets/pages/settings-shape.js' {
  type Row = import('../src/configuring.ts').SettingOut
  type Group = import('../src/configuring.ts').SettingsGroupOut
  type Answer = import('../src/configuring.ts').SettingsOut
  type Acts = { configure?: boolean } | null | undefined
  type Drawn = {
    kind: 'held' | 'default' | 'flag' | 'keys' | 'words'
    text: string
    tag: string | null
    on: boolean
    mono: boolean
    caps: string[]
  }
  type Editor = {
    kind: 'pick' | 'list' | 'number' | 'text' | 'clear'
    options: { value: string; label: string }[]
  }
  type Box = {
    kind: 'loading' | 'empty' | 'error'
    title: string
    line: string | null
    retry: boolean
    icon: string | undefined
  }
  export const GROUP_ICONS: Record<string, string>
  export const HERE: string
  export const KEYS_SAID: string
  export const PICK_MOST: number
  export const CUT_FROM: number
  export function iconOf(id: string): string
  export function capsOf(value: string): string[]
  export function drawnOf(row: Row): Drawn
  export function nowSaid(row: Row): string
  export function appliesSaid(row: Row): string
  export function factsOf(row: Row): [string, string | null][]
  export function emptyLabel(row: Row): string
  export function editorOf(row: Row): Editor
  export function typedSaid(editor: Editor, value: string): string | null
  export function pressWord(editor: Editor, armed: boolean, going: boolean): string
  export function partsOf(group: Group): {
    own: Row[]
    scopes: { key: string; rows: Row[] }[]
  }
  export function queryOf(typed: string): string[]
  export function finds(row: Row, group: Group, words: readonly string[]): boolean
  export function foundIn(group: Group, words: readonly string[]): number
  export function settingsWord(n: number): string
  export function hereOf(
    answer: Answer | null,
    acts: Acts,
  ): { row: Row; group: Group; crumb: string }[]
  export function changeableIn(group: Group, acts: Acts): number
  export function groupSaid(group: Group, acts: Acts, words?: readonly string[]): string
  export function totalOf(answer: Answer | null): number | null
  export function leftSaid(answer: Answer | null): string | null
  export function pageState(
    answer: Answer | null,
    trouble: { title: string; fix: string } | null,
  ): { kind: 'coming' | 'wrong' | 'ungranted' | 'nothing' | 'ready'; box: Box | null }
  export function missedBox(typed: string): Box
  export function firstChosen(answer: Answer | null, acts: Acts): string
}
