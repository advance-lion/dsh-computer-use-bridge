import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskGate } from '../lib/task-gate.js'

test('stop aborts active signal, blocks late calls and waits for finally cleanup', async () => {
  const gate = new TaskGate()
  const parent = new AbortController()
  const exec = { signal: parent.signal }
  const cleanup = Promise.withResolvers()
  let released = false
  const running = gate.run(exec, async () => {
    try {
      await new Promise((resolve) => exec.signal.addEventListener('abort', resolve, { once: true }))
    } finally { await cleanup.promise; released = true }
  })
  gate.stop()
  let idle = false
  const idlePromise = gate.whenIdle().then(() => { idle = true })
  await assert.rejects(gate.run({ signal: parent.signal }, async () => assert.fail()), /stopped/)
  await Promise.resolve()
  assert.equal(idle, false)
  assert.equal(released, false)
  cleanup.resolve()
  await Promise.all([running, idlePromise])
  assert.equal(released, true)
  assert.equal(exec.signal, parent.signal)
})

test('ordinary caller cancellation and thrown errors retain signal and release tracking', async () => {
  const gate = new TaskGate()
  const parent = new AbortController()
  const exec = { signal: parent.signal }
  await assert.rejects(gate.run(exec, async () => {
    parent.abort()
    exec.signal.throwIfAborted()
  }), { name: 'AbortError' })
  await gate.whenIdle()
  assert.equal(exec.signal, parent.signal)
  assert.equal(gate.controller.signal.aborted, false)
})
