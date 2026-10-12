#!/usr/bin/env node
/**
 * Wrapper around the Pillow asset builder.
 *
 * Node cannot decode PNG alpha without a dependency, and the plugin itself must
 * stay dependency-free, so the build step shells out to Python. The processed
 * images are committed, which means this only ever runs when the source artwork
 * changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(here, 'build-assets.py');

/** Candidate interpreters, most specific first. */
function findPython() {
  const candidates = [
    process.env.PET_PYTHON,
    path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'),
      'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
    'python3',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import PIL; print(PIL.__version__)'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    if (probe.status === 0) return { python: candidate, pillow: (probe.stdout ?? '').trim() };
  }
  return null;
}

const found = findPython();
if (!found) {
  console.error('build-assets: no Python with Pillow was found.');
  console.error('build-assets: install Pillow (pip install Pillow) or set PET_PYTHON to an interpreter that has it.');
  process.exit(1);
}

console.log(`build-assets: using ${found.python} (Pillow ${found.pillow})`);
const source = fs.existsSync(path.join(ROOT, 'pet-source.png'))
  ? path.join(ROOT, 'pet-source.png')
  : fs.existsSync(path.join(ROOT, 'assets', 'pet-source.png'))
    ? path.join(ROOT, 'assets', 'pet-source.png')
    : null;
console.log(source
  ? `build-assets: source artwork ${path.relative(ROOT, source)}`
  : 'build-assets: no pet-source.png, generating the fallback mascot');

const result = spawnSync(found.python, [SCRIPT], { stdio: 'inherit', cwd: ROOT });
process.exit(result.status ?? 1);
