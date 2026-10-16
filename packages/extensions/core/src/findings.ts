import type { ExtensionContext, JudgeFinding, TadeExtension } from './port.ts'

// What every judge an extension runs has raised, gathered for the window.
//
// Beside the host rather than in it because it needs nothing of the host but
// the extensions that are ready and their contexts, and the host is a
// conversation already. Asked on the window's clock, so each extension is given
// a moment and one that is late or fails is left out *and said*: a desk that
// read one judge's findings and not another's must be able to say so, rather
// than draw the second judge's silence as nothing found.

/** How long one extension is given to say what its record holds. */
export const FINDINGS_TIMEOUT_MS = 3_000

/**
 * Every finding the ready extensions hold, which of them could not say, and how
 * many were asked — none asked is no judge reading anything here, which is not
 * a judge that found nothing.
 */
export async function askFindings(
  ready: readonly { extension: TadeExtension; ctx: ExtensionContext }[],
  timeoutMs = FINDINGS_TIMEOUT_MS,
): Promise<{ findings: JudgeFinding[]; problems: string[]; asked: number }> {
  const findings: JudgeFinding[] = []
  const problems: string[] = []
  const asked = ready.filter(({ extension }) => extension.findings !== undefined).length
  await Promise.all(
    ready.map(async ({ extension, ctx }) => {
      if (!extension.findings) return
      let timer: NodeJS.Timeout | undefined
      try {
        const found = await Promise.race([
          extension.findings(ctx),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('it did not answer in time')), timeoutMs)
            timer.unref?.()
          }),
        ])
        if (!Array.isArray(found)) throw new Error('it answered something that is not a list')
        findings.push(...found)
      } catch (err) {
        problems.push(`${extension.title}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (timer) clearTimeout(timer)
      }
    }),
  )
  return { findings, problems, asked }
}
