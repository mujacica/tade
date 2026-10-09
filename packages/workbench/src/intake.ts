import { hostname } from 'node:os'
import {
  type Config,
  INTAKE_SOURCES,
  INTAKE_ATTEMPTS as INTAKE_TRIES,
  type Intake,
  type IntakeCandidate,
  type IntakeGrantRead,
  type IntakeItem,
  type IntakeMode,
  type IntakeSaying,
  type IntakeSource,
  intakeAgain,
  intakeContext,
  intakeDecision,
  intakeFrom,
  intakeInputs,
  intakeItem,
  intakeKey,
  intakeMapped,
  intakeNext,
  intakeRepliesLeft,
  intakeSays,
  intakeSuffix,
  intakeSummary,
  type PlanStanding,
  planTooTight,
  readPublished,
} from '@tade/core'
import { readTaskFile } from './tasks.ts'
import { fillFor, stampTemplate, type TemplateFilled } from './templates.ts'
import type { Workbench } from './workbench.ts'

// Taking in work that came from outside this machine.
//
// **It is the existing watch and queue path and nothing else.** A source is an
// `ExtensionWatch`; the look is the schedules' look; the keys are the keys Tade
// already remembers; the work is queued work the queue starts by rule. What is
// here is the three things that path did not have and an outside request needs:
// a rule that reads the owner's grant, a record of each delivery that survives
// a crash in the middle of it, and the arithmetic of trying again.
//
// **The order of the journal lines is the design.** Nothing is made before
// `intake_received` is written, so a window that died in the middle leaves a
// delivery that is visibly unfinished rather than a request that silently never
// happened — and the key it is found again by is the *external id*, not the
// revision, because the revision's key is what the existing `seen` set burns
// and a request nobody will file twice must not be burned by one bad minute.
//
// **Which key is burned, and when.** This is the whole of the dedupe:
//
// | what happened | `watch_found` | so the next look |
// |---|---|---|
// | the rule refused it | written, with why | leaves it alone: a refusal is a final answer about that revision |
// | it was accepted and made | written, with the task | leaves it alone |
// | an older or equal revision arrived | written | leaves it alone |
// | nobody can order the revisions | written | leaves it alone, and a person answers |
// | carrying it out failed, tries left | **not written** | finds it again and tries again |
// | Tade gave up | written, with why | leaves it alone, and the giving up is a line somebody can see |

/** What a delivery came to, for whoever has to say it back. */
export interface Taken {
  /** The work made for it, or null when nothing was. */
  task: string | null
  /** Every task made, where a template made several. */
  tasks: readonly string[]
  outcome: 'ignored' | 'refused' | 'accepted' | 'adopted' | 'held' | 'waiting'
  /** Tade's own sentence about what happened, for a transcript or a tool's answer. */
  said: string
  /** Whether the finding's key may now be written down as found. */
  settled: boolean
}

/** One source's grant, read out of the config at the moment it is needed. */
export function intakeGrant(config: Config, source: IntakeSource): IntakeGrantRead {
  const intake = config.surfaces.intake
  const grant = intake.sources[source]
  return {
    path: `surfaces.intake.sources.${source}`,
    on: intake.enabled,
    accept: grant.accept,
    reply: grant.reply,
    projects: grant.projects,
    from: grant.from,
    mode: grant.mode,
    template: grant.template,
    document: grant.document,
  }
}

/** Whether a name is a source Tade implements, for a door that was handed a string. */
export function intakeSourceOf(name: string): IntakeSource | null {
  return INTAKE_SOURCES.includes(name as IntakeSource) ? (name as IntakeSource) : null
}

