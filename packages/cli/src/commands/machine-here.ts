import { homedir } from 'node:os'
import {
  type Config,
  defaultConfigPath,
  type Inventory,
  machineLabel,
  resolveCommand,
} from '@tade/core'
import { loadExtensions } from '@tade/orchestrator'
import { listAccounts } from '@tade/workbench/accounts'
import { type EnvScan, scanEnv } from '@tade/workbench/env-scan'
import {
  inventoryHere,
  type McpDeclared,
  namesThatMatter,
  type SecretDeclared,
} from '@tade/workbench/inventory'
import { adapterFor } from './accounts.ts'

// This machine's inventory, looked at from a shell (`tade machine`, `tade
// machine setup --from`, `tade remote add`): the same look the window takes on
// its beat (`@tade/workbench`'s `inventory.ts`), out of the config, the
// harnesses' own word and the extensions' declared keys — without opening the
// workbench, so it answers with a window open on this home or not.
//
// Every part has a deadline: a harness that will not say, extensions that will
// not load, files that will not read are each `unknown`, said, and never a
// hang.

/** How long the harnesses, the extensions and the files are each given. */
const PART_MS = 20_000

/** Settles with `instead` once `ms` have gone, or where `work` fails — which is said, as `what`. */
async function inTime<T>(work: Promise<T>, ms: number, instead: T, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work.catch((err: unknown) => {
        process.stderr.write(
          `${what} could not be read: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return instead
      }),
      new Promise<T>((done) => {
        timer = setTimeout(() => done(instead), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The keys the extensions declare and the MCP servers written, as the inventory reads them. */
export async function declaredHere(
  config: Config,
  home: string,
): Promise<{ secrets: SecretDeclared[]; mcp: McpDeclared[] }> {
  const host = await inTime(
    loadExtensions({ config, home, configPath: defaultConfigPath(), onWarning: () => {} }),
    PART_MS,
    null,
    'the extensions’ keys',
  )
  const secrets = (host?.secrets() ?? []).map((one) => ({
    path: one.path,
    title: one.title,
    label: one.label,
    variables: one.variables,
    value: one.value,
    from: one.from,
  }))
  const mcp = Object.entries(config.mcp.servers).map(([name, one]) => {
    const { enabled, ...settings } = one
    return {
      name,
      enabled: enabled === true,
      settings,
      variables: one.key_env ? [one.key_env] : [],
    }
  })
  return { secrets, mcp }
}

/** Where each key is set here: the scan the inventory reads. */
export async function scanHere(
  config: Config,
  declared: { secrets: readonly SecretDeclared[]; mcp: readonly McpDeclared[] },
): Promise<EnvScan | null> {
  return inTime(
    scanEnv({
      homeDir: homedir(),
      projects: Object.entries(config.projects).map(([name, one]) => ({ name, root: one.root })),
      names: namesThatMatter(declared.secrets, declared.mcp),
      platform: process.platform,
      env: process.env,
    }),
    PART_MS,
    null,
    'where your keys are set',
  )
}

/** This machine's inventory, now, origin asked too. */
export async function inventoryFromShell(config: Config, home: string): Promise<Inventory> {
  const declared = await declaredHere(config, home)
  const [accounts, scan] = await Promise.all([
    inTime(
      listAccounts(config, {
        adapterFor: (harness, name) => adapterFor(config, home, harness, name),
      }),
      PART_MS,
      null,
      'how each harness is signed in',
    ),
    scanHere(config, declared),
  ])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return inventoryHere({
    config,
    machine: machineLabel(),
    now: Date.now(),
    env: process.env,
    accounts,
    accountsUnsaid: 'its harnesses did not say in time',
    secrets: declared.secrets,
    mcp: declared.mcp,
    projects: Object.entries(config.projects).map(([name, one]) => ({ name, root: one.root })),
    scan,
    askOrigins: true,
    caddy: resolveCommand('caddy', env) !== null,
  })
}
