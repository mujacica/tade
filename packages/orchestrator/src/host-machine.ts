// The `ToolHost` methods behind the update and reload tools (`tools-machine.ts`):
// what is current, running the updates, and reloading the window. Their own
// file because `tool-host.ts` is at its budget, and because three methods that
// share one boundary read better in one place.
//
// **All three are the window's**, like the config: the run happens in a
// terminal the window opens and puts in front, the reload is the window's own,
// and the person's words are checked there against the journal
// (`UPDATE_REACH`, `RELOAD_REACH`) — never here, where the model's call lands.

type Handler = (params: Record<string, unknown>) => Promise<string>

/** What the window answers for them. Without a window, there is nothing to run them in. */
export interface UpdateHost {
  read(check: boolean): Promise<string>
  run(req: { which: readonly string[]; said: string }): Promise<string>
  reload(req: { said: string }): Promise<string>
}

export function machineMethods(host: () => UpdateHost | undefined): Record<string, Handler> {
  const of = (): UpdateHost => {
    const found = host()
    if (!found) throw new Error('updating and reloading are the window’s, and no window is open')
    return found
  }
  return {
    'updates/read': async (p) => of().read(p.check === true),
    'updates/run': async (p) =>
      of().run({
        which: Array.isArray(p.which) ? p.which.map((one) => String(one)) : [],
        said: String(p.said ?? ''),
      }),
    'window/reload': async (p) => of().reload({ said: String(p.said ?? '') }),
  }
}

/**
 * What each of the person's machines has, and moving this one's keys into one
 * file (`tools-machine.ts`'s `tade_machines`, `tade_env_move`): the window's,
 * which holds every machine's inventory and checks the person's words for a
 * move against the journal (`ENV_MOVE_REACH`).
 */
export interface InventoryHost {
  read(): Promise<string>
  move(req: { said: string; move: boolean }): Promise<string>
}

export function inventoryMethods(host: () => InventoryHost | undefined): Record<string, Handler> {
  const of = (): InventoryHost => {
    const found = host()
    if (!found) throw new Error('what each machine has is the window’s, and no window is open')
    return found
  }
  return {
    'machines/read': async () => of().read(),
    'machines/env-move': async (p) =>
      of().move({ said: String(p.said ?? ''), move: p.move === true }),
  }
}
