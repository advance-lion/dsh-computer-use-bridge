import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { startStopShortcut } from '../lib/stop-shortcut.js'

function fake() {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  child.connected = true
  child.exitCode = null
  child.send = (message, callback) => {
    callback?.()
    if (message.type === 'dispose') queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0) })
  }
  child.kill = () => { child.exitCode = 1; child.emit('exit', 1) }
  return child
}

test('shortcut waits for readiness, ignores late messages and disposes its own child', async () => {
  const child = fake()
  let calls = 0
  const starting = startStopShortcut(() => { calls++ }, { spawn: () => child })
  child.emit('message', { type: 'stop' })
  child.emit('message', { type: 'ready' })
  const dispose = await starting
  assert.equal(calls, 0)
  child.emit('message', { type: 'stop' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  await dispose()
  child.emit('message', { type: 'stop' })
  assert.equal(calls, 1)
})

test('registration conflicts fail startup and helper loss stops the active task', async () => {
  const failed = fake()
  const starting = startStopShortcut(() => assert.fail(), { spawn: () => failed })
  failed.emit('message', { type: 'error', error: 'registration conflict' })
  await assert.rejects(starting, /registration conflict/)
  const child = fake()
  let calls = 0
  const running = startStopShortcut(() => { calls++ }, { spawn: () => child })
  child.emit('message', { type: 'ready' })
  const dispose = await running
  child.kill()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  await dispose()
})

test('native shortcut registers, detects a real conflict and unregisters on task release', {
  skip: process.platform !== 'win32',
}, async () => {
  let calls = 0
  const dispose = await startStopShortcut(() => { calls++ })
  try {
    await assert.rejects(startStopShortcut(() => {}), /registration failed/)
    assert.equal(calls, 0)
  } finally { await dispose() }
  const again = await startStopShortcut(() => { calls++ })
  await again()
  assert.equal(calls, 0, 'cleanup must not look like a user stop')
})
