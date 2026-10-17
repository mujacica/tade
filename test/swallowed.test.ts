import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discardsIn } from './swallowed.ts'

// A caught error the program carries on without.
//
// Jev asks of every change whether it "catches an error and carries on
// without reporting it anywhere", and fourteen times a verdict said yes: a
// journal that fell back to no index without a word, a record that could not
// be read drawn as an empty conversation, a tell to the orchestrator dropped
// with `.catch(() => {})`, an unreadable run record turned into a tree where
// nothing ran with `.catch(() => [])`, a screen that could not be read said to
// have no agent behind it. Each was found after it was committed, by a judge
// reading the diff — and each time the next agent made it again, because a
// sentence about it is a sentence an agent can read past.
//
// What a machine can see is the shape every one of them had: a handler that
// never names what it caught. `catch {}` and `.catch(() => [])` have nothing
// to report with; `catch (err) {}` names it only to drop it. A handler that
// says anything about the failure, or looks at it before deciding, cannot help
// naming it, and every one of these handlers that has been fixed now does.
// `discardsIn` (`./swallowed.ts`) says exactly what is counted.
//
// There are over six hundred of these already, many deliberate and commented,
// a few still the finding they were made in. So this is a ratchet: one number
// per file, today's, which may go DOWN in the commit that earns it and never
// up. A new one is a line here
// argued for in review, which is the moment the fourteen never had.
//
// What it cannot see, and the two of the fourteen that showed it:
//
// - **An error that arrives as a value.** `tade web status` read
//   `loaded.ok ? … : defaults` and printed the defaults as what was set; no
//   catch anywhere. Choosing a default and falling back to one in silence are
//   the same code, and the fix — `read: loaded.ok`, carried to the lines —
//   reads no error either.
// - **A swallow rewritten in place.** `credentials?.().catch(() => ({}))`
//   became `.catch(() => null) ?? this.paid`: still silent, and the count did
//   not move. The ratchet would have refused the line when it was first
//   written (3c70d4e2), so it would never have been there to rewrite.
//
// It runs in `test:smoke`, which is what the commit hook runs.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const TABLE = 'test/swallowed.test.ts'

/** Where the counting is done: what ships, the away view's page included. */
const SOURCE = /^packages\/(.+\/)?src\/.*\.(ts|m?js)$/

/**
 * The mistakes as they were made, a line or two of each, so this test can
 * never pass by having stopped looking. Every one must be counted.
 */
const MADE: Record<string, string> = {
  '56694e7f packages/workbench/src/events.ts': `
    try {
      index?.rebuild(await readAll(opts.path))
    } catch {
      index?.close()
      index = null
    }`,
  '6ba1a03b packages/harnesses/core/src/history.ts': `
    const handle = await open(file, 'r').catch(() => null)`,
  '6ba1a03b packages/orchestrator/src/orchestrator.ts': `
    return adapter.history(ORCHESTRATOR_TASK, cwd, ask).catch(() => NO_HISTORY)`,
  '0079fb3f packages/app/src/app.ts': `
    if (told && this.orchestrator.started) void this.orchestrator.tell(told).catch(() => {})`,
  'b568d0eb packages/app/src/wire/forecast.ts': `
    void this.deps.tell(this.says(conflict, project.tasks, live.queued)).catch(() => {})`,
  '599c0919 packages/web/src/assets/install.js': `
    reg.update().catch(() => {})`,
  '5ff47534 packages/app/src/wire/findings.ts': `
    void host.findings().then(keep).catch(() => {}).finally(done)`,
  'be5bf20e packages/app/src/wire/web-checks.ts': `
    const runs = stamp === null ? [] : await this.deps.read(one.dir).catch(() => [])`,
  'b24f0e7d packages/app/src/wire/machine.ts': `
    this.paid = (await this.wire.opts.credentials?.().catch(() => null)) ?? this.paid`,
  'cc193f71 packages/app/src/wire/web-lanes.ts': `
    try {
      this.held.set(task, { kind: 'read', text: await capture(task) })
    } catch {
      if (this.watching.has(task)) this.held.set(task, { kind: 'none', why: 'no agent' })
    }`,
  'b89e0c21 packages/web/src/assets/push.js': `
    try {
      return (await reg.pushManager.getSubscription()) === null ? OFF : ON
    } catch {
      return OFF
    }`,
  'b1024b46 packages/app/src/wire/updates.ts': `
    await rememberUpdates(this.wire.opts.home, this.look).catch(() => {})`,
  'a name bound only to be dropped': `
    try { await rm(path) } catch (_err) {}`,
}

