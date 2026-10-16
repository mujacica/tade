import { compactedSays, documentsWaitingSays, everyDocumentSays, triagedSays } from '@tade/core'
import {
  cleanupDocuments,
  deleteDocument,
  documentsOf,
  triageDocument,
  type Workbench,
} from '@tade/workbench'

// The `ToolHost` methods behind the document tools (`tools-documents.ts`):
// list, triage, delete and clean up. Their own file because `tool-host.ts` is
// at its budget, and because four methods that share one boundary read better
// in one place.
//
// **Deliberately no way from here to read a document's contents** — it is
// opened with the orchestrator's own file tool, so what it says arrives as
// material rather than as a Tade tool's answer, which is the one voice it has
// no reason to doubt. And nothing here decides a deletion: `delete` carries a
// person's reason, and `cleanup` may only take what `documentsToCompact`
// allows, which is never a document nobody decided about.

type Handler = (params: Record<string, unknown>) => Promise<string>

export function documentMethods(tade: Workbench): Record<string, Handler> {
  return {
    'documents/list': async (p) =>
      p.all === true
        ? everyDocumentSays(await documentsOf(tade))
        : documentsWaitingSays(await documentsOf(tade), Date.now()),
    'documents/triage': async (p) =>
      triagedSays(
        await triageDocument(tade, {
          task: String(p.task ?? ''),
          path: String(p.path ?? ''),
          decided: String(p.decided ?? ''),
          by: 'orchestrator',
          // Checked against the person's own lines in the window, never here
          // in the tool: an approval is theirs (`triageDocument`).
          ...(p.approved === true ? { approved: true } : {}),
          ...(typeof p.said === 'string' ? { said: p.said } : {}),
        }),
      ),
    'documents/delete': async (p) => {
      const gone = await deleteDocument(tade, {
        task: String(p.task ?? ''),
        path: String(p.path ?? ''),
        why: String(p.why ?? ''),
        by: 'orchestrator',
      })
      return `Deleted ${gone.path}, and the journal says who asked and why.`
    },
    'documents/cleanup': async (p) =>
      compactedSays(
        await cleanupDocuments(tade, {
          keepDays: tade.config.documents.keep_days,
          apply: p.apply === true,
          by: 'orchestrator',
        }),
        p.apply === true,
      ),
  }
}
