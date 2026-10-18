import type { Setting } from './settings.ts'

// How far the orchestrator's arm reaches into the config.
//
// The orchestrator is ungated on purpose — asking permission to answer "where
// are we" is nobody's idea of useful — and it reads attacker-controlled text
// all day: review comments, an MCP server's tool descriptions, a page somebody
// pasted. So the question is never "can it be trusted", it is "what is the
// worst a sentence it read can do". That is a property of the *setting*, not
// of the model, which is why it is decided here, in a pure function, and not
// in a prompt.
//
// Three answers, and nothing else:
//
// - `never`  — no words are enough. Each one widens what an agent may do,
//              hands a third party tools or a credential, changes who is
//              asked, or changes where Tade sends something. Those are exactly
//              what an injected sentence wants, so the answer has to be that
//              there is no path, not a path with a warning on it.
// - `asked`  — only when the person's own words name it (`namedBy`, checked
//              against the journal by whoever holds one). This is the default:
//              changing a setting is never something to do as a side effect of
//              anything, so requiring their words is not friction on the act,
//              it is the act.
// - `open`   — an ordinary request is enough. Mostly the short list where the
//              worst case is a cosmetic annoyance the person is looking at,
//              plus what the person has said outright is the orchestrator's to
//              set (`OPEN_UNDER`), which argues for itself where it is written.
//
// It may only ever *refuse*. Nothing here can widen what a tier allows, and
// nothing outside these tiers is writable at all.
//
// One thing here is not a config key at all: a watch, which lives in
// `schedules.jsonl`. It is decided here anyway (`WATCH_REACH`), because the
// question is the same question and answering it somewhere else is how two
// answers to it come to exist.
//
// **The one `asked` that reaches outside Tade, said here because somebody
// will ask why it is not `never`.** `agents.keep_awake` holds the machine's
// sleep off while the window is open, and it is the only setting whose effect
// is on the machine rather than on Tade. That is a real consequence and it is
// still not the shape `never` is for: it widens nothing an agent may do, hands
// nobody tools or a credential, changes who is asked about nothing, and moves
// nowhere Tade sends anything — the four things an injected sentence wants.
// What the worst wording of it can do is keep a laptop from sleeping until the
// window closes, which is undone by closing the window and cannot outlive it,
// because the assertion is held rather than written down (`awakeArgs`). And
// the direction that matters most is the *off* one: "let it sleep" is the
// sentence a page would like obeyed while agents work, and it is refused by
// the same rule, because `namedBy` reads what the person said and nothing an
// agent read ever gets into that. So: `asked`, both ways, like every other
// ordinary setting — not `open`, because a machine that will not sleep is not
// a cosmetic annoyance somebody is looking at.
//
// **`queue.holds` changes who is asked, and is still not `never`.** The "who
// is asked" that `never` is for is who answers for what an *agent* may do —
// approvals. This one is who answers about held queued work, and it is words
// in what the orchestrator is told, never a gate: it can start, rewait or
// retell held work under either value, because nothing it does is gated. The
// worst wording of it is the orchestrator deciding what it could already have
// done, and saying so afterwards rather than asking first — the person's
// call, so `asked`, both ways.

/** How far the orchestrator may go with one setting. */
export type Reach = 'open' | 'asked' | 'never'

export interface Reaches {
  reach: Reach
  /** Why, in one clause — what a person is told when it is refused. */
  because: string
}

/**
 * Settings the orchestrator may change on an ordinary request.
 *
 * Deliberately short. What the three window ones have in common is that the
 * worst case is a cosmetic annoyance the person is already looking at and can
 * undo in one sentence — and `editor` is an enum of editors Tade knows, never
 * a command. `OPEN_UNDER` is the one thing here that is not that, and it says
 * why in its own words.
 */
const OPEN: readonly string[] = [
  'surfaces.window.sidebar_width',
  'surfaces.window.strip_height',
  'surfaces.window.editor',
]

