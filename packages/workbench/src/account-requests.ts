import { accountRequestsSpool } from '@tade/core'
import { z } from 'zod'
import { awaitSpooled, spoolRequest, type Taken, takeSpooled, type Waiting } from './spool.ts'
import type { Workbench } from './workbench.ts'

// What a terminal asks of the accounts while a window holds the home: `tade
// accounts add`, `use`, `remove` and `name` on a server whose `tade serve` is
// running, which is the only shell there is on a machine nobody sits at. They
// were refused there ("Tade is open: do it in Settings › Accounts there"), and
// a headless service has no Settings, so the person had to stop it.
//
// Each of them is the workbench's own act, which writes the config and a line
// in the journal, and **one writer numbers the journal** — so the terminal does
// not do it. It spools the request (`spool.ts`), the window does it on its next
// beat (`AccountsHere.beat`) through the same `accountDone` the terminal calls
// where it holds the home itself, so the two can never do different things of
// the same words, and the terminal prints the answer.
//
// **What comes in is what the command line takes, and no wider**: a harness,
// a name, a kind, a project. Signing in is not here at all: it needs no
// window, and runs in the terminal that asked, as the harness's own sign-in —
// what you give it goes where the harness keeps it, and never through Tade.

/** What a terminal asks: exactly what `tade accounts add|remove|use|name` take. */
export const AccountRequest = z.discriminatedUnion('do', [
  z.strictObject({
    do: z.literal('add'),
    harness: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(['subscription', 'api-key']),
    share: z.boolean(),
  }),
  z.strictObject({ do: z.literal('remove'), name: z.string().min(1) }),
  z.strictObject({
    do: z.literal('use'),
    harness: z.string().min(1),
    /** Null for its own sign-in; absent gives a project's question back to the machine. */
    account: z.string().min(1).nullable().optional(),
    project: z.string().min(1).optional(),
  }),
  z.strictObject({
    do: z.literal('name'),
    harness: z.string().min(1),
    name: z.string().nullable(),
  }),
])
export type AccountRequest = z.infer<typeof AccountRequest>

/** What the window answers: done, with the name it came to where there is one, or why not. */
export type AccountAnswer = { ok: true; named: string | null } | { ok: false; error: string }

/** The workbench's acts a request is one of. */
export type AccountActs = Pick<
  Workbench,
  'addAccount' | 'removeAccount' | 'useAccount' | 'nameOwnSignIn'
>

export const WAITING: Waiting = { takeMs: 30_000, doMs: 2 * 60_000, everyMs: 250 }

/**
 * Do one request with the workbench's own acts: by `tade accounts` where it
 * holds the home, and by the window that does where it does not.
 */
export async function accountDone(
  tade: AccountActs,
  request: AccountRequest,
): Promise<string | null> {
  switch (request.do) {
    case 'add':
      await tade.addAccount({
        name: request.name,
        harness: request.harness,
        kind: request.kind,
        share: request.share,
      })
      return request.name.trim().toLowerCase()
    case 'remove':
      await tade.removeAccount(request.name)
      return request.name
    case 'use':
      await tade.useAccount(request.harness, request.account, request.project)
      return request.account ?? null
    case 'name':
      return tade.nameOwnSignIn(request.harness, request.name)
  }
}

/** Into the spool for the window holding `home`; the id to wait on its answer by. */
export function requestAccount(home: string, request: AccountRequest): Promise<string> {
  return spoolRequest(accountRequestsSpool(home), AccountRequest.parse(request))
}

/** What came of request `id`: the window's answer, `'untaken'`, or `'doing'` (`awaitSpooled`). */
export function awaitAccount(
  home: string,
  id: string,
  waiting: Waiting = WAITING,
): Promise<AccountAnswer | 'untaken' | 'doing'> {
  return awaitSpooled(accountRequestsSpool(home), id, answerFrom, waiting)
}

/** Do every request a terminal spooled since the last beat, and answer each. Never throws. */
export function takeAccountRequests(
  home: string,
  tade: AccountActs,
  now: number = Date.now(),
): Promise<Taken> {
  return takeSpooled<AccountRequest, AccountAnswer>(
    accountRequestsSpool(home),
    requestFrom,
    async (request) => ({ ok: true, named: await accountDone(tade, request) }),
    (error) => ({ ok: false, error }),
    now,
  )
}

/** The request a spool file holds, or why it is not one Tade wrote. */
function requestFrom(text: string): AccountRequest | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return `not JSON: ${err instanceof Error ? err.message : String(err)}`
  }
  const request = AccountRequest.safeParse(parsed)
  return request.success ? request.data : 'not the shape Tade writes'
}

/** The answer a window wrote, or one saying it could not be read. */
function answerFrom(text: string): AccountAnswer {
  let parsed: Partial<{ ok: unknown; named: unknown; error: unknown }>
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      error: `the window's answer is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (parsed?.ok === true && (parsed.named === null || typeof parsed.named === 'string')) {
    return { ok: true, named: parsed.named }
  }
  if (parsed?.ok === false && typeof parsed.error === 'string') {
    return { ok: false, error: parsed.error }
  }
  return { ok: false, error: 'the window answered in a shape Tade does not write' }
}
