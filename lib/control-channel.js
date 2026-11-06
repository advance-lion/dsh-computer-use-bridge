/**
 * Cross-process desktop control ownership.
 *
 * The in-process scheduler cannot see another Host process (a second DSH window, or the
 * CLI beside the desktop app), and neither can dsh-orb's action lock — both live on
 * `globalThis`. One physical desktop must still have one controller, so ownership is
 * claimed with an exclusive OS handle: a named pipe on Windows, a domain socket elsewhere.
 *
 * Claims are task-scoped, but the OS handle belongs to the process. An HMR reload can
 * replace the plugin while an old task still holds that handle, so live claims are
 * refcounted and kept in a process-global record instead of module state.
 *
 * Failure to claim is not a crash; the plugin keeps working and refuses desktop delegation
 * with an explanation.
 */

import net from 'node:net'
import { unlink } from 'node:fs/promises'

const CHANNEL = process.env.DSH_DESKTOP_BRIDGE_CHANNEL || 'dsh-desktop-bridge.control'
const STATE = Symbol.for('dsh-desktop-bridge.control')

/** The OS address that represents "control of this desktop". */
export function desktopControlAddress() {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${CHANNEL}` : `${process.env.TMPDIR ?? '/tmp'}/${CHANNEL}.sock`
}

function state() {
  const holder = globalThis
  let shared = holder[STATE]
  if (shared === null || typeof shared !== 'object') {
    shared = { attempt: undefined, refs: 0, chain: Promise.resolve() }
    holder[STATE] = shared
    return shared
  }

  // HMR can leave state from an older plugin build. Normalize it instead of
  // assuming that every shared-state field introduced by this build exists.
  if (typeof shared.chain?.then !== 'function') shared.chain = Promise.resolve()
  if (!Number.isInteger(shared.refs) || shared.refs < 0) shared.refs = 0
  return shared
}

/**
 * Serialize claim/release so an HMR reload cannot race its own previous socket:
 * releasing is asynchronous, and a claim that starts before the close lands would
 * see EADDRINUSE from this very process.
 */
function runExclusive(shared, task) {
  const next = shared.chain.then(task, task)
  shared.chain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function listen(address) {
  return new Promise((resolve) => {
    const server = net.createServer()
    const fail = (error) => {
      server.removeAllListeners()
      try {
        server.close()
      } catch {
        // Already closed.
      }
      resolve({ owner: false, reason: error?.code ?? 'unknown' })
    }
    server.once('error', fail)
    server.listen(address, () => {
      server.removeAllListeners('error')
      server.on('error', () => {})
      server.unref?.()
      resolve({
        owner: true,
        dispose: async () => {
          await new Promise((done) => server.close(() => done()))
          if (process.platform !== 'win32') await unlink(address).catch(() => {})
        },
      })
    })
  })
}

/**
 * Probe whether a Unix socket path has a live listener.
 *
 * EADDRINUSE alone cannot distinguish a live owner from a socket left behind by a
 * crashed process. Treat every response except an explicit refusal/missing path as
 * live, so an uncertain probe fails closed instead of stealing another process's
 * control path.
 */
function socketIsLive(address) {
  return new Promise((resolve) => {
    const socket = net.connect(address)
    let settled = false
    const finish = (live) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(live)
    }

    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(true))
    socket.once('error', (error) => {
      finish(
        error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' || error?.code === 'ENOTSOCK'
          ? false
          : true,
      )
    })
    socket.setTimeout(250)
  })
}

async function claimOnce(options) {
  const address = desktopControlAddress()
  let result = await listen(address)
  // A crashed POSIX process leaves its socket file behind; Windows pipes vanish with it.
  if (!result.owner && process.platform !== 'win32' && result.reason === 'EADDRINUSE') {
    if (!await socketIsLive(address)) {
      await unlink(address).catch(() => {})
      result = await listen(address)
    }
  }
  if (!result.owner) {
    options.onConflict?.(
      'Another DeepSeek Harness process is controlling this desktop. Close it, or use that process for desktop work.',
    )
  }
  return result
}

/**
 * Claim desktop control for this process, sharing it with other plugin instances.
 * @param {{ onConflict?: (message: string) => void }} [options]
 */
export async function claimDesktopControl(options = {}) {
  const shared = state()
  return runExclusive(shared, async () => {
    shared.attempt ??= claimOnce(options)
    const attempt = shared.attempt
    let result
    try {
      result = await attempt
    } catch (error) {
      if (shared.attempt === attempt) shared.attempt = undefined
      throw error
    }
    if (!result.owner) {
      // Conflict is a fact about this attempt, not a permanent property of the
      // process: the other Host may exit before the next task is submitted.
      if (shared.attempt === attempt) shared.attempt = undefined
      return result
    }

    shared.refs += 1
    let released = false
    return {
      owner: true,
      dispose: () =>
        runExclusive(shared, async () => {
          if (released) return
          released = true
          shared.refs -= 1
          if (shared.refs > 0) return
          const pending = shared.attempt
          shared.attempt = undefined
          const claim = await pending
          await claim?.dispose?.()
        }),
    }
  })
}

/** Drop this process's claim entirely (feature disabled, or a deliberate handover). */
export async function releaseDesktopControl() {
  const shared = state()
  return runExclusive(shared, async () => {
    const pending = shared.attempt
    shared.attempt = undefined
    shared.refs = 0
    const claim = await pending
    await claim?.dispose?.()
  })
}
