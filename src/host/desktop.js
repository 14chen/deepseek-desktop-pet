/**
 * Lifecycle management for the Windows floating window.
 *
 * The pet window is a separate PowerShell/WPF process rather than an Electron
 * `BrowserWindow`, for three reasons: it needs per-pixel transparency with a
 * click-through option, it must survive a DSH reload without losing its
 * position, and it must be startable by hand (`node bin/pet.mjs start`) when
 * the user wants the mascot without the harness.
 *
 * The two processes communicate exclusively through files, so neither needs a
 * socket, a port, or an authentication handshake. See `store.js` for the
 * channel definitions.
 *
 * @module dsh-desktop-pet/host/desktop
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveLabels } from '../shared/labels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, '..', '..');
const SCRIPT = path.join(PACKAGE_ROOT, 'desktop', 'pet-window.ps1');
const ASSETS = path.join(PACKAGE_ROOT, 'assets');

/** How long to wait for a graceful quit before killing the process tree. */
const GRACEFUL_EXIT_MS = 2500;
/** How long the window gets to announce itself before the strategy is doubted. */
const READY_TIMEOUT_MS = 12_000;
/** Restart backoff after an unexpected exit. */
const RESTART_DELAYS_MS = [1000, 3000, 8000, 20_000, 60_000];