/**
 * The same tier for a path with a name in it, and the one setting in it that
 * is not cosmetic: what a project pushes.
 *
 * **Asked for, and the argument is not the one `OPEN` makes above.** A push is
 * a real act — it puts commits on a remote — so this is not "the worst case is
 * something they are looking at". It is here because the person said it should
 * be, in as many words: most settings should be the orchestrator's to change,
 * and the ones that are not are the secrets and the destructive ones. A push
 * mode is neither. It carries no credential, it deletes nothing, it is one
 * project's workflow preference, and every value of it is undone by setting it
 * back — which is the shape of `open`'s "undo it in one sentence" even where
 * it is not the shape of "cosmetic".
 *
 * **The line that still holds, and where it is.** This is reach over the
 * *setting*, never over the act. Nothing Tade runs pushes anything: the mode
 * is words in an agent's prompt (`pushTold`), exactly as the commit rule is,
 * and what can actually hold a push while the checks run is `approvals` —
 * which is the first `never` subtree in the table below and stays there. So
 * the orchestrator may say what an agent *should* do with finished work, and
 * may not touch what an agent is *allowed* to do.
 *
 * **What it costs, said rather than left for somebody to find.** Under
 * `approvals.mode: 'bypass'` — the default — nothing holds a push, so a
 * sentence the orchestrator read that talks it into `branch` is a sentence that
 * gets the next agent's commits onto the project's branch. That is the residual
 * risk of this tier and it is the person's to accept; it is bounded by the
 * three things the mode cannot do — it cannot force-push, cannot merge
 * (`extensions.review.merge` is `never` by default and a person's), and cannot
 * reach a project Tade does not already have open. `projects.<name>.root` is
 * still refused, so it cannot move where any of it happens.
 *
 * **The machine-wide `agents.push` is deliberately not here.** It is unnamed,
 * so it is `asked`: one project's answer is bounded to one repository and sits
 * on that project's own tab, while the machine's answer turns pushing on for
 * every project at once, including ones nobody was talking about. Same act,
 * different blast radius, and the words are cheap where the radius is wide.
 */
const OPEN_UNDER: readonly RegExp[] = [/^projects\.[a-z0-9-]+\.push$/]

/**
 * What no words reach, as a prefix and the clause said when it is refused.
 *
 * Matched as a dotted prefix — `extensions` catches `extensions.sentry.org` as
 * well as `extensions.sentry.enabled` — because a subtree is a rule that holds
 * without anybody remembering which key inside it was the dangerous one. The
 * first match wins, so a longer path sits above the subtree it lives in.
 */
const NEVER: readonly (readonly [string, string])[] = [
  [
    'approvals',
    'approvals decide what agents may do without asking, and I relay them — a thing inside that loop does not get to rewrite it',
  ],
  // Adding one, taking one away, signing one in, its kind and an API-key
  // account's key: each is a credential, so the whole subtree. *Which* of the
  // ones that exist new agents run as is not here (`ALLOWED_UNDER` says why).
  [
    'accounts',
    'an account is a sign-in: adding, removing or signing one in is whose money and whose permissions agents run with',
  ],
  [
    'workers.routes',
    'a route carries the provider an agent’s work is sent to, and where Tade sends something is not mine to move',
  ],
  [
    'extensions',
    'an extension is code your agents call, and its own key lives here — turning one on or pointing it somewhere else is a person’s act',
  ],
  [
    'mcp',
    'an MCP server is somebody else’s code with tools your agents will call, and only a person turns one on',
  ],
  // Which user agents run as is what they can read and write: Tade's home and
  // every key in it, or none of it (`agent-user.ts`). A project's own is under
  // `projects`, refused below with the rest of its block.
  [
    'agents.user',
    'which user agents run as decides whether they can read every key Tade keeps, and a thing inside that loop does not get to move its own walls',
  ],
  ['orchestrator.extensions', 'that is the folder my own tools are read from'],
  // Where my own conversation is sent, as a route's provider is where an
  // agent's work is. My `Model` row writes it beside the model it is chosen
  // with (`modelChosen`), so the row stays `asked` and the window refuses a
  // model that would move it at both doors that write one, `tade_setting_change`
  // and `tade_orchestrator_model` (`ownProviderMoved`): the person's own press
  // in Settings or on my tab's picker moves it. Where none is kept yet the name
  // picks it, as on a route that sets none, and Tade keeps the one I first
  // start on.
  [
    'orchestrator.provider',
    'it is the provider everything said to me is sent to, and where Tade sends something is not mine to move',
  ],
  ['telemetry.dsn', 'a DSN is where Tade sends things, and I read pages all day'],
  [
    'projects',
    'moving a project’s root moves where every agent in it works — closing it and opening it again is two acts, each said',
  ],
  // The away view's keys, all but two (`ALLOWED_UNDER`). What is left here is
  // each a door or a grant: whether anything listens (`enabled`), on which
  // network (`bind`) and at which address a pairing code sends a phone with
  // the ticket that makes it a device (`port`), which origin is trusted
  // (`trusted_hosts`), what a paired device may do — and an agent here can
  // pair itself (`DEVICES_SEEN_BY_AGENTS`), so `acting`, `orchestrator`,
  // `drafts` and `settings` widen what an agent may do — what goes through a
  // push service somebody else runs (`push`, `push_details`), and the key that
  // signs it (`push_key`).
  [
    'surfaces.web',
    'the away view is who can reach Tade from off this machine, and a page I read does not get to let anybody in',
  ],
  // Matched as a dotted prefix, so every key under it — the ones there are and
  // the ones a connector adds next month — is refused on the day it is written,
  // two named in `ALLOWED_UNDER` aside. All four clauses of `never` apply to
  // the rest: a grant widens what an agent may do, it hands somebody else's
  // words to one, `mode` changes who is asked, and `reply` and `names` change
  // what Tade sends where. And the shape of the attack is the plainest there
  // is: the text I read all day would like to be the text that is allowed to
  // make work.
  [
    'surfaces.intake',
    'intake is whose words can make work on this machine, and the words I read all day do not get to put themselves on that list',
  ],
  // Another machine's Tade this one is an owner of (`remotes.ts`): where it is,
  // the command run there, and the session whose reach is that keyboard's.
  // Every clause at once — where Tade sends something, a credential, and what
  // this machine may do on another — so the whole section, and anything added
  // under it, is the person's.
  [
    'remotes',
    'a remote is another machine I would reach and drive as you, with a session that is yours there — only a person points me at one',
  ],
  // Where `tade host backup` sends this machine's home — every key and every
  // word Tade keeps — and the password it is read with: where Tade sends
  // something and a credential, both, so the whole section.
  [
    'backup',
    'a backup is every key and every word Tade keeps, sent where it names — where it goes and the password that opens it are a person’s',
  ],
]

