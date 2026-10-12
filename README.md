# dsh-desktop-pet · a desktop pet for DeepSeek Harness

> A mascot that actually lives on your Windows desktop: it tells you when a task finishes, waves when the agent needs you, and keeps an eye on your DeepSeek platform balance.

![On the desktop](docs/screenshots/desktop-pet.png)

> That is a real screenshot. The window is **per-pixel transparent**, so the wallpaper shows straight through, and `WS_EX_TOPMOST` keeps it above everything else.

---

## The problem it solves

Two things make agent work annoying:

1. **You do not know when it finished.** You went off to do something else and came back to find it stopped twenty minutes ago.
2. **It is stuck waiting for you.** It asked a question, or wants an approval, and you are looking at a different window.

This plugin turns both into a small creature sitting on your desktop:

- when a turn finishes it hops and says so;
- when it needs an answer or an approval it waves, and the bubble **stays on screen** until you deal with it;
- it watches your API balance, warns you before it runs out, and tells you how many days are left at your current burn rate.

---

## Features

### Reminders

| Moment | What you get |
|---|---|
| A turn finishes | Green "done" bubble, a bounce, and experience |
| The agent asks a question | Amber bubble, **sticky until answered** |
| The agent needs approval | Blue bubble plus a Windows notification, so a fullscreen window cannot hide it |
| Balance drops below a threshold | Warning bubble; red and sticky below the critical line, with a "top up" button |

A subagent finishing does **not** interrupt you — only work you actually asked for counts.

### Balance monitoring

The platform API exposes wallet balances, not usage, so the plugin derives the story:

- recharge (`normal_wallets`) and granted (`bonus_wallets`) are summed separately;
- the highest balance ever seen becomes the 100% mark for the remaining-quota ring;
- a least-squares fit over the last week's samples gives a **daily burn rate** and an **estimated runway**;
- thresholds are **edge-triggered**: crossing into a warning speaks once, recovering speaks once, and a balance hovering on the line cannot spam you.

### Interacting with the window

- **Drag** it anywhere; the position is remembered
- **Click** to stroke it — it reacts, affection grows, and it says something
- **Right-click** for a menu: greet, check quota, focus 25 minutes, quiet, open DSH, hide, quit
- **Hover** for a tooltip: level, balance, tasks done today, affection, timer remaining
- **Ambient animation** — breathing, drifting, faster when it is busy, sleepy when you are away
- **Tray icon**, because the window has no taskbar entry and you still need to find it again

### Extras that turned out to be worth having

- **Pomodoro** with a break nudge, optionally auto-starting the break
- **A personal checklist** that syncs to every surface and survives restarts
- **Plan mirroring** — the agent's own `todo_write` plan appears on the pet automatically, so you can see which step it is on
- **Levels and affection** that grow with completed work and strokes
- **Daily stats**: tasks, focus minutes, pomodoro rounds, streak
- **Hydration and stretch reminders**, off by default
- **Mute** with `/pet mute`, which silences chatter but never suppresses errors

### Three surfaces, one state

1. **The Windows floating window** — a real always-on-top desktop mascot
2. **A LAN web page** — open it on a phone or tablet; mobile-first, light and dark, installable to the home screen
3. **An in-app overlay** injected into the DSH page, so you can see it without leaving the harness

---

## Install

### Through the plugin manager (recommended)

Ask the agent to call `plugin_manager`:

```
install_bundle  F:\devbox\deepseek-desktop-pet
```

Or from the CLI for a non-desktop profile:

```bash
dsh plugin --profile <profile> add F:/devbox/deepseek-desktop-pet
```

It hot-loads immediately and brings the floating window up on its own.

### Verify the environment

```bash
node bin/pet.mjs doctor        # Node, PowerShell, WPF, artwork, web files, state directory
node bin/pet.mjs status        # level, balance, pending work
node bin/pet.mjs urls          # the page URL
```

---

## Usage

### Tools for the agent

| Tool | Purpose |
|---|---|
| `pet_notify` | Raise a desktop bubble. Keep it under ~80 characters; `sticky: true` when blocked |
| `pet_status` | Level, tasks done today, balance, pending work, timer |
| `pet_quota` | Read the balance; `refresh: true` forces a fresh platform call |
| `pet_control` | Show, hide, restart, pomodoro, mute, open the page, or `page-url` for the phone link |
| `pet_todo` | Manage the pet's checklist |

