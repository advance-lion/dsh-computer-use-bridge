/**
 * One-shot Computer Use worker sessions.
 *
 * A worker is an ordinary DSH session composed with the GUI preset. It exists
 * for exactly one `computer_task` invocation. Completion, Escape, budget
 * expiry and explicit cancellation all close and archive the worker.
 *
 * @module dsh-desktop-bridge/worker-session
 */

import { randomUUID } from 'node:crypto'

const MAX_TRACE_CHARS = 12_000
const MAX_TRACE_LINE_CHARS = 1_200

/** @param {object} ctx Cordis context. */
function controllerOf(ctx) {
  return ctx.get?.('sessionController')
}

/** Whether this DSH version exposes the SessionController surface we need. */
export function canUseSessionWorker(ctx) {
  const controller = controllerOf(ctx)
  return typeof controller?.create === 'function'
    && typeof controller.prompt === 'function'
    && typeof controller.cancel === 'function'
}

/** Allocate a stable worker session identity before its first prompt is admitted. */
export function createWorkerSessionId() {
  return `desktop-${randomUUID()}`
}

/**
 * Create the worker session in its GUI preset and optionally select its model.
 * The caller reserves the screen before sending the first prompt.
 */
export async function createWorkerSession(ctx, parent, config, sessionId) {
  const controller = controllerOf(ctx)
  if (controller === undefined) throw new Error('sessionController is unavailable')
  const cwd = parent?.session?.header?.cwd
  await controller.create({
    sessionId,
    ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    agentPreset: config.workerPreset,
  })
  if (config.workerProvider && config.workerModel) {
    await controller.selectModel({
      sessionId,
      provider: config.workerProvider,
      model: config.workerModel,
    })
  }
}

/** Queue one prompt into the freshly created worker session. */
export async function promptWorkerSession(ctx, sessionId, text, signal) {
  const controller = controllerOf(ctx)
  if (controller === undefined) throw new Error('sessionController is unavailable')
  await controller.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, signal)
}

/** Interrupt the worker's active turn. The caller closes the worker afterwards. */
export function cancelWorkerSession(ctx, sessionId) {
  const controller = controllerOf(ctx)
  if (controller === undefined) return
  controller.cancel({ sessionId })
}

/**
 * Archive a finished worker so the main conversation remains the only active
 * task. The durable log and image attachments remain available in history.
 */
