import type { ExtensionContext } from '@tade/extensions-core'
import { check, type Report } from './check.ts'
import { PUBLIC_REGISTRIES, type Registries } from './registries.ts'

// Reading a project's dependencies: which registries to ask, what to leave
// alone, and which files hold the requirements.
//
// Here rather than beside the tools because the watch reads exactly what
// `deps_check` reads. Two readers would answer differently about the same
// project the first time somebody set a mirror.

export function registries(ctx: ExtensionContext): Registries {
  const npm =
    typeof ctx.settings.registry === 'string' ? ctx.settings.registry : ctx.env.npm_config_registry
  return { ...PUBLIC_REGISTRIES, ...(npm ? { npm: npm.replace(/\/+$/, '') } : {}) }
}

export function ignored(ctx: ExtensionContext): string[] {
  return Array.isArray(ctx.settings.ignore) ? ctx.settings.ignore.map(String) : []
}

/** The files git knows about in a folder: what it tracks, and what it would. */
export async function files(ctx: ExtensionContext, root: string): Promise<string[]> {
  const listed = await ctx.exec('git', [
    '-C',
    root,
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
  if (listed.code !== 0) throw new Error(`${root} is not a git repository: ${listed.stderr.trim()}`)
  return listed.stdout.split('\0').filter((file) => file !== '')
}

export async function report(
  ctx: ExtensionContext,
  root: string,
  progress: (text: string) => void,
): Promise<{ report: Report; files: string[] }> {
  const found = await files(ctx, root)
  progress('reading manifests')
  return {
    files: found,
    report: await check({
      root,
      files: found,
      fetch: ctx.fetch,
      registries: registries(ctx),
      ignore: ignored(ctx),
      vulnerabilities: ctx.settings.vulnerabilities !== false,
      onProgress: progress,
    }),
  }
}
