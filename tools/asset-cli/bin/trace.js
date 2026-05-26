#!/usr/bin/env node
// Compiled from src/cli.ts by `pnpm --filter @trace/asset-cli build`.
// Phase 0: thin shim that uses tsx loader for dev. Replace with built output post-build.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'src', 'cli.ts');

const tsxBin = path.resolve(here, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

const child = spawn(process.execPath, [tsxBin, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
