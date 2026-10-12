#!/usr/bin/env node
/**
 * Standalone control of the desktop pet.
 *
 * The plugin normally owns the floating window's lifecycle, but this command
 * exists for three good reasons:
 *
 *   - the pet can be shown without the harness running, which is how the art
 *     and the window are developed and verified;
 *   - `doctor` is a single command that answers "why is nothing on screen?";
 *   - `capture` proves visually that the window really is transparent and on
 *     top, without a human having to look at the desktop.
 *
 * @module dsh-desktop-pet/bin/pet
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/** Resolve a repo-relative module to a real file URL (Windows drive letters need this). */
const moduleUrl = (...segments) => pathToFileURL(path.join(ROOT, ...segments)).href;

const { resolvePetHome } = await import(moduleUrl('src', 'host', 'store.js'));
const { DesktopBridge, findPowerShell, isSupportedPlatform, resolvePetArt, pngSize } = await import(
  moduleUrl('src', 'host', 'desktop.js')
);
const { PetStore } = await import(moduleUrl('src', 'host', 'store.js'));
const { DEFAULT_SETTINGS, createInitialState } = await import(moduleUrl('src', 'shared', 'protocol.js'));

const settings = { ...DEFAULT_SETTINGS };
const store = new PetStore({ dir: resolvePetHome() });
store.load({ pet: createInitialState(settings).pet, settings });

