import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BACKUP_HOLDS_KEYS,
  BACKUP_SERVICE,
  BACKUP_START,
  BACKUP_TIMER,
  BackupConfigSchema,
  BRANCHES_ARE_THE_WORK,
  backupUnits,
  bytesSaid,
  type Config,
  KEEP_THE_PASSWORD,
  passwordFor,
  type RunResult,
  shownRepository,
} from '@tade/core'
import {
  type BackupPlace,
  type BackupTaken,
  backUp,
  initRepository,
  type NotPushed,
  notPushed,
  type Restic,
  type Restored,
  recordsHere,
  restoreInto,
  restoreTo,
  snapshotsIn,
} from '@tade/workbench/backup'
import { serviceUnitPath } from '@tade/workbench/machine'
import { type Unrecorded, writeFromShell } from '../config-write.ts'
import { Exit } from '../io.ts'
import type { Asker } from './host-service.ts'

// `tade host backup` and `tade host restore`: this machine's Tade kept
// somewhere else, encrypted, and put back. What is kept and why is
// `@tade/core`'s `backup.ts`, and running restic is `@tade/workbench/backup`;
// here is the asking and the saying, each step taking what it needs as an
// argument, so a test drives it against a real restic and real files.
//
// **What a backup says is standard output and what is happening is standard
// error**, as `tade host service` splits them: under its timer the report is
// the unit's log, and a person running it sees restic going.

/** What every step here is handed. */
export interface BackupDeps {
  ask: Asker
  /** Whether somebody is there to answer a question: both a terminal, and no `--json`. */
  asking: boolean
  place: BackupPlace
  configPath: string
  out: (line: string) => void
  /** The pid holding the home, where something does (`heldBy`). */
  held: () => Promise<number | null>
  unrecorded: Unrecorded
}

/** A path as it is said: the home folder as `~`. */
function tilde(path: string, home = process.env.HOME ?? ''): string {
  return home !== '' && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path
}

/** Work that is on this machine alone, a line each. */
export function notPushedLines(found: readonly NotPushed[]): string[] {
  return found.map((one) => {
    const what = [
      one.ahead === null ? null : one.ahead > 0 ? `${one.ahead} commits on no remote` : null,
      one.changed ? 'changes not committed' : null,
    ].filter(Boolean)
    return `▲ ${one.project}: ${tilde(one.path)}${one.branch ? ` (${one.branch})` : ''} — ${what.join(', ')}`
  })
}

/** What one backup came to, as its report says it. */
export function takenLines(taken: BackupTaken): string[] {
  const summary = taken.summary
  if (!taken.ok || summary === null) return [`✗ no backup: ${taken.said}`]
  const out = [
    `✓ snapshot ${summary.snapshot}: ${summary.filesNew} new, ${summary.filesChanged} changed, ` +
      `${summary.filesUnmodified} unchanged — ${bytesSaid(summary.bytesAdded)} sent of ` +
      `${bytesSaid(summary.bytesProcessed)} read, in ${Math.round(summary.seconds)} s`,
  ]
  if (taken.errors.length > 0) {
    out.push(`▲ ${taken.errors.length} could not be read, so are not in it:`)
    for (const one of taken.errors.slice(0, 5)) out.push(`    ${tilde(one.item)}: ${one.said}`)
    if (taken.errors.length > 5) out.push(`    and ${taken.errors.length - 5} more`)
  }
  return out
}

/** Take one backup: what it reads, restic's run, what it came to, and what it does not hold. */
export async function takeBackup(deps: BackupDeps, json: boolean): Promise<number> {
  const { place } = deps
  const repository = place.config.backup.repository.trim()
  if (repository === '') {
    deps.ask.say(
      'There is nowhere to back up to: `tade host backup --init <repository>` names one — a folder, `sftp:user@host:/path`, `s3:…` — and makes its password.',
    )
    return Exit.invalidInput
  }
  const records = await recordsHere(place)
  const password = passwordFor(place.env ?? process.env, place.config.backup.password)
  deps.ask.say(
    `Backing up ${tilde(place.home)}${records.length > 0 ? ` and ${records.length} harness folder${records.length === 1 ? '' : 's'}` : ''} to ${shownRepository(repository)}${password ? ` (its password from ${password.from})` : ''}`,
  )
  for (const one of records) {
    deps.ask.say(`  ${tilde(one.path)} — ${one.harness}${one.user ? ` as ${one.user}` : ''}`)
  }
  const [taken, alone] = await Promise.all([backUp(place), notPushed(place.config)])
  if (json) {
    deps.out(JSON.stringify({ ...taken, notPushed: alone }, null, 2))
  } else {
    for (const line of takenLines(taken)) deps.out(line)
    if (alone.length > 0) {
      deps.out('Not pushed anywhere, so on this machine alone:')
      for (const line of notPushedLines(alone)) deps.out(`  ${line}`)
    }
    if (taken.ok) deps.out(BRANCHES_ARE_THE_WORK)
  }
  return taken.ok && taken.errors.length === 0 ? Exit.ok : Exit.error
}

