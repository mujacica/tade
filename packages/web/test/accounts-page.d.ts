// The Accounts page's pure half (`src/assets/pages/accounts-shape.js`),
// declared for `accounts-page-client.test.ts` — beside `assets.d.ts` rather
// than in it, so the page that owns the module owns its declaration. Loose for
// `assets.d.ts`'s reason: the answer it reads is `AccountsAnswer`, held by the
// machine's own types, and a second description of it here would be a second
// schema.

declare module '*/assets/pages/accounts-shape.js' {
  type Account = import('../src/accounts.ts').AccountAway
  type Answer = import('../src/accounts.ts').AccountsAnswer
  type Press = {
    id: string
    do: string
    word: string
    asks?: 'name' | 'key'
    kind?: 'subscription' | 'api-key'
    again?: string
    danger?: boolean
    quiet?: boolean
  }
  type Group = {
    harness: string
    head: string
    accounts: Account[]
    canAdd: boolean
    why: string | null
  }
  export const ACCOUNTS_PATH: string
  export const ACCOUNT_SIGN_IN_PATH: string
  export function harnessTitle(one: Partial<Account> | null | undefined): string
  export function accountName(one: Account): string
  export function statusSaid(one: Account): string
  export function windowsSaid(one: Account): string
  export function whoseSaid(one: Account): string
  export function tabsOf(answer: Answer | null): { id: string | null; label: string }[]
  export function tabHere(chosen: string | null, answer: Answer | null): string | null
  export function tabSaid(tab: { id: string | null; label: string }): string
  export function harnessesOf(answer: Answer | null): Group[]
  export function accountKey(one: Account): string
  export function pressesOf(one: Account, many: boolean): Press[]
  export function addsOf(group: Group): Press[]
  export function askedOf(
    press: Press,
    one: Account,
    group: Group,
  ): { label: string; value: string; secret: boolean }
  export function lookBody(machine: string | null): Record<string, unknown>
  export function pressBody(
    press: Press,
    subject: { harness: string; name: string | null },
    machine: string | null,
    typed?: string | null,
  ): Record<string, unknown> | null
  export function signInWith(
    harness: string,
    account: string | null,
    machine: string | null,
  ): Record<string, unknown>
  export function signInHeading(name: string, machine: string | null): string
  export function accountSignInSaid(standing: unknown): string
  export function emptySaid(answer: Answer | null): string | null
}

declare module '*/assets/pages/accounts.js' {
  export function accountsScreen(ctx: unknown): {
    node: unknown
    update(): void
    leave(): void
  }
}
