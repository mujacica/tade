import type { IntakeSource } from './intake.ts'

// What turning a source on takes, and whether somebody has finished doing it.
//
// Its own file for the reason `settings-intake.ts` is one: these are read by
// people rather than by code, and they grow by one entry per source while
// `intake.ts` is the rule and must not. Nothing here decides anything — the
// rule is `intakeDecision`'s, and this only says whether somebody has finished
// writing the thing that rule reads.

/**
 * What turning each source on actually takes, in order, in the owner's words.
 *
 * Here rather than in each connector because every surface that offers a
 * source has to be able to say it — `tade intake status`, the Settings page,
 * whatever comes next — and a second copy is a second answer. The sentences
 * name keys and programs and nothing reads them: they are read by people.
 *
 * **One entry per source, so tsc names the one somebody forgot.** A source
 * whose grant a person cannot work out how to write is a source nobody turns
 * on, and that has been the whole failure mode of every connector anybody has
 * shipped.
 */
export const INTAKE_SETUP: Readonly<Record<IntakeSource, readonly string[]>> = {
  cli: [
    'Nothing to install: no key, no endpoint, no account.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.cli.accept: true.',
    'surfaces.intake.sources.cli.projects: the projects it may make work in.',
    'surfaces.intake.sources.cli.from: the handles whose requests count. Empty means nobody.',
    'A watch: Settings › Extensions, or a schedule over intake.cli.',
    'Then `tade intake add <id> --project <p> --from <who>` and write the request.',
  ],
  github: [
    'A credential: `gh auth login`, or $GITHUB_TOKEN with `repo` for a private repository.',
    'A label on the repository — `tade` is the one Tade suggests — and nothing defaults to it.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.github.accept: true.',
    'surfaces.intake.sources.github.projects: the Tade projects it may make work in.',
    'surfaces.intake.sources.github.from: the logins whose LABELLING counts, not whose issues.',
    'A watch, told the label: Settings › Extensions, or a schedule over intake.github.',
    'Then label an issue. mode is propose, so a task is made and parked for you to approve.',
    'For a workflow rather than one task: template: bug-repro-fix-review, document: report.',
  ],
  // Slack's own numbers, read off its documentation on 2026-10-09, because the
  // one that decides whether this is usable is not the one most people quote.
  // `conversations.history` and `conversations.replies` are Tier 3 — 50+ a
  // minute, up to 1,000 objects — for an **internal customer-built app** and
  // for a Marketplace-approved one. For an app distributed outside the
  // Marketplace and created after 29 May 2025, both are **1 request a minute
  // with the `limit` parameter capped at 15 objects**, and existing
  // non-Marketplace installations join them on 3 March 2026. So the app to make
  // for this is the internal one in your own workspace, and the step says so
  // rather than leaving somebody to find out from a 429.
  slack: [
    'A Slack app in your own workspace — an internal one, created from scratch, not distributed.',
    'Bot scopes: channels:history for a public channel, or groups:history for a private one.',
    'chat:write and reactions:write too, and surfaces.intake.sources.slack.reply: true, only if Tade may say a status back.',
    'Install it, then INVITE the bot to the channel: without that every look answers not_in_channel.',
    'The bot token (xoxb-…) as $SLACK_BOT_TOKEN, or extensions.intake.slack_token in config.yaml.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.slack.accept: true.',
    'surfaces.intake.sources.slack.projects: the Tade projects it may make work in.',
    'surfaces.intake.sources.slack.from: Slack USER IDS (U…), not display names, which people change.',
    'A watch, told the channel id (C…): Settings › Extensions, or a schedule over intake.slack.',
    'Then @-mention the app in that channel. It is polled every two minutes: Tade notices a mention, it does not answer one.',
    'A mention inside a thread is invisible to a poll unless you also send it to the channel. Instant replies need Socket Mode, which is not built.',
  ],
  // Linear's own numbers, read off its documentation and its own published
  // GraphQL schema on 2026-10-09. Two of them decide the shape rather than
  // decorating it, and both are in `linear-api.ts` with the arithmetic:
  // 2,500 requests an hour on a personal API key, and a *complexity* budget
  // where "any connection multiplies its children's points based on the given
  // pagination argument, or the default 50" — so every nested connection in
  // the one query this sends carries an explicit `first`, and a connector that
  // left the default on would cost fifty times what it needed to.
  linear: [
    'A personal API key: Linear › Settings › Security & access › Personal API keys.',
    'A label on the team — `tade` is the one Tade suggests — and nothing defaults to it.',
    'The key as $LINEAR_API_KEY, or extensions.intake.linear_key in config.yaml.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.linear.accept: true.',
    'surfaces.intake.sources.linear.projects: the Tade projects it may make work in.',
    'surfaces.intake.sources.linear.from: Linear USER IDS, not display names, which somebody else can take over once their owner gives one up. The look names the ids it saw.',
    'A watch, told the team key (ENG) and the label: Settings › Extensions, or a schedule over intake.linear.',
    'Then label an issue in that team. mode is propose, so a task is made and parked for you to approve.',
    'It is polled every ten minutes: Tade notices a labelled issue, it does not answer one.',
    'Nothing is ever posted back to Linear: this watch has no reply at all, so reply: true would turn nothing on.',
  ],
}