/** A password made here: 32 random bytes, as text a person can copy without a character to misread. */
export function mintPassword(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Name where backups go, make its password where none is set, and make the
 * repository there. The password is printed once, on standard output, and
 * what it is every time — the rule for a credential a command mints.
 */
export async function initBackup(
  deps: BackupDeps,
  repository: string,
  mint: () => string = mintPassword,
): Promise<number> {
  const given = repository.trim()
  const checked = BackupConfigSchema.safeParse({ repository: given })
  if (given === '' || !checked.success) {
    deps.ask.say(
      `${JSON.stringify(given)} is not a repository: a folder, sftp:user@host:/path, s3:…, rest:…`,
    )
    return Exit.invalidInput
  }
  const env = deps.place.env ?? process.env
  const was = deps.place.config.backup
  const kept = passwordFor(env, was.password)
  const minted = kept === null ? mint() : null
  const writes = [
    ...(was.repository === given ? [] : [{ key: 'backup.repository', value: given }]),
    ...(minted === null ? [] : [{ key: 'backup.password', value: minted, secret: true }]),
  ]
  if (writes.length > 0) {
    mkdirSync(dirname(deps.configPath), { recursive: true })
    await writeFromShell(deps.configPath, writes, deps.unrecorded)
  }
  if (was.repository !== '' && was.repository !== given) {
    deps.ask.say(
      `backup.repository is ${shownRepository(given)} now, in place of ${shownRepository(was.repository)}`,
    )
  }
  const config: Config = {
    ...deps.place.config,
    backup: { repository: given, password: minted ?? was.password },
  }
  const made = await initRepository({ ...deps.place, config })
  if (!made.ok) {
    // One that is there already is made, if this password opens it.
    const opened = await snapshotsIn({ ...deps.place, config })
    if (!opened.ok) {
      deps.ask.say(`✗ ${shownRepository(given)} could not be made: ${made.said}`)
      if (minted !== null) say(deps, minted)
      return Exit.error
    }
    deps.ask.say(`${shownRepository(given)} is a repository already, and this password opens it.`)
  } else {
    deps.ask.say(`Made ${shownRepository(given)}.`)
  }
  if (minted !== null) say(deps, minted)
  else deps.ask.say(`Its password is the one from ${kept?.from ?? 'the config'}.`)
  deps.ask.say(BACKUP_HOLDS_KEYS)
  deps.ask.say('`tade host backup` takes one now; `tade host backup --timer` takes one every hour.')
  return Exit.ok
}

/** The minted password, once, where a person can copy it, with what it is. */
function say(deps: BackupDeps, minted: string): void {
  deps.out(minted)
  deps.ask.say(`That is the backup’s password, written as backup.password. ${KEEP_THE_PASSWORD}`)
}

/** The snapshots there, newest first. */
export async function listBackups(deps: BackupDeps, json: boolean): Promise<number> {
  const listed = await snapshotsIn(deps.place)
  if (!listed.ok) {
    deps.ask.say(`✗ ${listed.said}`)
    return Exit.error
  }
  if (json) {
    deps.out(JSON.stringify(listed.snapshots, null, 2))
    return Exit.ok
  }
  if (listed.snapshots.length === 0) deps.out('No backups there yet: `tade host backup` takes one.')
  for (const one of listed.snapshots) {
    deps.out(`${one.id}  ${new Date(one.at).toLocaleString()}  ${one.machine}`)
  }
  return Exit.ok
}

/** What a restore came to, as its report says it. */
export function restoredLines(restored: Restored, home: string): string[] {
  if (!restored.ok) {
    return [
      `✗ not restored: ${restored.said}`,
      ...(restored.staging ? [`  what restic put back is in ${restored.staging}`] : []),
    ]
  }
  const manifest = restored.manifest
  const out = [
    `✓ restored ${tilde(home)}${manifest ? `, as ${manifest.machine} had it at ${manifest.at} under Tade ${manifest.tade}` : ''}`,
  ]
  if (restored.movedAside) out.push(`  what was there is at ${tilde(restored.movedAside)}`)
  for (const one of restored.records) {
    const who = `${one.harness}${one.user ? ` as ${one.user}` : ''}`
    if (one.to === null) {
      out.push(`▲ ${who}’s conversations stayed where restic put them: ${one.why ?? 'not placed'}`)
    } else {
      const left = one.left > 0 ? `, leaving ${one.left} this machine already had` : ''
      out.push(`  ${who}’s conversations into ${tilde(one.to)}${left}`)
    }
  }
  const unplaceable = manifest?.unplaceable ?? 0
  if (unplaceable > 0) {
    out.push(
      `▲ ${unplaceable} of the folders its manifest named had a path that leads somewhere else (a \`..\`, or not absolute), so nothing was looked for there`,
    )
  }
  for (const one of restored.cut) {
    out.push(`  cut a torn last line (${one.bytes} bytes) off ${tilde(one.path)}`)
  }
  if (restored.links.length > 0) {
    out.push(
      `▲ ${restored.links.length} links it held were not put back, since a link may point anywhere:`,
    )
    for (const one of restored.links.slice(0, 5)) out.push(`    ${tilde(one)}`)
    if (restored.links.length > 5) out.push(`    and ${restored.links.length - 5} more`)
  }
  if (restored.staging) out.push(`▲ not placed, and left in ${restored.staging}`)
  if (restored.missing.length > 0) {
    out.push('Projects whose checkout is not on this machine:')
    for (const one of restored.missing) {
      out.push(
        one.remote
          ? `  git clone ${one.remote} ${one.root}`
          : `  ${one.name}: ${one.root}, which had no remote — its work was on the old machine alone`,
      )
    }
  }
  out.push(BRANCHES_ARE_THE_WORK)
  out.push('Then `tade setup --check` looks at this machine, and Tade opens on what was kept.')
  return out
}

/**
 * Put a snapshot back: into the home in place, on a press, where nothing
 * holds it and it has no journal yet — or, with `to`, under a folder to look
 * at, which moves nothing.
 */
export async function restoreBackup(
  deps: BackupDeps,
  snapshot: string,
  opts: { to?: string; yes: boolean },
): Promise<number> {
  const repository = deps.place.config.backup.repository
  if (repository.trim() === '') {
    deps.ask.say(
      'Restore from where? `--from <repository>`, with its password in $RESTIC_PASSWORD, or set backup.repository.',
    )
    return Exit.invalidInput
  }
  if (opts.to !== undefined) {
    const done = await restoreTo(deps.place, snapshot, opts.to)
    if (!done.ok) {
      deps.out(`✗ not restored: ${done.said}`)
      return Exit.error
    }
    deps.out(`✓ ${snapshot} is under ${opts.to}, laid out as it was on the machine it came from`)
    return Exit.ok
  }
  const held = await deps.held()
  if (!opts.yes) {
    if (!deps.asking) {
      deps.ask.say(
        `Restoring puts ${snapshot} back as this machine’s Tade, at ${deps.place.home}: \`--yes\` to do it without asking.`,
      )
      return Exit.invalidInput
    }
    const where = existsSync(deps.place.home) ? ', moving what is there aside' : ''
    if (!(await deps.ask.confirm(`Restore ${snapshot} into ${deps.place.home}${where}?`, false))) {
      deps.ask.say('  not restored')
      return Exit.ok
    }
  }
  const restored = await restoreInto(deps.place, snapshot, { held })
  for (const line of restoredLines(restored, deps.place.home)) deps.out(line)
  return restored.ok ? Exit.ok : Exit.error
}

/** The two units for this Tade, with where each goes. */
export function timerHere(
  env: NodeJS.ProcessEnv,
  bin: string,
): { service: { path: string; text: string }; timer: { path: string; text: string } } {
  const lang = env.LANG && /utf-?8/i.test(env.LANG) ? env.LANG : 'C.UTF-8'
  const units = backupUnits({
    tade: [process.execPath, bin],
    path: env.PATH ?? '',
    home: env.TADE_HOME ?? null,
    lang,
  })
  const folder = dirname(serviceUnitPath(env))
  return {
    service: { path: join(folder, BACKUP_SERVICE), text: units.service },
    timer: { path: join(folder, BACKUP_TIMER), text: units.timer },
  }
}

/**
 * The hourly timer: both units printed whole, written on a press (or
 * `write`), and started on another. Only where a repository is named — a
 * timer that fails every hour is noise — and only written where systemd runs
 * this machine.
 */
export async function offerTimer(
  deps: BackupDeps,
  units: ReturnType<typeof timerHere>,
  opts: { write: boolean; systemd: boolean },
): Promise<number> {
  for (const unit of [units.service, units.timer]) {
    deps.out(`# ${unit.path}`)
    deps.out(unit.text.trimEnd())
    deps.out('')
  }
  if (!opts.systemd) {
    deps.ask.say('systemd does not run this machine, so nothing here would start these: they are')
    deps.ask.say('for a Linux server. Here, run `tade host backup` hourly from cron or launchd.')
    return opts.write ? Exit.error : Exit.ok
  }
  if (deps.place.config.backup.repository.trim() === '') {
    deps.ask.say('Name where backups go first: `tade host backup --init <repository>`.')
    return Exit.invalidInput
  }
  const same = [units.service, units.timer].every(
    (unit) => existsSync(unit.path) && readFileSync(unit.path, 'utf8') === unit.text,
  )
  if (!same) {
    if (!opts.write && !deps.asking) {
      deps.ask.say('`tade host backup --timer --write` writes them.')
      return Exit.ok
    }
    if (
      !(opts.write || (await deps.ask.confirm(`write them to ${dirname(units.timer.path)}?`, true)))
    ) {
      deps.ask.say('  not written')
      return Exit.ok
    }
    mkdirSync(dirname(units.timer.path), { recursive: true })
    for (const unit of [units.service, units.timer]) writeFileSync(unit.path, unit.text)
    deps.ask.say(`  written to ${dirname(units.timer.path)}`)
  } else {
    deps.ask.say(`  ${dirname(units.timer.path)} already says this`)
  }
  if (opts.write || !(await deps.ask.confirm('start the timer now, and at every boot?', true))) {
    deps.ask.say(`  to start it, now and at every boot: \`${BACKUP_START}\``)
  } else if ((await deps.ask.run(BACKUP_START, '/bin/sh', ['-c', BACKUP_START])) !== 0) {
    deps.ask.say(`  that did not work — \`journalctl --user -u ${BACKUP_TIMER}\` says why`)
    return Exit.error
  } else {
    deps.ask.say(
      `  started — \`systemctl --user list-timers ${BACKUP_TIMER}\` says when it runs next`,
    )
  }
  return Exit.ok
}

/** How often restic's progress is said, at most: a terminal is not a log. */
const PROGRESS_MS = 2_000

/**
 * restic in this terminal: its standard input this one's, so it can ask for a
 * password where none is set; what it says on standard error passed on as it
 * says it; and its `--json` progress drawn on one line where standard error is
 * a terminal. A child of this process and not of its own group, so ctrl+c
 * reaches it as it reaches Tade.
 */
export function resticHere(err: NodeJS.WriteStream = process.stderr): Restic {
  return (args, env) =>
    new Promise<RunResult>((resolve) => {
      const child = spawn('restic', args, {
        env: { ...process.env, ...env },
        stdio: ['inherit', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let pending = ''
      let saidAt = 0
      let drawn = false
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stdout += text
        pending += text
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (!err.isTTY || !line.includes('"message_type":"status"')) continue
          const now = Date.now()
          if (now - saidAt < PROGRESS_MS) continue
          saidAt = now
          try {
            const status = JSON.parse(line) as { percent_done?: number; total_bytes?: number }
            const percent = Math.round((status.percent_done ?? 0) * 100)
            const total = status.total_bytes ? ` of ${bytesSaid(status.total_bytes)}` : ''
            err.write(`\r  ${percent}%${total}   `)
            drawn = true
          } catch (cause) {
            // A line it cut short: the next one says the same.
            if (!(cause instanceof SyntaxError)) throw cause
          }
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderr = (stderr + text).slice(-16_384)
        if (drawn) err.write('\n')
        drawn = false
        err.write(text)
      })
      child.on('error', (cause: NodeJS.ErrnoException) =>
        resolve({
          code: 127,
          stdout,
          stderr: cause.message,
          timedOut: false,
          missing: cause.code === 'ENOENT',
        }),
      )
      child.on('close', (code, signal) => {
        if (drawn) err.write('\n')
        resolve({
          code: code ?? (signal ? 128 + 2 : 1),
          stdout,
          stderr,
          timedOut: false,
          missing: false,
        })
      })
    })
}
