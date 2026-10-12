/**
 * End-to-end verification of the Windows floating window and the image pipeline.
 *
 * The window is the one part of this plugin that a headless test cannot simply
 * `import`. So it is verified the way it actually fails: the real PowerShell
 * script is launched through the real bridge, and Windows itself is asked
 * whether the resulting window exists, is visible, is layered (per-pixel
 * transparent) and is topmost.
 *
 * The window is launched with the WMI strategy because that is the one that
 * survives being started from a harness that runs its commands inside a Windows
 * job object - the same reason the bridge escalates to it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assert, assertEqual, assertMatch, waitFor } from '../harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

const { PetStore } = await load('src/host/store.js');
const { DesktopBridge, findPowerShell, isSupportedPlatform, resolvePetArt, pngSize } = await load('src/host/desktop.js');
const { DEFAULT_SETTINGS, createInitialState } = await load('src/shared/protocol.js');

const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`  \u2713 ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  \u2717 ${name}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`);
  }
}

const POWERSHELL = findPowerShell();

/** Run a PowerShell snippet and return its trimmed stdout. */
function ps(command, timeout = 60_000) {
  // Windows PowerShell writes to the console using the OEM codepage, so the
  // encoding is forced to UTF-8 first; otherwise non-ASCII output is mangled on
  // the way back to Node.
  const preamble = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
    + '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', preamble + command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
  });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

/**
 * Ask Windows for the pet window's real geometry and extended styles, which is
 * the only authoritative answer to "is it transparent and on top?".
 *
 * Only visible windows are reported: a window that is still being torn down
 * from an earlier run would otherwise be found first and make the assertions
 * meaningless.
 */
function inspectWindow(title = 'DeepSeek Pet') {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$env:LIB=''; $env:INCLUDE=''; $env:LIBPATH=''
Add-Type -TypeDefinition @"
using System;using System.Text;using System.Runtime.InteropServices;
public class Inspect {
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr p);
 public delegate bool Cb(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rt,B; }
}
"@
$rows = New-Object System.Collections.ArrayList
$cb = [Inspect+Cb]{ param($h,$l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][Inspect]::GetWindowTextW($h,$sb,256)
  if ($sb.ToString() -eq '${title}' -and [Inspect]::IsWindowVisible($h)) {
    $ex = [Inspect]::GetWindowLong($h,-20)
    $r = New-Object Inspect+R
    [void][Inspect]::GetWindowRect($h,[ref]$r)
    $pid2 = 0
    [void][Inspect]::GetWindowThreadProcessId($h,[ref]$pid2)
    $row = [ordered]@{
      hwnd = [int64]$h
      pid = [int]$pid2
      visible = [Inspect]::IsWindowVisible($h)
      layered = [bool]($ex -band 0x80000)
      topmost = [bool]($ex -band 0x8)
      left = $r.L; top = $r.T
      width = $r.Rt - $r.L; height = $r.B - $r.T
    }
    [void]$rows.Add(($row | ConvertTo-Json -Compress))
  }
  return $true }
