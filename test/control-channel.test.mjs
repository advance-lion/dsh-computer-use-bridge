import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'

process.env.DSH_DESKTOP_BRIDGE_CHANNEL = `dsh-desktop-bridge.test.${process.pid}`
const {
  claimDesktopControl,
  desktopControlAddress,
  releaseDesktopControl,
} = await import('../lib/control-channel.js')

/** Stands in for a second Host process holding the desktop. */
function foreignHolder() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(desktopControlAddress(), () => resolve(server))
  })
}

test('a second plugin instance in the same process shares the claim instead of fighting for it', async () => {
  await releaseDesktopControl()
  const first = await claimDesktopControl()
  const second = await claimDesktopControl()
  assert.equal(first.owner, true)
  assert.equal(second.owner, true, 'an HMR reload must not lock the process out of its own desktop')

  await first.dispose()
  const third = await claimDesktopControl()
  assert.equal(third.owner, true, 'the claim survives while another instance still holds it')

  await second.dispose()
  await third.dispose()
  await releaseDesktopControl()
})

test('another process holding the desktop makes this process refuse', async () => {
  await releaseDesktopControl()
  const foreign = await foreignHolder()
  const messages = []
  const claim = await claimDesktopControl({ onConflict: (message) => messages.push(message) })

  assert.equal(claim.owner, false)
  assert.equal(claim.reason, 'EADDRINUSE')
  assert.equal(messages.length, 1)
  assert.match(messages[0], /Another DeepSeek Harness process/)

  await new Promise((done) => foreign.close(done))
  await releaseDesktopControl()
})

test('control is reclaimable once the other process lets go', async () => {
  await releaseDesktopControl()
  const foreign = await foreignHolder()
  const refused = await claimDesktopControl()
  assert.equal(refused.owner, false)
  await new Promise((done) => foreign.close(done))

  const claim = await claimDesktopControl()
  assert.equal(claim.owner, true)
  await claim.dispose()
  await releaseDesktopControl()
})

test('state left by a pre-chain HMR instance is upgraded in place', async () => {
  await releaseDesktopControl()
  const stateKey = Symbol.for('dsh-desktop-bridge.control')
  const previous = globalThis[stateKey]
  globalThis[stateKey] = { attempt: undefined, refs: 0 }

  try {
    const claim = await claimDesktopControl()
    assert.equal(claim.owner, true)
    await claim.dispose()
  } finally {
    await releaseDesktopControl()
    if (previous === undefined) delete globalThis[stateKey]
    else globalThis[stateKey] = previous
  }
})
