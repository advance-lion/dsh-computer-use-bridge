/**
 * Resumable Computer Use worker sessions.
 *
 * The worker is an ordinary DSH session composed with the GUI preset. Pausing
 * cancels only its active turn; the durable session and its transcript remain
 * available for a later continuation prompt.
 *
 * @module dsh-desktop-bridge/worker-session
 */

import { randomUUID } from 'node:crypto'

/** @param {object} ctx Cordis context. */
function controllerOf(ctx) {
  return ctx.get?.('sessionController')
}

/** Whether this DSH version exposes the resumable SessionController surface. */
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

/** Queue one prompt into the existing worker session, waking it if cold. */
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

/** Interrupt the worker's active turn without discarding the durable session. */
export function cancelWorkerSession(ctx, sessionId) {
  const controller = controllerOf(ctx)
  if (controller === undefined) return
  controller.cancel({ sessionId })
}

/** Extract the newest non-empty assistant text from the durable worker log. */
export async function readWorkerResult(ctx, sessionId) {
  const controller = controllerOf(ctx)
  if (typeof controller?.inspect !== 'function') return ''
  try {
    const inspection = await controller.inspect(sessionId)
    const events = Array.isArray(inspection?.events) ? inspection.events : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'assistant/message') continue
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text !== '') return text
    }
  } catch {
    // Completion reporting is best effort; the durable worker session remains visible.
  }
  return ''
}

/**
 * Queue a host-authored completion notice into the parent Agent. Keeping the
 * subagent-settled source preserves the existing UI and wake-up semantics used
 * by continuable subagents.
 */
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
