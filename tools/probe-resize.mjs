/**
 * Verify that the floating window resizes live.
 *
 * The window reads `settings.desktopScale` from the live snapshot, so a slider
 * or a menu click should resize it without a relaunch. This drives the real
 * HTTP action endpoint and then asks Windows for the window's actual size.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const PORT = 19387;
const HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh');
const LIVE = path.join(HOME, 'desktop-pet', 'live.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function post(body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: PORT, path: '/pet/api/action', method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

const SHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function windowRect() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$env:LIB=''; $env:INCLUDE=''
Add-Type -TypeDefinition @"
using System;using System.Text;using System.Runtime.InteropServices;
public class W {
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr p);
 public delegate bool Cb(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rt,B; }
}
"@
$out = 'NONE'
$cb = [W+Cb]{ param($h,$l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetWindowTextW($h,$sb,256)
  if ($sb.ToString() -eq 'DeepSeek Pet' -and [W]::IsWindowVisible($h)) {
    $r = New-Object W+R
    [void][W]::GetWindowRect($h,[ref]$r)
    $script:out = "$($r.Rt - $r.L)x$($r.B - $r.T) at ($($r.L),$($r.T))"
    return $false
  }
  return $true }
$script:out = 'NONE'
[void][W]::EnumWindows($cb,[IntPtr]::Zero)
$script:out
`;
  const result = spawnSync(SHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  return (result.stdout ?? '').trim();
}

function liveScale() {
  try {
    return JSON.parse(fs.readFileSync(LIVE, 'utf8')).settings?.desktopScale;
  } catch {
    return null;
  }
}

console.log('live resize check\n');

const steps = [
  { scale: 0.7, label: 'small' },
  { scale: 1.5, label: 'large' },
  { scale: 2.2, label: 'extra large' },
  { scale: 1, label: 'default' },
];

let ok = true;
for (const step of steps) {
  const result = await post({ type: 'settings', settings: { desktopScale: step.scale }, source: 'probe' });
  await sleep(1800);
  const rect = windowRect();
  const applied = liveScale();
  const matches = rect !== 'NONE';
  if (!matches) ok = false;
  console.log(`  ${step.label.padEnd(12)} requested=${step.scale}  live=${applied}  window=${rect}`);
  console.log(`               action said: ${result.text.slice(0, 90)}`);
}

console.log(ok ? '\nthe window survived every resize.' : '\nTHE WINDOW DISAPPEARED.');
process.exit(ok ? 0 : 1);
