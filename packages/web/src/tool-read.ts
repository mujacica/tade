import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// One of this machine's extension tools that only reads — its Sentry issues,
// what its judge flagged — asked by another machine of the person's that links
// to it as an owner, and answered with this machine's own settings and keys
// (REMOTE-TADE.md §9.6: the VPS's Sentry token is the VPS's).
//
// **An owner's, and only at this machine's own door** (`here`): whoever holds
// the SSH key can already run this Tade's tools over the same connection — ask
// its orchestrator, or run `tade extensions run` there — and a phone's session
// is refused it however much it was granted.
//
// **Only a tool that says it reads** (`ExtensionTool.reads`, declared and never
// guessed from its name): a tool that changes something — resolving an issue,
// starting an agent on one — is not one another machine may ask for this way,
// and asking for it is answered as for a tool that is not here. The window's
// half re-asks that at the call, so a tool is never run on the strength of what
// the asking machine believed. What it answers is the tool's own text, which
// the asking machine hands its orchestrator as a tool's answer.

/** The most of one answer, in characters. */
export const TOOL_ANSWER_MOST = 200_000

/** A tool's name, as an extension's tools are named: `sentry_issues`. */
const TOOL = /^[a-z][a-z0-9_-]{0,79}$/

export const ToolAskSchema = z.strictObject({
  tool: z.string().regex(TOOL),
  input: z.record(z.string(), z.unknown()),
})
export type ToolAsk = z.infer<typeof ToolAskSchema>

/** The answer, read for its shape by the machine that asked. */
export const ToolAnswerSchema = z.object({
  /** The tool's own answer, or what it said when it failed. */
  text: z.string().max(TOOL_ANSWER_MOST),
  /** It threw: `text` is why, and the asking machine's tool throws it on. */
  failed: z.boolean(),
})
export type ToolReadAnswer = z.infer<typeof ToolAnswerSchema>

/**
 * The window's half: the tool run as an owner's, where it is one that reads —
 * or null where there is no such tool here, or it is not one that only reads.
 */
export type WebToolRead = (ask: ToolAsk, device: string) => Promise<ToolReadAnswer | null>

/** The route. `tool` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function toolHere(
  req: IncomingMessage,
  device: Device,
  tool: WebToolRead | undefined,
): Promise<{ body: ToolReadAnswer } | { refusal: Refusal }> {
  if (tool === undefined) return { refusal: refuse('no_such') }
  if (!device.owner) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const asked = ToolAskSchema.safeParse(got.body)
  if (!asked.success) return { refusal: refuse('malformed') }
  const answered = await tool(asked.data, device.id)
  if (answered === null) return { refusal: refuse('no_such') }
  return {
    body: { text: answered.text.slice(0, TOOL_ANSWER_MOST), failed: answered.failed },
  }
}