export async function archiveWorkerSession(ctx, sessionId) {
  const workspace = ctx.get?.('workspaceRegistry')
  if (typeof workspace?.archiveSession !== 'function') return false
  try {
    await workspace.archiveSession(sessionId, { stopActivity: true })
    return true
  } catch (error) {
    console.warn(
      `[desktop-bridge] could not archive Computer Use worker ${sessionId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
    return false
  }
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function imagesFromContent(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'image')
}

function imageReference(block) {
  const attachment = block?.attachment
  if (!attachment || typeof attachment !== 'object') return 'screenshot'
  const name = typeof attachment.name === 'string' && attachment.name !== ''
    ? attachment.name
    : 'screenshot'
  const dimensions = Number.isFinite(attachment.width) && Number.isFinite(attachment.height)
    ? ` ${attachment.width}x${attachment.height}`
    : ''
  const id = typeof attachment.attachmentId === 'string' ? ` id=${attachment.attachmentId}` : ''
  return `${name}${dimensions}${id}`
}

function compact(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= MAX_TRACE_LINE_CHARS) return text
  return `${text.slice(0, MAX_TRACE_LINE_CHARS - 1)}…`
}

function callIdOf(resultEvent) {
  const message = resultEvent?.data?.message
  return String(message?.toolCallId ?? message?.source?.callId ?? resultEvent?.data?.callId ?? '')
}

function collectWorkerEvidence(inspection) {
  const events = Array.isArray(inspection?.events) ? inspection.events : []
  const pendingCalls = new Map()
  const toolEntries = []
  let latestAssistant = ''
  let screenshotCount = 0
  const screenshots = []

  for (const event of events) {
    if (event?.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '')
      if (callId !== '') {
        pendingCalls.set(callId, {
          name: String(event.data?.name ?? 'tool'),
          arguments: compact(event.data?.arguments),
        })
      }
      continue
    }

    if (event?.type === 'tool/result') {
      const callId = callIdOf(event)
      const call = pendingCalls.get(callId)
      if (call !== undefined) pendingCalls.delete(callId)
      const content = event.data?.message?.content
      const text = textFromContent(content)
      const images = imagesFromContent(content)
      screenshotCount += images.length
      for (const image of images) screenshots.push(imageReference(image))
      toolEntries.push({
        name: call?.name ?? 'tool',
        arguments: call?.arguments ?? '',
        result: text,
        error: event.data?.error !== undefined
          ? compact(event.data.error.reason ?? event.data.error.code ?? 'tool failed')
          : event.data?.message?.isError
            ? 'tool failed'
            : '',
      })
      continue
    }

    if (event?.type === 'assistant/message') {
      const text = textFromContent(event.data?.message?.content)
      if (text !== '') latestAssistant = text
    }
  }

  for (const call of pendingCalls.values()) {
    toolEntries.push({
      name: call.name,
      arguments: call.arguments,
      result: '',
      error: 'no result was recorded before the worker stopped',
    })
  }

  return { toolEntries, latestAssistant, screenshotCount, screenshots }
}

function truncateTrace(text) {
  if (text.length <= MAX_TRACE_CHARS) return text
  const marker = '\n… middle of trace omitted because it exceeded the context budget …\n'
  const available = MAX_TRACE_CHARS - marker.length
  const headLength = Math.floor(available * 0.45)
  const tailLength = available - headLength
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`
}

function outcomeText(status, reason) {
  if (status === 'cancelled') return 'Outcome: the task was explicitly cancelled.'
  if (status === 'paused' && reason === 'user') {
    return 'Pause event: the user pressed Escape. The worker was interrupted and the desktop lease was released.'
  }
  if (status === 'paused' && reason === 'budget') {
    return 'Stop event: the desktop time budget was exhausted. The worker was interrupted and the desktop lease was released.'
  }
  if (status === 'paused') {
    return `Stop event: the worker stopped without completing (${String(reason ?? 'unknown')}). The desktop lease was released.`
  }
  return 'Outcome: the worker completed its turn and released the desktop.'
}

/**
 * Build a bounded evidence handoff for the original conversation.
 *
 * Image bytes are deliberately represented only by their durable references;
 * copying every screenshot into the parent transcript would flood its context.
 */
export async function readWorkerTrace(ctx, task, options = {}) {
  const controller = controllerOf(ctx)
  let inspection
  if (typeof controller?.inspect === 'function') {
    try {
      inspection = await controller.inspect(task.childId)
    } catch {
      // The durable session may already be closing. The task metadata still
      // gives the parent a truthful, useful handoff.
    }
  }

  const evidence = collectWorkerEvidence(inspection)
  const status = options.status ?? 'completed'
  const lines = [
    `Computer Use worker closed for task ${task.taskId}.`,
    outcomeText(status, options.reason),
    `Goal: ${task.args.goal}`,
    task.args.app ? `Target application: ${task.args.app}` : undefined,
    `Stop condition: ${task.args.stop_condition}`,
    `Worker session: ${task.childId}`,
  ].filter((line) => line !== undefined)

  if (evidence.screenshotCount > 0) {
    lines.push(
      `Screen observations captured by the worker: ${evidence.screenshotCount}. ` +
        'Image bytes are not copied into this handoff; the durable references remain in the worker history.',
    )
    const latestImages = evidence.screenshots.slice(-2)
    if (latestImages.length > 0) lines.push(`Latest screen references: ${latestImages.join('; ')}`)
  }

  if (evidence.toolEntries.length > 0) {
    lines.push('Tool trace in execution order:')
    for (const [index, entry] of evidence.toolEntries.entries()) {
      const args = entry.arguments === '' ? '' : ` ${entry.arguments}`
      const result = entry.result === '' ? '' : ` => ${entry.result}`
      const error = entry.error === '' ? '' : ` [${entry.error}]`
      lines.push(`${index + 1}. ${entry.name}${args}${result}${error}`)
    }
  } else {
    lines.push('Tool trace: no tool calls were recorded before the worker closed.')
  }

  if (evidence.latestAssistant !== '') {
    lines.push(`Latest worker message: ${evidence.latestAssistant}`)
  }

  lines.push(
    'The worker session is closed and is not resumable. Continue from this evidence in the original conversation. ' +
      'If another on-screen action is still needed, submit a new computer_task; its fresh worker will observe the current screen again.',
  )

  return truncateTrace(lines.join('\n'))
}

/**
 * Put a paused worker's evidence into the original conversation without waking
 * it. The user's next ordinary message naturally picks up this context.
 */
export function injectParentTaskTrace(parent, childId, trace) {
  if (parent === undefined || typeof parent.inject !== 'function') return false
  const summary = 'Computer Use worker paused by Escape; its bounded trace was returned.'
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: trace }],
    source: {
      kind: 'subagent-settled',
      form: 'notice',
      summary,
      senderSessionId: childId,
    },
  }
  try {
    parent.inject(deepFreeze(message))
    return true
  } catch (error) {
    console.warn(
      `[desktop-bridge] could not return the paused Computer Use trace to ${String(parent.id ?? 'parent')}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
    return false
  }
}

/** Legacy fallback: extract the newest non-empty assistant text from a worker. */
export async function readWorkerResult(ctx, sessionId) {
  const controller = controllerOf(ctx)
  if (typeof controller?.inspect !== 'function') return ''
  try {
    const inspection = await controller.inspect(sessionId)
    const evidence = collectWorkerEvidence(inspection)
    return evidence.latestAssistant
  } catch {
    return ''
  }
}

/** Legacy fallback for DSH versions that still expose the old subagent path. */
export function notifyParentTaskSettled(parent, childId, text) {
  if (typeof parent?.followup !== 'function') return
  const closing = text.trim()
  const summary = closing === '' ? 'Desktop task finished.' : closing.slice(0, 119)
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [
      { type: 'text', text: summary },
      ...(closing === '' ? [] : [{ type: 'text', text: 'Its closing message:' }, { type: 'text', text: closing }]),
    ],
    source: {
      kind: 'subagent-settled',
      form: 'notice',
      summary,
      senderSessionId: childId,
    },
  }
  parent.followup(deepFreeze(message))
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