/**
 * Paths under a `never` subtree that are not themselves dangerous.
 *
 * `projects` is the whole of a project's block, and most of it is ordinary:
 * what it may spend, the line I am told about it, its own answer to the check
 * rules, whether its agents share its checkout. Only `root` moves where the
 * work happens. Checked before `NEVER`, and a list rather than a pattern so
 * that a key added to `ProjectConfigSchema` tomorrow is refused until somebody
 * looks at it.
 *
 * `workspace` is here because it is the machine-wide `agents.workspace` asked
 * of one project, and that is `asked`: it decides where the next agent works,
 * which widens nothing an agent may do. `root` stays refused — moving it moves
 * every agent already in the project. `max_parallel` is the same shape: how
 * many of its agents work at once, which says when the next one starts and
 * nothing about what any of them may do.
 *
 * `watches` is which machine's clock looks with the project's watches on
 * outside sources (`watch-where.ts`): naming a remote there sends that machine
 * nothing and reaches it in no new way, and `here` cannot start a second
 * machine watching, because a remote already looking holds this one whatever
 * the key says. What it can do is turn this machine's watches off for the
 * project, which `WATCH_REACH` already lets the person's own words do one
 * watch at a time — so `asked`, like turning one off, and not `never`.
 *
 * A route is the same shape: its model, how hard it thinks and which harness
 * it opens are ordinary settings, and `provider` is the one left that a
 * sentence I read must not reach, because it is where the work is sent. So
 * are the model and thinking it keeps for each other harness
 * (`harnesses.<h>`): what new agents start on there, a default like the
 * route's own — the person's decision, 2026-10-17, that defaults are settings
 * the orchestrator changes when they ask. `provider` under one stays out, and
 * so does anything added beside them. What is left is named rather than
 * hidden: a model is written as its harness names it, and on a route that
 * sets no provider `openrouter/…` picks the provider out of the name — only
 * among those somebody is already signed in to, handing nobody new anything,
 * and only on words of theirs naming that model setting.
 *
 * **`title` is `asked` and deliberately not `open`**, which is the one here
 * somebody will argue about, because a display name moves nothing: the id
 * stays, every task id stays, every trailer stays, and the worst a bad one
 * does is sit on a tab. That is exactly the shape `open` is for, and it is
 * still wrong — because what a tab says is how somebody knows *which project
 * they are in*. A label is the one cosmetic thing that is read as a fact:
 * `payments` written over the `docs` tab is somebody approving work in the
 * wrong repository, and it is a sentence a page would like obeyed for that
 * reason. So it takes the person's own words, like every other ordinary
 * setting, and the confusion has to be asked for out loud.
 *
 * **Two of an intake source's eight, and only the two that choose among the
 * owner's own things.** `template` is which *published* template a request is
 * stamped from — a template is the owner's, an immutable snapshot, and using
 * one makes parked work — and `document` is which of its document inputs the
 * body lands in, every one of which is under the material heading. Neither
 * says whose words count, where, whether anybody approves, or what goes back:
 * the hole the skill warns about is a template the *requester* chose, and this
 * is the owner choosing, in their own words.
 *
 * **Which account new agents run as — the machine's (`workers.accounts.<h>`,
 * `asked` by being in no subtree) and a project's (`accounts.<h>` here) — and
 * only among accounts that already exist.** It was `never` beside the accounts
 * themselves, on the argument that which sign-in agents run as is whose money
 * and whose permissions. The person decided otherwise on 2026-10-17, asking
 * that they "and the orchestrator switch which one gets used" between a
 * personal and a company subscription, project by project. What a switch can
 * do is bounded by what a person already did: every value is an account they
 * added and signed in themselves (the schema refuses any other name, and a
 * row offers no other), so it hands nobody a credential and sends nothing
 * anywhere new — it moves the next agent between two plans of theirs. What
 * makes a sign-in exists stays `never`: the `accounts` subtree, which is
 * adding, removing, signing in and every key. The residual risk, said: a
 * sentence the orchestrator read cannot reach this, because the person's own
 * words must name the harness's account (`wordsTogether`), but words of theirs
 * that do can put company work on a personal plan or the other way round —
 * which is exactly the act they asked to be able to ask for. A running agent
 * is never moved by it (`accountFor`).
 *
 * **And the orchestrator's own (`orchestrator.account`), `asked` the same
 * way**, on the person's word of 2026-10-18 that it "should be able to control
 * both" — a running agent's account (`tade_agent_account`) and its own. The
 * same bound holds: only an account of its harness that they added. Named only
 * as "your account" (`OWNED_ROWS`), never by "account" alone, which is every
 * agent's row's word too. Moving it starts it again on that sign-in once the
 * turn that asked is over (`moveAccount`), its conversation carried along.
 *
 * **Two of the away view's, and only the two that hand a device nothing.**
 * `install` puts the static page on a device already paired — the same bytes
 * for every device, no projection, no way to read one without a session — and
 * `offline` lets that device keep counts and a moment it was already shown,
 * no text. Neither lets anybody in, lets a device do anything, or sends
 * anything anywhere it was not already going.
 */
