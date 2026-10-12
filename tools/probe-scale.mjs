/**
 * Drive the size control the way a menu item and the web slider do, and confirm
 * the floating window follows. Reads the snapshot with Node so PowerShell's
 * ANSI `Get-Content` cannot mangle the JSON.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh');
const LIVE = path.join(HOME, 'desktop-pet', 'live.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scale = () => JSON.parse(fs.readFileSync(LIVE, 'utf8')).settings.desktopScale;

function post(body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: 19387, path: '/pet/api/action', method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve(text));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

console.log(`starting at ${scale()}x\n`);

// Exactly what the 放大 menu item computes: current + 0.15, sent as an absolute
// value through the settings action, which every host version understands.
for (let step = 1; step <= 3; step += 1) {
  const current = Number(scale()) || 1;
  const next = Math.min(3, Math.max(0.5, Math.round((current + 0.15) * 100) / 100));
  const reply = await post({ type: 'settings', settings: { desktopScale: next }, source: 'probe' });
  await sleep(900);
  console.log(`  放大 #${step}: ${current} -> ${next}   applied=${scale()}   host said ${reply.slice(0, 64)}`);
}

const peak = scale();
console.log(`\npeak ${peak}x`);

console.log('\n  恢复大小: 1');
await post({ type: 'settings', settings: { desktopScale: 1 }, source: 'probe' });
await sleep(1200);
console.log(`  applied=${scale()}`);
