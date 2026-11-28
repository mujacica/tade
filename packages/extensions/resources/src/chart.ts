import { diskLow, type MachineLook, room } from './machine.ts'
import { type History, megabytes, percent, type Sample, sparkline, totals } from './usage.ts'

// What Tade is using, drawn for a person: the extension's page and the
// machine's sentence. Out of `extension.ts`, which reads `ps` and the disk,
// because these only draw — and the window's golden scenarios draw them in a
// browser too (`packages/app/scripts/browser-goldens.ts`).

/**
 * The same breakdown drawn for a person: each row a bar of its share of what
 * Tade uses, CPU and memory side by side, so the heavy one is seen before it
 * is read.
 */
export function chart(
  now: Sample & { machine?: MachineLook },
  history: History,
  period: number,
): string {
  const lines = [
    `**Tade is using ${percent(now.total.cpu)} CPU and ${megabytes(now.total.rss)} of memory**, across ${now.total.processes} process${now.total.processes === 1 ? '' : 'es'}.`,
    ...(now.machine ? ['', machineSaid(now.machine)] : []),
  ]
  const sections = [
    { title: 'By project', rows: totals(now, 'project'), limit: 12 },
    { title: 'By kind', rows: totals(now, 'kind'), limit: 12 },
    { title: 'By agent and terminal', rows: totals(now, 'agent'), limit: 12 },
    { title: 'Busiest processes', rows: totals(now, 'process'), limit: 8 },
  ].filter((one) => one.rows.length > 0)
  // One column of names for the whole page, not one per section. Four little
  // tables that each measured their own widest name put their bars in four
  // different places, and nothing on the page lined up with anything else —
  // which is the first thing the eye reads and the first thing it gets wrong.
  const wide = Math.min(
    NAME,
    Math.max(
      MIN_NAME,
      ...sections.flatMap((one) => one.rows.slice(0, one.limit).map((row) => row.label.length)),
    ),
  )
  const head = `${''.padEnd(wide)}  ${'CPU'.padEnd(BARS + 7)}memory`
  for (const one of sections) {
    lines.push('', `### ${one.title}`, '', '```chart', head)
    for (const row of one.rows.slice(0, one.limit)) {
      lines.push(
        `${row.label.slice(0, wide).padEnd(wide)}  ${bar(row.cpu, now.total.cpu)} ${percent(row.cpu).padStart(5)}  ${bar(row.rss, now.total.rss)} ${megabytes(row.rss).padStart(7)}`,
      )
    }
    if (one.rows.length > one.limit) lines.push(`…and ${one.rows.length - one.limit} more`)
    lines.push('```')
  }
  const past = history.within(period)
  const summary = history.summary(period)
  if (past.length > 1) {
    lines.push(
      '',
      `### The last ${Math.round(period / 60_000)} minutes`,
      '',
      '```chart',
      `${'CPU'.padEnd(wide)}  ${sparkline(past.map((one) => one.total.cpu))}  ${percent(summary.cpu.average)} average, ${percent(summary.cpu.peak)} peak`,
      `${'memory'.padEnd(wide)}  ${sparkline(past.map((one) => one.total.rss))}  ${megabytes(summary.rss.average)} average, ${megabytes(summary.rss.peak)} peak`,
      '```',
    )
  }
  lines.push(
    '',
    `Watching costs one \`ps\` every few seconds: this one took ${Math.round(now.took)} ms${
      summary.samples > 1 ? `, ${Math.round(summary.took.average)} ms on average` : ''
    }.`,
  )
  return lines.join('\n')
}

/** How wide a bar is, and how much room a name gets: the chart's own columns. */
const BARS = 10
const NAME = 28
const MIN_NAME = 8

/** A share as ten cells: how much of the whole one row is. */
function bar(part: number, whole: number, cells = BARS): string {
  const filled = whole > 0 ? Math.round((part / whole) * cells) : 0
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

/**
 * The machine in a sentence: how busy, how loaded, how full, how much room.
 * What it could not say is said as `—`, never as nought.
 */
export function machineSaid(machine: MachineLook): string {
  const cores = machine.cores === null ? '' : ` of ${machine.cores} cores`
  const cpu = machine.cpu === null ? '—' : percent(machine.cpu)
  const load = machine.load === null ? '' : `, load ${machine.load.toFixed(2)}`
  const memory = machine.memory
    ? `${megabytes(machine.memory.used)} of ${megabytes(machine.memory.total)}`
    : '—'
  const disk = machine.disk
    ? `${room(machine.disk.free)} free of ${room(machine.disk.total)}${
        machine.disk.volumes > 1 ? ` (the fullest of ${machine.disk.volumes} volumes)` : ''
      }${diskLow(machine.disk) ? ' — **running out**' : ''}`
    : '—'
  return `**This machine:** CPU ${cpu}${cores}${load} · memory ${memory} · disk ${disk}.`
}