[void][Inspect]::EnumWindows($cb,[IntPtr]::Zero)
if ($rows.Count -eq 0) { 'NONE' } else { $rows -join "\`n" }
`;
  const { stdout } = ps(script);
  if (!stdout || stdout === 'NONE') return null;
  return JSON.parse(stdout.split('\n')[0]);
}

/** Kill any pet window left over from an earlier run. */
function killPetWindows() {
  ps("Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
    + "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('pet-window.ps1') -and $_.CommandLine.Contains('-ConfigPath') } | "
    + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }');
}

// ---------------------------------------------------------------------------
console.log('\ndesktop-pet window and asset tests');
// ---------------------------------------------------------------------------

// --- scripts --------------------------------------------------------------
await check('every PowerShell script parses', async () => {
  for (const relative of ['desktop/pet-window.ps1', 'tools/capture.ps1']) {
    const file = path.join(ROOT, relative);
    assert(fs.existsSync(file), `${relative} must exist`);
    const command = `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$null,[ref]$e); `
      + 'if ($e.Count -gt 0) { $e | ForEach-Object { Write-Output ("line " + $_.Extent.StartLineNumber + ": " + $_.Message) } } else { "OK" }';
    const { stdout } = ps(command);
    assertEqual(stdout, 'OK', `${relative} must parse cleanly`);
  }
});

await check('the window script is pure ASCII', async () => {
  // Windows PowerShell 5.1 decodes a BOM-less .ps1 using the system ANSI
  // codepage, so a non-ASCII byte can corrupt the text or even break the parse.
  // All localized strings therefore travel through the JSON config instead.
  const bytes = fs.readFileSync(path.join(ROOT, 'desktop', 'pet-window.ps1'));
  const offenders = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] > 127) offenders.push(index);
  }
  assertEqual(offenders.length, 0, `found ${offenders.length} non-ASCII byte(s), first at offset ${offenders[0]}`);
});

await check('the capture script is pure ASCII', async () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'tools', 'capture.ps1'));
  const offenders = [...bytes].filter((byte) => byte > 127).length;
  assertEqual(offenders, 0, 'capture.ps1 must be ASCII as well');
});

// --- assets ---------------------------------------------------------------
await check('the pet art exists and decodes', async () => {
  const art = resolvePetArt();
  assert(art, 'art must be present (run `npm run build:assets`)');
  const size = pngSize(art.file);
  assert(size, 'the art must be a decodable PNG');
  assertEqual(size.width, size.height, 'the art is square, so no surface distorts it');
  assert(size.width >= 256, `the master should be at least 256px, got ${size.width}`);
});

await check('every documented size is produced', async () => {
  for (const size of [64, 128, 256, 512]) {
    const file = path.join(ROOT, 'assets', `pet-${size}.png`);
    assert(fs.existsSync(file), `assets/pet-${size}.png must exist`);
    const dimensions = pngSize(file);
    assertEqual(dimensions.width, size, `pet-${size} width`);
    assertEqual(dimensions.height, size, `pet-${size} height`);
  }
});

await check('a multi-size tray icon is produced', async () => {
  const file = path.join(ROOT, 'assets', 'pet.ico');
  assert(fs.existsSync(file), 'assets/pet.ico must exist');
  const header = fs.readFileSync(file).subarray(0, 4);
  assertEqual([...header], [0, 0, 1, 0], 'a valid ICO header');
  const count = fs.readFileSync(file).readUInt16LE(4);
  assert(count >= 4, `the ICO should carry several sizes, got ${count}`);
});

await check('the web assets mirror the shared artwork', async () => {
  for (const name of ['pet.png', 'pet-256.png', 'pet-128.png', 'avatar.png']) {
    const file = path.join(ROOT, 'web', 'assets', name);
    assert(fs.existsSync(file), `web/assets/${name} must exist`);
    assert(pngSize(file), `web/assets/${name} must be a valid PNG`);
  }
});

await check('the avatar is round and the pet art has transparent corners', async () => {
  // Both facts are what make the art usable as a floating window and a badge,
  // so they are checked rather than assumed. Pillow is the only decoder here
  // that understands alpha without extra dependencies.
  const script = path.join(os.tmpdir(), `pet-alpha-${Date.now()}.py`);
  fs.writeFileSync(script, [
    'import sys',
    'from PIL import Image',
    'pet = Image.open(sys.argv[1]).convert("RGBA")',
    'avatar = Image.open(sys.argv[2]).convert("RGBA")',
    'print("pet_corner_alpha=%d" % pet.getpixel((0, 0))[3])',
    'print("avatar_corner_alpha=%d" % avatar.getpixel((0, 0))[3])',
    'print("avatar_center_alpha=%d" % avatar.getpixel((avatar.width // 2, avatar.height // 2))[3])',
    'print("pet_opaque_pixels=%d" % sum(1 for p in pet.getdata() if p[3] > 200))',
  ].join('\n'), 'utf8');

  const python = process.env.PET_PYTHON
    || 'C:\\Users\\HP\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
  const result = spawnSync(python, [script,
    path.join(ROOT, 'assets', 'pet.png'),
    path.join(ROOT, 'assets', 'avatar.png')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  fs.rmSync(script, { force: true });

  if (result.status !== 0) {
    throw new Error(`alpha inspection failed: ${(result.stderr ?? '').trim().slice(0, 200)}`);
  }
  const values = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map((line) => {
    const [key, value] = line.split('=');
    return [key, Number(value)];
  }));

  assertEqual(values.pet_corner_alpha, 0, 'the pet art must have a transparent corner');
  assert(values.pet_opaque_pixels > 10_000, 'the mascot must actually be drawn');
  assertEqual(values.avatar_corner_alpha, 0, 'the avatar must be masked to a circle');
  assertEqual(values.avatar_center_alpha, 255, 'the avatar centre must be opaque');
});

// --- probe ----------------------------------------------------------------
if (!isSupportedPlatform()) {
  console.log('  \u2139 not Windows: skipping the floating-window checks');
} else {
  await check('the window builds in probe mode and reports its real state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-probe-'));
    try {
      const store = new PetStore({ dir });
      store.load({});
      await store.publishState(createInitialState({ ...DEFAULT_SETTINGS, desktopScale: 1 }));

      const bridge = new DesktopBridge({ store, getSettings: () => DEFAULT_SETTINGS, log: () => {} });
      const config = bridge.writeConfig();

      const { stdout, stderr } = ps(
        `& '${POWERSHELL}' -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
        + `-File '${path.join(ROOT, 'desktop', 'pet-window.ps1')}' -ConfigPath '${config === null ? '' : bridge.configPath}' -Probe`,
      );
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('PROBE '));
      assert(line, `probe produced no report. stderr: ${stderr.slice(0, 300)}`);
      const report = JSON.parse(line.slice('PROBE '.length));
      assertEqual(report.ok, true, 'probe ok');
      assertEqual(report.topmost, true, 'the window is topmost');
      assertEqual(report.allowsTransparency, true, 'per-pixel transparency is enabled');
      assertEqual(report.imageLoaded, true, 'the art loads');
      assert(report.imageWidth >= 256, 'the art is at full resolution');
      assertEqual(report.liveStateReadable, true, 'the window can read the published state');
      assertEqual(report.labelsLoaded, '我来啦！需要我就摸我一下～', 'localized labels arrive through the JSON config');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('the window script reports a real failure instead of dying silently', async () => {
    const { status, stdout, stderr } = ps(
      `& '${POWERSHELL}' -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
      + `-File '${path.join(ROOT, 'desktop', 'pet-window.ps1')}' -ConfigPath 'C:\\definitely\\missing\\config.json' 2>&1`,
    );
    assert(status !== 0, 'a missing config must be a non-zero exit');
    assertMatch(`${stdout}\n${stderr}`, /desktop-pet:|config not found/i, 'the reason is reported, not swallowed');
  });

  await check('a real window launches, is transparent and topmost, and answers interactions', async () => {
    killPetWindows();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-window-'));
    try {
      const store = new PetStore({ dir });
      store.load({});
      const settings = { ...DEFAULT_SETTINGS, desktopScale: 1 };
      // Give the window a bubble to render, so the screenshot is meaningful.
      const state = createInitialState(settings);
      state.toast = {
        id: 'e2e', kind: 'done', title: '任务完成', text: '端到端测试通过', actions: [],
        sticky: true, ttlMs: 0, at: Date.now(), dismissed: false,
      };
      state.toasts = [state.toast];
      await store.publishState(state);

      const bridge = new DesktopBridge({
        store,
        getSettings: () => settings,
        log: () => {},
        onBridgeChange: () => {},
      });
      // The WMI launcher is the one that survives a job-object host, which is
      // exactly why the bridge escalates to it.
      bridge.strategy = 'wmi';
      const started = bridge.start();
      assertEqual(started.ok, true, `launch failed: ${started.error ?? ''}`);
      assertEqual(started.strategy, 'wmi', 'used the job-independent launcher');

      // Windows is the authority on whether the window really exists.
      const window = await waitFor(() => inspectWindow(), { timeoutMs: 20_000, label: 'the window to appear' });
      assertEqual(window.visible, true, 'the window is visible');
      assertEqual(window.layered, true, 'the window is layered, i.e. per-pixel transparent');
      assertEqual(window.topmost, true, 'the window floats above others');
      assert(window.width > 100 && window.height > 100, `sensible geometry, got ${window.width}x${window.height}`);

      // The window announces readiness through the action queue.
      const ready = await waitFor(() => {
        const actions = store.peekActions();
        return actions.find((action) => action.type === 'desktop-ready') ?? null;
      }, { timeoutMs: 10_000, label: 'the window to announce readiness' });
      assertEqual(ready.pid, window.pid, 'the announced pid matches the live window');

      // A stroke from the window must reach the host queue.
      store.appendAction({ type: 'pet' });
      const actions = store.drainActions();
      assert(actions.some((action) => action.type === 'pet'), 'the interaction queue works');

      const stopped = await bridge.stop();
      assertEqual(stopped.ok, true, 'the window stops cleanly');
      await waitFor(() => inspectWindow() === null, { timeoutMs: 10_000, label: 'the window to disappear' });
    } finally {
      killPetWindows();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  await check('a WMI-launched window that dies is detected and restarted', async () => {
    killPetWindows();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-verify-'));
    try {
      const store = new PetStore({ dir });
      store.load({});
      const settings = { ...DEFAULT_SETTINGS, desktopScale: 1 };
      await store.publishState(createInitialState(settings));

      const changes = [];
      const bridge = new DesktopBridge({
        store,
        getSettings: () => settings,
        log: () => {},
        onBridgeChange: (patch) => changes.push(patch),
      });
      bridge.strategy = 'wmi';
      assertEqual(bridge.start().ok, true, 'launch');
      await waitFor(() => inspectWindow(), { timeoutMs: 20_000, label: 'the window to appear' });
      const pid = bridge.windowPid;
      assert(bridge.isAlive(pid), 'the process is alive');
      assertEqual(bridge.verify(), false, 'a healthy window reports no change');

      // Kill it behind the bridge's back - the exact case a WMI-launched process
      // cannot report on its own, because it has no child handle.
      ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
      await waitFor(() => !bridge.isAlive(pid), { timeoutMs: 10_000, label: 'the process to die' });

      assertEqual(bridge.verify(), true, 'the death is detected');
      assertEqual(bridge.running, false, 'and the bridge stops claiming it is running');
      assert(changes.some((patch) => patch.desktopRunning === false), 'the change is published to the state');

      await bridge.stop();
    } finally {
      killPetWindows();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  await check('a capture produces a real PNG of the pet area', async () => {
    const file = path.join(os.tmpdir(), `pet-capture-${Date.now()}.png`);
    try {
      const { stdout } = ps(
        `& '${POWERSHELL}' -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
        + `-File '${path.join(ROOT, 'tools', 'capture.ps1')}' -Out '${file}' -Full`,
        90_000,
      );
      assertMatch(stdout, /saved/, 'the capture reports success');
      assert(fs.existsSync(file), 'the file exists');
      const size = pngSize(file);
      assert(size && size.width > 200 && size.height > 200, 'the capture has real dimensions');
      assert(fs.statSync(file).size > 10_000, 'the capture is not an empty frame');
    } finally {
      fs.rmSync(file, { force: true });
    }
  }, 90_000);

  await check('the environment passes its own doctor', async () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'pet.mjs'), 'doctor'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assertMatch(output, /all checks passed/, `doctor failed:\n${output.slice(-1200)}`);
  }, 120_000);
}

