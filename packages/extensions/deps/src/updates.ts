import { join } from 'node:path'
import { loadConfig, watchedFrom, workspaceFor } from '@tade/core'
import {
  boolean,
  type ExtensionContext,
  type ExtensionWatch,
  type Finding,
  object,
  oneOf,
  type WatchAgent,
  type WatchContext,
} from '@tade/extensions-core'
import { readJournal } from '@tade/workbench/events'
import { readSchedules } from '@tade/workbench/schedules'
import { type Finding as Dependency, installCommands, type Level } from './check.ts'
import { files, report } from './look.ts'

// Keeping a project's dependencies current, on a clock.
//
// `deps.vulnerabilities` answers "something here is dangerous"; this answers
// the ordinary half — releases came out and nobody bumped them. Same shape as
// every watch: a cheap look, no model, and what an agent on each finding is
// told. What is deliberate about it is what it will *not* do, because a daily
// robot that edits manifests is the kind of thing people turn off after one
// bad morning:
//
//   · **Patch and minor, never major.** A patch or a minor release promises
//     not to break you, and when it does the checks say so within the hour. A
//     major promises the opposite: somebody has to read a migration guide and
//     decide. So majors are *named* — in the finding, and by the agent when it
//     finishes — and never bumped by a clock. `deps_update` with `level:
//     major` is still there for a person who asked for it.
//   · **Ranges and ceilings stay as written.** Already `deps_update`'s rule:
//     rewriting a constraint somebody chose is not a dependency update.
//   · **The patches are one commit and each minor is its own.** Twenty agents
//     in one checkout is twenty installs racing one lockfile; twenty bumps in
//     one branch is a diff nobody reads. Patches are the boring half — one
//     agent, one install, one check run, one commit, and if one of them breaks
//     the checks it is left behind and named rather than taking the other
//     nineteen down with it. A minor can change behaviour, so it gets its own
//     branch and its own green-or-red, which is the whole of how anybody finds
//     out which package did it.
//   · **It commits nothing red.** The value here is not the bump, it is the
//     evidence that the project still works on it — so the agent runs the
//     project's own checks through `checks_run`, and where it cannot make them
//     green it puts the manifests back and says so. A dependency bot that
//     lands broken code is worse than none.
//   · **A package it has already tried twice is told about, not tried again.**
//     The same rule the review watches keep, counted over a fortnight so a bad
//     week does not stop it for good.
//   · **Never in a checkout other agents share** unless whoever turned it on
//     said it may.

/** Its name in the extension, and the half of its schedule id Tade keeps findings under. */
const ID = 'updates'

/** How many patch bumps go in one commit. What is left waits for the next look. */
const BATCH = 20

/**
 * How long an automatic bump still counts against the next one.
 *
 * Long, because this looks once a day: counted over the six hours the review
 * watches use, a daily look would never see yesterday's attempt and the limit
 * would hold nothing. Counted over every attempt ever made, one bad week last
 * spring would stop a package being bumped for good.
 */
const TRYING_DAYS = 14

/** What a finding is: a set of packages, and how far each of them moves. */
export type Shape = 'patch' | 'minor' | 'held'

interface Bump {
  name: string
  /** The newest release: what this bump moves to. */
  to: string
  behind: 'patch' | 'minor'
  /** Every requirement that names it — one package can be in several manifests. */
  of: Dependency[]
}

/**
 * The key of a finding: what it moves, and each package at the version it
 * moves to. A package at a version, which is what makes a bump that failed
 * not be tried again tomorrow — and a release after it new information, and so
 * a new finding.
 */
export function keyOf(shape: Shape, bumps: readonly { name: string; to: string }[]): string {
  return `${shape}:${bumps
    .map((one) => `${one.name}@${one.to}`)
    .sort()
    .join(',')}`
}

/** What packages a finding of this watch was about, read back out of its key. */
export function readKey(key: string): { shape: Shape; names: string[] } | null {
  const at = key.indexOf(':')
  if (at < 0) return null
  const shape = key.slice(0, at)
  if (shape !== 'patch' && shape !== 'minor' && shape !== 'held') return null
  const names = key
    .slice(at + 1)
    .split(',')
    // A scoped npm name has an `@` of its own, so the version is after the last one.
    .map((one) => one.slice(0, one.lastIndexOf('@')))
    .filter((one) => one !== '')
  return names.length > 0 ? { shape, names } : null
}

