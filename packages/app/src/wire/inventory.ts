import { homedir } from 'node:os'
import {
  driftFindings,
  ENV_MOVE_REACH,
  envMoveNamedBy,
  expiryFindings,
  findingsWritten,
  type GridColumn,
  type Inventory,
  inventoryChanges,
  inventoryFrom,
  KEYS_AND_AGENTS,
  LINES_LOOKED_BACK,
  machineGrid,
  machineLabel,
  resolveCommand,
} from '@tade/core'
import { inTime } from '@tade/web'
import {
  applyConsolidation,
  type ConsolidationPlan,
  loginShellHas,
  planConsolidation,
} from '@tade/workbench/consolidate'
import { scanEnv } from '@tade/workbench/env-scan'
import {
  inventoryHere,
  keepInventory,
  keptInventoryPath,
  machineFolder,
  namesThatMatter,
  ownInventoryPath,
  readInventory,
  type SecretDeclared,
} from '@tade/workbench/inventory'
import type { Frame } from '../frame.ts'
import {
  CANCEL,
  LOOK,
  type MachinesShown,
  MOVE,
  machineActions,
  PLAN,
} from '../panels/settings/machines.ts'
import type { PanelInputs } from '../panels.ts'
import { notify, type Subject, saidLately, type Wiring, why } from './context.ts'

// What this machine has, and what each of the person's other machines last
// said it has (`@tade/core`'s `inventory.ts`): looked at on the beat, kept,
// written to the journal as `set` or `missing` an item at a time, served to an
// owner on `/api/machine`, drawn as Settings › Machines, and folded into the
// findings worth saying once — a sign-in running out, a key that changed on
// one machine and not another.
//
// **The heart's**, so a box under `tade serve` with no screen looks too, and
// answers the Mac with what it has. The face adds the other machines it links
// to (`InventoriesDeps.remotes`); a machine that links here tells its own
// (`told`), kept in this home so a guided setup run here can walk it.
//
// **Nothing here waits on a child process.** A look is every small look at
// once, each with its own deadline and the whole under `LOOK_MS`; the answer to
// `/api/machine` is the last look, never one started for it.

/** How often this machine looks at what it has, while nothing asks sooner. */
export const AGAIN_MS = 10 * 60_000
/** How often origin is asked, which reaches the network once per project. */
export const ORIGINS_MS = 60 * 60_000
/** The most one look may take, all of it. */
export const LOOK_MS = 60_000
/** How long the harnesses are given to say how each is signed in. */
const ACCOUNTS_MS = 15_000
/** How long the files are given to be read. */
const SCAN_MS = 20_000

/** Another machine as the face holds it: what it last said it has, and when. */
export interface InventoryThere {
  name: string
  inventory: Inventory | null
  /** When it was heard, in this machine's clock; null before anything. */
  at: number | null
  /** Why it has nothing to say: an older Tade, a link that is down. */
  said: string | null
}

/** What the orchestrator's `tade_machines` and `tade_env_move` reach (`host-machine.ts`'s `InventoryHost`). */
export interface InventoryTools {
  read(): Promise<string>
  move(req: { said: string; move: boolean }): Promise<string>
}

export interface InventoriesDeps {
  /** Said with the next thing the person says to the orchestrator (`Orchestrator.note`). */
  news: (said: string) => void
  /** The machines this one links to, as the face holds them. Absent with no face. */
  remotes?: () => readonly InventoryThere[]
  /** Whether Settings is open: the Machines page is one of its categories. Absent, nobody ever looks. */
  settingsOpen?: () => boolean
  /**
   * Where each machine and this one stand, their journals, notes and settings
   * compared (`feeds.ts`): drawn under each column. Absent, nothing is said of it.
   */
  synced?: () => readonly { name: string; said: string }[]
}

/** A machine that linked here and said what it has, by its folder here. */
interface Told {
  inventory: Inventory
  at: number
}