/** The same handlers as they were fixed, and the shapes that are not carrying on. None is counted. */
const FIXED: Record<string, string> = {
  '1daf4e01 says why, with the cause': `
    try {
      index?.rebuild(await readAll(opts.path))
    } catch (cause) {
      index = null
      unindexed = \`could not build the index of \${opts.path}: \${String(cause)}\`
    }`,
  'b568d0eb..4d8786f1 hands it to whoever says it': `
    void this.deps.tell(said).catch((err) => this.troubled(err))`,
  'f7f7e18b looks at it before deciding': `
    try {
      this.held.set(task, { kind: 'read', text: await capture(task) })
    } catch (problem) {
      const gone = problem instanceof LaneNotFoundError || problem instanceof LaneClosedError
      if (gone) this.held.set(task, { kind: 'none', why: 'no agent' })
      else this.couldNot(task)
    }`,
  '1e06743e narrows it, and throws the rest': `
    try {
      return await stat(recordsPath(dir))
    } catch (problem) {
      if ((problem as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw problem
    }`,
  'a handler handed by name is handed the error': `
    void this.orchestrator.tell(told).catch(report)`,
  'throwing is not carrying on': `
    try { return JSON.parse(text) } catch { throw new Error(\`\${path} is not JSON\`) }`,
}

/**
 * How many handlers in each file catch an error and carry on without it. A
 * number here may go DOWN in the commit that earns it, and never up; a file
 * that is not here is allowed none.
 */