/** How many automatic bumps this watch has already started on each package, in a window. */
export async function bumpsAlready(
  ctx: ExtensionContext,
  since: number,
): Promise<Map<string, number>> {
  const events = await readJournal(ctx.home, { types: ['watch_found'] }).catch(() => [])
  let ids: string[] = []
  try {
    ids = readSchedules(ctx.home)
      .filter(
        (schedule) =>
          schedule.does.kind === 'watch' && schedule.does.watch === `${ctx.extension}.${ID}`,
      )
      .map((schedule) => schedule.id)
  } catch {
    // No schedules file is the normal case, not an error.
  }
  const counted = new Map<string, number>()
  for (const id of ids) {
    for (const finding of watchedFrom(events, id).findings) {
      // A finding nothing was started on was not an attempt at anything.
      if (finding.task === null || finding.at < since) continue
      for (const name of readKey(finding.key)?.names ?? []) {
        counted.set(name, (counted.get(name) ?? 0) + 1)
      }
    }
  }
  return counted
}

/** How many automatic bumps one package may have before it is only reported. */
function allowed(ctx: ExtensionContext): number {
  const said = ctx.settings.attempts
  return typeof said === 'number' && said > 0 ? said : 2
}

/**
 * Whether the agent this watch would start works in the project's own
 * checkout, which every other agent there shares.
 *
 * A config nobody could read is read as the checkout: that is the machine's
 * own default (`agents.workspace`), and guessing the safe-looking answer here
 * would be guessing the one that lets a clock rewrite a shared tree.
 */
async function sharesTheCheckout(ctx: WatchContext): Promise<boolean> {
  const loaded = await loadConfig(join(ctx.home, 'config.yaml')).catch(() => null)
  const workspace = loaded?.ok ? workspaceFor(loaded.config, ctx.watching.name) : 'checkout'
  return workspace === 'checkout'
}

/** `- vitest: ~4.0.1 → ~4.0.5 (patch)`, under the manifest each is written in. */
function requirementLines(bumps: readonly Bump[]): string[] {
  const lines: string[] = []
  let manifest = ''
  for (const one of bumps) {
    for (const dep of one.of) {
      if (dep.dependency.manifest !== manifest) {
        manifest = dep.dependency.manifest
        lines.push('', manifest)
      }
      lines.push(
        `- ${one.name}: ${dep.dependency.spec} → ${dep.to ?? dep.dependency.spec} (${dep.behind})`,
      )
    }
  }
  return lines
}

