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
import {
  canUseSessionWorker,
  cancelWorkerSession,
  createWorkerSession,
  createWorkerSessionId,
  notifyParentTaskSettled,
  promptWorkerSession,
  readWorkerResult,
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

function resumePrompt(task, input) {
  return [
    `Resume the same desktop task from where it was interrupted.`,
    ``,
    `Goal: ${task.args.goal}`,
    task.args.app ? `Target application: ${task.args.app}` : undefined,
    `Stop condition: ${task.args.stop_condition}`,
    ``,
    `First look at the current screen. Continue only the unfinished work; do not repeat`,
    `actions that already succeeded. Stop and report when the original stop condition is met.`,
    input.instruction ? `Additional instruction: ${input.instruction}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
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

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const scheduler = sharedScheduler()
  const tasks = new Map()
  const sessionWorkers = canUseSessionWorker(ctx)

  function interruptWorker(task, authority) {
    if (task.kind === 'session') {
      cancelWorkerSession(ctx, task.childId)
      return
    }
    ctx.subagents.interrupt(task.childId, authority)
  }

  async function releaseTaskDesktop(task) {
    if (!task.leaseHeld) return
    clearTimeout(task.budget)
    task.budget = undefined
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
      await releaseTaskDesktop(task)
      task.settling = undefined

      if (options.paused && task.kind === 'session') {
        task.status = 'paused'
        task.pauseRequested = false
        task.pausedReason = options.reason ?? 'user'
        return
      }

      task.finished = true
      tasks.delete(task.taskId)
      if (options.notify && task.kind === 'session') {
        const result = await readWorkerResult(ctx, task.childId)
        notifyParentTaskSettled(task.parent, task.childId, result)
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

  async function pauseTask(task, reason) {
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
    task.status = 'pausing'
    try {
      interruptWorker(task, { kind: 'user', parentSessionId: task.sessionId })
    } catch (error) {
      task.status = 'running'
      task.pauseRequested = false
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
      'Returns as soon as the worker starts; its result arrives as a completion notice.',
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
          status: { type: 'string', enum: ['started', 'queued'] },
          childId: { type: 'string' },
          waitedSeconds: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['taskId', 'status', 'childId'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Desktop task ${value.taskId} started in the background (worker ${value.childId}).` +
            (value.waitedSeconds ? ` It waited ${value.waitedSeconds}s for the desktop.` : '') +
            (value.note ? `\n${value.note}` : ''),
        },
      ],
    },
    isConcurrencySafe: () => false,
    timeoutMs: (config.maxWaitSeconds + 60) * 1000,
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
      const running = [...tasks.values()].filter(
        (task) => task.sessionId === sessionId && (task.status === 'queued' || task.status === 'running'),
      )
      if (running.length >= config.maxTasksPerSession) {
        throw new Error(
          `This session already has ${running.length} desktop task(s) in flight (limit ${config.maxTasksPerSession}). ` +
            'Wait for the completion notice before submitting another.',
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
          await createWorkerSession(ctx, agent, config, record.childId)
          record.previousOwner = readScreenOwner()
          writeScreenOwner(record.childId)
          record.status = 'running'
          record.startedAt = Date.now()
          armBudget(record)
          await promptWorkerSession(ctx, record.childId, workerPrompt(args, config), exec.signal)
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
        tasks.delete(taskId)
        await releaseTaskDesktop(record)
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
          waiting: { type: 'integer' },
          ownTasks: { type: 'integer' },
          workerPresetReady: { type: 'boolean' },
        },
        required: ['busy', 'waiting', 'ownTasks', 'workerPresetReady'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.busy
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
        (task) => task.sessionId === sessionId && (task.status === 'queued' || task.status === 'running'),
      ).length
      const probe = await probeWorkerPreset(ctx, config.workerPreset)
      return { busy: scheduler.busy, waiting: scheduler.queueLength, ownTasks: own, workerPresetReady: probe.available }
    },
  })

  registerTool({
    name: 'computer_task_cancel',
    description:
      'Stop one desktop task this session submitted: a waiting task leaves the queue, a running task is interrupted. ' +
      'Use it when the user changes their mind or the worker is stuck. Stopping your own turn also cancels your desktop tasks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'The task id returned by computer_task.' },
      },
      required: ['task_id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          result: { type: 'string', enum: ['cancelled_queued', 'interrupted', 'cancelled', 'not_found'] },
        },
        required: ['taskId', 'result'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.result === 'not_found'
              ? `No desktop task ${value.taskId} belongs to this session.`
              : value.result === 'cancelled_queued'
                ? `Desktop task ${value.taskId} left the queue.`
                : value.result === 'cancelled'
                  ? `Desktop task ${value.taskId} was cancelled and cannot be resumed.`
                  : `Desktop task ${value.taskId} is being interrupted.`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args, exec) {
      const sessionId = exec.agent ? String(exec.agent.id) : ''
      const task = tasks.get(args.task_id)
      if (!task || task.sessionId !== sessionId) return { taskId: args.task_id, result: 'not_found' }
      if (task.status === 'queued') {
        scheduler.cancelQueued(task.taskId)
        tasks.delete(task.taskId)
        return { taskId: task.taskId, result: 'cancelled_queued' }
      }
      if (task.status === 'paused') {
        tasks.delete(task.taskId)
        return { taskId: task.taskId, result: 'cancelled' }
      }
      if (task.childId) {
        try {
          task.hardCancel = true
          task.pauseRequested = false
          task.status = 'cancelling'
          interruptWorker(task, { kind: 'user', parentSessionId: sessionId })
        } catch (error) {
          throw new Error(`Could not interrupt the worker: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return { taskId: task.taskId, result: 'interrupted' }
    },
  })

  registerTool({
    name: 'computer_task_pause',
    description:
      'Pause one running desktop task so it can be continued later in the same worker session. ' +
      'Pausing cancels the active worker turn, releases the desktop lease, and keeps the GUI session context. ' +
      'Use this when the user asks to stop for now but may want to continue. Queued tasks cannot be resumed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'The task id returned by computer_task.' },
      },
      required: ['task_id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          result: {
            type: 'string',
            enum: ['cancelled_queued', 'pausing', 'paused', 'not_found', 'unsupported'],
          },
        },
        required: ['taskId', 'result'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.result === 'not_found'
              ? `No desktop task ${value.taskId} belongs to this session.`
              : value.result === 'cancelled_queued'
                ? `Desktop task ${value.taskId} was removed before it started and cannot be resumed.`
                : value.result === 'paused'
                  ? `Desktop task ${value.taskId} is already paused.`
                  : value.result === 'unsupported'
                    ? `Desktop task ${value.taskId} is running on the legacy subagent backend, which cannot preserve a resumable worker session.`
                    : `Desktop task ${value.taskId} is stopping. Wait for it to pause before resuming.`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args, exec) {
      const sessionId = exec.agent ? String(exec.agent.id) : ''
      const task = tasks.get(args.task_id)
      if (!task || task.sessionId !== sessionId) return { taskId: args.task_id, result: 'not_found' }
      return { taskId: task.taskId, result: await pauseTask(task, 'user') }
    },
  })

  registerTool({
    name: 'computer_task_resume',
    description:
      'Resume a paused desktop task in the same worker session, preserving everything the worker already saw and did. ' +
      'The task waits for the desktop FIFO slot again. Use this only after the user asks to continue.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'The paused task id returned by computer_task.' },
        instruction: {
          type: 'string',
          description: 'Optional extra instruction for how to continue from the interrupted state.',
        },
        timeout_seconds: {
          type: 'integer',
          description: `How long the resumed task may wait for a busy desktop. Default ${config.maxWaitSeconds}.`,
        },
      },
      required: ['task_id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string', enum: ['resumed'] },
          childId: { type: 'string' },
          waitedSeconds: { type: 'number' },
        },
        required: ['taskId', 'status', 'childId'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Desktop task ${value.taskId} resumed in worker ${value.childId}.` +
            (value.waitedSeconds ? ` It waited ${value.waitedSeconds}s for the desktop.` : ''),
        },
      ],
    },
    isConcurrencySafe: () => false,
    timeoutMs: (config.maxWaitSeconds + 60) * 1000,
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('computer_task_resume needs a session context.')
      const sessionId = String(agent.id)
      const task = tasks.get(args.task_id)
      if (!task || task.sessionId !== sessionId) {
        throw new Error(`No paused desktop task ${args.task_id} belongs to this session.`)
      }
      if (task.kind !== 'session') {
        throw new Error('This task used the legacy subagent backend and has no resumable worker session.')
      }
      if (task.status === 'pausing') {
        throw new Error('The desktop task is still stopping. Wait for it to reach the paused state, then resume it.')
      }
      if (task.status !== 'paused') {
        throw new Error(`Desktop task ${task.taskId} is ${task.status}, not paused.`)
      }

      const maxWaitMs = Math.min(
        Math.max(1, args.timeout_seconds ?? config.maxWaitSeconds) * 1000,
        config.maxWaitSeconds * 1000,
      )
      task.status = 'resuming'
      task.parent = agent
      task.finished = false
      task.settling = undefined

      let grant
      try {
        grant = await acquireTaskDesktop(task, exec.signal, maxWaitMs)
      } catch (error) {
        task.status = 'paused'
        throw error
      }

      try {
        task.previousOwner = readScreenOwner()
        writeScreenOwner(task.childId)
        task.status = 'running'
        task.pauseRequested = false
        task.hardCancel = false
        task.pausedReason = undefined
        task.startedAt = Date.now()
        armBudget(task)
        await promptWorkerSession(ctx, task.childId, resumePrompt(task, args), exec.signal)
      } catch (error) {
        await releaseTaskDesktop(task)
        task.status = 'paused'
        throw new Error(`Could not resume the desktop worker: ${error instanceof Error ? error.message : String(error)}`)
      }

      return {
        taskId: task.taskId,
        status: 'resumed',
        childId: task.childId,
        waitedSeconds: Math.round(grant.waitedMs / 1000),
      }
    },
  })

  // Route worker turn ends back into the task lease, and make stopping the calling
  // turn pause a resumable worker instead of leaving it clicking in the background.
  const disposeAbortListener = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const sessionId = sessionIdOf(session)
    if (sessionId === '') return

    const workerTask = [...tasks.values()].find(
      (task) => task.childId === sessionId
        && (task.status === 'running' || task.status === 'pausing' || task.status === 'cancelling'),
    )
    if (workerTask) {
      if (workerTask.hardCancel) {
        settleInBackground(workerTask, { notify: false })
      } else if (workerTask.pauseRequested) {
        settleInBackground(workerTask, { paused: true, reason: workerTask.pausedReason })
      } else {
        settleInBackground(workerTask, { notify: true })
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
        void pauseTask(task, 'user').catch(() => {})
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

  return () => {
    for (const dispose of disposers) dispose()
  }
}
