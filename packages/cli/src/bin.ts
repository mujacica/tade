#!/usr/bin/env node
import { run } from './program.ts'

process.exitCode = await run(process.argv)