/** A handful of names as somebody would say them. */
function said(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

/** `pnpm install` and `go mod tidy`, as a sentence, or how to say there is no such command. */
function installing(commands: readonly string[]): string {
  return commands.length > 0
    ? `Then run ${commands.map((one) => `\`${one}\``).join(' and ')} so the lockfiles match the manifests.`
    : 'Then install, however this project installs, so its lockfiles match the manifests.'
}

/** Every package with a new major, deduplicated, as something to read and not to do. */
function majorsSaid(findings: readonly Dependency[]): string[] {
  const byName = new Map<string, string>()
  for (const one of findings) {
    if (one.behind === 'major' && one.latest) byName.set(one.dependency.name, one.latest)
  }
  if (byName.size === 0) return []
  return [
    '',
    '## New majors, which are not this agent’s to bump',
    '',
    // By code point, so the same project reads the same way on every machine.
    ...[...byName]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, to]) => `- ${name} → ${to}`),
    '',
    'A major is a breaking change and somebody’s decision. Leave every one of these exactly as it',
    'is written, and say which they are when you finish so that somebody can decide.',
  ]
}

export const dependencyUpdates: ExtensionWatch = {
  id: ID,
  title: 'Dependency updates',
  means:
    'looks daily for patch and minor releases and puts an agent on them — the patches in one commit, each minor on its own — which installs, runs the project’s own checks and commits only if they pass; majors are reported and never bumped',
  every: '1d',
  input: object({
    level: oneOf(
      ['patch', 'minor'],
      'how far a bump may go on its own: minor (the default) includes patch. A major is never bumped on a clock, only reported.',
    ),
    in_checkout: boolean(
      'true to say a project whose agents share its own checkout may have its manifests bumped there anyway',
    ),
  }),

  async check(ctx) {
    const since = new Date(ctx.now()).toISOString()
    const level: Level = ctx.input.level === 'patch' ? 'patch' : 'minor'
    // Said before anything is read, because it is about where the work would
    // go rather than about what there is to do — and said once: the same
    // sentence at every look is the same problem, and Tade repeats neither.
    if (ctx.input.in_checkout !== true && (await sharesTheCheckout(ctx))) {
      throw new Error(
        `bumping dependencies rewrites manifests and lockfiles, and ${ctx.watching.name}’s agents work in its own checkout, which every other agent there shares: set projects.${ctx.watching.name}.workspace to worktree, or turn this watch on with in_checkout true to say it may`,
      )
    }
    const found = await report(ctx, ctx.watching.root, () => {})

    // Nothing behind because nothing could be asked is not nothing behind: a
    // machine with no network would otherwise report a project as current.
    const versioned = found.report.findings.filter((one) => one.leftAlone !== 'names no version')
    const unanswered = versioned.filter((one) => one.problem !== null)
    // Counted as packages and not as requirements: one thing named in a pnpm
    // catalog and in a package.json is one thing nobody could ask about.
    const packages = (of: readonly Dependency[]) =>
      new Set(of.map((one) => one.dependency.name)).size
    if (versioned.length > 0 && unanswered.length === versioned.length) {
      throw new Error(
        `no registry could be asked about the ${packages(versioned)} dependencies of ${ctx.watching.name}: ${unanswered[0]?.problem}`,
      )
    }

    // One bump per package, however many manifests name it — a pnpm catalog
    // entry and a package.json that pins the same thing are one decision, and
    // `deps_update` moves both. The worse of the two levels is the one that
    // decides, so a patch here and a minor there is a minor.
    const byName = new Map<string, Bump>()
    for (const one of found.report.findings) {
      if (one.to === null || one.latest === null) continue
      if (one.behind !== 'patch' && one.behind !== 'minor') continue
      if (one.behind === 'minor' && level === 'patch') continue
      const already = byName.get(one.dependency.name)
      if (already) {
        already.of.push(one)
        if (one.behind === 'minor') already.behind = 'minor'
        continue
      }
      byName.set(one.dependency.name, {
        name: one.dependency.name,
        to: one.latest,
        behind: one.behind,
        of: [one],
      })
    }

    const limit = allowed(ctx)
    const counted = await bumpsAlready(ctx, ctx.now() - TRYING_DAYS * 24 * 60 * 60_000)
    const tried = (one: Bump) => counted.get(one.name) ?? 0
    const under = [...byName.values()].filter((one) => tried(one) < limit)
    const held = [...byName.values()].filter((one) => tried(one) >= limit)
    const patches = under.filter((one) => one.behind === 'patch')
    const minors = under.filter((one) => one.behind === 'minor')
    const batch = patches.slice(0, BATCH)
    const waiting = patches.length - batch.length
    const couldNotAsk =
      unanswered.length > 0
        ? [
            '',
            `${packages(unanswered)} of this project’s dependencies could not be checked at all (${unanswered[0]?.problem}), so there may be more behind than this.`,
          ]
        : []

    const findings: Finding[] = []
    if (batch.length > 0) {
      findings.push({
        key: keyOf('patch', batch),
        title: `bump ${batch.length} patch release${batch.length === 1 ? '' : 's'} (${said(batch.map((one) => one.name))})`,
        detail: [
          `# ${batch.length} patch release${batch.length === 1 ? '' : 's'} behind in ${ctx.watching.name}`,
          '',
          'Each of these is a patch release of something already required here. Bump them together,',
          'in one commit, and leave behind any one of them that the checks say is the problem.',
          ...requirementLines(batch),
          ...(waiting > 0
            ? [
                '',
                `${waiting} more patch release${waiting === 1 ? '' : 's'} wait for the next look.`,
              ]
            : []),
          ...couldNotAsk,
        ].join('\n'),
      })
    }
    for (const one of minors) {
      findings.push({
        key: keyOf('minor', [one]),
        title: `bump ${one.name} to ${one.to}`,
        detail: [
          `# ${one.name} ${one.to} is out`,
          '',
          'A minor release, so it promises not to break this project — the checks are what say',
          'whether it kept the promise.',
          ...requirementLines([one]),
          ...couldNotAsk,
        ].join('\n'),
      })
    }
    // A package this watch has already moved its allowance of times and that
    // is still behind. Said rather than tried again, and said again only when
    // a release after it makes the key new.
    for (const one of held) {
      findings.push({
        key: keyOf('held', [one]),
        title: `${one.name} is still behind ${one.to} after ${tried(one)} automatic bump${tried(one) === 1 ? '' : 's'}`,
        detail: [
          `# ${one.name} → ${one.to}`,
          '',
          `This watch has started ${tried(one)} automatic bump${tried(one) === 1 ? '' : 's'} of ${one.name} in the last ${TRYING_DAYS} days and it is still behind.`,
          ...requirementLines([one]),
        ].join('\n'),
      })
    }

    // The majors ride on the first finding of the look rather than on each of
    // them: three agents each reporting the same breaking release is noise.
    // With nothing to bump there is no finding and they are not mentioned —
    // a major nobody is bumping is a standing fact rather than news, and
    // `deps_check` answers it whenever anybody asks.
    const majors = majorsSaid(found.report.findings)
    const first = findings[0]
    if (first && majors.length > 0) first.detail = `${first.detail ?? ''}\n${majors.join('\n')}`

    return { found: findings, since }
  },

  async agent(finding, ctx): Promise<WatchAgent> {
    const part = readKey(finding.key)
    if (!part) throw new Error(`${finding.key} does not say which packages it is about`)
    // Told rather than done, and told without a lane: Tade writes the finding
    // down with this sentence and says it to the orchestrator, so nothing is
    // bumped again unasked and nobody has to read a transcript to find out
    // why. A model spending a turn to say "it failed twice" is the same
    // sentence at a worse price.
    if (part.shape === 'held') {
      throw new Error(
        `${finding.title} — somebody should move it by hand, or put it in extensions.deps.ignore, before a clock tries it again`,
      )
    }
    const install = installCommands(await files(ctx, ctx.watching.root).catch(() => []))
    const patches = part.shape === 'patch'
    return {
      title: patches ? `bump ${part.names.length} patch releases` : `bump ${part.names[0]}`,
      prompt: [
        patches
          ? `The ${part.names.length} patch release${part.names.length === 1 ? '' : 's'} in your task’s context file are behind in this project.`
          : `${part.names[0]} has a new minor release, in your task’s context file with what is required now and what it would be.`,
        `Call deps_update with level ${part.shape} and packages ${JSON.stringify(part.names)}: it moves those requirements in your own worktree and nothing else, and leaves ranges and ceilings exactly as somebody wrote them.`,
        installing(install),
        'Then run this project’s own checks with `checks_run` — never by typing the command in a shell: Tade runs one suite per checkout, waits for anybody else’s rather than starting a second, and records what ran against the tree it ran on.',
        ctx.watching.test
          ? `If Tade has no checks recorded for this project, run \`${ctx.watching.test}\` instead.`
          : 'If this project has no checks at all, say so plainly rather than committing on no evidence.',
        'Fix what the update broke. Do not pin anything back unless there is no other way, and say which and why when you do. Bump nothing to a new major, whatever a changelog suggests: a major is somebody’s decision and not this one’s.',
        'If the install cannot resolve the new versions at all, that is the answer rather than something to work around: say which requirement could not be satisfied and against what, and put it back.',
        patches
          ? 'If one package is what breaks the checks, leave that one at the version it was, bump the rest, and say which you left and what it broke — one bad release must not hold up the others.'
          : '',
        'Commit only once the checks are green, with a message naming what moved. If you cannot make them green, put every manifest and lockfile back the way you found it, commit nothing, and say what broke and how far you got: a dependency update that lands red is worse than none.',
      ]
        .filter((line) => line !== '')
        .join(' '),
      ...(finding.detail ? { context: finding.detail } : {}),
    }
  },
}