const ALLOWED_UNDER: readonly RegExp[] = [
  /^projects\.[a-z0-9-]+\.title$/,
  /^projects\.[a-z0-9-]+\.brief$/,
  /^projects\.[a-z0-9-]+\.budget\./,
  /^projects\.[a-z0-9-]+\.checks\./,
  /^projects\.[a-z0-9-]+\.workspace$/,
  /^projects\.[a-z0-9-]+\.max_parallel$/,
  /^projects\.[a-z0-9-]+\.watches$/,
  /^projects\.[a-z0-9-]+\.accounts\.[a-z0-9-]+$/,
  /^workers\.routes\.[a-z0-9-]+\.(model|thinking|harness)$/,
  /^workers\.routes\.[a-z0-9-]+\.harnesses\.[a-z0-9-]+\.(model|thinking)$/,
  /^surfaces\.intake\.sources\.[a-z0-9-]+\.(template|document)$/,
  /^surfaces\.web\.(install|offline)$/,
]

/** Whether `path` is `prefix` or lives under it. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`)
}

/**
 * How far the orchestrator may go with this setting, and why.
 *
 * Anything unnamed is `asked`, which is the safe default for an ordinary key
 * and would be the wrong one for a dangerous key — so nothing dangerous is a
 * lone key. Every one of them is a *subtree*, which is what makes a key added
 * to `approvals`, `extensions`, `mcp` or an account refused on the day it is
 * added, by somebody who never read this file. What a subtree cannot catch is
 * a whole new section of the config, and a test holds the list of those.
 */
export function settingReach(path: string): Reaches {
  // `open` is answered first, so a path in it never has to be repeated in
  // `ALLOWED_UNDER` to escape the subtree it lives in.
  if (OPEN.includes(path) || OPEN_UNDER.some((allowed) => allowed.test(path))) {
    return { reach: 'open', because: '' }
  }
  if (!ALLOWED_UNDER.some((allowed) => allowed.test(path))) {
    for (const [prefix, because] of NEVER) {
      if (under(path, prefix)) return { reach: 'never', because }
    }
  }
  return { reach: 'asked', because: '' }
}

/**
 * How far the orchestrator reaches into a watch, and why that is not where its
 * extension sits.
 *
 * `extensions` is a `never` subtree, and turning a *watch* on is not turning
 * an extension on. The difference is what the act widens. Enabling an
 * extension imports somebody's code, hands its tools to every agent and puts
 * its credential in reach — which is why no words are enough. A watch lives
 * inside an extension a person already turned on and already trusts: its code
 * is loaded either way, its tools are offered either way, no third party is
 * handed anything new, and nothing about what an agent may do moves an inch.
 * What it changes is that a clock may start work, in a project that is already
 * open, on findings the person can see in the queue and stop there.
 *
 * That is `asked`-shaped and not `never`-shaped: a real consequence, visible,
 * undoable, and written down. So it takes the person's own words naming the
 * watch, the same bar `tade_setting_change` is held to, checked the same way
 * against the journal.
 *
 * **Both ways, and turning one off is the direction that needs it most.** Off
 * is usually the safe direction and here it is not: the watches are what
 * notice a red build, a new error, a vulnerable package and what a judge
 * flagged, so "turn the review watch off" is exactly the sentence an injected
 * page would like to be obeyed. Nothing an agent read can put those words in
 * somebody's mouth, which is the whole of why `namedBy` reads `said` lines.
 *
 * **Honest about what it holds.** It is checked at every door that turns a
 * watch on — the watch tool and `tade_schedule`, which writes the same
 * schedule — so there is no way round it in that direction. What it does not
 * hold is the other end of a watch's life: the schedule a watch makes is an
 * ordinary schedule, and the queue's own tools can still pause or remove one
 * without naming the watch, because pausing the queue is not a watch decision
 * and `tade_queue_change` has no idea it is looking at one. That is a gap and
 * is said rather than papered over: what it costs is a look that stops, in the
 * queue, where a person can see it and start it again, with a line in the
 * journal saying who asked.
 */
