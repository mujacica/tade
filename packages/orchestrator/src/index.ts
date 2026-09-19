// The tools extension is deliberately not exported: pi loads it from disk, and
// importing it here would pull agent-side code into the window's process.
export { type BriefingInput, composeBriefing } from './briefing.ts'
export {
  activeExtensions,
  activeSkills,
  BUILTIN_EXTENSIONS,
  decideProposal,
  extensionWorkbench,
  loadExtensions,
  orchestratorExtensions,
  type Proposal,
  proposedExtensions,
  proposedSkills,
  workbenchExtensions,
  writeToolList,
} from './extensions.ts'
export * from './orchestrator.ts'
export * from './tool-host.ts'
