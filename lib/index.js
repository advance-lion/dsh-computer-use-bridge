/**
 * Desktop fallback bridge (Host half).
 *
 * Exposes one delegation tool to every agent that is allowed to use it, and keeps
 * desktop work serialized: a task owns the desktop from admission until its worker
 * session settles. Structured routes stay the default; this is the fallback.
 *
 * @module dsh-desktop-bridge
 */

import { DesktopScheduler, DesktopBusyError, DesktopAbortedError } from './coordinator.js'
import { claimDesktopControl } from './control-channel.js'
import { SCREEN_OWNER, probeWorkerPreset, missingPresetMessage } from './orb-compat.js'
import { explicitDesktopRequest, MARKER_HINT } from './trigger.js'
import { TaskGate } from './task-gate.js'
import { startStopShortcut } from './stop-shortcut.js'
import {
  archiveWorkerSession,
  canUseSessionWorker,
  cancelWorkerSession,
  createWorkerSession,
  createWorkerSessionId,
  injectParentTaskTrace,
  notifyParentTaskSettled,
  promptWorkerSession,
  readWorkerResult,
  readWorkerTrace,
} from './worker-session.js'

/** Cordis plugin name. */
export const name = 'desktop-bridge'

/** Services required at apply time. */
export const inject = ['tools', 'subagents']

const DEFAULTS = {
  mode: 'auto',
  workerPreset: 'computer-use',
  spawnProvider: 'spawn',
  maxWaitSeconds: 300,
  maxRunSeconds: 600,
  maxTasksPerSession: 1,
  workerProvider: undefined,
  workerModel: undefined,
  stopShortcut: true,
}

