import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'

// Keep this process's desktop-control channel namespaced: the real Harness may be
// holding the production one while the suite runs.
process.env.DSH_DESKTOP_BRIDGE_CHANNEL = `dsh-desktop-bridge.test.${process.pid}`
const { apply } = await import('../lib/index.js')
const { desktopControlAddress, releaseDesktopControl } = await import('../lib/control-channel.js')

const SCHEDULER_KEY = Symbol.for('dsh-desktop-bridge.scheduler')
const OWNER_KEY = Symbol.for('dsh-orb.screen-owner')
const CONTROL_KEY = Symbol.for('dsh-desktop-bridge.control')

function reset() {
  delete globalThis[SCHEDULER_KEY]
  delete globalThis[OWNER_KEY]
}

function makeAgent(id, preset) {
  const notices = []
  return {
    id,
    session: { header: { agentPreset: preset } },
    notices,
    followup(message) {
      notices.push(message)
    },
  }
}

/** Minimal Cordis context: only the surfaces the plugin touches. */
function makeContext(options = {}) {
  const tools = new Map()
  const handlers = new Map()
  const sections = new Map()
  const interrupts = []
  const activations = []
  const sessions = new Map()
  const prompts = []
  const cancels = []
  const presets = options.presets ?? ['standard', 'computer-use']
  const sessionController = options.sessionWorker
    ? {
        async create(request) {
          sessions.set(request.sessionId, { ...request })
          return { sessionId: request.sessionId, agentPreset: request.agentPreset }
        },
        async selectModel() {
          return { selected: {} }
        },
        async prompt(request) {
          prompts.push(request)
          return { accepted: true }
        },
        cancel(request) {
          cancels.push(request)
          return { accepted: true }
        },
        async inspect() {
          return {
            events: [{
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: 'desktop task result' }] } },
            }],
          }
        },
      }
    : undefined

  const ctx = {
    tools: {
      register(definition) {
        assert.equal(tools.has(definition.name), false, `duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    subagents: {
      async startActivation(spec) {
        if (options.startError) throw options.startError
        const childId = `child-${activations.length + 1}`
        let settle
        const result = new Promise((resolve) => {
          settle = resolve
        })
        const activation = { childId, messageId: 'm1', result, dispose: async () => {} }
        activations.push({ spec, activation, settle })
        return activation
      },
      interrupt(targetId) {
        interrupts.push(targetId)
      },
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(fn) {
      return fn()
    },
    get(name) {
      if (name === 'agentPresets') return { list: async () => presets.map((id) => ({ id })) }
      if (name === 'sessionController') return sessionController
      if (name === 'systemPrompt') {
        return {
          section(section) {
            sections.set(section.name, section)
            return () => sections.delete(section.name)
          },
        }
      }
      return undefined
    },
  }

  return {
    ctx,
    tools,
    handlers,
    sections,
    interrupts,
    activations,
    sessions,
    prompts,
    cancels,
    finishAll: () => activations.forEach((a) => a.settle({ stopReason: 'completed', output: [] })),
  }
}

function taskArgs(overrides = {}) {
  return {
    goal: 'click Export',
    stop_condition: 'the success dialog is visible',
    justification: 'no_structured_interface',
    ...overrides,
  }
}

const execFor = (agent) => ({ agent, signal: new AbortController().signal, callId: 'c', rootCallId: 'c' })

/** An agent whose newest user turn is `text`, so the marker reader has something to read. */
const agentWithText = (id, preset, text) => ({
  id,
  session: {
    header: { agentPreset: preset },
    events: [{ type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }],
  },
})

test('registers the task lifecycle tools', () => {
  reset()
  const { ctx, tools } = makeContext()
  const cleanup = apply(ctx, {})
  assert.deepEqual([...tools.keys()].sort(), [
    'computer_desktop_status',
    'computer_task',
    'computer_task_cancel',
    'computer_task_pause',
    'computer_task_resume',
  ])
  cleanup()
})

test('mode off refuses delegation', async () => {
  reset()
  const { ctx, tools } = makeContext()
  apply(ctx, { mode: 'off' })
  await assert.rejects(tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard'))), /disabled/)
})

test('explicit_only refuses anything but an explicit interface request', async () => {
  reset()
  const { ctx, tools } = makeContext()
  apply(ctx, { mode: 'explicit_only' })
  const tool = tools.get('computer_task')
  await assert.rejects(tool.execute(taskArgs(), execFor(makeAgent('s1', 'standard'))), /@computer/)
  const started = await tool.execute(
    taskArgs({ justification: 'explicit_gui_request' }),
    execFor(makeAgent('s1', 'standard')),
  )
  assert.equal(started.status, 'started')
})

test('a missing worker preset refuses clearly instead of failing inside a child session', async () => {
  reset()
  const { ctx, tools } = makeContext({ presets: ['standard', 'minimal'] })
  apply(ctx, { workerPreset: 'computer-use' })

  await assert.rejects(
    tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard'))),
    (error) => {
      assert.match(error.message, /install and enable dsh-orb/i)
      assert.match(error.message, /standard, minimal/)
      return true
    },
  )

  const status = await tools.get('computer_desktop_status').execute({}, execFor(makeAgent('s1', 'standard')))
  assert.equal(status.workerPresetReady, false)
})

test('the startup self-check tells the model why desktop work is unavailable', async () => {
  reset()
  const { ctx, sections } = makeContext({ presets: ['standard'] })
  apply(ctx, {})

  const section = sections.get('desktop-bridge-readiness')
  assert.ok(section, 'the plugin must register its readiness section at load')
  // The probe is asynchronous; wait for it like the first prompt assembly would.
  await new Promise((resolve) => setTimeout(resolve, 20))

  const text = section.text()
  assert.match(text, /dsh-orb/)
  assert.match(text, /installed and enabled/)
  assert.match(text, /Do not claim a desktop action happened/)
})

test('the readiness section stays empty when the preset exists', async () => {
  reset()
  const { ctx, sections } = makeContext()
  apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sections.get('desktop-bridge-readiness').text(), '')
})

test('installing the preset later is noticed without a restart', async () => {
  reset()
  const presets = ['standard']
  const { ctx, tools, sections } = makeContext({ presets })
  apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.notEqual(sections.get('desktop-bridge-readiness').text(), '')
  await assert.rejects(
    tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard'))),
    /dsh-orb/,
  )

  // dsh-orb becomes available; enforcement re-probes on every submission.
  presets.push('computer-use')
  const started = await tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard')))
  assert.equal(started.status, 'started')
})

test('an explicit @computer in the user message bypasses the explicit_only gate', async () => {
  reset()
  const { ctx, tools } = makeContext()
  apply(ctx, { mode: 'explicit_only' })

  // The marker comes from the user's own message, not from the model's justification.
  const started = await tools
    .get('computer_task')
    .execute(
      taskArgs({ justification: 'no_structured_interface' }),
      execFor(agentWithText('s1', 'standard', '@computer 帮我把这个窗口关掉')),
    )
  assert.equal(started.status, 'started')
})

test('explicit_only still refuses a plain request with no marker', async () => {
  reset()
  const { ctx, tools } = makeContext()
  apply(ctx, { mode: 'explicit_only' })
  await assert.rejects(
    tools
      .get('computer_task')
      .execute(
        taskArgs({ justification: 'no_structured_interface' }),
        execFor(agentWithText('s1', 'standard', '帮我把这个窗口关掉')),
      ),
    /@computer/,
  )
})

test('the desktop worker cannot delegate again', async () => {  reset()
  const { ctx, tools } = makeContext()
  apply(ctx, {})
  await assert.rejects(
    tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s2', 'computer-use'))),
    /already the desktop worker/,
  )
})

test('a second session waits for the first, then starts with the real wait time', async () => {
  reset()
  const { ctx, tools, activations, finishAll } = makeContext()
  apply(ctx, { maxWaitSeconds: 5 })
  const tool = tools.get('computer_task')

  const first = await tool.execute(taskArgs({ goal: 'first' }), execFor(makeAgent('s1', 'standard')))
  assert.equal(first.waitedSeconds, 0)

  const secondRun = tool.execute(taskArgs({ goal: 'second' }), execFor(makeAgent('s2', 'standard')))
  await new Promise((resolve) => setTimeout(resolve, 30))

  // Still queued: only one activation exists.
  assert.equal(activations.length, 1)

  // The first worker releases the desktop.
  for (const a of activations) a.settle({ stopReason: 'completed', output: [] })
  const second = await secondRun

  assert.equal(second.status, 'started')
  assert.equal(activations.length, 2)
  assert.equal(activations[1].spec.request.agentPreset, 'computer-use')
  assert.equal(activations[1].spec.provider, 'spawn')
  finishAll()
})

test('a queued task is visible as waiting, and the holder is reported busy', async () => {
  reset()
  const { ctx, tools, activations } = makeContext()
  apply(ctx, { maxWaitSeconds: 5 })

  await tools.get('computer_task').execute(taskArgs({ goal: 'holder' }), execFor(makeAgent('s1', 'standard')))
  const queuedRun = tools.get('computer_task').execute(taskArgs({ goal: 'waiter' }), execFor(makeAgent('s2', 'standard')))
  queuedRun.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 30))

  const status = await tools.get('computer_desktop_status').execute({}, execFor(makeAgent('s1', 'standard')))
  assert.equal(status.busy, true)
  assert.equal(status.waiting, 1)
  assert.equal(status.ownTasks, 1)
  assert.equal(status.workerPresetReady, true)
  assert.equal(activations.length, 1)

  activations[0].settle({ stopReason: 'completed', output: [] })
  await queuedRun
})

test('cancelling a running task interrupts its worker, and only for its own session', async () => {
  reset()
  const { ctx, tools, interrupts } = makeContext()
  apply(ctx, {})

  const started = await tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard')))
  const cancel = tools.get('computer_task_cancel')

  const foreign = await cancel.execute({ task_id: started.taskId }, execFor(makeAgent('s2', 'standard')))
  assert.equal(foreign.result, 'not_found')
  assert.deepEqual(interrupts, [])

  const own = await cancel.execute({ task_id: started.taskId }, execFor(makeAgent('s1', 'standard')))
  assert.equal(own.result, 'interrupted')
  assert.deepEqual(interrupts, ['child-1'])
})

test('stopping the calling turn interrupts its worker', async () => {
  reset()
  const { ctx, tools, activations, handlers, interrupts } = makeContext()
  apply(ctx, {})
  await tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard')))
  assert.equal(interrupts.length, 0)

  const onSessionEvent = handlers.get('session/event')
  onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.deepEqual(interrupts, ['child-1'])

  // Another session's abort must not touch this worker.
  onSessionEvent({ header: { id: 'other' } }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  assert.deepEqual(interrupts, ['child-1'])
  activations.forEach((a) => a.settle({ stopReason: 'completed', output: [] }))
})

test('the worker keeps the screen owner while it runs and restores it after', async () => {
  reset()
  globalThis[OWNER_KEY] = { ownerId: 'ball-session' }
  const { ctx, tools, activations } = makeContext()
  apply(ctx, {})
  await tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard')))
  assert.equal(globalThis[OWNER_KEY].ownerId, 'child-1')
  activations[0].settle({ stopReason: 'completed', output: [] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(globalThis[OWNER_KEY].ownerId, 'ball-session')
})

test('cross-process control is a task lease, not a plugin-process claim', async () => {
  reset()
  await releaseDesktopControl()

  const { ctx, tools, activations } = makeContext()
  const cleanup = apply(ctx, {})

  assert.equal(
    globalThis[CONTROL_KEY]?.attempt,
    undefined,
    'loading the plugin must not reserve the desktop while no task is running',
  )

  await tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard')))
  assert.notEqual(
    globalThis[CONTROL_KEY]?.attempt,
    undefined,
    'the running task must hold cross-process control',
  )

  activations[0].settle({ stopReason: 'completed', output: [] })
  for (let attempt = 0; attempt < 20 && globalThis[CONTROL_KEY]?.attempt !== undefined; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(
    globalThis[CONTROL_KEY]?.attempt,
    undefined,
    'settling the worker must release cross-process control for the next process',
  )

  await cleanup()
})

test('worker-start failure releases both task queues', async () => {
  reset()
  await releaseDesktopControl()

  const { ctx, tools } = makeContext({ startError: new Error('worker failed') })
  const cleanup = apply(ctx, {})

  await assert.rejects(
    tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard'))),
    /Could not start the desktop worker: worker failed/,
  )
  const status = await tools.get('computer_desktop_status').execute({}, execFor(makeAgent('s1', 'standard')))
  assert.equal(status.busy, false)
  assert.equal(status.waiting, 0)
  assert.equal(globalThis[CONTROL_KEY]?.attempt, undefined)

  await cleanup()
})

test('a foreign process conflict is detected per task and does not leave the local queue held', async () => {
  reset()
  await releaseDesktopControl()

  const foreign = await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(desktopControlAddress(), () => resolve(server))
  })
  const { ctx, tools } = makeContext()
  const cleanup = apply(ctx, {})

  try {
    await assert.rejects(
      tools.get('computer_task').execute(taskArgs(), execFor(makeAgent('s1', 'standard'))),
      /Another DeepSeek Harness process/,
    )
    const status = await tools.get('computer_desktop_status').execute({}, execFor(makeAgent('s1', 'standard')))
    assert.equal(status.busy, false)
    assert.equal(status.waiting, 0)
  } finally {
    await new Promise((done) => foreign.close(done))
    await cleanup()
  }
})

test('pause keeps the worker session and resume continues it from the same context', async () => {
  reset()
  await releaseDesktopControl()

  const parent = makeAgent('s1', 'standard')
  const {
    ctx,
    tools,
    handlers,
    sessions,
    prompts,
    cancels,
  } = makeContext({ sessionWorker: true })
  const cleanup = apply(ctx, {})

  const started = await tools.get('computer_task').execute(taskArgs(), execFor(parent))
  assert.equal(sessions.get(started.childId).agentPreset, 'computer-use')
  assert.equal(prompts.length, 1)

  const paused = await tools
    .get('computer_task_pause')
    .execute({ task_id: started.taskId }, execFor(parent))
  assert.equal(paused.result, 'pausing')
  assert.deepEqual(cancels, [{ sessionId: started.childId }])

  handlers.get('session/event')(
    { header: { id: started.childId } },
    { type: 'turn/end', data: { reason: { kind: 'aborted' } } },
  )
  for (let attempt = 0; attempt < 20 && globalThis[CONTROL_KEY]?.attempt !== undefined; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(globalThis[CONTROL_KEY]?.attempt, undefined)

  const resumed = await tools.get('computer_task_resume').execute(
    { task_id: started.taskId, instruction: 'Finish the export dialog.' },
    execFor(parent),
  )
  assert.equal(resumed.status, 'resumed')
  assert.equal(resumed.childId, started.childId)
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1].sessionId, prompts[0].sessionId)
  assert.match(prompts[1].content[0].text, /Resume the same desktop task/)
  assert.match(prompts[1].content[0].text, /Finish the export dialog/)

  handlers.get('session/event')(
    { header: { id: started.childId } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  )
  for (let attempt = 0; attempt < 20 && parent.notices.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(parent.notices.length, 1)
  assert.equal(parent.notices[0].source.kind, 'subagent-settled')

  await cleanup()
})

test('stopping the calling turn pauses a resumable session worker', async () => {
  reset()
  await releaseDesktopControl()

  const parent = makeAgent('s1', 'standard')
  const { ctx, tools, handlers, sessions, cancels } = makeContext({ sessionWorker: true })
  const cleanup = apply(ctx, {})
  const started = await tools.get('computer_task').execute(taskArgs(), execFor(parent))

  handlers.get('session/event')(
    { header: { id: 's1' } },
    { type: 'turn/end', data: { reason: { kind: 'aborted' } } },
  )
  assert.deepEqual(cancels, [{ sessionId: started.childId }])

  handlers.get('session/event')(
    { header: { id: started.childId } },
    { type: 'turn/end', data: { reason: { kind: 'aborted' } } },
  )
  await new Promise((resolve) => setImmediate(resolve))

  const resumed = await tools.get('computer_task_resume').execute(
    { task_id: started.taskId },
    execFor(parent),
  )
  assert.equal(resumed.status, 'resumed')
  assert.equal(sessions.has(started.childId), true)

  await tools.get('computer_task_cancel').execute({ task_id: started.taskId }, execFor(parent))
  await cleanup()
})

test('a recoverable worker error pauses instead of completing the task', async () => {
  reset()
  await releaseDesktopControl()

  const parent = makeAgent('s1', 'standard')
  const { ctx, tools, handlers } = makeContext({ sessionWorker: true })
  const cleanup = apply(ctx, {})
  const started = await tools.get('computer_task').execute(taskArgs(), execFor(parent))

  handlers.get('session/event')(
    { header: { id: started.childId } },
    { type: 'turn/end', data: { reason: { kind: 'error' } } },
  )
  for (let attempt = 0; attempt < 20 && parent.notices.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(parent.notices.length, 1)
  assert.match(parent.notices[0].content[0].text, /paused after worker:error/)

  const resumed = await tools.get('computer_task_resume').execute(
    { task_id: started.taskId, instruction: 'Retry after the transient error.' },
    execFor(parent),
  )
  assert.equal(resumed.status, 'resumed')

  await tools.get('computer_task_cancel').execute({ task_id: started.taskId }, execFor(parent))
  await cleanup()
})
