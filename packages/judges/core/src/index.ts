// What a judge is. The suite every implementation must pass is a subpath
// (`@tade/judges-core/conformance`) so that importing the port does not drag a
// test runner into production code.
export * from './ask.ts'
export * from './port.ts'
