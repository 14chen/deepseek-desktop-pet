/**
 * Build identity, so a running plugin can tell the user it is out of date.
 *
 * DSH caches ES modules by URL: disabling and re-enabling an entry recomposes
 * the Loader tree but does *not* re-import the file, so editing a plugin's
 * source has no effect until the whole process restarts. That is easy to
 * misread as "the fix did not work".
 *
 * The host therefore fingerprints its own modules **at load time** and again on
 * demand. When the two differ, a newer version is on disk and a restart is what
 * will pick it up - which `/pet/health` reports and the web page surfaces.
 *
 * @module dsh-desktop-pet/host/build
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, '..', '..');

/** Everything whose content changes the behaviour of the host process. */
const HOST_SOURCES = [
  'src/host/index.js',
  'src/host/hub.js',
  'src/host/store.js',
  'src/host/account.js',
  'src/host/desktop.js',
  'src/host/server.js',
  'src/host/tools.js',
  'src/host/triggers.js',
  'src/host/build.js',
  'src/shared/protocol.js',
  'src/shared/persona.js',
  'src/shared/labels.js',
  'cordis.patch.yml',
];

/**
 * Fingerprint the host modules from what is on disk right now.
 *
 * Uses size and mtime rather than file contents: it is called on every health
 * check, and a metadata change is exactly what a rebuild produces.
 *
 * @param {string} [root] Package root; overridable for tests.
 * @returns {string} Eight hex characters, or `unknown` when nothing is readable.
 */
export function fingerprintHost(root = PACKAGE_ROOT) {
  const hash = crypto.createHash('sha256');
  let readable = 0;
  for (const relative of HOST_SOURCES) {
    const file = path.join(root, relative);
    try {
      const stat = fs.statSync(file);
      hash.update(`${relative}:${stat.size}:${Math.round(stat.mtimeMs)}`);
      readable += 1;
    } catch {
      hash.update(`${relative}:missing`);
    }
  }
  if (readable === 0) return 'unknown';
  return hash.digest('hex').slice(0, 8);
}

/** The fingerprint captured when this module was first evaluated. */
export const LOADED_BUILD = fingerprintHost();

/**
 * Compare the build this process is running against the one on disk.
 *
 * @param {string} [root]
 * @returns {{ loaded: string, onDisk: string, stale: boolean }}
 */
export function buildStatus(root = PACKAGE_ROOT) {
  const onDisk = fingerprintHost(root);
  return {
    loaded: LOADED_BUILD,
    onDisk,
    // `unknown` means the sources could not be read, which is not evidence of
    // staleness; only a definite mismatch is.
    stale: onDisk !== 'unknown' && LOADED_BUILD !== 'unknown' && onDisk !== LOADED_BUILD,
  };
}

export { PACKAGE_ROOT as BUILD_PACKAGE_ROOT, HOST_SOURCES };
