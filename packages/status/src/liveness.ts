// The port lives in core so the daemon can implement it without probes and
// daemon depending on each other.
export { type LivenessProbe, noLanes } from '@wilco/core'