const ALLOWED: Record<string, number> = {
  'packages/app/src/checkout-look.ts': 1,
  'packages/app/src/editor.ts': 1,
  'packages/app/src/highlight.ts': 2,
  'packages/app/src/images.ts': 6,
  'packages/app/src/live.ts': 9,
  'packages/app/src/projects.ts': 5,
  'packages/app/src/screen.ts': 6,
  'packages/app/src/wire/agents.ts': 2,
  'packages/app/src/wire/awake.ts': 1,
  'packages/app/src/wire/context.ts': 1,
  'packages/app/src/wire/earlier.ts': 1,
  'packages/app/src/wire/extensions.ts': 5,
  'packages/app/src/wire/files.ts': 3,
  'packages/app/src/wire/finding.ts': 1,
  'packages/app/src/wire/fitting.ts': 1,
  'packages/app/src/wire/keeping.ts': 2,
  'packages/app/src/wire/keyboard.ts': 5,
  'packages/app/src/wire/lanes.ts': 1,
  'packages/app/src/wire/machine.ts': 3,
  'packages/app/src/wire/network.ts': 2,
  'packages/app/src/wire/orchestrator.ts': 5,
  'packages/app/src/wire/outbox.ts': 1,
  'packages/app/src/wire/projects.ts': 1,
  'packages/app/src/wire/proposals.ts': 3,
  'packages/app/src/wire/queue.ts': 11,
  'packages/app/src/wire/races.ts': 2,
  'packages/app/src/wire/replays.ts': 3,
  'packages/app/src/wire/routes.ts': 5,
  'packages/app/src/wire/schedules.ts': 2,
  'packages/app/src/wire/search.ts': 3,
  'packages/app/src/wire/settings.ts': 2,
  // One of these is still the finding on tade/updates-chip-and-reload: a cache
  // that could not be written, `rememberUpdates(…).catch(() => {})`.
  'packages/app/src/wire/updates.ts': 2,
  'packages/app/src/wire/voice.ts': 1,
  'packages/app/src/wire/web-asking.ts': 1,
  'packages/app/src/wire/web-beat.ts': 1,
  'packages/app/src/wire/web-checks.ts': 1,
  'packages/app/src/wire/web-factory.ts': 1,
  'packages/app/src/wire/web-push.ts': 2,
  'packages/app/src/wire/web-sessions.ts': 1,
  'packages/app/src/wire/web-settings.ts': 1,
  'packages/app/src/wire/window.ts': 2,
  'packages/checks/core/src/ci.ts': 2,
  'packages/checks/core/src/coverage.ts': 1,
  'packages/checks/core/src/hooks.ts': 1,
  'packages/checks/core/src/lock.ts': 2,
  'packages/checks/core/src/machine.ts': 1,
  'packages/checks/core/src/records.ts': 2,
  'packages/checks/core/src/run.ts': 1,
  'packages/checks/core/src/running.ts': 5,
  'packages/checks/local/src/index.ts': 3,
  'packages/cli/src/attach.ts': 4,
  'packages/cli/src/commands/app.ts': 9,
  'packages/cli/src/commands/chat.ts': 3,
  'packages/cli/src/commands/documents.ts': 1,
  'packages/cli/src/commands/lanes.ts': 1,
  'packages/cli/src/commands/mcp.ts': 1,
  'packages/cli/src/commands/proposals.ts': 2,
  'packages/cli/src/commands/setup-facts.ts': 6,
  'packages/cli/src/commands/setup-watches.ts': 1,
  'packages/cli/src/commands/setup.ts': 2,
  'packages/cli/src/commands/update.ts': 1,
  'packages/cli/src/telemetry.ts': 2,
  'packages/cli/src/version.ts': 1,
  'packages/cli/src/with-workbench.ts': 1,
  'packages/core/src/config-file.ts': 2,
  'packages/core/src/config.ts': 1,
  'packages/core/src/policy.ts': 1,
  'packages/core/src/prepare.ts': 1,
  'packages/core/src/run.ts': 2,
  'packages/core/src/schedule.ts': 1,
  'packages/core/src/templates-store.ts': 5,
  'packages/core/src/which.ts': 1,
  'packages/drivers/core/src/waiting.ts': 1,
  'packages/drivers/pty/src/emulator.ts': 1,
  'packages/drivers/pty/src/helper.ts': 2,
  'packages/drivers/pty/src/index.ts': 2,
  'packages/drivers/tmux/src/ended.ts': 1,
  'packages/drivers/tmux/src/index.ts': 17,
  'packages/drivers/tmux/src/session.ts': 3,
  'packages/extensions/checks/src/extension.ts': 1,
  'packages/extensions/core/src/conformance.ts': 2,
  'packages/extensions/core/src/folders.ts': 2,
  'packages/extensions/core/src/host.ts': 4,
  'packages/extensions/deps/src/extension.ts': 1,
  'packages/extensions/deps/src/manifests.ts': 2,
  'packages/extensions/deps/src/registries.ts': 1,
  'packages/extensions/deps/src/updates.ts': 4,
  'packages/extensions/intake/src/spool.ts': 3,
  'packages/extensions/jev/src/changes.ts': 2,
  'packages/extensions/jev/src/record.ts': 1,
  'packages/extensions/jev/src/replay.ts': 3,
  'packages/extensions/jev/src/review.ts': 1,
  'packages/extensions/jev/src/reviews.ts': 3,
  'packages/extensions/resources/src/extension.ts': 1,
  'packages/extensions/review/src/branch.ts': 1,
  'packages/extensions/review/src/extension.ts': 6,
  'packages/extensions/review/src/record.ts': 3,
  'packages/extensions/sentry/src/api.ts': 2,
  'packages/extensions/sentry/src/auth.ts': 4,
  'packages/extensions/sentry/src/extension.ts': 3,
  'packages/forges/core/src/credentials.ts': 1,
  'packages/forges/core/src/port.ts': 2,
  'packages/forges/github/src/index.ts': 2,
  'packages/harnesses/acp/src/adapter.ts': 1,
  'packages/harnesses/acp/src/client.ts': 1,
  'packages/harnesses/acp/src/lane.ts': 1,
  'packages/harnesses/acp/src/launch.ts': 1,
  'packages/harnesses/acp/src/link.ts': 1,
  'packages/harnesses/acp/src/record.ts': 2,
  'packages/harnesses/acp/src/rpc.ts': 1,
  'packages/harnesses/acp/src/tools.ts': 2,
  'packages/harnesses/claude/src/adapter.ts': 10,
  'packages/harnesses/claude/src/ask.ts': 2,
  'packages/harnesses/claude/src/channel.ts': 1,
  'packages/harnesses/claude/src/installed.ts': 1,
  'packages/harnesses/claude/src/mcp.ts': 2,
  'packages/harnesses/claude/src/transcript.ts': 6,
  'packages/harnesses/claude/src/trust.ts': 4,
  'packages/harnesses/codex/src/adapter.ts': 12,
  'packages/harnesses/codex/src/ask.ts': 2,
  'packages/harnesses/codex/src/channel.ts': 1,
  'packages/harnesses/codex/src/installed.ts': 1,
  'packages/harnesses/codex/src/mcp.ts': 2,
  'packages/harnesses/codex/src/sessions.ts': 9,
  'packages/harnesses/core/src/channel.ts': 2,
  'packages/harnesses/core/src/headless.ts': 1,
  'packages/harnesses/core/src/history.ts': 2,
  'packages/harnesses/core/src/port.ts': 1,
  'packages/harnesses/core/src/reaper.ts': 1,
  'packages/harnesses/pi/src/adapter.ts': 11,
  'packages/harnesses/pi/src/compat.ts': 1,
  'packages/harnesses/pi/src/installed.ts': 2,
  'packages/harnesses/pi/src/models.ts': 1,
  'packages/harnesses/pi/src/sessions.ts': 7,
  'packages/harnesses/pi/src/tade.ts': 6,
  'packages/judges/jev/src/index.ts': 3,
  'packages/mcp/broker/src/broker.ts': 3,
  'packages/mcp/core/src/cache.ts': 3,
  'packages/mcp/core/src/conformance.ts': 2,
  'packages/mcp/core/src/protocol.ts': 1,
  'packages/mcp/http/src/index.ts': 8,
  'packages/mcp/stdio/src/index.ts': 6,
  'packages/orchestrator/src/extensions.ts': 8,
  'packages/orchestrator/src/orchestrator.ts': 3,
  'packages/orchestrator/src/told.ts': 1,
  'packages/orchestrator/src/tool-host.ts': 3,
  'packages/orchestrator/src/tools-extension.ts': 2,
  // Moved with the reader of the extension tools' list, unchanged.
  'packages/orchestrator/src/tools-listed.ts': 1,
  'packages/orchestrator/src/tools-gate.ts': 1,
  'packages/orchestrator/src/tools-machine.ts': 1,
  'packages/orchestrator/src/tools-mcp.ts': 1,
  'packages/status/src/adoption.ts': 5,
  'packages/status/src/forges.ts': 2,
  'packages/status/src/forked.ts': 3,
  'packages/status/src/gate.ts': 2,
  'packages/status/src/processes.ts': 1,
  'packages/status/src/serve.ts': 1,
  'packages/status/src/status.ts': 2,
  'packages/status/src/tests.ts': 1,
  'packages/telemetry/src/later.ts': 1,
  'packages/telemetry/src/open.ts': 2,
  'packages/telemetry/src/sentry.ts': 2,
  'packages/telemetry/src/shape.ts': 1,
  'packages/voice/stt/src/openai.ts': 1,
  'packages/voice/stt/src/recorder.ts': 2,
  'packages/voice/stt/src/whisper.ts': 1,
  'packages/voice/tts/src/speaker.ts': 1,
  'packages/web/src/acted.ts': 1,
  'packages/web/src/asked.ts': 1,
  'packages/web/src/assets.ts': 1,
  'packages/web/src/assets/boot.js': 8,
  'packages/web/src/assets/docks.js': 2,
  'packages/web/src/assets/dom.js': 1,
  // Three of these are still the finding on tade/away-pwa-shell: `reg.update()`'s
  // catch, which says nothing whatever the update failed on, and both of
  // `forget()`'s, which cannot know that what they failed to delete is gone.
  'packages/web/src/assets/install.js': 5,
  'packages/web/src/assets/offline.js': 3,
  // Two of these are still the finding on tade/away-push-notifications:
  // `pushState` and the `registered()` it reads both turn a browser that would
  // not answer into `off`, which is not knowing drawn as an answer.
  'packages/web/src/assets/push.js': 6,
  'packages/web/src/assets/routes.js': 2,
  'packages/web/src/assets/sw.js': 1,
  'packages/web/src/configured.ts': 1,
  'packages/web/src/devices.ts': 3,
  'packages/web/src/drafted.ts': 1,
  'packages/web/src/endpoint.ts': 1,
  'packages/web/src/factory.ts': 1,
  'packages/web/src/files.ts': 2,
  'packages/web/src/peers.ts': 2,
  'packages/web/src/pushes.ts': 3,
  'packages/web/src/qr.ts': 1,
  'packages/web/src/receipts.ts': 4,
  'packages/web/src/reloading.ts': 1,
  'packages/web/src/request.ts': 2,
  'packages/web/src/server.ts': 2,
  'packages/workbench/src/authored.ts': 3,
  'packages/workbench/src/checks.ts': 1,
  'packages/workbench/src/compact.ts': 8,
  'packages/workbench/src/documents.ts': 6,
  'packages/workbench/src/driver-choice.ts': 1,
  'packages/workbench/src/event-index.ts': 1,
  'packages/workbench/src/events.ts': 14,
  'packages/workbench/src/ignore.ts': 1,
  'packages/workbench/src/intake-acts.ts': 3,
  'packages/workbench/src/intake.ts': 3,
  'packages/workbench/src/lane-liveness.ts': 2,
  'packages/workbench/src/lock.ts': 1,
  'packages/workbench/src/machine.ts': 2,
  'packages/workbench/src/memory.ts': 2,
  'packages/workbench/src/notes.ts': 2,
  'packages/workbench/src/packages.ts': 2,
  'packages/workbench/src/plans.ts': 1,
  'packages/workbench/src/prepare.ts': 4,
  'packages/workbench/src/programs.ts': 6,
  'packages/workbench/src/prove.ts': 3,
  'packages/workbench/src/queue-changes.ts': 1,
  'packages/workbench/src/races.ts': 2,
  'packages/workbench/src/registry.ts': 6,
  'packages/workbench/src/replays.ts': 2,
  'packages/workbench/src/schedules.ts': 4,
  'packages/workbench/src/task-said.ts': 1,
  'packages/workbench/src/tasks.ts': 5,
  'packages/workbench/src/templates.ts': 1,
  'packages/workbench/src/workbench.ts': 32,
  'packages/workbench/src/workers.ts': 4,
}