const bridge = new DesktopBridge({
  store,
  getSettings: () => settings,
  log: (message) => console.log(message),
  onBridgeChange: () => {},
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ok(label, detail = '') {
  console.log(`  \u2713 ${label}${detail ? ` - ${detail}` : ''}`);
}

function bad(label, detail = '') {
  console.log(`  \u2717 ${label}${detail ? ` - ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandStart(args) {
  if (!isSupportedPlatform()) {
    console.error(`pet: the floating window requires Windows (this is ${process.platform}).`);
    console.error('pet: open the web page instead - see `pet doctor` for its URL.');
    return 1;
  }
  const scaleIndex = args.indexOf('--scale');
  if (scaleIndex !== -1) {
    const value = Number.parseFloat(args[scaleIndex + 1]);
    if (Number.isFinite(value)) settings.desktopScale = Math.max(0.5, Math.min(3, value));
  }
  if (args.includes('--reset-position')) {
    settings.desktopX = null;
    settings.desktopY = null;
  }

  // Give the window something to read even when the host plugin is not running.
  if (!fs.existsSync(path.join(store.dir, 'live.json'))) {
    const state = createInitialState(settings);
    state.toast = {
      id: 'standalone',
      kind: 'info',
      title: '桌宠独立模式',
      text: 'DSH 插件没有在运行，这是独立启动的桌宠。',
      actions: [],
      sticky: false,
      ttlMs: 12000,
      at: Date.now(),
      dismissed: false,
    };
    state.toasts = [state.toast];
    await store.publishState(state);
  }

  const result = bridge.start();
  if (!result.ok) {
    console.error(`pet: cannot start the window: ${result.error}`);
    return 1;
  }
  console.log(`pet: launching via "${result.strategy}" (pid ${result.pid})…`);

  // Stay alive long enough for the bridge to notice a launch that did not take
  // and to fall back to the other strategy. Without this the command would exit
  // before the self-healing logic could run.
  //
  // Readiness is confirmed two ways, because a running host plugin drains the
  // shared action queue before this process can see the announcement: either the
  // window said hello, or the process is still alive after a generous grace
  // period - which is what actually matters.
  const deadline = Date.now() + 40_000;
  const graceUntil = Date.now() + 9000;
  let ready = false;
  let announced = false;
  while (Date.now() < deadline) {
    await sleep(400);
    if (!announced) {
      for (const action of store.peekActions()) {
        if (action.type === 'desktop-ready') {
          announced = true;
          ready = true;
          console.log(`pet: window ready (pid ${action.pid ?? '?'}).`);
        }
      }
    }
    if (ready) break;
    if (!announced && Date.now() > graceUntil) {
      if (bridge.running) {
        ready = true;
        console.log(`pet: window process is alive (pid ${bridge.windowPid}); readiness was not announced here`
          + ' - the running host plugin consumed it first.');
      } else {
        break;
      }
    }
  }

  if (!ready) {
    console.error('pet: the window did not come up in time.');
    console.error(`pet: see ${bridge.logPath} for the window's own log.`);
    return 1;
  }
  console.log(`pet: state directory ${store.dir}`);
  console.log(`pet: window log ${bridge.logPath}`);
  return 0;
}

async function commandStop() {
  const stopped = await bridge.stop();
  // Also clean up a window started by an earlier process or by the plugin.
  const orphans = bridge.findOrphan();
  for (const pid of orphans) {
    if (pid === process.pid) continue;
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  const total = orphans.length + (stopped.ok ? 1 : 0);
  console.log(`pet: stopped ${total} window process(es).`);
  return 0;
}

async function commandStatus() {
  const live = path.join(store.dir, 'live.json');
  if (!fs.existsSync(live)) {
    console.log('pet: no live state yet - the plugin has not run.');
  } else {
    const state = JSON.parse(fs.readFileSync(live, 'utf8'));
    console.log('pet: state');
    console.log(`  pet        Lv.${state.pet?.level} ${state.pet?.xp}/${state.pet?.xpToNext} XP, mood=${state.pet?.mood}`);
    console.log(`  today      ${state.activity?.tasksToday} tasks, ${state.pomodoro?.completedToday} pomodoros`);
    console.log(`  quota      ${state.quota?.status} ${state.quota?.totalBalance ?? '--'} ${state.quota?.currency ?? ''}`);
    console.log(`  pending    ${state.pending?.length ?? 0}`);
    console.log(`  desktop    running=${state.bridge?.desktopRunning} pid=${state.bridge?.desktopPid ?? '-'}`);
    console.log(`  page       ${state.bridge?.webUrl ?? '-'}`);
  }
  const orphans = bridge.findOrphan();
  console.log(`pet: ${orphans.length} floating window process(es) alive${orphans.length ? ` (pid ${orphans.join(', ')})` : ''}.`);
  return 0;
}

function commandDoctor() {
  console.log('desktop-pet doctor');
  let failures = 0;
  const check = (condition, label, detail) => {
    if (condition) ok(label, detail);
    else {
      bad(label, detail);
      failures += 1;
    }
  };

  check(Number(process.versions.node.split('.')[0]) >= 20, 'Node.js >= 20', process.version);
  check(isSupportedPlatform(), 'Windows platform', process.platform);

  const shell = findPowerShell();
  const shellExists = shell === 'powershell.exe' || fs.existsSync(shell);
  check(shellExists, 'Windows PowerShell present', shell);

  if (shellExists) {
    const probe = spawnSync(
      shell,
      ['-NoProfile', '-NonInteractive', '-STA', '-Command',
        "try { Add-Type -AssemblyName PresentationFramework -ErrorAction Stop; 'WPF_OK' } catch { 'WPF_FAIL' }"],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    const output = (probe.stdout ?? '').trim();
    check(output.includes('WPF_OK'), 'WPF (PresentationFramework) loads', output.split(/\r?\n/).pop());
  }

  const art = resolvePetArt();
  check(art !== null, 'pet art present', art ? path.relative(ROOT, art.file) : 'run `npm run build:assets`');
  if (art) {
    const size = pngSize(art.file);
    check(size !== null, 'pet art is a decodable PNG', size ? `${size.width}x${size.height}` : 'unreadable');
  }

  const pages = ['index.html', 'pet.css', 'pet.js', 'embed.js', 'manifest.webmanifest'];
  for (const page of pages) {
    check(fs.existsSync(path.join(ROOT, 'web', page)), `web/${page}`);
  }

  const script = path.join(ROOT, 'desktop', 'pet-window.ps1');
  check(fs.existsSync(script), 'floating window script');

  check(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')), 'bundle patch');

  try {
    fs.mkdirSync(store.dir, { recursive: true });
    const probeFile = path.join(store.dir, '.write-probe');
    fs.writeFileSync(probeFile, 'ok', 'utf8');
    fs.unlinkSync(probeFile);
    check(true, 'state directory writable', store.dir);
  } catch (error) {
    check(false, 'state directory writable', String(error.message));
  }

  const orphans = bridge.findOrphan();
  console.log(`  \u2139 ${orphans.length} floating window process(es) currently running`);
  console.log(failures === 0 ? '\ndoctor: all checks passed.' : `\ndoctor: ${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

/**
 * Screenshot the region around the floating window. This is the only way to
 * assert "the mascot is actually drawn on the desktop" from a script.
 */
async function commandCapture(args) {
  const outIndex = args.indexOf('--out');
  const out = outIndex !== -1 ? path.resolve(args[outIndex + 1]) : path.join(store.dir, 'capture.png');
  const captureScript = path.join(ROOT, 'tools', 'capture.ps1');
  if (!fs.existsSync(captureScript)) {
    console.error('pet: tools/capture.ps1 is missing.');
    return 1;
  }
  const result = spawnSync(
    findPowerShell(),
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', captureScript,
      '-Out', out, ...(args.includes('--full') ? ['-Full'] : [])],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  const stdout = (result.stdout ?? '').trim();
  if (stdout) console.log(stdout);
  if (result.stderr?.trim()) console.error(result.stderr.trim());
  if (result.status !== 0 || !fs.existsSync(out)) {
    console.error('pet: capture failed.');
    return 1;
  }
  console.log(`pet: captured to ${out}`);
  return 0;
}

function commandUrls() {
  const live = path.join(store.dir, 'live.json');
  if (!fs.existsSync(live)) {
    console.log('pet: no live state yet.');
    return 1;
  }
  const state = JSON.parse(fs.readFileSync(live, 'utf8'));
  console.log(`pet page: ${state.bridge?.webUrl ?? '(unknown - is the DSH webserver running?)'}`);
  return 0;
}

function usage() {
  console.log(`DeepSeek desktop pet

Usage: node bin/pet.mjs <command> [options]

Commands
  start [--scale N] [--reset-position]   show the floating desktop window
  stop                                   close every floating window
  status                                 print the current live state
  urls                                   print the pet page URL
  doctor                                 diagnose the environment
  capture [--out FILE] [--full]          screenshot the pet window

The plugin normally starts the window for you; these commands are for
standalone use, development and troubleshooting.`);
}

// ---------------------------------------------------------------------------

const [command = 'status', ...rest] = process.argv.slice(2);

const table = {
  start: () => commandStart(rest),
  stop: () => commandStop(rest),
  status: () => commandStatus(rest),
  urls: () => commandUrls(rest),
  doctor: () => commandDoctor(rest),
  capture: () => commandCapture(rest),
  help: () => { usage(); return 0; },
  '--help': () => { usage(); return 0; },
  '-h': () => { usage(); return 0; },
};

if (!table[command]) {
  console.error(`pet: unknown command "${command}"\n`);
  usage();
  process.exit(2);
}

try {
  const code = await table[command]();
  await sleep(50);
  process.exit(code ?? 0);
} catch (error) {
  console.error(`pet: ${error?.message ?? error}`);
  process.exit(1);
}
