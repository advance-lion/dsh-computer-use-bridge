import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkerSession } from '../lib/worker-session.js'

test('worker inherits the calling model route and reasoning effort, with explicit overrides taking precedence', async () => {
  const selected = []
  const ctx = { get: () => ({
    create: async () => {}, selectModel: async (request) => selected.push(request),
  }) }
  const parent = { options: { provider: 'test-provider', model: 'gpt-6-luna', reasoningEffort: 'low' } }
  await createWorkerSession(ctx, parent, { workerPreset: 'computer-use' }, 'worker-1')
  assert.deepEqual(selected[0], { sessionId: 'worker-1', provider: 'test-provider', model: 'gpt-6-luna', reasoningEffort: 'low' })
  await createWorkerSession(ctx, parent, { workerPreset: 'computer-use', workerProvider: 'explicit', workerModel: 'explicit-model' }, 'worker-2')
  assert.deepEqual(selected[1], { sessionId: 'worker-2', provider: 'explicit', model: 'explicit-model' })
})