export const WATCH_REACH: Reaches = {
  reach: 'asked',
  because:
    'a watch starts work on a clock, so it goes on or off when the person asks for that watch',
}

/**
 * How far the orchestrator reaches into the order the project tabs are in.
 *
 * The second thing decided here that is not a config key — the order is one
 * person's view on one machine, in `window.json` beside the sizes they dragged
 * the dividers to — and it is here for the same reason a watch is: the
 * question is the same question, and answering it where the tools live is how
 * two answers to it come to exist.
 *
 * `open`, which is the tier almost nothing is in, and the argument is the one
 * `OPEN` already makes for the sidebar's width and the strip's height: the
 * worst case is a cosmetic annoyance the person is looking at and can undo in
 * one sentence. Moving a tab widens nothing an agent may do, hands nobody
 * tools or a credential, changes who is asked about nothing, and moves nowhere
 * Tade sends anything — the four things an injected sentence wants.
 *
 * **And it is `open` where a rename is `asked`, which is the line worth
 * seeing.** Both are "only what is on screen". The difference is that a rename
 * changes what a tab *says*, and what a tab says is how somebody knows which
 * project they are in; moving one changes only where it is, and the tab still
 * says what it always said. Nothing is misread by being second rather than
 * first — the worst an injected page buys itself is a tab somewhere the person
 * did not put it, in a window they are looking at.
 */
export const PROJECT_ORDER_REACH: Reaches = {
  reach: 'open',
  because: 'the order the tabs are in is a view, on one machine, undone by moving one back',
}

/**
 * How far the orchestrator reaches into updating what Tade runs.
 *
 * Not a config key, and decided here for `WATCH_REACH`'s reason. An update
 * installs software on this machine, and the rule for that is that nothing
 * installs anything unasked — so it is `asked`, and what is asked for is the
 * act: a line of theirs saying update, upgrade or updates (`updateNamedBy`).
 *
 * **What the model chooses is only which, never what.** The command each step
 * runs is the one Tade read off how that program got here (`updateWith`), the
 * same one Settings › Updates draws before it is pressed, typed into a
 * terminal somebody can watch. So the worst an injected sentence buys, past a
 * loose word — "give me an update on the agents" names `update` — is a program
 * Tade already runs moved to its newest release, in plain sight.
 */
export const UPDATE_REACH: Reaches = {
  reach: 'asked',
  because: 'an update installs software on this machine, so it runs when the person asks for one',
}

/**
 * How far the orchestrator reaches into reloading the window.
 *
 * `asked`, because a reload ends the orchestrator's own turn and starts the
 * window again — and under a driver whose lanes do not survive it, stops the
 * agents inside it too, which the reload panel still asks about first. What
 * survives either way is everything on disk, and the orchestrator picks its
 * conversation back up, so it is not `never`.
 */
export const RELOAD_REACH: Reaches = {
  reach: 'asked',
  because: 'a reload starts the window again and ends my own turn, so it happens when they ask',
}

/**
 * How far the orchestrator reaches into another machine's Tade: passing a
 * sentence to its orchestrator, as this machine's owner there (REMOTE-TADE.md
 * §9.4, `tade_remote_tell`).
 *
 * `asked`, and what is asked for is **that machine, by its name**
 * (`remoteNamedBy`). The turn it starts there runs as an owner's — it reaches
 * what that machine's keyboard does, starting agents included — so the words
 * it carries are worth as much as being at that machine, and the orchestrator
 * reads a stranger's text all day: an issue that says "tell the vps to run
 * this" must not be one tool call from being carried out there. A line of the
 * person's naming the machine is the barrier, and like every `asked` it can
 * only refuse. Where the turn calling it came from a paired device, it is
 * never reached at all (`origin.ts`).
 */
export const REMOTE_TELL_REACH: Reaches = {
  reach: 'asked',
  because:
    'it puts words to another machine’s Tade as its owner, where they reach what its keyboard does, so it happens when they name that machine',
}

/**
 * How far the orchestrator reaches into moving work to another machine of the
 * person's (REMOTE-TADE.md §9.2, `tade_task_move`): queued work started there
 * instead of here, or a running task handed over — its agent told to commit
 * and push, the work made there, the agent here stopped.
 *
 * `asked`, and what is asked for is **that machine, by its name**
 * (`remoteNamedBy`), for `REMOTE_TELL_REACH`'s reason and one more: the work
 * it makes there runs as the person's, with that machine's keyboard's reach,
 * and moving a running task stops an agent here. An issue that says "move this
 * to the vps" is not the person saying it. Like every `asked`, it can only
 * refuse; the window's own buttons are the person's press and need no words.
 */
