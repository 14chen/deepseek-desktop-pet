#!/usr/bin/env node
/**
 * Run every desktop-pet suite in one go.
 *
 * Each suite is a separate process on purpose: the window suite launches real
 * PowerShell processes and must not be able to wedge the pure-logic suites, and
 * a failure in one should still let the others report.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const suites = [
  ['unit', path.join(ROOT, 'test', 'unit', 'core.test.mjs')],
  ['host end-to-end', path.join(ROOT, 'test', 'e2e', 'host.e2e.mjs')],
  ['desktop window', path.join(ROOT, 'test', 'e2e', 'desktop.e2e.mjs')],
];

const only = process.argv.slice(2);
const selected = only.length > 0
  ? suites.filter(([name]) => only.some((needle) => name.includes(needle)))
  : suites;

let failed = 0;
const summary = [];

for (const [name, file] of selected) {
  process.stdout.write(`\n\u2500\u2500 ${name} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`);
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: ROOT });
  if (result.status === 0) {
    summary.push(`  \u2713 ${name}`);
  } else {
    failed += 1;
    summary.push(`  \u2717 ${name} (exit ${result.status ?? 'null'})`);
  }
}

console.log('\n\u2500\u2500 summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
console.log(summary.join('\n'));
console.log(failed === 0
  ? `\nall ${selected.length} suites passed.`
  : `\n${failed} of ${selected.length} suites FAILED.`);
process.exit(failed === 0 ? 0 : 1);
