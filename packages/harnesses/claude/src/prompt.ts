import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { answerPrompt, type PromptAnswer, type ToolEffect } from '../../../core/src/policy.ts'

// Claude Code's own yes/no, answered by rule.
//
// Launched to bypass its permissions, Claude Code still stops on a few things
// — a write into `.git` or `.claude`, a command it rates dangerous — and waits
// for somebody to press y in a lane nobody may be looking at. Its
// `PermissionRequest` hook is asked first, so Tade answers there by the rule
// in core (`answerPrompt`): the window when it can be asked, the hook itself
// when it cannot, and the same answer either way.
//
// Loaded by Claude Code's own processes, like `ask.ts`: Node's built-ins, and
// the one file of core's that imports nothing else (its test holds it), by
// path — a workspace import would not resolve there.

/** Claude Code's tools by what they do. Anything unknown is judged as unknown. */
export function effectOfTool(tool: string): ToolEffect {
  switch (tool) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'NotebookRead':
      return 'read'
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'write'
    case 'Bash':
      return 'exec'
    default:
      return 'other'
  }
}

/** Where the lane tells its hooks the task works, set at launch. */
export const WORKSPACE_ENV = 'TADE_CLAUDE_WORKSPACE'

/**
 * Where an agent may change things without asking: its workspace, then its
 * repository's git folder. A worktree's `.git` is a file naming a folder under
 * the repository's own, which is where its hooks are; read from the files
 * rather than asked of git, so nothing is spawned to answer.
 */
export async function rootsOf(workspace: string): Promise<string[]> {
  const roots = [workspace]
  const dotGit = resolve(workspace, '.git')
  const pointer = await readFile(dotGit, 'utf8').catch(absent)
  const named = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim() : undefined
  if (!named) return roots
  const gitDir = isAbsolute(named) ? named : resolve(workspace, named)
  const common = await readFile(resolve(gitDir, 'commondir'), 'utf8').catch(absent)
  roots.push(common ? resolve(gitDir, common.trim()) : gitDir)
  return roots
}

/**
 * The harness's own scratch and temporary folders, which count as the agent's:
 * `$TMPDIR` — this process's and the lane's, which a window and its agent may
 * not share — and Claude Code's scratchpads under `/tmp/claude-*`. Each also
 * as macOS spells it under `/private`, since a path is judged as written.
 */
export function scratchPlaces(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const places = new Set(['/tmp/claude-*', '/private/tmp/claude-*'])
  for (const one of [tmpdir(), env.TMPDIR]) {
    const dir = one?.replace(/\/+$/, '')
    if (!dir || !isAbsolute(dir)) continue
    places.add(dir)
    if (dir.startsWith('/private/')) places.add(dir.slice('/private'.length))
    else if (/^\/(var|tmp)\//.test(dir)) places.add(`/private${dir}`)
  }
  return [...places]
}

/**
 * Whether a `PermissionRequest` is a prompt Claude Code is putting to a person,
 * rather than its earlier look that only lets a hook refuse a call it may then
 * run unasked under bypass. 2.1.326 hands the prompt it builds its
 * suggestions (`permission_suggestions`, a list) and that look none. Only the
 * prompt is answered: refusing the look refused work that had always run.
 */
export function isPrompt(event: Readonly<Record<string, unknown>>): boolean {
  return (
    event.hook_event_name === 'PermissionRequest' && Array.isArray(event.permission_suggestions)
  )
}

/**
 * Tade's answer for the tool a prompt asks about, in `workspace`, asked from
 * `cwd` — where the agent stands, which a relative path is read against.
 */
export async function answerFor(
  tool: string,
  input: unknown,
  workspace: string,
  cwd: string | null = null,
): Promise<PromptAnswer> {
  return answerPrompt({
    tool,
    input,
    effect: effectOfTool(tool),
    roots: await rootsOf(workspace),
    scratch: scratchPlaces(),
    cwd,
    home: homedir(),
  })
}

/**
 * The hook's answer as Claude Code reads it (2.1.326's `PermissionRequest`
 * output): allow, or deny with a message the agent reads in place of the
 * tool's result — so it finds another way, or asks, rather than retrying.
 */
export function promptOutput(answer: PromptAnswer): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: answer.allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: refusalMessage(answer) },
    },
  }
}

/** What an agent reads when its own permission prompt was refused by rule. */
export function refusalMessage(answer: PromptAnswer): string {
  return `Tade answered this permission prompt by rule and refused it, because ${answer.reason}. Nobody was asked. Do it another way inside your own workspace, or say in your reply what you need and why, so the person can do it.`
}

/**
 * A file that is not there, or a `.git` that is a folder rather than a
 * worktree's pointer: no pointer to follow. Anything else is a look that
 * failed, and is thrown rather than taken for nothing there.
 */
function absent(err: unknown): null {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
  throw err
}