export const REMOTE_MOVE_REACH: Reaches = {
  reach: 'asked',
  because:
    'it makes work on another machine as its owner and takes it away from this one, so it happens when they name that machine',
}

/** The line of theirs that names a machine this one is linked to, or null when none does. */
export function remoteNamedBy(machine: string, lines: readonly string[]): string | null {
  return namedBy({ path: machine, title: machine }, lines)
}

/** The line of theirs that asks for an update, or null when none does. */
export function updateNamedBy(lines: readonly string[]): string | null {
  return namedBy({ path: 'update', title: 'upgrade', keywords: ['updates', 'updating'] }, lines)
}

/** The line of theirs that asks for the window to reload, or null when none does. */
export function reloadNamedBy(lines: readonly string[]): string | null {
  return namedBy(
    { path: 'reload', title: 'reloading', keywords: ['relaunch', 'restart tade'] },
    lines,
  )
}

/**
 * The words that identify one watch: what a person would have to say for a
 * line of theirs to be about it.
 *
 * Its full id (`sentry.new-errors`), its own half of that id in both the
 * spellings people use (`new-errors`, `new errors`), and its title.
 *
 * **The extension's name is deliberately not one of them.** `wordsFor` drops
 * the first segment of a setting's path for the same reason: a section names
 * everything under it, so "how is the review extension doing" would name four
 * different watches and identify none of them.
 */
export function watchNamedBy(
  watch: { id: string; title: string },
  lines: readonly string[],
): string | null {
  const own = watch.id.split('.').slice(1).join('.')
  return namedBy(
    { path: watch.id, title: watch.title, keywords: [own, own.replace(/-/g, ' ')] },
    lines,
  )
}

/**
 * The words that identify one setting: what a person would have to say for a
 * line of theirs to be about it.
 *
 * Its dotted path, its title as a phrase, whatever it declared as keywords,
 * and the segments of its path long enough to mean something on their own —
 * five letters, which keeps `commit`, `thinking`, `harness`, `workspace` and
 * drops `mode`, `keys`, `stt`, `mic`.
 *
 * **The first segment never counts.** It is the section, and a section names
 * everything under it: with `agents` in, "how are the agents getting on" was
 * somebody asking for the commit rule to be changed. That is not hypothetical
 * — it is what the first run of this rule's own test did.
 *
 * **And a project's name never counts inside that project**, for exactly the
 * same reason and with exactly the same evidence. `projects.app.budget.…` is
 * titled `app` and `projects.app.workspace` carries `app` as a keyword, so
 * every one of a project's settings was named by any sentence with the
 * project's name in it — "how is the app project getting on?" authorised
 * changing what it may spend a day. A project is a section like `agents` is,
 * so its name is dropped wherever it appears as a word of its own, and what is
 * left is the half that says *which* setting: `app budget`, `app brief`,
 * `workspace`, `checks`. The dotted path itself always counts, however, which
 * is what keeps `namedBy` usable for a thing whose whole path is its name —
 * closing a project is checked that way.
 *
 * **The same is true of any scope** (`Setting.scope`): every segment of the
 * path up to and including it is what holds that scope's settings, so none of
 * them counts. `surfaces.intake.sources.github.template` is named by `template`
 * and never by `intake`, `sources` or `github`, each of which names all eight
 * of that source's settings and six of them no words reach.
 *
 * **And a route's row counts no word of its path on its own**, for the same
 * reason a third time. Every route has a `model`, a `thinking` and a
 * `harness`, and every harness kept under one (`harnesses.<h>`) a model and a
 * thinking, so each of those words named that row under every route, and
 * `default` named every row of the default route — "switch the model" named
 * every default a new agent starts on. A line names one by saying what is its
 * own together with what it is (`wordsTogether`): the route's name and the
 * setting — `default thinking`, `fast model` — or a harness's name and the
 * setting — `codex thinking` — with the route's name as well under any route
 * but the default. The one word that may stand alone is `default`, for the
 * default route's model, because that is how a default is asked for — "make
 * opus the default" — and only in a line that does not say which other of the
 * route's settings it means: "make the default thinking high" is not about
 * its model.
 *
 * The default route is the one called `default`, which is what Tade makes:
 * this reads the path and not `workers.default`, so one renamed in
 * `config.yaml` is named by its own name and its title and never by `default`
 * — refused more, never less. And a line about another route's harness, "the
 * fast route's codex thinking", names the default route's codex thinking too,
 * which takes no route word: the same harness and the same setting they named.
 *
 * **An account row is the same shape a fourth time.** `accounts` is in every
 * one of them and a harness's name in every row about it, so "how are my
 * accounts" named which sign-in every project runs as. A line names one by
 * the harness and the word together — "the claude code account", "codex
 * accounts" — and the machine's row and a project's both by those, the
 * project's name counting for nothing inside it, as everywhere.
 *
 * The title always counts however short it is: it is the name the setting
 * actually has, and somebody who says it has named it. Which is also the shape
 * of the ordinary conversation here — the orchestrator says the setting back
 * by name, and they answer naming it.
 *
 * **Except where the title is only what kind of setting it is** (`OWNED_ROWS`):
 * the orchestrator's own `Model`, `Thinking` and `Harness`, which are titled
 * that way because the page draws them under its heading. Any line with
 * "model" in it named the first, so "use a cheaper model for refunds" was the
 * person letting the orchestrator change its own model. Those take whose they
 * are said with the title, as one phrase — "your model", "the orchestrator's
 * thinking" — and neither word alone, nor the two apart: "orchestrator, use a
 * cheaper model for refunds" is about refunds. Nor any of their `keywords`,
 * which are what the panel's search finds them by: the harness's are `agent`,
 * `code`, `claude` and `pi`, so "start an agent on refunds" was the person
 * letting it change what it runs in. Every other title, being specific, still
 * counts.
 *
 * Known looseness, said rather than hidden: a leaf that is an ordinary word of
 * this house — `checks.before`, `telemetry.agents` — is matched by a line that
 * meant something else by it. An English stop list is the kind of thing that
 * rots, and what it would buy is bounded: everything that could widen what an
 * agent may do is in the tier no words reach at all, and what is left here can
 * only change when Tade runs checks unasked, or what it times.
 */