### Commands for you

```
/pet                overview
/pet quota          refresh the balance
/pet url            the tokenized link for another device
/pet show|hide      show or hide the window
/pet mute|unmute    silence or restore bubbles
/pet pomodoro 45    45 minutes of focus
/pet stop           stop the timer
/pet page           open the pet page in a browser
/pet restart        restart the floating window
/pet scale 1.5      scale the mascot
```

### Standalone, without the harness

```bash
node bin/pet.mjs start
node bin/pet.mjs start --scale 1.6 --reset-position
node bin/pet.mjs stop
node bin/pet.mjs capture --out shot.png
```

---

## Configuration

Edit the profile's `cordis.patch.yml`, which outranks every bundle layer:

```yaml
- id: desktop-pet
  config:
    quotaPollSeconds: 300      # poll interval; 0 disables
    quotaWarnRatio: 0.25       # amber below 25%
    quotaCriticalRatio: 0.1    # red below 10%
    quotaBaseline: 50          # manual 100% mark; 0 remembers the peak
    autoStartDesktop: true
    alwaysOnTop: true
    desktopScale: 1.2
    sound: false
    mute: false
    hydrateReminderMinutes: 90
    stretchReminderMinutes: 0
    pomodoroFocusMinutes: 25
    pomodoroAutoBreak: true
    notifyOnTaskDone: true
    notifyOnUserAction: true
    webToken: 'your-fixed-token'
```

Every default is documented in [`cordis.patch.yml`](cordis.patch.yml).

---

## Using your own artwork

The plugin ships with a hand-drawn fallback mascot. To use your own picture:

```bash
copy your-image.png  F:\devbox\deepseek-desktop-pet\pet-source.png
node tools/build-assets.mjs
```

The build script genuinely *optimises* the picture rather than resizing it:

- **Background removal.** If the image is opaque and its corners agree on a colour, a breadth-first flood from the edges makes that flat colour transparent. Searching from the outside means interior regions of the same colour — a white shirt, an eye highlight — are left alone.
- **Trimming.** The alpha bounding box is cropped and a small margin returned, so the mascot fills its frame instead of floating in padding.
- **Colour lift.** Contrast, saturation and sharpness are nudged so it still reads when drawn small on a busy wallpaper.
- **Shadow and rim light.** A soft contact shadow underneath plus a faint brand-coloured glow are the reason a sticker reads as an object rather than a floating decal.
- **Every size.** 512/256/128/64 PNGs, a multi-size ICO for the notification area, and a circular avatar.

If the picture has no flat background at all — a photograph, say — the script **refuses to cut it** and leaves the art intact rather than destroying it.

This step needs Python with Pillow (`pip install Pillow`). Nothing at runtime does.

---

## How it works

```
┌─────────────────────────────────────────────────────────┐
│ DSH host process                                         │
│                                                          │
│  src/host/index.js      wiring for everything            │
│  src/host/triggers.js   agent/status, questions, approvals│
│  src/host/hub.js        single state source, throttled   │
│  src/host/store.js      atomic, debounced persistence     │
│  src/host/account.js    balance, burn rate, baseline      │
│  src/host/server.js     /pet/* HTTP + SSE                 │
│  src/host/desktop.js    window lifecycle, adaptive launch │
│  src/host/tools.js      5 tools and the /pet command      │
└───────┬──────────────────────────┬──────────────────────┘
        │ HTTP + SSE               │ file bridge
        ▼                          ▼
   phone / tablet / overlay   Windows window (PowerShell + WPF)
```

### Decisions worth knowing about

**A file bridge, not a socket, to the window.** The window reads a few-KB JSON snapshot and appends interactions to a jsonl file. No port, no auth, no firewall, and both halves stay independently testable.

**A pure-ASCII `.ps1`.** Windows PowerShell 5.1 decodes a script without a UTF-8 BOM using the system ANSI codepage — Chinese turns into mojibake and a multi-byte sequence can even swallow a quote and break the parse. So the window script contains no non-ASCII byte at all; every localized string arrives through the JSON config, decoded as explicit UTF-8.