// --- the user's own artwork ----------------------------------------------
await check('an opaque picture with a flat background is optimized into transparent art', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-source-'));
  const python = process.env.PET_PYTHON
    || 'C:\\Users\\HP\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

  // Stand in for a real supplied image: an opaque JPEG-like frame with a flat
  // white border and a colourful subject that touches none of the edges.
  const maker = path.join(scratch, 'make.py');
  fs.writeFileSync(maker, [
    'import sys',
    'from PIL import Image, ImageDraw',
    'img = Image.new("RGB", (900, 700), (255, 255, 255))',
    'd = ImageDraw.Draw(img)',
    'd.ellipse([250, 180, 650, 580], fill=(70, 130, 230))',
    'd.ellipse([330, 300, 400, 370], fill=(255, 255, 255))',
    'd.ellipse([520, 300, 590, 370], fill=(255, 255, 255))',
    'd.ellipse([355, 325, 380, 350], fill=(20, 20, 30))',
    'd.ellipse([545, 325, 570, 350], fill=(20, 20, 30))',
    'img.save(sys.argv[1], "PNG")',
  ].join('\n'), 'utf8');

  const source = path.join(scratch, 'pet-source.png');
  const made = spawnSync(python, [maker, source], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assertEqual(made.status, 0, `could not synthesise a source image: ${(made.stderr ?? '').slice(0, 200)}`);

  const built = spawnSync(python, [path.join(ROOT, 'tools', 'build-assets.py')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    // `PET_ART=source` selects the raw-picture pipeline; the default is now the
    // drawn Q-version, which is covered by its own check below.
    env: { ...process.env, PET_ASSET_ROOT: scratch, PET_ART: 'source' },
  });
  const log = `${built.stdout ?? ''}\n${built.stderr ?? ''}`;
  assertEqual(built.status, 0, `build failed:\n${log.slice(-600)}`);
  assertMatch(log, /flat outer background detected/, 'the background removal actually ran');
  assertMatch(log, /background removed/, 'and it succeeded');

  const inspect = path.join(scratch, 'inspect.py');
  fs.writeFileSync(inspect, [
    'import json, sys',
    'from PIL import Image',
    'img = Image.open(sys.argv[1]).convert("RGBA")',
    'w, h = img.size',
    'pad = 2',
    'corners = [img.getpixel((pad, pad))[3], img.getpixel((w - 1 - pad, pad))[3],',
    '           img.getpixel((pad, h - 1 - pad))[3], img.getpixel((w - 1 - pad, h - 1 - pad))[3]]',
    'opaque = sum(1 for p in img.getdata() if p[3] > 200)',
    'bbox = img.split()[3].getbbox()',
    'print(json.dumps({"corners": corners, "opaque": opaque, "size": [w, h], "bbox": bbox}))',
  ].join('\n'), 'utf8');

  const probed = spawnSync(python, [inspect, path.join(scratch, 'assets', 'pet-512.png')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  assertEqual(probed.status, 0, `inspection failed: ${(probed.stderr ?? '').slice(0, 200)}`);
  const report = JSON.parse(probed.stdout.trim());

  assertEqual(report.corners, [0, 0, 0, 0], 'the flat background became transparent');
  assert(report.opaque > 20_000, 'the subject survived');
  // Trimming and squaring mean the subject should now fill most of the frame.
  const [left, top, right, bottom] = report.bbox;
  assert((right - left) / report.size[0] > 0.9, 'the artwork was trimmed to its content');
  assert((bottom - top) / report.size[1] > 0.9, 'and vertically too');

  // Every derived artefact must exist for the scratch build as well.
  for (const name of ['pet.png', 'pet-64.png', 'pet.ico', 'avatar.png', 'pet-fallback.png']) {
    assert(fs.existsSync(path.join(scratch, 'assets', name)), `assets/${name} was produced`);
  }
  for (const name of ['pet.png', 'pet-256.png', 'pet-128.png', 'avatar.png']) {
    assert(fs.existsSync(path.join(scratch, 'web', 'assets', name)), `web/assets/${name} was produced`);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
}, 240_000);

await check('a full illustration is framed in a badge instead of being cut apart', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-nobg-'));
  const python = process.env.PET_PYTHON
    || 'C:\\Users\\HP\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

  // A picture with no flat background at all: the same failure mode as a real
  // illustration, where a colour matte would produce ragged edges.
  const maker = path.join(scratch, 'make.py');
  fs.writeFileSync(maker, [
    'import sys',
    'from PIL import Image',
    'img = Image.new("RGB", (400, 400))',
    'px = img.load()',
    'for y in range(400):',
    '    for x in range(400):',
    '        px[x, y] = (x % 256, y % 256, (x + y) % 256)',
    'img.save(sys.argv[1], "PNG")',
  ].join('\n'), 'utf8');

  const source = path.join(scratch, 'pet-source.png');
  spawnSync(python, [maker, source], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

  const built = spawnSync(python, [path.join(ROOT, 'tools', 'build-assets.py')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 240_000,
    // The deterministic raw-picture path: the optional ML matte is a large
    // download and must never decide whether the build is reproducible.
    env: { ...process.env, PET_ASSET_ROOT: scratch, PET_ART: 'source', PET_CUTOUT: '0' },
  });
  const log = `${built.stdout ?? ''}\n${built.stderr ?? ''}`;
  assertEqual(built.status, 0, `build failed:\n${log.slice(-600)}`);
  assertMatch(log, /full illustration/, 'the builder recognises the case');
  assertMatch(log, /framing the character in a badge/, 'and frames rather than mangles it');
  assert(!/background removed/.test(log), 'no bogus background removal was attempted');

  const inspect = path.join(scratch, 'inspect.py');
  fs.writeFileSync(inspect, [
    'import json, sys',
    'from PIL import Image',
    'img = Image.open(sys.argv[1]).convert("RGBA")',
    'w, h = img.size',
    'corners = [img.getpixel((2, 2))[3], img.getpixel((w - 3, 2))[3],',
    '           img.getpixel((2, h - 3))[3], img.getpixel((w - 3, h - 3))[3]]',
    'print(json.dumps({"corners": corners, "centre": img.getpixel((w // 2, h // 2))[3]}))',
  ].join('\n'), 'utf8');
  const probed = spawnSync(python, [inspect, path.join(scratch, 'assets', 'pet-512.png')], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assertEqual(probed.status, 0, `inspection failed: ${(probed.stderr ?? '').slice(0, 200)}`);
  const report = JSON.parse(probed.stdout.trim());
  assertEqual(report.corners, [0, 0, 0, 0], 'the badge is round, so its corners are transparent');
  assertEqual(report.centre, 255, 'and its centre is opaque');

  for (const name of ['pet.png', 'pet.ico', 'avatar.png', 'pet-fallback.png']) {
    assert(fs.existsSync(path.join(scratch, 'assets', name)), `assets/${name} was produced`);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
}, 300_000);

// --- the drawn Q-version --------------------------------------------------
await check('the default artwork is a drawn Q-version of the character', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-chibi-'));
  const python = process.env.PET_PYTHON
    || 'C:\\Users\\HP\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

  // No source picture at all: `PET_ART=chibi` must still produce the pet.
  const built = spawnSync(python, [path.join(ROOT, 'tools', 'build-assets.py')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 240_000,
    env: { ...process.env, PET_ASSET_ROOT: scratch, PET_ART: 'chibi' },
  });
  const log = `${built.stdout ?? ''}\n${built.stderr ?? ''}`;
  assertEqual(built.status, 0, `build failed:\n${log.slice(-800)}`);
  assertMatch(log, /Q-version/, 'the builder says it drew the Q-version');

  for (const name of ['pet.png', 'pet-64.png', 'pet.ico', 'avatar.png', 'pet-fallback.png']) {
    assert(fs.existsSync(path.join(scratch, 'assets', name)), `assets/${name} was produced`);
  }

  const inspect = path.join(scratch, 'inspect.py');
  fs.writeFileSync(inspect, [
    'import json, sys',
    'from PIL import Image',
    'pet = Image.open(sys.argv[1]).convert("RGBA")',
    'avatar = Image.open(sys.argv[2]).convert("RGBA")',
    'w, h = pet.size',
    'opaque = sum(1 for p in pet.getdata() if p[3] > 200)',
    'print(json.dumps({',
    '  "corner": pet.getpixel((2, 2))[3],',
    '  "opaque": opaque,',
    '  "total": w * h,',
    '  "avatar_corner": avatar.getpixel((2, 2))[3],',
    '  "avatar_centre": avatar.getpixel((avatar.width // 2, avatar.height // 2))[3],',
    '}))',
  ].join('\n'), 'utf8');
  const probed = spawnSync(python, [inspect,
    path.join(scratch, 'assets', 'pet-512.png'),
    path.join(scratch, 'assets', 'avatar.png')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assertEqual(probed.status, 0, `inspection failed: ${(probed.stderr ?? '').slice(0, 200)}`);
  const report = JSON.parse(probed.stdout.trim());

  assertEqual(report.corner, 0, 'the art has transparent corners');
  const coverage = report.opaque / report.total;
  assert(coverage > 0.15, `the character must actually be drawn, covered ${(coverage * 100).toFixed(1)}%`);
  assertEqual(report.avatar_corner, 0, 'the avatar is round');
  assertEqual(report.avatar_centre, 255, 'and its centre is the face, not empty space');

  fs.rmSync(scratch, { recursive: true, force: true });
}, 300_000);

await check('the Q-version declares where its face is', async () => {
  // The generic "top of the bounding box" heuristic lands on the sword, so the
  // generator has to state the face position explicitly.
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'chibi.py'), 'utf8');
  assertMatch(source, /^FACE_BOX = \(/m, 'chibi.py exports FACE_BOX');
  const build = fs.readFileSync(path.join(ROOT, 'tools', 'build-assets.py'), 'utf8');
  assertMatch(build, /crop_normalised\(master, face_box\)/, 'and the build honours it for the avatar');
});

// ---------------------------------------------------------------------------
console.log(results.join('\n'));
console.log(failures === 0
  ? `\nall ${results.length} checks passed.`
  : `\n${failures} of ${results.length} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
