#!/usr/bin/env node
// ABOUTME: Global launcher for the `mc` CLI. Runs cli/index.ts via the repo's tsx (no build step),
// ABOUTME: forwarding argv, stdio (so TTY detection + JSON-default work), and the exit code.
// Requires the repo's node_modules (tsx + deps), which is present on every machine that holds
// the scoped AGENT_DATABASE_URL credential — where this CLI is meant to run.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = join(root, 'node_modules', '.bin', 'tsx');
const entry = join(root, 'cli', 'index.ts');

const child = spawn(tsxBin, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', (err) => {
  process.stderr.write(`mc: failed to launch tsx (${err.message})\n`);
  process.exit(127);
});
child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
