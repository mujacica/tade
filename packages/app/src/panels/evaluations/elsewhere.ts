import type { FindingThere } from '../../machine-there.ts'
import type { Machine, Machines } from '../../machines.ts'
import type { Skin } from '../../skin.ts'
import { blank, type Row } from '../../ui.ts'
import { cap, padTo } from '../cells.ts'
import type { Line } from '../frame.ts'

// The Judge tab's other machines: what each one's judge flagged about its own
// agents' changes, what the agents said back, and what somebody there decided
// (REMOTE-TADE.md §9.5: findings are about one agent's change and stay on the
// machine that made it, so they are read here, never judged here).
//
// **Counts out of verdicts, and never a rate**: this machine has no `ENOUGH` to
// hold another one's young questions to, so a question there is said as how
// often it fired and what came of it. **A probability is never a verdict**: it
// orders and counts nothing — the open ones wait oldest first — and is drawn
// grey and called the judge's, beside what it is about. Under each machine's own name, as of when it last said, so a
// page drawn while its link is down never reads as *nothing flagged*.

/** How many open findings of one machine are listed before the rest are counted. */
const OPEN_LISTED = 8

/** Every other machine's findings, under its name: none where no machine said any. */
export function judgeElsewhere(
  machines: Machines | undefined,
  at: { row: () => Row; skin: Skin; date: (at: number) => string },
): Line[] {
  const lines: Line[] = []
  for (const machine of machines?.remotes ?? []) {
    const findings = machine.detail.findings
    if (findings.length === 0 && machine.detail.findingsMore === 0) continue
    lines.push(blank(0), ...machineFindings(machine, findings, at))
  }
  return lines
}

function machineFindings(
  machine: Machine,
  findings: readonly FindingThere[],
  { row, skin, date }: { row: () => Row; skin: Skin; date: (at: number) => string },
): Line[] {
  const confirmed = findings.filter((one) => one.verdict === 'confirmed').length
  const wrong = findings.filter((one) => one.verdict === 'false positive').length
  const open = findings.filter((one) => one.verdict === null)
  const accounted = open.filter((one) => one.account !== null).length
  const stale =
    machine.link === 'live' || machine.asOf === null ? '' : `as of ${date(machine.asOf)}`
  const lines: Line[] = [
    row()
      .space()
      .text(`ON ${machine.name.toUpperCase()}`, skin.label)
      .right((r) => r.text(stale, skin.hint).space())
      .build(),
    row()
      .space()
      .text(`${findings.length} findings`, skin.you)
      .text(` · ${open.length} with no verdict`, skin.hint)
      .text(` · ${confirmed} confirmed · ${wrong} false positive`, skin.hint)
      .text(accounted > 0 ? ` · ${accounted} its agent answered` : '', skin.hint)
      .build(),
  ]
  if (machine.detail.findingsMore > 0) {
    lines.push(
      row()
        .space(3)
        .text(`and ${machine.detail.findingsMore} more ${machine.name} did not send`, skin.hint)
        .build(),
    )
  }
  lines.push(
    row()
      .space()
      .text(padTo('QUESTION', 22), skin.label)
      .space(2)
      .text('FIRED'.padStart(5), skin.label)
      .space(2)
      .text('OPEN'.padStart(4), skin.label)
      .space(2)
      .text(padTo('DECIDED', 24), skin.label)
      .build(),
  )
  const questions = [...new Set(findings.map((one) => one.question))].sort()
  for (const question of questions) {
    const mine = findings.filter((one) => one.question === question)
    const yes = mine.filter((one) => one.verdict === 'confirmed').length
    const no = mine.filter((one) => one.verdict === 'false positive').length
    lines.push(
      row()
        .space()
        .text(padTo(cap(question, 22), 22))
        .space(2)
        .text(String(mine.length).padStart(5))
        .space(2)
        .text(String(mine.length - yes - no).padStart(4), skin.hint)
        .space(2)
        .text(yes + no === 0 ? 'none yet' : `${yes} confirmed, ${no} false`, skin.hint)
        .build(),
    )
  }
  if (open.length === 0) return lines
  lines.push(blank(0), row().space().text('WAITING ON A VERDICT', skin.label).build())
  // Oldest first: how long one has waited is what a verdict is owed by.
  const oldest = [...open].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  for (const one of oldest.slice(0, OPEN_LISTED)) {
    const answered = one.account === null ? '' : ` · its agent says ${one.account.did}`
    const line = row().space(3)
    line.text(`judge ${Math.round(one.probability * 100)}%`.padEnd(11), skin.hint)
    const said = `${one.question} · ${one.file}${answered}`
    lines.push(line.text(cap(said, Math.max(4, line.width - line.used - 1))).build())
  }
  if (oldest.length > OPEN_LISTED) {
    lines.push(
      row()
        .space(3)
        .text(`and ${oldest.length - OPEN_LISTED} more`, skin.hint)
        .build(),
    )
  }
  return lines
}