/** Repo-relative paths of every source file git tracks under `packages/`. */
function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => SOURCE.test(path))
}

/**
 * A file's source, or `null` when it is not on disk: four agents share this
 * checkout, and a file git tracks that nobody has is a deletion somebody has
 * not committed yet.
 */
function sourceOf(path: string): string | null {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch (problem) {
    // Only absence is a deletion; a file that could not be read is not one
    // that has nothing in it.
    if ((problem as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw problem
  }
}

/** The probes are parsed as the file they came from would be. */
const counted = (name: string, source: string): number =>
  discardsIn(name.endsWith('.js') ? 'probe.js' : 'probe.ts', source).length

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** Thrown rather than expected, so the message arrives as it was written, saying what to do. */
function report(problems: string[]): void {
  if (problems.length > 0) throw new Error(`\n\n${problems.join('\n\n')}\n`)
}

describe('a caught error is not carried on without', () => {
  it('counts every one of the mistakes it was written against', () => {
    const missed = Object.entries(MADE).filter(([name, source]) => counted(name, source) !== 1)
    expect(missed.map(([name]) => name)).toEqual([])
  })

  it('counts none of the handlers that say, look, pass it on or throw', () => {
    const counts = Object.entries(FIXED).filter(([name, source]) => counted(name, source) !== 0)
    expect(counts.map(([name]) => name)).toEqual([])
  })

  it('holds each file to the handlers it already had', () => {
    const problems: string[] = []
    for (const path of tracked()) {
      const source = sourceOf(path)
      if (source === null) continue
      const found = discardsIn(path, source)
      const allowed = ALLOWED[path] ?? 0
      if (found.length <= allowed) continue
      const where = found.map((one) => `  ${path}:${one.line}  ${one.kind}`).join('\n')
      problems.push(
        `${path} catches an error and carries on without it ${times(found.length)}, where it is allowed ${allowed}:\n${where}`,
      )
    }
    if (problems.length > 0)
      problems.push(
        'Name what was caught: say it where somebody will read it (a warning in the journal, the\n' +
          'transcript, `wire.note(err)`), look at it before deciding (`if (isMissing(err)) return null`,\n' +
          'then `throw err`), or let it throw. A failed look passed off as "nothing there" is the mistake.\n' +
          `If losing it really is the answer, raise the file's number in ALLOWED (${TABLE}) and say\n` +
          'in the commit message why nobody needs to know — that line is the conversation. Moving code\n' +
          'moves its number with it.',
      )
    report(problems)
  })

  it('keeps the numbers following the files down', () => {
    const problems: string[] = []
    for (const [path, allowed] of Object.entries(ALLOWED)) {
      const source = sourceOf(path)
      if (source === null) continue
      const found = discardsIn(path, source).length
      if (found < allowed)
        problems.push(
          `${path} carries on without ${found} caught errors, and ALLOWED (${TABLE}) still says ${allowed}.\n` +
            (found === 0 ? 'Delete its line' : `Lower it to ${found}`) +
            ' in the same commit: a number left above its file is room for the next one.',
        )
    }
    report(problems)
  })
})
