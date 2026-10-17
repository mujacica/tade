import { HOOK_SECRETS } from './hooks.ts'
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
    'A credential: `gh auth login`, or $GITHUB_TOKEN with `repo` for a private repository — or, read-only and its own budget, a GitHub App made at http://localhost:<port>/connect on this machine (through `ssh -L` from another, or Settings › Remotes there), which also brings the webhook below.',
    'A label on the repository — `tade` is the one Tade suggests — and nothing defaults to it.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.github.accept: true.',
    'surfaces.intake.sources.github.projects: the Tade projects it may make work in.',
    'surfaces.intake.sources.github.from: the logins whose LABELLING counts, not whose issues.',
    'A watch, told the label: Settings › Extensions, or a schedule over intake.github.',
    'Then label an issue. mode is propose, so a task is made and parked for you to approve.',
    'For a workflow rather than one task: template: bug-repro-fix-review, document: report.',
    `Optional, where this machine has a public name and no App was made at /connect: a repository webhook to https://<name>/hooks/github, content type application/json, the Issues and Issue comments events, and a secret — the same one as $${HOOK_SECRETS.github.env} or extensions.intake.${HOOK_SECRETS.github.key}. A delivery only makes the watch look now, and it polls hourly while deliveries arrive.`,
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
    'A Slack app in your own workspace — an internal one, not distributed: made at http://localhost:<port>/connect on this machine (through `ssh -L` from another), which writes its manifest, keeps its signing secret first and its token after, and installs it with OAuth where this machine has a public name. Or by hand, as below.',
    'Bot scopes: channels:history for a public channel, or groups:history for a private one — and app_mentions:read where it delivers to a public name.',
    'chat:write and reactions:write too, and surfaces.intake.sources.slack.reply: true, only if Tade may say a status back.',
    'Install it, then INVITE the bot to the channel: without that every look answers not_in_channel.',
    'The bot token (xoxb-…) as $SLACK_BOT_TOKEN, or extensions.intake.slack_token in config.yaml — which /connect writes.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.slack.accept: true.',
    'surfaces.intake.sources.slack.projects: the Tade projects it may make work in.',
    'surfaces.intake.sources.slack.from: Slack USER IDS (U…), not display names, which people change.',
    'A watch, told the channel id (C…): Settings › Extensions, or a schedule over intake.slack.',
    'Then @-mention the app in that channel. It is looked at every two minutes, or at once where Slack delivers here: Tade notices a mention, it does not answer one.',
    'A mention inside a thread is seen only where Slack delivers its app_mention to this machine’s public name, or where it was also sent to the channel. Socket Mode, which would need no public name, is not built.',
    `By hand, where this machine has a public name: the signing secret (Basic Information) as $${HOOK_SECRETS.slack.env} or extensions.intake.${HOOK_SECRETS.slack.key} FIRST, then Event Subscriptions on with the Request URL https://<name>/hooks/slack and the app_mention bot event. An event makes the watch look now, and reads the one thread it names.`,
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
    'A private Linear app in your own workspace, made at http://localhost:<port>/connect on this machine (through `ssh -L` from another, or Settings › Remotes there): it may only read, keeps its client id and a refresh token this machine renews itself — never its client secret, which connecting with PKCE does not need — and brings the webhook below where there is a public name. It gets 5,000 requests an hour of its own.',
    'Or, by hand, a personal API key (Linear › Settings › Security & access › Personal API keys) as $LINEAR_API_KEY, or extensions.intake.linear_key in config.yaml — read only where no app is connected.',
    'A label on the team — `tade` is the one Tade suggests — and nothing defaults to it.',
    'surfaces.intake.enabled: true, and surfaces.intake.sources.linear.accept: true.',
    'surfaces.intake.sources.linear.projects: the Tade projects it may make work in.',
    'surfaces.intake.sources.linear.from: Linear USER IDS, not display names, which somebody else can take over once their owner gives one up. The look names the ids it saw.',
    'A watch, told the team key (ENG) and the label: Settings › Extensions, or a schedule over intake.linear.',
    'Then label an issue in that team. mode is propose, so a task is made and parked for you to approve.',
    'It is looked at every ten minutes, or at once where Linear delivers here: Tade notices a labelled issue, it does not answer one.',
    'Nothing is ever posted back to Linear: this watch has no reply at all, so reply: true would turn nothing on.',
    `Where this machine has a public name, the app made at /connect delivers to https://<name>/hooks/linear, its signing secret kept there. By hand instead: a webhook (Linear › Settings › API) to that address for Issues and Comments, its signing secret as $${HOOK_SECRETS.linear.env} or extensions.intake.${HOOK_SECRETS.linear.key}. A delivery only makes the watch look now, and it polls hourly while deliveries arrive.`,
  ],
}

/**
 * What is **not** a source, said where somebody is deciding whether to turn one
 * on — because the failure this avoids is somebody reading a roadmap as a
 * switch they have not found yet.
 *
 * Both of these were looked at properly, which is why they are one sentence
 * each rather than a table. What used to stop Linear's was **a laptop cannot
 * promise to be awake**, and a server with a public name now can: Connect
 * Linear's app delivers its webhook there (REMOTE-TADE §6.3, V16). What still
 * stops Linear's agents is their own — a first activity inside ten seconds of
 * every session, a Developer Preview, and a subscription that shows the agent
 * to the whole workspace at once — so they are a later stage and their own
 * switch (V17). Jira's is an obligation Tade has no daemon to meet. Nothing
 * in Tade is half-built towards either: there is no name in `INTAKE_SOURCES`,
 * no grant, no setting, no input and no code path — which is the only honest
 * way to say "not supported", because a disabled switch is a promise.
 *
 * Read in full by `tade intake status`, which is where somebody asks. The
 * Settings page gets the short clause below instead, because a surface is
 * options and values and a paragraph under a heading is not one.
 */
export const INTAKE_NOT_SUPPORTED = [
  'Linear agents — @-mentioning or assigning Tade as an app user in Linear — are not supported and are not a labelled issue with a delay either: they are a different thing. Each session must be answered within 5 seconds and sent a first activity within 10, Linear’s Agents API is still a Developer Preview, and turning it on shows the agent to everyone in the workspace at once. What Tade does instead is read one team’s labelled issues: on a clock, and at once where this machine has a publicly accessible HTTPS name the Linear app made at /connect delivers to — a laptop with none is polled.',
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
  'Linear agents and Jira are not sources: there is nothing here to switch on for either, and `tade intake status` says why.'