export function wordsFor(
  setting: Pick<Setting, 'path' | 'title' | 'keywords' | 'scope'>,
): string[] {
  const parts = setting.path.split('.')
  const section = parts[0] ?? ''
  const scopeAt = setting.scope === undefined ? -1 : parts.indexOf(setting.scope)
  const sections = new Set(
    [section, section === 'projects' ? (parts[1] ?? '') : '', ...parts.slice(0, scopeAt + 1)]
      .filter((part) => part !== '')
      .map((part) => part.toLowerCase()),
  )
  // A route's row is named by its words together, never one of them, and a
  // row whose title is only its kind by whose it is with it (`wordsTogether`).
  const owned = Object.hasOwn(OWNED_ROWS, setting.path)
  const together =
    ROUTE_ROW.test(setting.path.toLowerCase()) ||
    ACCOUNT_ROW.test(setting.path) ||
    DEFAULT_NAME_ROW.test(setting.path)
  const segments = together ? [] : parts.slice(1).filter((part) => part.length >= 5)
  const rest = (owned ? [] : [setting.title, ...(setting.keywords ?? []), ...segments])
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== '' && !sections.has(word))
  return [setting.path.trim().toLowerCase(), ...rest]
}

/** How a line says a row is the orchestrator's own: said in front of the row's title. */
const THE_ORCHESTRATOR = ['your', 'your own', 'orchestrator', "orchestrator's", 'orchestrator’s']

/**
 * Rows whose title is only what kind of setting they are, and how a line says
 * whose (`wordsFor` says why): named by one of these said in front of the title.
 */
const OWNED_ROWS: Readonly<Record<string, readonly string[]>> = {
  'orchestrator.model': THE_ORCHESTRATOR,
  'orchestrator.thinking': THE_ORCHESTRATOR,
  'orchestrator.harness': THE_ORCHESTRATOR,
  // "Account" alone is every account row's word, and "move refunds to the
  // work account" is about an agent: only "your account" names this one.
  'orchestrator.account': THE_ORCHESTRATOR,
}

/**
 * What a person says to name a setting, as a refusal asks them for it: its
 * title, or where the title is only its kind, whose it is with it.
 */
export function spokenAs(setting: Pick<Setting, 'path' | 'title'>): string {
  const title = setting.title.toLowerCase()
  const owners = Object.hasOwn(OWNED_ROWS, setting.path) ? OWNED_ROWS[setting.path] : undefined
  return owners?.[0] ? `${owners[0]} ${title}` : title
}

/** The route Tade makes, and the default one unless `workers.default` was renamed. */
const DEFAULT_ROUTE = 'default'

/**
 * One of a route's rows: `workers.routes.<route>.<setting>`, or
 * `workers.routes.<route>.harnesses.<harness>.<setting>` for what new agents
 * start on in another harness under it.
 */
const ROUTE_ROW = /^workers\.routes\.([^.]+)\.(?:harnesses\.([^.]+)\.)?([^.]+)$/

/** Which account a harness's new agents run as: the machine's, or one project's. */
const ACCOUNT_ROW = /^(?:workers|projects\.[^.]+)\.accounts\.([^.]+)$/

/**
 * What a harness's own sign-in is called (`workers.default_names.<h>`).
 *
 * **`asked`, by being in no subtree, and outside `accounts` on purpose.** It
 * is a label: it signs nothing in, adds and removes nothing, hands nobody a
 * credential and moves no agent — the sign-in is where the harness always
 * kept it, and the name only says which one it is wherever accounts are shown
 * or chosen. So it sits beside `workers.accounts` rather than under the
 * `accounts` subtree, which stays `never` for adding, removing and signing in.
 * It is still the person's to set: the orchestrator writes it only on a line
 * of theirs naming the harness and the act together — "name the claude code
 * sign-in sentry" — never on `name` or the harness alone (`wordsTogether`).
 * The residual risk, said: a name that reads like another sign-in's could
 * mislabel a plan, which is why one an added account of that harness already
 * has is refused by the schema.
 */