function positiveNumber(value, fallback, label) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite number > 0`)
  }
  return value
}

function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  if (typeof config.stopShortcut !== 'boolean') throw new Error('stopShortcut must be a boolean')
  if (!['auto', 'explicit_only', 'off'].includes(config.mode)) {
    throw new Error("mode must be 'auto', 'explicit_only', or 'off'")
  }
  config.maxWaitSeconds = positiveNumber(config.maxWaitSeconds, DEFAULTS.maxWaitSeconds, 'maxWaitSeconds')
  config.maxRunSeconds = positiveNumber(config.maxRunSeconds, DEFAULTS.maxRunSeconds, 'maxRunSeconds')
  config.maxTasksPerSession = positiveNumber(
    config.maxTasksPerSession,
    DEFAULTS.maxTasksPerSession,
    'maxTasksPerSession',
  )
  return config
}

/**
 * The scheduler is process-global: two copies of this module (HMR, two compositions)
 * must still agree on one desktop. The state lives under a `Symbol.for` key.
 */
function sharedScheduler() {
  const key = Symbol.for('dsh-desktop-bridge.scheduler')
  globalThis[key] ??= new DesktopScheduler()
  return globalThis[key]
}

/** dsh-orb publishes the session that may touch the screen under this key. */
function readScreenOwner() {
  const state = globalThis[SCREEN_OWNER]
  return typeof state?.ownerId === 'string' ? state.ownerId : undefined
}

function writeScreenOwner(ownerId) {
  const holder = globalThis
  holder[SCREEN_OWNER] ??= { ownerId: '' }
  holder[SCREEN_OWNER].ownerId = ownerId ?? ''
}

/** Agent preset of a live agent; undefined reads as "not a Computer Use session". */
function presetOf(agent) {
  try {
    const preset = agent?.session?.header?.agentPreset
    return typeof preset === 'string' && preset !== '' ? preset : undefined
  } catch {
    return undefined
  }
}

function sessionIdOf(session) {
  return String(session?.header?.id ?? session?.id ?? '')
}

function workerPrompt(input, config) {
  return [
    `You are the desktop worker for one delegated task. The user is present at the machine.`,
    ``,
    `Goal: ${input.goal}`,
    input.app ? `Target application: ${input.app}` : undefined,
    `Stop condition: ${input.stop_condition}`,
    input.alternatives?.length
      ? `Structured routes already ruled out: ${input.alternatives.join('; ')}`
      : undefined,
    ``,
    `Rules for this task:`,
    `- Work only toward the goal; do not start unrelated work.`,
    `- Stop and report when the stop condition is met, when you are blocked, or when a`,
    `  confirmation would commit a payment, a send, a delete, or a permission change.`,
    `- Never ask the user through the screen; report back instead.`,
    `- Your final message is the whole result: state the verified outcome, what is left,`,
    `  and any side effect you caused. Keep it short.`,
    `- You have at most ${Math.round(config.maxRunSeconds)}s of desktop time.`,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

export function apply(ctx, rawConfig, dependencies = {}) {
  const config = resolveConfig(rawConfig)
  const scheduler = sharedScheduler()
  const tasks = new Map()
  const workerGates = new Map()
  const stoppedParents = new Set()
  const startShortcut = dependencies.startStopShortcut ?? startStopShortcut
  const sessionWorkers = canUseSessionWorker(ctx)

  function interruptWorker(task, authority) {
    if (task.kind === 'session') {
      return cancelWorkerSession(ctx, task.childId)
    }
    ctx.subagents.interrupt(task.childId, authority)
  }

  async function releaseTaskDesktop(task) {
    if (!task.leaseHeld) return
    clearTimeout(task.budget)
    task.budget = undefined
    task.gate?.stop()
    await task.gate?.whenIdle()
    await task.detachStopControl?.()
    task.detachStopControl = undefined
    if (readScreenOwner() === task.childId) writeScreenOwner(task.previousOwner)
    task.previousOwner = undefined
    try {
      await task.control?.dispose?.()
    } catch (error) {
      console.error(
        `[desktop-bridge] could not release Computer Use task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      task.control = undefined
      task.leaseHeld = false
      scheduler.release(task.taskId)
    }
  }

  async function settleTask(task, options = {}) {
    if (task.finished) return
    if (task.settling) return task.settling
    task.settling = (async () => {
      try {
        await releaseTaskDesktop(task)
        if (task.abortListener) {
          task.signal?.removeEventListener('abort', task.abortListener)
          task.abortListener = undefined
        }

        if (task.kind === 'session') {
          const status = task.hardCancel
            ? 'cancelled'
            : options.paused
              ? 'paused'
              : 'completed'
          const reason = options.reason ?? (status === 'paused' ? 'user' : undefined)
          const result = await readWorkerTrace(ctx, task, { status, reason })
          await archiveWorkerSession(ctx, task.childId)
          task.status = status
          task.finished = true
          task.pauseRequested = false
          tasks.delete(task.taskId)
          if (status === 'paused' && task.parentStopped) {
            injectParentTaskTrace(task.parent, task.childId, result)
          }
          task.outcome?.resolve({ status, result })
          return
        }

        const result = ''
        task.finished = true
        tasks.delete(task.taskId)
        if (options.notify) notifyParentTaskSettled(task.parent, task.childId, result)
        task.outcome?.resolve({ status: task.hardCancel ? 'cancelled' : 'completed', result })
      } finally {
        task.settling = undefined
      }
    })()
    return task.settling
  }

  function settleInBackground(task, options = {}) {
    void settleTask(task, options).catch((error) => {
      console.error(
        `[desktop-bridge] task ${task.taskId} settlement failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  async function pauseTask(task, reason, source = reason) {
    if (task.status === 'queued') {
      scheduler.cancelQueued(task.taskId)
      tasks.delete(task.taskId)
      return 'cancelled_queued'
    }
    if (task.status === 'paused') return 'paused'
    if (task.status !== 'running') return 'pausing'

    if (task.kind !== 'session') {
      task.hardCancel = true
      task.status = 'cancelling'
      try {
        interruptWorker(task, { kind: 'user', parentSessionId: task.sessionId })
      } catch {
        // Legacy interruption is best effort; the budget still bounds it.
      }
      return 'unsupported'
    }

    task.pauseRequested = true
    task.pausedReason = reason
    task.stopSource = source
    task.stopRequestedAt = Date.now()
    task.status = 'pausing'
    task.gate?.stop()
    if (reason === 'user') stoppedParents.add(task.sessionId)
    try {
      await interruptWorker(task, { kind: 'user', parentSessionId: task.sessionId })
    } catch (error) {
      // Fail closed: new actions remain forbidden even if cancel delivery fails.
      throw error
    }
    return 'pausing'
  }

  function armBudget(task) {
    clearTimeout(task.budget)
    task.budget = setTimeout(() => {
      void pauseTask(task, 'budget').catch(() => {})
    }, config.maxRunSeconds * 1000)
    task.budget.unref?.()
  }

  async function attachStopControl(task) {
    if (!config.stopShortcut) return
    task.detachStopControl = await startShortcut((source = 'Shift+Esc') => {
      if (!task.finished && !task.settling) {
        stoppedParents.add(task.sessionId)
        return pauseTask(task, source === 'helper-loss' ? 'helper-loss' : 'user', source)
      }
    })
  }

  async function acquireTaskDesktop(task, signal, maxWaitMs) {
    let grant
    try {
      grant = await scheduler.acquire({
        taskId: task.taskId,
        sessionId: task.sessionId,
        maxWaitMs,
        signal,
      })
    } catch (error) {
      if (error instanceof DesktopBusyError || error instanceof DesktopAbortedError) throw error
      throw error
    }

    let control
    try {
      control = await claimDesktopControl()
    } catch (error) {
      scheduler.release(task.taskId)
      throw new Error(
        `Could not claim Computer Use control: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!control.owner) {
      scheduler.release(task.taskId)
      throw new Error(
        'Another DeepSeek Harness process is already controlling this desktop, so this one refuses to ' +
          'move the mouse. Close that process, or do the desktop work there. Everything else here still works.',
      )
    }

    task.control = control
    task.leaseHeld = true
    return grant
  }

  // Startup self-check: probe once now, then keep watching while it is missing, so
  // installing (or removing) dsh-orb is noticed without a restart.
  let readiness = { checked: false, available: false, reason: 'unchecked', presets: [] }
  let disposed = false

  async function refreshReadiness() {
    const probe = await probeWorkerPreset(ctx, config.workerPreset)
    if (disposed) return probe
    const wasAvailable = readiness.available
    readiness = { checked: true, ...probe }
    if (!probe.available && !wasAvailable) {
      console.warn(`[desktop-bridge] ${missingPresetMessage(config.workerPreset, config.workerPreset, probe)}`)
    }
    return probe
  }

  const disposers = []

  const detachGate = ctx.on('tools/execute', async (exec, next) => {
    const gate = workerGates.get(String(exec.agent?.id ?? ''))
    return gate ? gate.run(exec, next) : next()
  })
  if (typeof detachGate === 'function') disposers.push(detachGate)

  const detachPreGate = ctx.on('tools/pre-execute', async (exec, next) => {
    if (workerGates.get(String(exec.agent?.id ?? ''))?.controller.signal.aborted) return { kind: 'cancel' }
    return next()
  })
  if (typeof detachPreGate === 'function') disposers.push(detachPreGate)

  function registerTool(definition) {
    disposers.push(ctx.tools.register(definition))
  }

  registerTool({
    name: 'computer_task',
    description:
      'Delegate one on-screen task to a dedicated Computer Use agent that can see the screen, click and type. ' +
      'This is a last resort: it occupies the user’s desktop and costs many screenshots. ' +
      'Reach for it only when the task needs a graphical interface that is hard to verify from files or command output: ' +
      'no structured interface exists, the structured path is blocked, the outcome must be judged visually, ' +
      'or the user asked to operate the interface. ' +
      `If the user’s message contains ${MARKER_HINT}, delegate without further weighing. ` +
      'Prefer a plugin, MCP server, API, file tool or browser automation whenever one covers the task; ' +
      'only the necessary on-screen fragment belongs here, never the whole job. ' +
      'The worker is one-shot: the user can stop it with the bridge-owned global Shift+Esc shortcut, ' +
      'or the original conversation Stop button. Completion or stopping closes the worker. The returned result is a bounded trace for continuing the ' +
      'original conversation; another GUI action starts a fresh worker.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: {
          type: 'string',
          description: 'The on-screen task as one verifiable outcome, for example "import report.xlsx and confirm the success dialog".',
        },
        app: {
          type: 'string',
          description: 'Application or window the task works in, when you know it.',
        },
        stop_condition: {
          type: 'string',
          description: 'What the worker must see before it stops and reports.',
        },
        justification: {
          type: 'string',
          enum: ['no_structured_interface', 'structured_path_blocked', 'visual_validation', 'explicit_gui_request'],
          description:
            'Why the interface is needed. no_structured_interface: nothing but the UI can do it; ' +
            'structured_path_blocked: the route exists but is blocked or unauthenticated; ' +
            'visual_validation: the result must be judged by looking at it; ' +
            'explicit_gui_request: the user asked for the interface itself.',
        },
        alternatives: {
          type: 'array',
          items: { type: 'string' },
          description: 'Structured routes you ruled out, and why. Shown to the user.',
        },
        timeout_seconds: {
          type: 'integer',
          description: `How long this task may wait for a busy desktop. Default ${config.maxWaitSeconds}.`,
        },
      },
      required: ['goal', 'stop_condition', 'justification'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string', enum: ['started', 'queued', 'completed', 'paused', 'cancelled'] },
          childId: { type: 'string' },
          waitedSeconds: { type: 'number' },
          note: { type: 'string' },
          result: { type: 'string' },
        },
        required: ['taskId', 'status', 'childId'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.status === 'started'
              ? `Desktop task ${value.taskId} started in the background (worker ${value.childId}).`
              : value.status === 'paused'
                ? `Desktop task ${value.taskId} stopped and its worker was closed (${value.childId}).`
                : value.status === 'cancelled'
                  ? `Desktop task ${value.taskId} was cancelled and its worker was closed (${value.childId}).`
                  : `Desktop task ${value.taskId} completed and its worker was closed (${value.childId}).`) +
            (value.waitedSeconds ? ` It waited ${value.waitedSeconds}s for the desktop.` : '') +
            (value.note ? `\n${value.note}` : '') +
            (value.result ? `\n\n${value.result}` : ''),
        },
      ],
    },
    isConcurrencySafe: () => false,
    timeoutMs: (config.maxWaitSeconds + config.maxRunSeconds + 60) * 1000,
    async execute(args, exec) {
      if (config.mode === 'off') {
        throw new Error(
          'Desktop delegation is disabled in this profile. Do the work with structured tools, or ask the user to enable it.',
        )
      }
      const agent = exec.agent
      if (!agent) throw new Error('computer_task needs a session context.')

      // The user's own words outrank the model's judgement, so read them from the log.
      const marker = explicitDesktopRequest(agent)
      if (marker === undefined && config.mode === 'explicit_only' && args.justification !== 'explicit_gui_request') {
        throw new Error(
          `This profile only runs desktop work the user asked for: put ${MARKER_HINT} in the request, or use a structured route.`,
        )
      }

      const presetProbe = await probeWorkerPreset(ctx, config.workerPreset)
      if (!presetProbe.available) {
        throw new Error(missingPresetMessage(config.workerPreset, config.workerPreset, presetProbe))
      }

      const preset = presetOf(agent)
      if (preset === config.workerPreset) {
        throw new Error(
          'You are already the desktop worker. Do the on-screen work yourself instead of delegating again.',
        )
      }

      const sessionId = String(agent.id)
      if (stoppedParents.has(sessionId)) {
        throw new Error('The user stopped Computer Use in this turn. Do not start another desktop worker; report the stopped result and wait for the next user turn.')
      }
      const running = [...tasks.values()].filter(
        (task) => task.sessionId === sessionId && !task.finished,
      )
      if (running.length >= config.maxTasksPerSession) {
        throw new Error(
          `This session already has ${running.length} desktop task(s) in flight (limit ${config.maxTasksPerSession}). ` +
            'Wait for this task result before submitting another.',
        )
      }

      const taskId = `dt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const record = {
        taskId,
        sessionId,
        parent: agent,
        args,
        kind: sessionWorkers ? 'session' : 'subagent',
        status: 'queued',
        submittedAt: Date.now(),
        outcome: sessionWorkers ? Promise.withResolvers() : undefined,
      }
      tasks.set(taskId, record)

      const maxWaitMs = Math.min(
        Math.max(1, args.timeout_seconds ?? config.maxWaitSeconds) * 1000,
        config.maxWaitSeconds * 1000,
      )

      let grant
      try {
        grant = await acquireTaskDesktop(record, exec.signal, maxWaitMs)
      } catch (error) {
        tasks.delete(taskId)
        if (error instanceof DesktopBusyError || error instanceof DesktopAbortedError) throw error
        throw error
      }

      try {
        if (record.kind === 'session') {
          record.childId = createWorkerSessionId()
          record.gate = new TaskGate()
          workerGates.set(record.childId, record.gate)
          await createWorkerSession(ctx, agent, config, record.childId)
          record.previousOwner = readScreenOwner()
          writeScreenOwner(record.childId)
          record.status = 'running'
          record.startedAt = Date.now()
          armBudget(record)
          record.signal = exec.signal
          record.abortListener = () => {
            record.parentStopped = true
            void pauseTask(record, 'user', 'parent-stop').catch(() => {})
          }
          exec.signal.addEventListener('abort', record.abortListener, { once: true })
          await attachStopControl(record)
          if (record.pauseRequested || exec.signal.aborted) {
            record.parentStopped ||= exec.signal.aborted
            await settleTask(record, { paused: true, reason: 'user' })
          } else {
            await promptWorkerSession(ctx, record.childId, workerPrompt(args, config),
              AbortSignal.any([exec.signal, record.gate.controller.signal]))
          }
          const outcome = await record.outcome.promise
          if (record.abortListener) exec.signal.removeEventListener('abort', record.abortListener)
          return {
            taskId,
            status: outcome.status,
            childId: record.childId,
            waitedSeconds: Math.round(grant.waitedMs / 1000),
            result: outcome.result,
          }
        } else {
          const activation = await ctx.subagents.startActivation({
            provider: config.spawnProvider,
            label: `desktop: ${args.goal}`.slice(0, 120),
            request: {
              prompt: [{ type: 'text', text: workerPrompt(args, config) }],
              parent: agent,
              agentPreset: config.workerPreset,
              ...(config.workerProvider && config.workerModel
                ? { agentOptions: { provider: config.workerProvider, model: config.workerModel } }
                : {}),
            },
            signal: exec.signal,
            delivery: 'parent',
          })
          record.status = 'running'
          record.childId = String(activation.childId)
          record.startedAt = Date.now()
          record.previousOwner = readScreenOwner()
          writeScreenOwner(record.childId)
          armBudget(record)
          void activation.result.then(
            () => settleInBackground(record, { notify: false }),
            () => settleInBackground(record, { notify: false }),
          )
        }
      } catch (error) {
        if (record.abortListener) exec.signal.removeEventListener('abort', record.abortListener)
        tasks.delete(taskId)
        await releaseTaskDesktop(record)
        if (record.kind === 'session' && record.childId) {
          await archiveWorkerSession(ctx, record.childId)
        }
        throw new Error(`Could not start the desktop worker: ${error instanceof Error ? error.message : String(error)}`)
      }

      return {
        taskId,
        status: 'started',
        childId: record.childId,
        waitedSeconds: Math.round(grant.waitedMs / 1000),
        note: 'The desktop is held until this worker finishes; other desktop tasks wait in order.',
      }
    },
  })

  registerTool({
    name: 'computer_desktop_status',
    description:
      'Report whether the shared desktop is currently owned by a task, how many tasks are waiting, and whether a ' +
      'Computer Use worker preset is available. Use it before promising the user that a desktop action will start now.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          busy: { type: 'boolean' },
          stopping: { type: 'boolean' },
          waiting: { type: 'integer' },
          ownTasks: { type: 'integer' },
          workerPresetReady: { type: 'boolean' },
        },
        required: ['busy', 'stopping', 'waiting', 'ownTasks', 'workerPresetReady'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.stopping
              ? 'Computer Use is stopping; waiting for the active tool to finish cleanup. The desktop is still reserved.'
              : value.busy
              ? `The desktop is in use; ${value.waiting} task(s) are waiting.`
              : `The desktop is free; ${value.waiting} task(s) are waiting.`) +
            (value.workerPresetReady
              ? ''
              : `\nNo "${config.workerPreset}" preset is registered, so desktop delegation will refuse until dsh-orb is installed and enabled.`),
        },
      ],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 15_000,
    async execute(_args, exec) {
      const sessionId = exec.agent ? String(exec.agent.id) : ''
      const own = [...tasks.values()].filter(
        (task) => task.sessionId === sessionId && !task.finished,
      ).length
      const probe = await probeWorkerPreset(ctx, config.workerPreset)
      return { busy: scheduler.busy, stopping: [...tasks.values()].some(task => task.status === 'pausing' || task.status === 'cancelling'), waiting: scheduler.queueLength, ownTasks: own, workerPresetReady: probe.available }
    },
  })

  // Route worker turn ends back into the task lease. Stopping the calling turn
  // also interrupts the worker; settlement then closes and archives it.
  const disposeAbortListener = ctx.on('session/event', (session, event) => {
    const sessionId = sessionIdOf(session)
    if (sessionId === '') return
    if (event?.type === 'turn/start') { stoppedParents.delete(sessionId); return }
    if (event?.type !== 'turn/end') return

    const workerTask = [...tasks.values()].find(
      (task) => task.childId === sessionId
        && (task.status === 'running' || task.status === 'pausing' || task.status === 'cancelling'),
    )
    if (workerTask) {
      workerTask.gate?.stop()
      if (workerTask.hardCancel) {
        settleInBackground(workerTask, { notify: false })
      } else if (workerTask.pauseRequested) {
        settleInBackground(workerTask, {
          paused: true,
          reason: workerTask.pausedReason,
        })
      } else if (
        event.data?.reason?.kind === 'aborted'
        && event.data?.reason?.reason?.kind === 'user'
      ) {
        // Direct cancellation returns through the still-active parent's tool call.
        workerTask.pauseRequested = true
        workerTask.pausedReason = 'user'
        workerTask.status = 'pausing'
        stoppedParents.add(workerTask.sessionId)
        settleInBackground(workerTask, {
          paused: true,
          reason: 'user',
        })
      } else if (event.data?.reason?.kind !== 'completed') {
        settleInBackground(workerTask, {
          paused: true,
          reason: `worker:${String(event.data?.reason?.kind ?? 'unknown')}`,
        })
      } else {
        settleInBackground(workerTask, { notify: false })
      }
    }

    if (event.data?.reason?.kind !== 'aborted') return
    for (const task of [...tasks.values()]) {
      if (task.sessionId !== sessionId) continue
      if (task.status === 'queued') {
        scheduler.cancelQueued(task.taskId)
        tasks.delete(task.taskId)
        continue
      }
      if (!task.childId) continue
      if (task.kind === 'session') {
        task.parentStopped = true
        void pauseTask(task, 'user', 'parent-stop').catch(() => {})
      } else {
        task.hardCancel = true
        task.status = 'cancelling'
        try {
          interruptWorker(task, { kind: 'user', parentSessionId: sessionId })
        } catch {
          // The media may already be gone; the budget timer still bounds the worker.
        }
      }
    }
  })
  if (typeof disposeAbortListener === 'function') disposers.push(disposeAbortListener)

  // Startup self-check surface: one prompt line while the worker preset is missing, so
  // the model can tell the user how to make desktop work possible instead of failing
  // the first time someone asks for it. The section is empty once everything is ready.
  const promptRegistry = ctx.get?.('systemPrompt')
  const disposeSection = promptRegistry?.section?.({
    name: 'desktop-bridge-readiness',
    order: 2400,
    text: () => {
      if (!readiness.checked || readiness.available) return ''
      return [
        'Desktop fallback note: the desktop delegation tool set is installed, but it cannot run.',
        `Reason: ${missingPresetMessage(config.workerPreset, config.workerPreset, readiness)}`,
        'Tell the user plainly that on-screen work needs the dsh-orb plugin installed and enabled in this profile,',
        'and that after installing it they can simply ask for the interface action again — no restart of the session is needed.',
        'Do not claim a desktop action happened.',
      ].join(' ')
    },
  })
  if (typeof disposeSection === 'function') disposers.push(disposeSection)

  void refreshReadiness()
  const poll = setInterval(() => {
    if (!disposed && !readiness.available) void refreshReadiness()
  }, 30_000)
  poll.unref?.()
  disposers.push(() => clearInterval(poll))

  disposers.push(
    ctx.effect(() => async () => {
      disposed = true
      const pending = [...tasks.values()]
      for (const task of pending) {
        if (task.status === 'queued') {
          scheduler.cancelQueued(task.taskId)
          tasks.delete(task.taskId)
          continue
        }
        if (task.childId) {
          try {
            task.hardCancel = true
            task.status = 'cancelling'
            interruptWorker(task, { kind: 'user', parentSessionId: task.sessionId })
          } catch {
            // Absent targets are accepted no-ops.
          }
        }
      }
      await Promise.all(
        pending
          .filter((task) => task.status === 'running' || task.status === 'pausing' || task.status === 'cancelling')
          .map((task) => settleTask(task, { notify: false })),
      )
    }),
  )

  return async () => {
    for (const dispose of [...disposers].reverse()) await dispose?.()
  }
}