/** What this machine is called, for a reply that says where work was queued. */
function machine(): string {
  try {
    return hostname().split('.')[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * One delivery, from a watch's finding to work that is waiting for somebody.
 *
 * Every door into intake is this one, which is why the grant is read here and
 * not by a connector: a caller-chosen grant is no grant. The watch says what
 * arrived and who the source says asked; this says whether that may become work
 * here, and under which rule.
 */
export async function takeIntake(
  tade: Workbench,
  req: {
    /** The schedule the watch runs as, which is what the journal keys looks by. */
    schedule: string
    /** The watch, as `<extension>.<id>`, for a recheck or a reply later. */
    watch: string
    candidate: IntakeCandidate
    /** What the watch would tell an agent, for a request with no template. */
    agent: {
      title: string
      prompt: string
      context?: string
      links?: readonly { title: string; url: string }[]
    }
    /**
     * A person at this machine asked for this one again.
     *
     * It skips the retry arithmetic and nothing else: the grant is still read,
     * the revision is still compared, the names are still the source's own, and
     * a second attempt still recognises the work the first one made rather than
     * making another copy. What it does not do is refuse because a counter is
     * at three — Tade stops on its own so a failing source is not hammered
     * every look, and a person who has read why it failed is answering that
     * rather than being bound by it.
     *
     * No automatic path sets it: the watch's own look does not take it, and
     * `retryIntake` is the only caller that does.
     */
    again?: boolean
    now: number
  },
): Promise<Taken> {
  const { candidate, now } = req
  const grant = intakeGrant(tade.config, candidate.source)
  const mapped = intakeMapped(candidate.from, grant)
  const decision = intakeDecision(candidate, grant, mapped)
  const item = intakeItem(candidate)
  const where = {
    item,
    watch: req.watch,
    schedule: req.schedule,
    source: candidate.source,
    external_id: candidate.externalId,
    revision: candidate.revision,
    correlation: candidate.correlation,
    requester: candidate.requester.id,
    hash: candidate.material.hash,
    ref: candidate.material.ref,
    // Where the request is at its source, where it is anywhere a person could
    // open. Written on the line rather than looked up later for the reason the
    // template version is: by the time somebody reads the row, only the line
    // knows what the source said.
    ...(candidate.url ? { url: candidate.url } : {}),
  }

  // Not Tade's business: no mapping, or the surface is off. Nothing is written
  // down — a line per unaddressed issue per poll fills the journal with the
  // world — and the key is not burned either, because the day somebody maps
  // that repository is the day this becomes news.
  if (decision.outcome === 'ignored') {
    return {
      task: null,
      tasks: [],
      outcome: 'ignored',
      said: decision.because,
      settled: false,
    }
  }

  // Not caught: a journal that could not be read folds to an empty map, and an
  // empty map says this request has never been seen — which is how one
  // unreadable read becomes a second task for a request that already has one.
  // The caller writes the hold and the next look tries again.
  const items = intakeFrom(await tade.log.read({}))
  const already = items.get(item)

  if (decision.outcome === 'refused') {
    await tade.log.append({
      type: 'intake_refused',
      detail: {
        ...where,
        project: mapped.project ?? '',
        why: decision.why,
        because: decision.because,
      },
    })
    return {
      task: null,
      tasks: [],
      outcome: 'refused',
      said: decision.because,
      settled: true,
    }
  }

  // Non-null by the rule above: a candidate with no project is `ignored` and
  // never reaches here. Read again rather than cast, so the day somebody adds
  // an outcome this stays true or fails loudly.
  if (mapped.project === null) throw new Error(`nothing maps ${candidate.from} to a project here`)
  const project = mapped.project
  const granted = decision.granted

  // Something is already in hand for this external thing. One active intake per
  // external id: a new revision updates or holds what exists, and a comment on
  // something already taken is not intake at all. Never a second workflow —
  // which is what a key that carried the revision and nothing else would make,
  // one per edit, one per comment, one per `updated_at` bump.
  if (already && already.tasks.length > 0) {
    const again = intakeAgain(already, candidate)
    await tade.log.append({ type: 'intake_received', detail: { ...where, project } })
    if (again.again === 'ignore') {
      return {
        task: already.task,
        tasks: already.tasks,
        outcome: 'ignored',
        said: again.because,
        settled: true,
      }
    }
    const said = await invalidate(tade, already, again.because)
    await tade.log.append({
      type: 'intake_held',
      task: already.task,
      detail: { ...where, project, problem: again.because, held: again.again },
    })
    return {
      task: already.task,
      tasks: already.tasks,
      outcome: 'held',
      said: `${again.because}. ${said}`,
      settled: true,
    }
  }

  // Interrupted before, and either worth another try or not. Bounded both ways:
  // a minute at least between identical tries so a failing source is not
  // hammered every look, and a limit past which Tade stops and says so rather
  // than retrying for ever or losing the request in silence.
  const next = req.again
    ? ({ next: 'retry', attempt: (already?.attempts ?? 0) + 1 } as const)
    : intakeNext(already, now)
  if (next.next === 'wait') {
    return {
      task: null,
      tasks: [],
      outcome: 'waiting',
      said: `${candidate.externalId} failed ${already?.attempts ?? 0} time${already?.attempts === 1 ? '' : 's'} and is tried again after a minute`,
      settled: false,
    }
  }
  if (next.next === 'give up') {
    const said = `${candidate.source} ${candidate.externalId} was given up on: ${next.because}`
    await tade.log.append({
      type: 'intake_held',
      detail: { ...where, project, problem: next.because, gave_up: true },
    })
    return { task: null, tasks: [], outcome: 'held', said, settled: true }
  }

  await tade.log.append({
    type: 'intake_received',
    detail: { ...where, project, attempt: next.attempt, ...(req.again ? { again: true } : {}) },
  })

  try {
    const made = await carryOut(tade, {
      candidate,
      project,
      grant: granted.grant,
      mode: granted.mode,
      template: granted.template,
      document: grant.document,
      agent: req.agent,
      items,
    })
    await tade.log.append({
      type: 'intake_accepted',
      task: made.tasks[0] ?? null,
      detail: {
        ...where,
        project,
        grant: granted.grant,
        mode: granted.mode,
        tasks: made.tasks,
        ...(made.template ? { template: made.template.name, version: made.template.version } : {}),
        ...(made.adopted ? { adopted: true } : {}),
      },
    })
    const held =
      granted.mode === 'propose'
        ? ', parked for a person to approve'
        : ', and the queue may start it'
    return {
      task: made.tasks[0] ?? null,
      tasks: made.tasks,
      outcome: made.adopted ? 'adopted' : 'accepted',
      said: `${candidate.source} ${candidate.externalId} ${made.adopted ? 'was already made as' : 'is'} ${made.tasks.join(', ')}${held}`,
      settled: true,
    }
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err)
    await tade.log.append({
      type: 'intake_held',
      detail: { ...where, project, problem, attempt: next.attempt },
    })
    // The key is NOT settled: the next look finds this external thing again and
    // tries again, which is the difference between an intake and a watch over a
    // source that will send another one anyway.
    return {
      task: null,
      tasks: [],
      outcome: 'held',
      said: `${candidate.source} ${candidate.externalId} could not be taken in (try ${next.attempt} of ${INTAKE_TRIES}): ${problem}`,
      settled: false,
    }
  }
}

/** What carrying one delivery out produced. */
interface CarriedOut {
  tasks: string[]
  template: { name: string; version: number } | null
  /** True where the work was already there: a window that died between the two writes. */
  adopted: boolean
}

/**
 * Make the work, or recognise the work a previous attempt already made.
 *
 * **The names come first, and that is the idempotency.** Everything a delivery
 * makes is named from the source's own id, so a second attempt asks for the
 * same names — and a name that exists already is either this delivery's own
 * work from an attempt that died before it could say so, or somebody else's
 * task and a collision to say out loud. Neither answer is "make another one".
 */
async function carryOut(
  tade: Workbench,
  req: {
    candidate: IntakeCandidate
    project: string
    grant: string
    mode: IntakeMode
    template: string
    document: string
    agent: {
      title: string
      prompt: string
      context?: string
      links?: readonly { title: string; url: string }[]
    }
    items: ReadonlyMap<string, IntakeItem>
  },
): Promise<CarriedOut> {
  const { candidate, project } = req
  const suffix = intakeSuffix(candidate)
  let filled: TemplateFilled | null = null
  let names: string[]
  let envelope: Intake
  if (req.template) {
    const published = await readPublished(tade.home, req.template)
    if ('problem' in published) {
      throw new Error(`${req.grant}.template names ${req.template}: ${published.problem}`)
    }
    // The version is resolved HERE, now, and written down — never the caller's
    // wish and never "whatever the file says today": a draft moves on, and a
    // task made from one in March must not read as having come from this
    // week's shape.
    const version = published.template.version
    envelope = envelopeFor(candidate, project, req.grant, { name: req.template, version })
    const inputs = intakeInputs(envelope, published.template, req.document)
    if (!('ok' in inputs)) throw new Error(inputs.problem)
    filled = await fillFor(tade, { template: req.template, version, inputs: inputs.inputs })
    names = [...filled.names]
  } else {
    envelope = envelopeFor(candidate, project, req.grant)
    names = [`${project}/${suffix}`]
  }

  const standing = await whoseAlready(tade, names, {
    items: req.items,
    item: intakeItem(candidate),
    source: candidate.source,
  })
  if (standing === 'ours') {
    // Made before, and the line saying so never got written. Park again — it is
    // told per task and telling it twice is the same fact — and let the caller
    // write the record this time.
    if (req.mode === 'propose') for (const name of names) await tade.parkTask(name, true)
    return {
      tasks: names,
      template: filled ? { name: filled.template, version: filled.version } : null,
      adopted: true,
    }
  }

  if (filled) {
    const used = await stampTemplate(tade, filled, `intake:${candidate.source}`)
    const made = used.made.made.map((task) => task.id)
    // Parked by `stampTemplate` whatever the mode, because a template makes
    // several tasks and a plan half-started is nobody's idea of a workflow. A
    // granted `queue` lifts them here, one at a time, through the one door.
    if (req.mode === 'queue') for (const id of made) await tade.parkTask(id, false)
    return { tasks: made, template: { name: used.template, version: used.version }, adopted: false }
  }

  const made = await tade.createTask({
    project,
    slug: suffix,
    // Tade's own sentence, naming the source, the id and the handle. Never a
    // word of the body: this is the field drawn everywhere as the person's own
    // words, and `intakeSummary` cannot reach the body to put it here.
    intent: intakeSummary(envelope),
    by: `intake:${candidate.source}`,
    context: intakeContext(envelope),
    ...(candidate.url
      ? { links: [{ title: `${candidate.source} ${candidate.externalId}`, url: candidate.url }] }
      : {}),
    start: { after: [], prompt: req.agent.prompt, touches: [] },
  })
  // `propose` is the default and means a person approves it: the task is made,
  // parked, and the queue's own rule reads a park ahead of everything but a
  // merge. Approval is picking it up, which is one act, visible, reversible and
  // already in the window, the CLI, the voice grammar and the orchestrator.
  if (req.mode === 'propose') await tade.parkTask(made.id, true)
  return { tasks: [made.id], template: null, adopted: false }
}

/**
 * The envelope, once the three things only this machine can say are filled in:
 * the project, the key that mapped it, and the grant that allowed it.
 *
 * A connector never sees this function, which is the point: `IntakeCandidate`
 * is what a watch returns and it has no `grant` and no `template` field at all,
 * so there is no shape in which one could ask for either.
 */
function envelopeFor(
  candidate: IntakeCandidate,
  project: string,
  grant: string,
  template?: { name: string; version: number },
): Intake {
  const { from, ...rest } = candidate
  return {
    ...rest,
    project,
    mapping: { from, by: `${grant}.projects` },
    grant,
    ...(template ? { template } : {}),
  }
}

/**
 * Whether the tasks a delivery would make are already there, and whose.
 *
 * `none` is the ordinary case. `ours` is a window that died between making the
 * work and writing down that it had — recognised rather than repeated. Anything
 * else throws with the collision named, because a task somebody else made that
 * happens to have the name this request would use is exactly the case where
 * quietly carrying on means two requests sharing one agent's conversation.
 */
async function whoseAlready(
  tade: Workbench,
  names: readonly string[],
  req: { items: ReadonlyMap<string, IntakeItem>; item: string; source: IntakeSource },
): Promise<'none' | 'ours'> {
  const there: { name: string; by: string }[] = []
  for (const name of names) {
    const file = await readTaskFile(tade.home, name).catch(() => null)
    if (file) there.push({ name, by: String(file.by ?? '') })
  }
  if (there.length === 0) return 'none'
  const found = there.map((one) => one.name)
  const claimed = [...req.items.values()].filter(
    (one) => one.item !== req.item && one.tasks.some((task) => found.includes(task)),
  )
  if (claimed.length > 0) {
    throw new Error(
      `${found.join(', ')} already belongs to ${claimed.map((one) => one.item).join(', ')}: two requests would share one agent's conversation`,
    )
  }
  // This source's own, exactly — not merely "some intake made it". Two sources
  // whose ids slugify to one name is rare and is the case where carrying on
  // quietly means two requests sharing one agent's conversation, which is the
  // thing a task name is never used twice to prevent.
  if (there.some((one) => one.by !== `intake:${req.source}`)) {
    throw new Error(
      `${found.join(', ')} is already a task that did not come from ${req.source} intake: pick the name apart before this request can be taken in`,
    )
  }
  if (there.length !== names.length) {
    throw new Error(
      `${found.join(', ')} ${there.length === 1 ? 'exists' : 'exist'} and ${names.filter((name) => !found.includes(name)).join(', ')} ${names.length - there.length === 1 ? 'does' : 'do'} not: a half-made workflow is a person's to finish or remove`,
    )
  }
  return 'ours'
}

/**
 * What a newer revision does to work already in hand: the approval goes.
 *
 * **It never stops a running agent.** A rule that killed agents on an outside
 * signal is a remote kill switch, which is on the list of things not to build —
 * so a task whose agent is working is written down and said, and the person
 * decides. What has not started is parked again, which puts back exactly the
 * hold their approval lifted.
 */
async function invalidate(tade: Workbench, already: IntakeItem, because: string): Promise<string> {
  const running = new Set(tade.runs().map((run) => run.task))
  const parked: string[] = []
  const working: string[] = []
  const stuck: string[] = []
  for (const task of already.tasks) {
    if (running.has(task)) {
      working.push(task)
      continue
    }
    try {
      // Not swallowed: putting the hold back is the whole of what invalidating
      // an approval *is*, and a park that quietly failed leaves a task the
      // queue will start on words nobody approved.
      await tade.parkTask(task, true)
      await tade.holdQueued(task, because, { start: 'failed' })
      parked.push(task)
    } catch (err) {
      stuck.push(`${task} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  const said: string[] = []
  if (parked.length > 0) said.push(`${parked.join(', ')} is parked again`)
  if (stuck.length > 0) {
    said.push(`${stuck.join('; ')} could NOT be parked again and may still start`)
  }
  if (working.length > 0) {
    said.push(
      `${working.join(', ')} is already working and was not stopped: nothing outside this machine stops an agent`,
    )
  }
  return said.join('; ')
}

/**
 * Say one status back to a source, where the owner granted that for it.
 *
 * Three gates, every one of them here rather than in a connector: the grant,
 * the cap, and the fixed sentence. A connector's `reply` is only the transport —
 * it never chooses what is said, and it is never reached at all while `reply` is
 * off, which is the default and is a separate act from accepting work.
 */
export async function sayBackAbout(
  tade: Workbench,
  req: {
    source: IntakeSource
    candidate: Pick<IntakeCandidate, 'externalId' | 'revision' | 'correlation'>
    saying: IntakeSaying
    task: string | null
    now: number
    /** The one thing that actually posts: the host's door to that watch's `reply`. */
    post: (request: { key: string; say: string }) => Promise<void>
  },
): Promise<{ said: string | null; because: string | null }> {
  const grant = intakeGrant(tade.config, req.source)
  if (!grant.on || !grant.reply) {
    return { said: null, because: `${grant.path}.reply is off: nothing is posted anywhere` }
  }
  const item = intakeItem({ source: req.source, externalId: req.candidate.externalId })
  // Not caught, for the reason above: unread would read as "nothing said yet",
  // which is the one answer that lets the cap be passed.
  const items = intakeFrom(await tade.log.read({}))
  const left = intakeRepliesLeft(items.get(item), req.now)
  if (left <= 0) {
    return {
      said: null,
      because: `enough has already been said back about ${req.candidate.externalId} today`,
    }
  }
  const say = intakeSays(req.saying, { task: req.task, machine: machine() })
  await req.post({ key: intakeKey({ ...req.candidate, source: req.source }), say })
  await tade.log.append({
    type: 'intake_replied',
    task: req.task,
    detail: {
      item,
      source: req.source,
      external_id: req.candidate.externalId,
      correlation: req.candidate.correlation,
      saying: req.saying,
      // The sentence itself, because it is Tade's own and the record of what
      // left this machine is the point. Never an agent's words — there is no
      // path by which one could get here.
      said: say,
    },
  })
  return { said: say, because: null }
}

/**
 * Whether an intake-originated start may go ahead now, asked at the moment the
 * queue would start it — and it may only ever hold.
 *
 * The precedent is `lookAtTrees`: what was true when the work was planned is
 * read again at the moment of starting, because that is the moment it is true.
 * Three things are asked, in the order they are cheap:
 *
 * 1. **The grant, as the config says it now.** Turned off, or the project taken
 *    off its list, since the request was accepted — the work does not start, and
 *    the hold names the key. A grant is permission at the moment of acting, not
 *    a permission granted once in the past.
 * 2. **The plan.** `planTooTight` holds a start that would spend what is left
 *    of a subscription window on somebody else's request — and holds it when
 *    nobody can say how full that window is, because unknown is not zero.
 * 3. **The source.** The watch is asked whether the request still stands.
 *    Closed, reassigned, relabelled or rewritten holds it. So does a source
 *    nobody can reach: an inaccessible source is never permission, which is the
 *    one direction this must get right.
 */
export async function intakeStands(req: {
  config: Config
  item: IntakeItem
  task: string
  /** Every account's plan standing, as the window already folds them. */
  plans: readonly PlanStanding[]
  /** The host's door to that watch's `recheck`. Throwing is a hold. */
  recheck: (key: string) => Promise<{ still: boolean; because?: string }>
}): Promise<{ because: string } | null> {
  const source = intakeSourceOf(req.item.source)
  if (!source) {
    return { because: `${req.item.source} is not a source Tade implements any more` }
  }
  const grant = intakeGrant(req.config, source)
  if (!grant.on) return { because: 'surfaces.intake.enabled is off' }
  if (!grant.accept) return { because: `${grant.path}.accept is off` }
  if (!grant.projects.includes(req.item.project)) {
    return { because: `${grant.path}.projects no longer lists ${req.item.project}` }
  }
  if (req.item.requester && !grant.from.includes(req.item.requester)) {
    return { because: `${grant.path}.from no longer lists @${req.item.requester}` }
  }
  const tight = planTooTight(req.plans)
  if (tight) return tight
  const key = intakeKey({
    source,
    externalId: req.item.externalId,
    revision: req.item.taken || req.item.revision,
  })
  try {
    const answer = await req.recheck(key)
    if (!answer.still) {
      return { because: answer.because ?? `${req.item.externalId} no longer stands at its source` }
    }
  } catch (err) {
    // A source that could not be asked has not said yes. This is the whole of
    // "inaccessible holds rather than assumes permission", and it is why the
    // throw is not swallowed into a shrug.
    const why = err instanceof Error ? err.message : String(err)
    return { because: `${req.item.externalId} could not be checked at its source: ${why}` }
  }
  return null
}