const DEFAULT_NAME_ROW = /^workers\.default_names\.([^.]+)$/

/** The words that, with a harness's name, ask for its own sign-in to be called something. */
const NAMING = ['name', 'names', 'named', 'rename', 'call', 'called']

/** What every route has a row of: a line saying one of the others is not about its model. */
const ROUTE_SETTINGS = ['model', 'thinking', 'harness']

/** Words a line names something by: every one of `all`, and none of `unless`. */
interface Together {
  all: readonly string[]
  unless?: readonly string[]
}

/**
 * What a line has to say to name a route's row (`wordsFor` says why), each
 * word on its own and in any order: the route's name and the setting's, and
 * under a harness that harness's name as well — in place of the route's on
 * the default route. A harness is said as its id or with spaces for its
 * hyphens, as `watchNamedBy` says a watch: `claude-code`, `claude code`. And
 * the default route's model by `default` alone, where the line says none of
 * the route's other settings.
 *
 * A row whose title is only its kind (`OWNED_ROWS`) is one phrase instead:
 * whose it is in front of the title, `your model`.
 */
function wordsTogether(row: Pick<Setting, 'path' | 'title'>): Together[] {
  const { path } = row
  if (Object.hasOwn(OWNED_ROWS, path)) {
    const title = row.title.trim().toLowerCase()
    return (OWNED_ROWS[path] ?? []).map((owner) => ({ all: [`${owner} ${title}`] }))
  }
  const account = ACCOUNT_ROW.exec(path.trim().toLowerCase())
  if (account) {
    const said = [...new Set([account[1] ?? '', (account[1] ?? '').replace(/-/g, ' ')])]
    return said.flatMap((harness) =>
      ['account', 'accounts'].map((word) => ({ all: [harness, word] })),
    )
  }
  const naming = DEFAULT_NAME_ROW.exec(path.trim().toLowerCase())
  if (naming) {
    const said = [...new Set([naming[1] ?? '', (naming[1] ?? '').replace(/-/g, ' ')])]
    return said.flatMap((harness) => NAMING.map((word) => ({ all: [harness, word] })))
  }
  const found = ROUTE_ROW.exec(path.trim().toLowerCase())
  if (!found) return []
  const [, route = '', harness, setting = ''] = found
  if (harness === undefined) {
    const own = { all: [route, setting] }
    if (route !== DEFAULT_ROUTE || setting !== 'model') return [own]
    return [own, { all: [route], unless: ROUTE_SETTINGS.filter((one) => one !== setting) }]
  }
  return [...new Set([harness, harness.replace(/-/g, ' ')])].map((said) => ({
    all: route === DEFAULT_ROUTE ? [said, setting] : [route, said, setting],
  }))
}

/** Whether `phrase` appears in `line` on its own, rather than inside a longer word. */
function saidIn(line: string, phrase: string): boolean {
  let at = line.indexOf(phrase)
  while (at >= 0) {
    const before = line[at - 1]
    const after = line[at + phrase.length]
    const word = (char: string | undefined) => char !== undefined && /[a-z0-9]/.test(char)
    if (!word(before) && !word(after)) return true
    at = line.indexOf(phrase, at + 1)
  }
  return false
}

/**
 * The line of theirs that names this setting, or null when none does.
 *
 * The other half of `asked`, and the half that makes it a rule rather than a
 * promise: `lines` are the things the *person* said — typed or spoken, kept
 * verbatim in the journal — and text an agent read cannot ever get into them.
 * A page can tell a model to turn the checks off; it cannot put "turn the
 * checks off" in somebody's mouth.
 *
 * Honest about what it holds. It is a barrier and not a proof: an ordinary
 * word like `before` can match a line that meant something else, and somebody
 * who says "make the left bit wider" has named nothing and is refused. Both
 * are the safe direction — it can only ever refuse, never permit what the tier
 * did not already allow.
 */
export function namedBy(
  setting: Pick<Setting, 'path' | 'title' | 'keywords' | 'scope'>,
  lines: readonly string[],
): string | null {
  const words = wordsFor(setting)
  const together = wordsTogether(setting)
  for (const line of lines) {
    const said = line.toLowerCase()
    const says = (word: string) => saidIn(said, word)
    const saysAll = ({ all, unless = [] }: Together) => all.every(says) && !unless.some(says)
    if (words.some(says) || together.some(saysAll)) return line
  }
  return null
}

/** How many of the person's own lines are looked back over for one. */
export const LINES_LOOKED_BACK = 40
