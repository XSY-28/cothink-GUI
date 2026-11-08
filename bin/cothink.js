#!/usr/bin/env node
import { runEntrypoint } from '../src/project-handoff.js';
process.exitCode = await runEntrypoint();
