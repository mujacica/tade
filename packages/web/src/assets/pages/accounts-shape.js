// The Accounts page's words, presses and bodies, out of `POST /api/accounts`
// (`src/accounts.ts`): pure, so every line of it is a test
// (`test/accounts-page-client.test.ts`) rather than something to make happen.
//
// **The window's Settings › Accounts, on the phone.** The same presses, offered
// when the window offers them (`accountActions` in the app's
// `panels/settings/accounts.ts`), but one: which account the orchestrator runs
// as is that machine's own setting, moved by `/login` on its tab. And the same
// tabs — this machine first, then every machine it links to — because a phone
// paired with one machine reaches every one that machine does.

/** Where a look or a press goes, and where an account's sign-in is driven from. */
export const ACCOUNTS_PATH = '/api/accounts'
export const ACCOUNT_SIGN_IN_PATH = '/api/accounts/sign-in'

/** A harness as people call it, out of what its machine said. */
export function harnessTitle(one) {
  return one?.title || one?.harness || ''
}

/** What an account is called: its name, its own sign-in's name, or its harness's own sign-in. */
export function accountName(one) {
  return one.name ?? one.ownName ?? 'its own sign-in'
}

/** How it stands, as its line says it: `● work@x.com · Max`, `paid with an API key`, `○ not signed in`. */
export function statusSaid(one) {
  if (!one.signedIn) return `○ ${one.problem ?? 'not signed in'}`
  if (one.kind === 'api-key') return '● paid with an API key'
  return `● ${one.who ?? 'signed in'}${one.plan ? ` · ${one.plan}` : ''}`
}

/** How much of each of its plan's windows is used, shortest first: `42% of 5h · 10% of 7d`; empty for none. */
export function windowsSaid(one) {
  return (one.windows ?? []).map((w) => `${Math.round(w.used)}% of ${w.label}`).join(' · ')
}

/** Who runs as it: new agents, the agents running as it now, and the projects whose own answer it is. */
export function whoseSaid(one) {
  const parts = []
  if (one.forNewAgents) parts.push('new agents')
  if (one.agents > 0) parts.push(`${one.agents} agent${one.agents === 1 ? '' : 's'} now`)
  if ((one.projects ?? []).length > 0) parts.push(`new agents in ${one.projects.join(', ')}`)
  return parts.join(' · ')
}

/** The tabs, this machine first; none where there is only one machine. */
export function tabsOf(answer) {
  const machines = answer?.machines ?? []
  return machines.length < 2 ? [] : machines.map((one) => ({ id: one.id, label: one.label }))
}

/** The tab a page is on: the one chosen where it is still a tab, and this machine's (null) otherwise. */
export function tabHere(chosen, answer) {
  return (answer?.machines ?? []).some((one) => one.id === chosen) ? chosen : null
}

/** What a tab's label says, and which one is the machine the phone asked. */
export function tabSaid(tab) {
  return tab.id === null ? `${tab.label} · here` : tab.label
}

/**
 * Each harness with its accounts, its own sign-in first as the machine sent
 * them, and why no account can be added beside it where none can.
 */
export function harnessesOf(answer) {
  const groups = []
  for (const one of answer?.accounts ?? []) {
    let group = groups.find((it) => it.harness === one.harness)
    if (group === undefined) {
      group = {
        harness: one.harness,
        head: harnessTitle(one),
        accounts: [],
        canAdd: false,
        why: null,
      }
      groups.push(group)
    }
    group.accounts.push(one)
    if (one.canAdd) group.canAdd = true
    if (!one.canAdd && one.why && group.why === null) group.why = one.why
  }
  for (const group of groups) if (group.canAdd) group.why = null
  return groups
}

/** One account's id on the page, as a key and in a press's id: `<harness>:<name>`. */
export function accountKey(one) {
  return `${one.harness}:${one.name ?? ''}`
}

/**
 * What can be done to one account, in the order the window's page offers it.
 * `many` is whether its harness has more than one, so choosing between them
 * means something. A press that needs words says which (`asks`).
 */