/**
 * What is **not** a source, said where somebody is deciding whether to turn one
 * on — because the failure this avoids is somebody reading a roadmap as a
 * switch they have not found yet.
 *
 * Both of these were looked at properly and both come down to the same thing,
 * which is why they are one sentence each rather than a table: **a laptop
 * cannot promise to be awake.** Linear's realtime path (Agent Interaction) and
 * every Jira webhook need a publicly reachable HTTPS endpoint that answers
 * inside seconds, and a machine that is asleep misses the delivery, misses the
 * retries, and has its webhook switched off at the far end. Nothing in Tade is
 * half-built towards either: there is no name in `INTAKE_SOURCES`, no grant, no
 * setting, no input and no code path — which is the only honest way to say
 * "not supported", because a disabled switch is a promise.
 *
 * Read in full by `tade intake status`, which is where somebody asks. The
 * Settings page gets the short clause below instead, because a surface is
 * options and values and a paragraph under a heading is not one.
 */
export const INTAKE_NOT_SUPPORTED = [
  'Linear in realtime — @-mentioning or assigning Tade as a Linear agent — is not supported and is not polled-with-a-delay either: it is a different thing. It needs a publicly accessible HTTPS, non-localhost URL that answers a webhook within 5 seconds and sends a first activity within 10, and Linear retries a failed delivery after 1 minute, 1 hour and 6 hours and may then disable the webhook. A laptop cannot promise any of that, so what Tade does instead is poll one team’s labelled issues.',
  'Jira is not supported at all, and there is no Jira source to switch on. Only Connect and OAuth apps may register a Jira webhook, 5 per app per user per tenant all to the same URL, and they expire 30 days from creation unless something keeps calling "Extend webhook life" — an operational obligation Tade has no daemon to meet. Polling by JQL would be this file’s shape with a different query, and is deferred on demand rather than started and left half-done.',
] as const

/**
 * Whether a source's grant is written far enough to do anything, and what is
 * missing — for a surface deciding whether to print the setup above.
 *
 * Null when it would work. Never a refusal of its own: the rule is
 * `intakeDecision`'s, and this only says whether somebody has finished writing
 * the thing that rule reads.
 */
export function intakeUnfinished(grant: {
  on: boolean
  accept: boolean
  projects: readonly string[]
  from: readonly string[]
}): string | null {
  if (!grant.on) return 'surfaces.intake.enabled is off'
  if (!grant.accept) return 'accept is off'
  if (grant.projects.length === 0) return 'no project is on its list'
  if (grant.from.length === 0) return 'nobody is on its list'
  return null
}

/**
 * The same thing in a clause, for a surface that has room for a clause.
 *
 * The pair is `KEYS_AND_AGENTS`/`SEEN_BY_AGENTS`'s pattern: one sentence
 * written once, and a short form of it for where there is no room — never a
 * second, friendlier claim.
 */
export const INTAKE_NO_REALTIME =
  'Linear in realtime and Jira are not sources: there is nothing here to switch on for either, and `tade intake status` says why.'
