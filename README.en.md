<div align="center">

<img src="icon.svg" width="88" alt="Desktop Fallback Bridge">

# Desktop Fallback Bridge

**Give DSH the same Computer Use you get from Codex, on Windows and macOS.**

See the screen · Click · Type · Across apps — from one conversation entry point

[中文](README.md) | **English**

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0078d4)
![Execution](https://img.shields.io/badge/execution-dsh--orb-6b46c1)
![Tools](https://img.shields.io/badge/GUI%20tools-13-2f9e44)

</div>

---

## In one sentence

DSH writes code and runs commands, but it **cannot see what is on your screen**, and it cannot click a single button.

[dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) provides the actual executor: screen capture, mouse, keyboard, 13 GUI tools.

**This plugin is the layer in between** — one entry point that lets any session hand off the part that needs hands, with the guarantee that exactly **one controller drives the desktop at a time**.

```text
your session ──computer_task──▶ desktop worker ──▶ screenshot / click / type
     │                                  │
     └──── result + verification ◀──────┘
```

---

## Aligned with Codex's Computer Use

| Capability | Codex | dsh-orb + this plugin |
| --- | --- | --- |
| See the screen (target-window capture) | ✅ | ✅ every step starts from the latest frame |
| Click / double / right / drag / scroll | ✅ | ✅ |
| Typing, chords, press-and-hold | ✅ | ✅ |
| Identify foreground app, list apps, launch apps | ✅ | ✅ |
| Workflows spanning several apps | ✅ | ✅ (one scoped stage at a time) |
| Explicit `@Computer` invocation | ✅ | ✅ `@computer` / `@desktop` |
| Structured integrations first (plugin / MCP) | ✅ | ✅ built into the tool criteria |
| One executor on the desktop | platform-level | ✅ task lease + cross-process claim |
| Stops when you stop | ✅ | ✅ Bridge-owned Shift+Esc or original chat Stop, returning the trace |
| Per-task budget cap | ✅ | ✅ time-and-queue limits, configurable |
| Independent cursor, background operation | macOS background; Windows foreground-only | macOS (dsh-orb background); Windows (dsh-orb foreground-only) |
| Per-action human confirmation | ✅ | ⚠️ partial: budget and stop, no per-click prompt yet |

> In short: **the execution surface is on par with Codex; the scheduling and safety model is rebuilt for how DSH actually runs.**
> Platform behavior and per-action confirmation limits are listed under Boundaries.

---

## Why a bridge layer is needed

dsh-orb already built the hands. What was missing is the **session layer**:

- Who owns the desktop right now? What happens when another session submits?
- The user hits stop halfway through — is the desktop agent still clicking?
- Two DSH processes are open. Which one wins?
- The dependency is missing — how does the user find out before it matters?

This plugin answers those four: **task-level lease, FIFO queue, cross-process claim, cancellation that follows your stop, and a startup self-check.**

---

## Install

```sh
dsh plugin add dsh-orb              # 1. the executor (required)
dsh plugin add dsh-desktop-bridge  # 2. the bridge (this repo)
```

Both cards show up in the plugin page, with the bridge reporting **running**:

<p align="center">
  <img src="docs/media/plugin-card.png" width="760" alt="Desktop Fallback Bridge in the DSH plugin page, status running">
</p>

Then just ask:

> Work out 7×8 in the calculator for me

When you want it to **act without deliberating**, tag it:

> **@computer** dismiss that dialog

---

## A real run

An actual run, recorded on a secondary display: the task was handed to a desktop worker session, which pressed `C` → `7` → `×` → `8` → `=` key by key. **The result was not computed by the model — it was read back from the calculator UI.**

<p align="center">
  <img src="docs/media/desktop-task.gif" width="720" alt="The desktop worker pressing C, 7, ×, 8, = on a calculator and reading back 56">
</p>

<sub>Recorded at 1 frame per ~0.4 s and played back slightly faster than real time. Only the target display is captured.</sub>

The still frame below is the verified end state:

<p align="center">
  <img src="docs/media/calculator-7x8.png" width="260" alt="Calculator showing 7 × 8 = 56, produced by the desktop worker">
</p>

---

## Stopping: the trace returns to the original chat

Use **Shift+Esc**, registered by bridge's own native helper, or the original chat Stop button.
Stock orb is sufficient. No orb modifications, private protocol, floating ball, or orb runtime path is required.
The shortcut is enabled by default for each task and removed on release or disconnect. Startup/conflict
failures prevent GUI work from starting; `stopShortcut: false` opts into original-chat Stop only.
Unexpected helper exit stops the task. Windows is verified; the macOS native path still needs device acceptance.
Bare Escape and the stock orb ball Stop button are not bridge-wide stop controls.

Bridge closes the worker's tool gate, aborts the signal delivered to active tools, and cancels the worker.
After worker `turn/end`, it also waits for entered tool promises and cleanup before releasing the lease.
Desktop status reports `stopping` while cleanup is pending. The shortcut leaves the caller alive so the
trace returns as the tool result, and prevents that caller from restarting GUI work in the same turn.
The tool calls, results, errors, latest worker message, and latest screenshot references from before the pause
are reduced to a bounded trace. If the parent turn itself was stopped, the trace is instead injected through
`parent.inject()` without waking the model. The user does not need to manage a resume command.

| Outcome | Action | Next step |
| --- | --- | --- |
| Shift+Esc | Block new worker calls, abort active calls, wait for settlement, archive and return the trace | No more CMU in this parent turn |
| Parent turn stops | Stop worker, wait for cleanup, archive and inject trace without waking | The next ordinary user message has the trace |
| `maxRunSeconds` is reached | Interrupt, release, archive, and return the stop reason plus trace as the tool result | The original Agent continues from the evidence or starts a fresh worker |
| Worker ends with `error`, `max-tokens`, `refusal`, or another non-complete reason | Close and archive it, returning the failure and available trace | The original Agent chooses another route or retries |
| Worker completes normally | Archive it and return the completion status plus bounded trace as the tool result | The original Agent answers the user |
| Parent chat stops while queued | Remove it without creating a worker | Terminated; ball and shortcut target the running task only |

There is no `computer_task_resume`. Like a one-shot subagent, a GUI worker serves exactly one `computer_task`.
The complete worker log and image attachments remain in archived history, but every screenshot is not copied
into the parent context. The next GUI action starts a new worker and observes the current screen again because
the page may have changed while the previous worker was away.

Current DSH still provides one-shot `ctx.subagents.start()`, but bridge also has to select dsh-orb's
`computer-use` preset at creation. The public one-shot subagent request has no preset option, so bridge uses
`sessionController.create()` to create a GUI session that lives for one invocation. Session is the mechanism
that exposes the preset; it does not change the one-shot, dispose-after-use subagent lifecycle.

`computer_task` keeps the current parent turn active while the worker runs. A
normal completion returns through the tool result. When the user aborts the parent turn, that result cannot
be delivered reliably, so the pause path injects the trace instead of asking the user to say “continue”.

Stopping cannot undo input already delivered to the OS. Current-action cancellation depends on stock orb.
Bridge does not abandon execution promises, release a still-busy desktop, or kill the DSH host to stop a worker.
Zero-latency interruption and rollback are not guaranteed.

---

## When it actually gets used

The criterion is borrowed from Codex: **when a task depends on a graphical interface that cannot be verified from files or command output alone**, hand it to the GUI.

| Need | Route |
| --- | --- |
| Code changes, file reads, batch renames | file / shell |
| A plugin, MCP server, API or skill exists | structured interface |
| Web content | fetch / browser automation |
| A setting only reachable by clicking | **this plugin** |
| A bug that only reproduces in a GUI | **this plugin** |
| A workflow spanning several apps | **this plugin** |
| Looking at the screen / "what am I doing" | screenshot + image read, not this |

**On a full-access Windows machine it gets used less than you would expect** — `pwsh` can call Win32, capture the screen, and drive UI Automation. That is by design: it takes over your desktop only when something genuinely needs a hand.

---

## Boundaries

> **This repository contains no Computer Use implementation.** Capture, clicking and typing all come from dsh-orb. This package only bridges, queues, and enforces limits.
> **Install dsh-orb first**, otherwise `computer_task` refuses and tells you why.

- **Not for observation.** "What am I doing right now" is answered faster and more accurately by a shell screenshot plus an image read, without occupying the desktop.
- **No preemption.** A busy desktop means queueing or timing out, never interrupting a running task.
- **Not cross-machine.** It drives the host desktop, not the device your browser runs on.
- **Not everything is automatable.** Terminal apps, DSH itself, and admin-authorised system dialogs are out of scope.
- **Windows is foreground-only.** It really takes over pointer and keyboard; dsh-orb provides macOS background operation, while bridge adds no independent cursor of its own.
- **macOS requires system permissions.** Screen Recording lets dsh-orb see windows, and Accessibility lets it click
  and type. Grant them to the DeepSeek Harness app or the terminal process hosting dsh-orb.

---

## How ownership works

```text
submit → queue → acquire lease → desktop worker → release → next
```

- **Task-level exclusivity**, not per-click locking. Otherwise A opens a form, B switches windows, and A types into the wrong one.
- **FIFO by default**; the model cannot jump the queue.
- **Cross-process**: an OS-level exclusive handle (a Windows named pipe, or a Unix domain socket on macOS/Linux) is held for one `computer_task` at a time and released when that worker settles.
- **Mutual exclusion with the floating ball**: whichever side holds the desktop, the other yields.
- **Stops with you**: stopping the conversation interrupts the desktop worker too.

### Lock granularity

Windows and macOS use the same task-level semantics. An idle plugin holds nothing; after winning
the FIFO slot it acquires a cross-process Computer Use lease, and releases it after the worker
settles, is cancelled, or fails to start. Only then may the next task begin.

| Layer | Windows | macOS |
| --- | --- | --- |
| In-process task queue | FIFO, one CMU task | FIFO, one CMU task |
| Cross-process lease | One `computer_task` lifetime | One `computer_task` lifetime |
| OS primitive | Windows named pipe | Unix domain socket |
| Crash residue | Vanishes with the process | Probe the listener; remove only a stale socket |
| Idle state | Does not reserve desktop control | Does not reserve desktop control |

The OS handle belongs to a process, but the lease belongs to one task. It is not held from plugin
load until process exit.

---

## Configuration

`config` in `cordis.patch.yml`:

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto` applies the criteria; `explicit_only` requires the marker; `off` disables |
| `workerPreset` | `computer-use` | Preset for the worker session, supplied by dsh-orb |
| `maxWaitSeconds` | `300` | Longest queue wait while the desktop is busy |
| `maxRunSeconds` | `600` | Longest time one task may hold the desktop |
| `maxTasksPerSession` | `1` | Concurrent in-flight tasks per session |
| `stopShortcut` | `true` | Bridge-owned global Shift+Esc; false uses original-chat Stop only |
| `workerProvider` / `workerModel` | inherited | Worker model, **must accept image input** |

---

## Compatibility

| Item | Note |
| --- | --- |
| DSH | 0.2.x (verified on the desktop app) |
| Platform | Windows / macOS; dsh-orb supplies screen and input, while macOS uses a Unix domain socket task lease |
| Requires | **dsh-orb ≥ 0.2.0** (supplies the `computer-use` preset) |
| Coupling | Only the preset id and the `screen-owner` record; **no dsh-orb code is imported**, so an upgrade cannot break loading |

If the preset is renamed or missing, the plugin says so in a startup self-check and keeps telling the model *why* and *how to fix it* — instead of failing the first time someone asks for the interface.

---

## Known issues

- **The worker can click an occluded window.** In the first real run the calculator sat behind another window and a few clicks landed in an editor, opening a stray tab (which it then closed). Bring the target app to the front, or say so in the task.
- **No native status panel.** State is available through `computer_desktop_status`.
- **Pause ends the worker.** This is deliberate: the GUI may change while the worker is away, so the next GUI
  action starts a fresh worker and observes the current screen instead of restoring stale page assumptions.

---

## Development

```sh
node --test --test-concurrency=1 "test/*.test.mjs"
```

Tests cover scheduling, task leases, one-shot trace handoff, tool cancellation and quiescence, same-turn restart prevention, independent shortcut lifecycle/conflicts, marker parsing, and missing-dependency behavior.

Design rationale and the full verification record: [docs/design-notes.md](docs/design-notes.md).

---

## License

MIT.