**An adaptive launcher.** A plain `spawn({ detached: true })` does **not** escape a Windows job object. If the host runs commands inside a job with `KILL_ON_JOB_CLOSE` — which is how many harnesses bound a command's process tree — the window is reaped the instant the command ends. So the plugin tries the direct launch first, detects that the window never came up, and **escalates to `Win32_Process.Create`**, which parents the process to `WmiPrvSE.exe` and therefore belongs to no job the caller controls. The winning strategy is remembered.

**Passive waterfall observers.** `user-questions/request` and `approval/request` are Cordis `waterfall` events: an observer **must** `return next()`, or it vetoes the whole chain and the real browser answerer never runs. Every listener here is wrapped in try/catch, registered with `prepend` (so it observes before a claiming answerer can short-circuit), and forwards `next()` unconditionally. Because it returns the very promise the chain would have returned, observing its settlement is a free and exact "the user dealt with it" signal.

**`agent/status` is the only clean "finished" edge.** There is no "final assistant message" event, and `agent/turn-stopping` is advisory — a listener can still steer the turn back to life. Only `agent/status` fires once on a real `running` → `idle` transition.

**Shadow DOM for the in-app overlay.** DSH's own client plugins register a classic-script factory with `window.__ModuleLoader__`, pin a React version, and couple to its internal bundle layout. Injecting one `<script>` tag and drawing inside a shadow root is far more stable across harness versions.

---

## Testing

```bash
npm test                  # all three suites
npm run test:unit         # protocol, persona, balance parsing, store, hub
npm run test:host         # the real plugin inside a miniature Cordis host
npm run test:desktop      # launches a real window and asks Windows about it
```

108 assertions, including:

- **Logic**: boundary values, edge-triggered thresholds, bubble expiry, the level curve, corrupt-file quarantine
- **Host end to end**: real HTTP requests against every route, path-traversal refusal, the LAN token gate, the SSE first frame and push, all five tool schemas and executions, the `/pet` command, waterfall observers that never veto, plan mirroring, persistence across a restart, and graceful degradation when a service is missing
- **The window**: PowerShell syntax, ASCII-only enforcement, the WPF probe report, **actually launching a window and asking Windows whether it is layered and topmost**, a window killed behind the bridge's back being detected and restarted, the interaction queue, a clean shutdown, screenshots, and the artwork optimiser

DSH caches ES modules by URL, so editing a plugin's source does not change the running instance. These suites load the **real modules** directly in Node, which is exactly why they can cover changed code.

---

## Troubleshooting

```bash
node bin/pet.mjs doctor
```

The window's own log is at `%DSH_HOME%\desktop-pet\desktop.log`, with the state beside it.

| Symptom | Cause / fix |
|---|---|
| No window | Run `doctor`; read `desktop.log`; `node bin/pet.mjs start` reports which launch strategy it used |
| The window vanishes immediately | The host runs commands in a job object — the plugin switches to the WMI launcher and logs `switching to the WMI launcher` |
| Balance says "not signed in" | No DeepSeek platform account in DSH. That is a state, not an error |
| Balance stays `unknown` | The first poll has not run yet; wait one heartbeat or run `/pet quota` |
| A phone cannot open the page | Start with `dsh web --host 0.0.0.0` and use the tokenized link from `/pet url` |
| Source edits have no effect | DSH caches ES modules; restart DSH to load new plugin code |

---

## Compatibility

- **Windows 10/11** — the floating window needs WPF, which ships with .NET Framework
- **Node.js ≥ 20**
- **DSH 0.2.0-rc.2** — the plugin uses only Cordis's public conventions and DSH's documented services and events. `inject` declares only `timer`, which every profile ships; everything else attaches through `ctx.inject([...])`. No `webServer` means no web page, no `tools` means no tools, and the window still works either way.

On a non-Windows host the plugin still loads and serves the page and the tools; it simply does not try to start the window.

---

## License

MIT — see [LICENSE](LICENSE).

The bundled mascot is original artwork drawn in code. If you supply your own picture, make sure you have the right to use it.