/** Locate Windows PowerShell. WPF needs 5.1's .NET Framework, not pwsh 7. */
export function findPowerShell() {
  const candidates = [
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ];
  for (const candidate of candidates) {
    if (candidate === 'powershell.exe') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

/** True when this machine can host the floating window at all. */
export function isSupportedPlatform() {
  return process.platform === 'win32';
}

/** Desktop pet art, preferring the processed sprite over the raw source image. */
export function resolvePetArt(assetsDir = ASSETS) {
  const candidates = ['pet.png', 'pet-fallback.png'];
  for (const name of candidates) {
    const full = path.join(assetsDir, name);
    if (fs.existsSync(full)) return { file: full, name };
  }
  return null;
}

/** Read PNG dimensions without decoding the pixels. */
export function pngSize(file) {
  try {
    const buffer = fs.readFileSync(file);
    if (buffer.length < 24) return null;
    if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/**
 * Owns the floating window process: start, stop, restart-on-crash and the
 * bookkeeping the state document exposes as `bridge`.
 *
 * ## Why there are two launch strategies
 *
 * A plain `spawn(..., { detached: true })` is the natural way to start a
 * detached child, but it does **not** escape a Windows *job object*. A host
 * that runs its commands inside a job with `KILL_ON_JOB_CLOSE` (which is how
 * many harnesses keep a command's process tree bounded) will therefore reap the
 * window the moment the command finishes, and the pet never appears. This was
 * observed in practice, not theorised.
 *
 * `Win32_Process.Create` creates the process under `WmiPrvSE.exe` instead, so
 * it belongs to no job the caller controls and survives anything short of a
 * logoff. That is slower and goes through WMI, so it is used only when the
 * direct launch is proven not to work - and the winning strategy is remembered
 * so later runs start the right way immediately.
 */
export class DesktopBridge {
  /**
   * @param {object} options
   * @param {import('./store.js').PetStore} options.store
   * @param {() => object} options.getSettings
   * @param {(message: string) => void} [options.log]
   * @param {(patch: object) => void} [options.onBridgeChange]
   */
  constructor({ store, getSettings, log = () => {}, onBridgeChange = () => {} }) {
    this.store = store;
    this.getSettings = getSettings;
    this.log = log;
    this.onBridgeChange = onBridgeChange;
    this.child = null;
    this.restartIndex = 0;
    this.restartTimer = null;
    this.stopping = false;
    this.configPath = path.join(store.dir, 'desktop.json');
    this.logPath = path.join(store.dir, 'desktop.log');
    this.pidPath = path.join(store.dir, 'desktop.pid');
    this.lastError = null;
    this.startedAt = null;
    this.readySeen = false;
    this.readyTimer = null;
    this.wmiPid = null;
    // Persisted so the second run onward skips the failed strategy.
    this.strategy = store.data?.desktopStrategy === 'wmi' ? 'wmi' : 'spawn';
  }

  get running() {
    if (this.child !== null && this.child.exitCode === null && !this.child.killed) return true;
    if (this.wmiPid !== null) return this.isAlive(this.wmiPid);
    return false;
  }

  get pid() {
    return this.windowPid;
  }

  /** Write the config the window reads at startup. */
  writeConfig(extra = {}) {
    const settings = this.getSettings();
    const art = resolvePetArt();
    const size = art ? pngSize(art.file) : null;

    // The window is sized from the art's natural aspect ratio so a tall or wide
    // mascot is never squashed.
    const baseHeight = 220;
    const baseWidth = size && size.height > 0
      ? Math.round(baseHeight * (size.width / size.height))
      : 220;

    const config = {
      liveFile: path.join(this.store.dir, 'live.json'),
      actionsFile: path.join(this.store.dir, 'actions.jsonl'),
      commandFile: this.store.commandFile,
      logFile: this.logPath,
      assetsDir: ASSETS,
      image: art?.name ?? 'pet.png',
      width: Math.min(520, Math.max(120, baseWidth)),
      height: baseHeight,
      scale: Number(settings.desktopScale) || 1,
      x: Number.isFinite(settings.desktopX) ? settings.desktopX : null,
      y: Number.isFinite(settings.desktopY) ? settings.desktopY : null,
      alwaysOnTop: settings.alwaysOnTop !== false,
      sound: Boolean(settings.sound),
      dsUrl: extra.dsUrl ?? '',
      pollMs: 600,
      // All non-ASCII text lives here rather than in the .ps1, because
      // Windows PowerShell 5.1 reads a BOM-less script as the ANSI codepage.
      labels: resolveLabels(extra.labels),
      ...extra,
    };

    this.store.ensureDir();
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    return config;
  }

  /**
   * Start the window. Resolves once the process is spawned; readiness is
   * reported separately by the window's `desktop-ready` action, because
   * WPF window creation takes a moment and should not block the host.
   */
  start(extra = {}) {
    if (!isSupportedPlatform()) {
      return { ok: false, error: `unsupported platform: ${process.platform}` };
    }
    if (this.running) {
      return { ok: true, alreadyRunning: true, pid: this.pid };
    }
    if (!fs.existsSync(SCRIPT)) {
      return { ok: false, error: `pet window script missing: ${SCRIPT}` };
    }

    this.stopping = false;
    let config;
    try {
      config = this.writeConfig(extra);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { ok: false, error: this.lastError };
    }

    const shell = findPowerShell();
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', SCRIPT,
      '-ConfigPath', this.configPath,
    ];

    this.readySeen = false;
    this.wmiPid = null;

    let pid = null;
    try {
      pid = this.strategy === 'wmi'
        ? this.#launchViaWmi(shell, args)
        : this.#launchDirect(shell, args);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.log(`desktop-pet: ${this.strategy} launch failed: ${this.lastError}`);
      return { ok: false, error: this.lastError };
    }

    if (pid === null) {
      return { ok: false, error: this.lastError ?? 'launch produced no pid' };
    }

    this.startedAt = Date.now();
    this.onBridgeChange({ desktopRunning: true, desktopPid: pid });
    this.log(`desktop-pet: floating window started via ${this.strategy} (pid=${pid})`);
    this.#armReadinessWatchdog();
    return { ok: true, pid, config, strategy: this.strategy };
  }

  /**
   * Direct `spawn`: fast, no external tooling, and correct everywhere except
   * inside a Windows job object that kills its tree on close.
   */
  #launchDirect(shell, args) {
    // PowerShell's own stderr goes straight into the log file through an
    // inherited handle: no pipes (so a wedged window cannot back-pressure the
    // host) and no lost output.
    let logHandle = null;
    try {
      this.store.ensureDir();
      logHandle = fs.openSync(this.logPath, 'a');
      fs.writeSync(logHandle, `\r\n=== launch(${this.strategy}) ${new Date().toISOString()} ===\r\n`);
    } catch {
      logHandle = null;
    }

    let child;
    try {
      child = spawn(shell, args, {
        // Detached so the pet outlives a DSH reload, and with no pipes so a
        // wedged window can never back-pressure the host.
        detached: true,
        stdio: logHandle === null ? 'ignore' : ['ignore', logHandle, logHandle],
        windowsHide: true,
        cwd: PACKAGE_ROOT,
      });
    } finally {
      // The parent's copy of the handle is not needed once the child owns it.
      if (logHandle !== null) {
        try {
          fs.closeSync(logHandle);
        } catch {
          /* the child keeps its own duplicate */
        }
      }
    }

    child.on('error', (error) => {
      this.lastError = String(error?.message ?? error);
      this.log(`desktop-pet: window process error: ${this.lastError}`);
      this.onBridgeChange({ desktopRunning: false, desktopPid: null, lastError: this.lastError });
    });
    child.on('exit', (code, signal) => this.#onExit(code, signal));
    child.unref();
    this.child = child;
    return child.pid ?? null;
  }

  /**
   * Launch through WMI, which parents the process to `WmiPrvSE.exe` and so
   * escapes any job object the caller lives in. The helper PowerShell exits
   * immediately; the pid comes back through a file rather than a pipe, which
   * keeps this working even where captured stdio is restricted.
   */
  #launchViaWmi(shell, args) {
    this.store.ensureDir();
    try {
      fs.rmSync(this.pidPath, { force: true });
    } catch {
      /* a stale pid file is harmless; it is overwritten below */
    }

    // A single argv string is what Win32_Process.Create takes, so every
    // argument is quoted for CommandLineToArgvW.
    const commandLine = [shell, ...args]
      .map((part) => (/[\s"]/u.test(part) ? `"${String(part).replace(/"/g, '\\"')}"` : part))
      .join(' ');
    const escaped = commandLine.replace(/'/g, "''");
    const pidLiteral = this.pidPath.replace(/'/g, "''");

    const helper = [
      '$ErrorActionPreference = "Stop"',
      `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}' }`,
      `Set-Content -LiteralPath '${pidLiteral}' -Value ("$($result.ReturnValue)|$($result.ProcessId)") -Encoding ASCII`,
    ].join('; ');

    const probe = spawnSync(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', helper],
      { encoding: 'utf8', windowsHide: true, timeout: 45_000 },
    );
    if (probe.error) throw probe.error;

    let raw = '';
    try {
      raw = fs.readFileSync(this.pidPath, 'utf8').trim();
    } catch {
      throw new Error(`WMI helper produced no pid file (exit ${probe.status}): ${(probe.stderr ?? '').trim().slice(0, 200)}`);
    }
    const [returnValue, pidText] = raw.split('|');
    if (returnValue !== '0') throw new Error(`Win32_Process.Create returned ${returnValue}`);
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Win32_Process.Create returned pid "${pidText}"`);

    // No ChildProcess handle exists for a WMI-created process, so liveness is
    // polled from the watchdog instead of driven by an 'exit' event.
    this.child = null;
    this.wmiPid = pid;
    return pid;
  }

  /** Shared exit bookkeeping for a directly spawned child. */
  #onExit(code, signal) {
    this.child = null;
    this.onBridgeChange({
      desktopRunning: false,
      desktopPid: null,
      lastError: this.stopping ? null : this.lastError,
    });
    if (this.stopping) {
      this.log('desktop-pet: floating window stopped');
      return;
    }
    this.log(`desktop-pet: floating window exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    if (!this.readySeen) this.#escalate('the window process died before it became ready');
    this.scheduleRestart();
  }

  /**
   * Give up on the current launch strategy and remember the next one. Without
   * this the plugin would retry the same doomed spawn forever inside a host
   * that runs its commands in a job object.
   */
  #escalate(reason) {
    if (this.strategy === 'wmi') return;
    this.strategy = 'wmi';
    this.restartIndex = 0;
    try {
      this.store.data = { ...this.store.data, desktopStrategy: 'wmi' };
      this.store.touch();
    } catch {
      /* persistence is a optimisation here, not a requirement */
    }
    this.log(`desktop-pet: ${reason}; switching to the WMI launcher`);
  }

  /**
   * Confirm the window actually announced itself. A process that starts and
   * dies silently is the exact failure mode a job object produces, so its
   * absence is the signal to switch strategies.
   */
  #armReadinessWatchdog() {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.stopping || this.readySeen) return;
      if (this.wmiPid !== null && !this.isAlive(this.wmiPid)) {
        this.#escalate('the WMI-launched window exited before it became ready');
        this.onBridgeChange({ desktopRunning: false, desktopPid: null });
        this.scheduleRestart();
        return;
      }
      if (this.running) {
        this.log('desktop-pet: the window process is up but has not reported ready yet');
        return;
      }
      this.#escalate('the window never reported ready');
      this.scheduleRestart();
    }, READY_TIMEOUT_MS);
    if (typeof this.readyTimer.unref === 'function') this.readyTimer.unref();
  }

  /** Is this pid still running? Used for WMI-launched windows, which have no handle. */
  isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to another user.
      return error?.code === 'EPERM';
    }
  }

  /** The pid of the window, whichever launcher produced it. */
  get windowPid() {
    return this.child?.pid ?? this.wmiPid ?? null;
  }

  /** Retry with backoff, so a transient failure self-heals but a real one stops. */
  scheduleRestart() {
    if (this.restartIndex >= RESTART_DELAYS_MS.length) {
      this.log('desktop-pet: giving up on the floating window after repeated failures');
      return;
    }
    const delay = RESTART_DELAYS_MS[this.restartIndex];
    this.restartIndex += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.log(`desktop-pet: restarting the floating window (attempt ${this.restartIndex})`);
      this.start();
    }, delay);
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  /** Reset the backoff after the window proves it can stay up. */
  noteReady() {
    this.readySeen = true;
    this.restartIndex = 0;
    this.onBridgeChange({
      desktopRunning: true,
      desktopPid: this.pid,
      desktopStartedAt: this.startedAt,
      lastError: null,
    });
  }

  /** Ask the window to close itself, then make sure it is gone. */
  async stop({ force = false } = {}) {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }

    const child = this.child;
    const pid = this.windowPid;
    if (!child && pid === null) {
      this.onBridgeChange({ desktopRunning: false, desktopPid: null });
      return { ok: true, alreadyStopped: true };
    }

    if (!force) {
      try {
        fs.writeFileSync(this.store.commandFile, JSON.stringify({ cmd: 'quit', at: Date.now() }), 'utf8');
      } catch (error) {
        this.log(`desktop-pet: cannot write the quit command: ${error?.message ?? error}`);
      }
      const exited = child
        ? await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), GRACEFUL_EXIT_MS);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
          });
        })
        // A WMI-launched window has no handle, so its disappearing pid is the
        // only completion signal.
        : await this.#waitForPidExit(pid, GRACEFUL_EXIT_MS);
      if (exited) {
        this.child = null;
        this.wmiPid = null;
        this.onBridgeChange({ desktopRunning: false, desktopPid: null, lastError: null });
        return { ok: true };
      }
    }

    // PowerShell hosts WPF in-process, so killing the shell is the whole job.
    try {
      if (process.platform === 'win32' && pid) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else if (child) {
        child.kill('SIGKILL');
      }
    } catch (error) {
      this.log(`desktop-pet: cannot kill the floating window: ${error?.message ?? error}`);
    }
    this.child = null;
    this.wmiPid = null;
    this.onBridgeChange({ desktopRunning: false, desktopPid: null });
    return { ok: true, killed: true };
  }

  /** Poll until a pid disappears or the deadline passes. */
  async #waitForPidExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return !this.isAlive(pid);
  }

  /**
   * Reconcile the recorded state with reality.
   *
   * A directly spawned child reports its own exit through a handle, but a
   * WMI-created process has no handle at all - so nothing would ever notice the
   * user closing the window, or Windows killing it. The heartbeat calls this to
   * close that gap.
   *
   * @returns {boolean} True when the recorded state changed.
   */
  verify() {
    const pid = this.windowPid;
    if (pid === null || this.stopping) return false;
    if (this.isAlive(pid)) return false;

    this.child = null;
    this.wmiPid = null;
    this.readySeen = false;
    this.onBridgeChange({ desktopRunning: false, desktopPid: null, lastError: this.lastError });
    this.log(`desktop-pet: floating window (pid ${pid}) is gone; scheduling a restart`);
    this.scheduleRestart();
    return true;
  }

  /** Is a pet window already running for this pet home, from a previous host? */
  findOrphan(scriptPath = SCRIPT) {
    if (process.platform !== 'win32') return [];
    // Excluding `Get-CimInstance` matters: this very query's own command line
    // contains the search string, so without the filter it matches itself.
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
        + 'Where-Object { $_.CommandLine -like \'*-File*pet-window.ps1*\' '
        + "-and $_.CommandLine -notlike '*Get-CimInstance*' "
        + "-and $_.CommandLine -notlike '*capture.ps1*' } | "
        + 'Select-Object -ExpandProperty ProcessId',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== process.pid);
  }

  dispose() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }
}

export { SCRIPT as PET_SCRIPT, ASSETS as PET_ASSETS, PACKAGE_ROOT };