export function pressesOf(one, many) {
  const presses = []
  const key = accountKey(one)
  if (one.kind === 'api-key') {
    presses.push({
      id: `key:${key}`,
      do: 'key',
      word: one.signedIn ? 'Change its key' : 'Set its key',
      asks: 'key',
    })
  } else if (one.canSignIn) {
    presses.push({
      id: `sign-in:${key}`,
      do: 'sign-in',
      word: one.signedIn ? 'Sign in again' : 'Sign in',
    })
    if (one.signedIn && one.canAdd) {
      presses.push({ id: `sign-out:${key}`, do: 'sign-out', word: 'Sign out', quiet: true })
    }
  }
  if (one.name === null && (one.canAdd || one.ownName)) {
    presses.push({ id: `name:${key}`, do: 'name', word: 'Name it', asks: 'name', quiet: true })
  }
  if (!one.forNewAgents && (one.canAdd || many)) {
    presses.push({ id: `use:${key}`, do: 'use', word: 'Use for new agents', quiet: true })
  }
  if (one.name !== null) {
    presses.push({
      id: `remove:${key}`,
      do: 'remove',
      word: 'Remove',
      again: 'Press again to remove',
      danger: true,
      quiet: true,
    })
  }
  return presses
}

/** What can be added beside a harness's own sign-in, where its harness keeps accounts apart. */
export function addsOf(group) {
  if (!group.canAdd) return []
  return [
    {
      id: `add:${group.harness}`,
      do: 'add',
      kind: 'subscription',
      word: 'Add an account',
      asks: 'name',
    },
    {
      id: `add-key:${group.harness}`,
      do: 'add',
      kind: 'api-key',
      word: 'Add an API-key account',
      asks: 'name',
      quiet: true,
    },
  ]
}

/** What the field a press asks with is labelled, and what it holds to begin with. */
export function askedOf(press, one, group) {
  if (press.asks === 'key')
    return { label: `${accountName(one)}'s API key`, value: '', secret: true }
  if (press.do === 'name') {
    return {
      label: `Name ${harnessTitle(one)}'s own sign-in`,
      value: one.ownName ?? '',
      secret: false,
    }
  }
  const paid = press.kind === 'api-key' ? ', paid with an API key' : ''
  return { label: `Add a ${group.head} account${paid}`, value: '', secret: false }
}

/** The machine a call names: none for this one, whose tab's id is null. */
function on(machine) {
  return machine === null || machine === undefined ? {} : { machine }
}

/** A look at a machine's accounts. */
export function lookBody(machine) {
  return { ...on(machine), do: 'look' }
}

/**
 * The body of one press on `POST /api/accounts`, or null for a press that is
 * not one (Sign in, which is the sheet's) or that needs words it was not given.
 */
export function pressBody(press, subject, machine, typed = null) {
  const words = typeof typed === 'string' ? typed.trim() : null
  switch (press.do) {
    case 'use':
    case 'sign-out':
      return { ...on(machine), do: press.do, harness: subject.harness, account: subject.name }
    case 'remove':
      return subject.name === null ? null : { ...on(machine), do: 'remove', account: subject.name }
    case 'name':
      return words === null
        ? null
        : { ...on(machine), do: 'name', harness: subject.harness, name: words }
    case 'key':
      return words === null || subject.name === null
        ? null
        : { ...on(machine), do: 'key', account: subject.name, key: words }
    case 'add':
      return words === null || words === ''
        ? null
        : { ...on(machine), do: 'add', harness: subject.harness, name: words, kind: press.kind }
    default:
      return null
  }
}

/** Whose sign-in the sheet drives, as every one of its presses says it. */
export function signInWith(harness, account, machine) {
  return { ...on(machine), harness, account }
}

/** What the sign-in sheet is called, for one account on one machine. */
export function signInHeading(name, machine) {
  return machine === null || machine === undefined
    ? `Sign ${name} in`
    : `Sign ${name} in on ${machine}`
}

/** The words above the sheet's screen: starting, the harness's own while it runs, then how it ended. */
export function accountSignInSaid(standing) {
  if (standing === null) return 'Starting its sign-in…'
  if (standing.state === 'ended') return standing.said ?? 'The sign-in ended.'
  if (standing.state === 'idle') return standing.said ?? 'No sign-in is running for it.'
  const who = standing.who === null ? '' : `Signing in ${standing.who}. `
  return `${who}${standing.how ?? ''}`.trim()
}

/** What a page that has nothing to draw for a machine says: why it could not be asked, or that it has none. */
export function emptySaid(answer) {
  if (answer === null) return null
  if (answer.accounts === null) return answer.said ?? 'That machine could not be asked.'
  if (answer.accounts.length === 0) return 'No harness there has an account to show.'
  return null
}