export class Inventories implements Subject {
  private readonly wire: Wiring
  private readonly deps: InventoriesDeps
  private latestHere: Inventory | null = null
  private lookedAt = 0
  private originsAt = 0
  private looking: Promise<Inventory | null> | null = null
  /** What the journal last said of each item, read once and kept. */
  private states: Map<string, 'set' | 'missing'> | null = null
  /** The findings the journal holds, read once and kept. */
  private written: Set<string> | null = null
  /** What each machine last said, as last folded for drift: by its name. */
  private before = new Map<string, Inventory>()
  private seeded = false
  private readonly told = new Map<string, Told>()
  private plan: ConsolidationPlan | null = null
  private busy = false
  private said: string | null = null

  constructor(wire: Wiring, deps: InventoriesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** The last look at this machine, or null before the first. Never waits. */
  latest(): Inventory | null {
    return this.latestHere
  }

  /** The beat: look again where it is due. Returns at once. */
  beat(): void {
    const now = this.wire.now()
    if (this.looking === null && (this.lookedAt === 0 || now - this.lookedAt >= AGAIN_MS)) {
      void this.look()
    }
    void this.foldThere()
  }

  /**
   * Look at what this machine has, now — origin too where it is due or
   * `origins` asks. Never throws: what could not be looked at is said.
   */
  look(origins = false): Promise<Inventory | null> {
    if (this.looking) return this.looking
    this.looking = this.lookNow(origins).finally(() => {
      this.looking = null
      this.wire.draw()
    })
    this.wire.draw()
    return this.looking
  }

  private async lookNow(forceOrigins: boolean): Promise<Inventory | null> {
    const now = this.wire.now()
    this.lookedAt = now
    try {
      const config = this.wire.opts.config
      const secrets = secretsOf(this.wire)
      const mcp = Object.entries(config.mcp.servers).map(([name, one]) => {
        const { enabled, ...settings } = one
        return {
          name,
          enabled: enabled === true,
          settings,
          variables: one.key_env ? [one.key_env] : [],
        }
      })
      const projects = Object.entries(config.projects).map(([name, one]) => ({
        name,
        root: one.root,
      }))
      const askOrigins = forceOrigins || this.originsAt === 0 || now - this.originsAt >= ORIGINS_MS
      if (askOrigins) this.originsAt = now
      let unsaid = 'its harnesses did not say in time'
      const [accounts, scan, kept] = await Promise.all([
        inTime(
          this.wire.opts.client.accounts().catch((err: unknown) => {
            unsaid = `its harnesses could not say: ${why(err)}`
            return null
          }),
          ACCOUNTS_MS,
          null,
        ),
        inTime(
          scanEnv({
            homeDir: homedir(),
            projects,
            names: namesThatMatter(secrets, mcp),
            platform: process.platform,
            env: process.env,
          }).catch((err: unknown) => {
            notify(this.wire, `Where your keys are set could not be read: ${why(err)}`)
            return null
          }),
          SCAN_MS,
          null,
        ),
        this.latestHere === null
          ? readInventory(ownInventoryPath(this.wire.opts.home))
          : Promise.resolve(null),
      ])
      const inventory = await inTime(
        inventoryHere({
          config,
          machine: machineLabel(),
          now,
          env: process.env,
          accounts,
          accountsUnsaid: unsaid,
          secrets,
          mcp,
          projects,
          scan,
          askOrigins,
          origins:
            (this.latestHere ?? kept?.inventory)?.items.filter((one) => one.kind === 'origin') ??
            [],
          caddy: resolveCommand('caddy', stringEnv(process.env)) !== null,
        }),
        LOOK_MS,
        null,
      )
      if (inventory === null) {
        notify(this.wire, 'Looking at what this machine has took too long, so the last look stands')
        return this.latestHere
      }
      const previous = this.latestHere ?? kept?.inventory ?? null
      this.latestHere = inventory
      await keepInventory(ownInventoryPath(this.wire.opts.home), inventory, now).catch(
        (err: unknown) => {
          notify(this.wire, `What this machine has could not be kept in its home: ${why(err)}`)
        },
      )
      await this.writeChanges(inventory)
      if (previous !== null && !this.before.has(inventory.machine))
        this.before.set(inventory.machine, previous)
      await this.findings()
      return inventory
    } catch (err) {
      notify(this.wire, `Looking at what this machine has failed: ${why(err)}`)
      return this.latestHere
    }
  }

  /** `inventory_changed` for each item whose state is not what the journal last said. */
  private async writeChanges(inventory: Inventory): Promise<void> {
    if (this.states === null) {
      const events = await this.wire.opts.client
        .events({ types: ['inventory_changed'] })
        .catch((err: unknown) => {
          notify(
            this.wire,
            `What the journal last said this machine has could not be read: ${why(err)}`,
          )
          return []
        })
      this.states = inventoryFrom(events)
    }
    for (const change of inventoryChanges(this.states, inventory)) {
      try {
        await this.wire.opts.client.log.append({
          type: 'inventory_changed',
          detail: {
            item: change.item,
            now: change.now,
            ...(change.was === null ? {} : { was: change.was }),
          },
        })
        this.states.set(change.item, change.now)
      } catch (err) {
        notify(this.wire, `What this machine has could not be written down: ${why(err)}`)
        return
      }
    }
  }

  /** What another machine said, kept beside what it said before; drift is folded from the two. */
  private async foldThere(): Promise<void> {
    if (!this.seeded) {
      this.seeded = true
      for (const one of this.deps.remotes?.() ?? []) {
        const path = keptInventoryPath(this.wire.opts.home, one.name)
        const kept =
          path === null
            ? null
            : await readInventory(path).catch((err: unknown) => {
                notify(this.wire, `What ${one.name} last had could not be read back: ${why(err)}`)
                return null
              })
        if (kept !== null) this.before.set(one.name, kept.inventory)
      }
    }
    let moved = false
    for (const one of this.deps.remotes?.() ?? []) {
      if (one.inventory === null) continue
      const was = this.before.get(one.name)
      if (was?.at === one.inventory.at) continue
      moved = true
      const path = keptInventoryPath(this.wire.opts.home, one.name)
      if (path !== null)
        await keepInventory(path, one.inventory, one.at ?? this.wire.now()).catch((err: unknown) =>
          notify(this.wire, `What ${one.name} has could not be kept here: ${why(err)}`),
        )
    }
    if (moved) await this.findings()
  }

  /** Each machine as it stands now: this one first, then each it links to, then each that told it. */
  columns(): GridColumn[] {
    const here: GridColumn = { machine: machineLabel(), inventory: this.latestHere, asOf: null }
    const there = (this.deps.remotes?.() ?? []).map((one) => ({
      machine: one.name,
      inventory: one.inventory,
      asOf: one.at,
    }))
    const told = [...this.told].map(([name, one]) => ({
      machine: name,
      inventory: one.inventory,
      asOf: one.at,
    }))
    return [
      here,
      ...there,
      ...told.filter((one) => !there.some((each) => each.machine === one.machine)),
    ]
  }

  /** Every finding due, written once and said once. */
  private async findings(): Promise<void> {
    if (this.written === null) {
      const events = await this.wire.opts.client
        .events({ types: ['machine_finding'] })
        .catch((err: unknown) => {
          notify(this.wire, `The findings about your machines could not be read back: ${why(err)}`)
          return []
        })
      this.written = findingsWritten(events)
    }
    const columns = this.columns()
    const after = new Map<string, Inventory>()
    for (const one of columns) if (one.inventory !== null) after.set(one.machine, one.inventory)
    const found = [
      ...expiryFindings(columns, this.wire.now()),
      ...driftFindings(this.before, after),
    ]
    for (const [name, one] of after) this.before.set(name, one)
    for (const one of found) {
      if (this.written.has(one.key)) continue
      this.written.add(one.key)
      const said = one.said
      try {
        await this.wire.opts.client.log.append({
          type: 'machine_finding',
          detail: { key: one.key, kind: one.kind, machine: one.machine, item: one.item, said },
        })
      } catch (err) {
        notify(this.wire, `A finding about your machines could not be written down: ${why(err)}`)
      }
      this.deps.news(said)
      notify(this.wire, said)
    }
  }

  /** Another machine telling this one what it has (`/api/inventory`): kept in this home. */
  async heard(inventory: Inventory, device: string): Promise<boolean> {
    const name = machineFolder(inventory.machine) ?? machineFolder(device)
    if (name === null) return false
    const at = this.wire.now()
    this.told.set(name, { inventory, at })
    const path = keptInventoryPath(this.wire.opts.home, name)
    if (path === null) return false
    try {
      await keepInventory(path, inventory, at)
    } catch (err) {
      notify(this.wire, `What ${name} has could not be kept here: ${why(err)}`)
      return false
    }
    void this.findings()
    this.wire.draw()
    return true
  }

  /** What the Machines page draws, while Settings is open on it. */
  shown(): MachinesShown | null {
    if (this.latestHere === null && this.looking === null) return null
    const columns = this.columns()
    const there = this.deps.remotes?.() ?? []
    const synced = this.deps.synced?.() ?? []
    return {
      columns: columns.map((one, at) => ({
        machine: one.machine,
        asOf: one.asOf,
        here: at === 0,
        synced:
          at === 0
            ? null
            : (synced.find((each) => sameMachine(each.name, one.machine))?.said ?? null),
        said:
          one.inventory !== null
            ? null
            : at === 0
              ? 'looking…'
              : (there.find((each) => each.name === one.machine)?.said ??
                'it has not said what it has'),
      })),
      rows: machineGrid(columns, this.wire.now()),
      looking: this.looking !== null,
      plan:
        this.plan === null
          ? null
          : {
              diff: this.plan.diff,
              moved: this.plan.moved.map((one) => one.name),
              left: this.plan.left,
            },
      busy: this.busy,
      said: this.said,
      pinned: this.wire.opts.config.machine.pinned,
    }
  }

  /**
   * What the Machines page draws, while Settings is open and there is another
   * machine to compare with — a category only then, as Remotes is: a page of
   * one column says nothing a person did not know, and would be a page in
   * every picture of Settings.
   */
  panel(): Frame['panel'] {
    return this.compared() ? { inventories: this.shown() } : {}
  }

  inputs(): PanelInputs {
    return this.compared() ? { machineActions: machineActions(this.shown()) } : {}
  }

  private compared(): boolean {
    return this.deps.settingsOpen?.() === true && this.columns().length > 1
  }

  /**
   * The orchestrator's half: every machine's items by name — never a digest —
   * and moving the keys into one file, the diff on its own and the move only
   * on a line of the person's asking for it (`ENV_MOVE_REACH`), checked here
   * against the journal rather than in the tool. A refusal throws its reason.
   */
  tools(): InventoryTools {
    return {
      read: async () => {
        if (this.latestHere === null) await this.look()
        const now = this.wire.now()
        return JSON.stringify(
          {
            machines: this.columns().map((one) => ({
              machine: one.machine,
              asOf: one.asOf === null ? null : new Date(one.asOf).toISOString(),
              said: one.inventory === null ? 'it has not said what it has' : null,
              service: one.inventory?.service ?? null,
            })),
            items: machineGrid(this.columns(), now).map((row) => ({
              item: row.id,
              label: row.label,
              marks: row.cells.map(
                (cell) => `${cell.mark}${cell.days === null ? '' : ` ${cell.days}d`}`,
              ),
              here: row.cells[0]?.where ?? [],
              said: row.cells[0]?.said ?? null,
            })),
          },
          null,
          2,
        )
      },
      move: async (req) => {
        if (!req.move) {
          const plan = await this.planMove()
          if (plan === null)
            throw new Error(this.said ?? 'What moving the keys would do could not be worked out.')
          return JSON.stringify(
            { diff: plan.diff, moving: plan.moved, left: plan.left, said: KEYS_AND_AGENTS },
            null,
            2,
          )
        }
        if (req.said.trim() === '') {
          throw new Error(
            'Moving their keys is only done when they ask for it: pass what they said, word for word.',
          )
        }
        if (!envMoveNamedBy(await saidLately(this.wire, LINES_LOOKED_BACK))) {
          throw new Error(
            `Nothing they have said asks for their keys to be moved, so I will not: ${ENV_MOVE_REACH.because}.`,
          )
        }
        return this.move('orchestrator')
      },
    }
  }

  /** A press on the Machines page. Never throws: what went wrong is said on the page. */
  async action(choice: string): Promise<void> {
    if (choice === LOOK) {
      await this.look(true)
      return
    }
    if (choice === CANCEL) {
      this.plan = null
      this.said = 'Left them where they are.'
      this.wire.draw()
      return
    }
    if (choice === PLAN) {
      await this.planMove()
      return
    }
    if (choice === MOVE) await this.move('you')
  }

  /** What moving the keys would do: worked out, shown, and nothing written. */
  async planMove(): Promise<ConsolidationPlan | null> {
    if (this.busy) return this.plan
    this.busy = true
    this.said = null
    this.wire.draw()
    try {
      this.plan = await planConsolidation({
        homeDir: homedir(),
        names: namesThatMatter(secretsOf(this.wire), []),
      })
      return this.plan
    } catch (err) {
      this.said = `What moving the keys would do could not be worked out: ${why(err)}`
      return null
    } finally {
      this.busy = false
      this.wire.draw()
    }
  }

  /**
   * Move the keys as the plan shown says, verified and rolled back by
   * `applyConsolidation`, and written down whatever happened. `by` is who
   * asked: `you`, the orchestrator on the person's word, a device.
   */
  async move(by: string): Promise<string> {
    const plan = this.plan ?? (await this.planMove())
    if (plan === null) return this.said ?? 'Nothing was moved.'
    this.busy = true
    this.wire.draw()
    try {
      const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
      const done = await applyConsolidation(plan, {
        verify: (names) => loginShellHas(names, { shell, homeDir: homedir(), env: process.env }),
      })
      this.said = done.said
      if (done.outcome === 'moved' || done.outcome === 'rolled back') {
        await this.wire.opts.client.log
          .append({
            type: 'env_consolidated',
            detail: {
              by,
              names: plan.moved.map((one) => one.name).join(' '),
              files: plan.files.map((one) => one.said).join(' '),
              outcome: done.outcome,
              ...(done.why === null ? {} : { why: done.why }),
            },
          })
          .catch((err: unknown) => notify(this.wire, `The move was not written down: ${why(err)}`))
      }
      this.plan = null
      void this.look()
      return done.said
    } finally {
      this.busy = false
      this.wire.draw()
    }
  }
}

/** The keys the loaded extensions declare, as the inventory reads them. */
function secretsOf(wire: Wiring): SecretDeclared[] {
  return (wire.opts.extensions?.secrets() ?? []).map((one) => ({
    path: one.path,
    title: one.title,
    label: one.label,
    variables: one.variables,
    value: one.value,
    from: one.from,
  }))
}

/**
 * Whether a sync state's name and a column are one machine. A machine that
 * links here is a column under its folder name (`heard`), lowercased, dashed
 * and cut short, while its sync state is under what it calls itself
 * (`machineLabel`): both are compared as folders.
 */
function sameMachine(synced: string, column: string): boolean {
  const folder = (name: string) => machineFolder(name) ?? name.toLowerCase()
  return folder(synced) === folder(column)
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((one): one is [string, string] => one[1] !== undefined),
  )
}

/** Settings is open, which the Machines page is a category of. */
export function settingsOpen(panel: Wiring['state']['panel']): boolean {
  return panel?.kind === 'settings'
}
