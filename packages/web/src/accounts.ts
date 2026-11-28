import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// Settings › Accounts, for every machine of the person's, from one place: the
// person's own phone, and another of their machines' windows, which is how
// Settings › Accounts there draws this machine's tab (`/api/accounts`).
//
// **Who each harness's agents run as, and what can be done about it**, as the
// window's own Accounts page has it: each sign-in, how much of its plan is
// used, and the presses — have new agents use it, sign it out, add one, take
// one away, name a harness's own sign-in, set an API-key account's key. Each
// is the workbench's own act, carried out by whoever holds this home: the
// window, or `tade serve` on a machine nobody sits at, so a server is managed
// without stopping it.
//
// **Every machine from one door.** A call that names another machine is that
// machine's, asked over this machine's link to it as its owner and answered
// with what it said — so the phone, paired with one machine, reaches every
// machine that one links to, as the window's tabs do. One that names none is
// this machine's.
//
// **The person's, and never the orchestrator's.** A paired device's and an
// owner's, as every route of the SSH key's is (`here` in `routes.ts`): adding
// or signing in an account is what that key may do at the machine, and every
// paired device is the person's own. No orchestrator tool
// reaches these doors, and in `settingReach` the `accounts` subtree — what
// makes a sign-in exist — is `never`, while which one new agents run as is
// `asked`, so only the person's own words can move it.

/** The most a name, a harness or a machine may be on the wire. */
const NAME_MAX = 64
/** The most an API key typed on the phone may be. */
const KEY_MAX = 4096

/** One account as a page draws it. */
export interface AccountAway {
  harness: string
  /** Its harness, as people call it: `Claude Code`. */
  title: string
  /** Null for the harness's own sign-in. */
  name: string | null
  /** What its own sign-in is called, on that row (`workers.default_names`). */
  ownName: string | null
  kind: 'subscription' | 'api-key'
  /** Whether its harness keeps accounts apart, so one can be added beside it. */
  canAdd: boolean
  /** Why not, in its harness's words. */
  why: string | null
  signedIn: boolean
  who: string | null
  plan: string | null
  problem: string | null
  /** How much of each of its plan's windows is used, shortest first: `5h 42%`. */
  windows: { label: string; minutes: number; used: number }[]
  agents: number
  forNewAgents: boolean
  /** The projects whose own answer it is. */
  projects: string[]
  canSignIn: boolean
  /** What would put its harness on that machine, where it is not there. */
  install: string | null
}

/** One tab: a machine, by the id a call names it with (null for this one). */
export interface AccountsTab {
  id: string | null
  label: string
}

/** What the page draws, after a look or a press. */
export interface AccountsAnswer {
  /** Whose accounts these are: the tab's id, null for this machine. */
  machine: string | null
  /** Every machine with a tab, this one first. */
  machines: AccountsTab[]
  /** What each harness said, or null where that machine could not be asked. */
  accounts: AccountAway[] | null
  /** What a press did or why it did not, or why there is nothing to show. */
  said: string | null
  /** Whether `said` is trouble rather than news. */
  trouble: boolean
  /**
   * That an agent runs as you and can read every key Tade keeps, whichever
   * sign-in it is on (`KEYS_AND_AGENTS`): said where somebody decides which.
   */
  keys: string
}

const Machine = z.string().min(1).max(NAME_MAX).optional()
const Name = z.string().min(1).max(NAME_MAX)

/** What a call asks: a look, or one press. Nothing else is read. */
export const AccountsCall = z.discriminatedUnion('do', [
  z.strictObject({ machine: Machine, do: z.literal('look') }),
  z.strictObject({
    machine: Machine,
    do: z.literal('use'),
    harness: Name,
    account: Name.nullable(),
  }),
  z.strictObject({
    machine: Machine,
    do: z.literal('sign-out'),
    harness: Name,
    account: Name.nullable(),
  }),
  z.strictObject({
    machine: Machine,
    do: z.literal('add'),
    harness: Name,
    name: Name,
    kind: z.enum(['subscription', 'api-key']),
  }),
  z.strictObject({ machine: Machine, do: z.literal('remove'), account: Name }),
  // An empty name takes the name away.
  z.strictObject({
    machine: Machine,
    do: z.literal('name'),
    harness: Name,
    name: z.string().max(NAME_MAX),
  }),
  z.strictObject({
    machine: Machine,
    do: z.literal('key'),
    account: Name,
    key: z.string().max(KEY_MAX),
  }),
])
export type AccountsCall = z.infer<typeof AccountsCall>

/** The window's half. It answers what is true after it, and never throws. */
export interface WebAccounts {
  /** A look or a press, on this machine or asked of the one it names; `device` is who pressed. */
  carry(call: AccountsCall, device: string): Promise<AccountsAnswer>
}

/** `POST /api/accounts`: a machine's accounts, and a press on them. */
export async function accountsHere(
  req: IncomingMessage,
  device: Device,
  accounts: WebAccounts | undefined,
): Promise<{ body: AccountsAnswer } | { refusal: Refusal }> {
  if (accounts === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = AccountsCall.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  return { body: await accounts.carry(parsed.data, device.id) }
}

/** A call as it is sent on to the machine it names: that machine's own, so it names none. */
export function forwardedCall<T extends { machine?: string | undefined }>(
  call: T,
): Omit<T, 'machine'> {
  const { machine: _, ...rest } = call
  return rest
}

/** An answer another machine gave, if it is one Tade writes; null where it is not. */
export function accountsAnswerOf(
  body: unknown,
): Omit<AccountsAnswer, 'machine' | 'machines' | 'keys'> | null {
  const parsed = AnswerShape.safeParse(body)
  return parsed.success ? parsed.data : null
}

// What is read back from another machine: its fields, bounded, and nothing
// else carried on — a far side's words go on to the phone as text.
const Text = z.string().max(2000)
const AccountShape = z.object({
  harness: Name,
  title: Text,
  name: Name.nullable(),
  ownName: Name.nullable(),
  kind: z.enum(['subscription', 'api-key']),
  canAdd: z.boolean(),
  why: Text.nullable(),
  signedIn: z.boolean(),
  who: Text.nullable(),
  plan: Text.nullable(),
  problem: Text.nullable(),
  windows: z
    .array(z.object({ label: z.string().max(16), minutes: z.number(), used: z.number() }))
    .max(8),
  agents: z.number().int().nonnegative(),
  forNewAgents: z.boolean(),
  projects: z.array(Text).max(200),
  canSignIn: z.boolean(),
  install: Text.nullable(),
})
const AnswerShape = z.object({
  accounts: z.array(AccountShape).max(200).nullable(),
  said: Text.nullable(),
  trouble: z.boolean(),
})
