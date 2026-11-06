import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'

// Keep this process's desktop-control channel namespaced: the real Harness may be
// holding the production one while the suite runs.
process.env.DSH_DESKTOP_BRIDGE_CHANNEL = `dsh-desktop-bridge.test.${process.pid}`
const { apply } = await import('../lib/index.js')
const { desktopControlAddress, releaseDesktopControl } = await import('../lib/control-channel.js')
const { readWorkerTrace } = await import('../lib/worker-session.js')

const SCHEDULER_KEY = Symbol.for('dsh-desktop-bridge.scheduler')
const OWNER_KEY = Symbol.for('dsh-orb.screen-owner')
const CONTROL_KEY = Symbol.for('dsh-desktop-bridge.control')

function reset() {
  delete globalThis[SCHEDULER_KEY]
  delete globalThis[OWNER_KEY]
}

function makeAgent(id, preset) {
  const notices = []
  const injected = []
  return {
    id,
    session: { header: { agentPreset: preset } },
    notices,
    injected,
    followup(message) {
      notices.push(message)
    },
    inject(message) {
      injected.push(message)
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
  const workerEvents = new Map()
  const prompts = []
  const cancels = []
  const archives = []
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
        async inspect(sessionId) {
          return {
            events: workerEvents.get(sessionId) ?? [{
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: 'desktop task result' }] } },
            }],
          }
        },
      }
    : undefined

  const workspaceRegistry = {
    async archiveSession(sessionId, options) {
      archives.push({ sessionId, options })
    },
  }

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
      if (name === 'workspaceRegistry') return workspaceRegistry
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
    workerEvents,
    prompts,
    cancels,
    archives,
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

async function waitFor(condition, message) {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(condition(), true, message)
}

/** An agent whose newest user turn is `text`, so the marker reader has something to read. */
const agentWithText = (id, preset, text) => ({
  id,
  session: {
    header: { agentPreset: preset },
    events: [{ type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }],
  },
})

function workerTraceEvents() {
  return [
    {
      type: 'tool/call',
      data: { callId: 'call-1', name: 'screenshot', arguments: '{"app":"Calculator"}' },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          toolCallId: 'call-1',
          source: { kind: 'tool', callId: 'call-1' },
          content: [
            { type: 'text', text: 'Calculator shows 56 after pressing equals.' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'img-1',
                name: 'calculator.png',
                width: 800,
                height: 600,
              },
            },
          ],
        },
      },
    },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'The export dialog is still waiting for input.' }] } },
    },
  ]
}

test('registers the task lifecycle tools', () => {
  reset()
  const { ctx, tools } = makeContext()
  const cleanup = apply(ctx, {})
  assert.deepEqual([...tools.keys()].sort(), [
    'computer_desktop_status',
    'computer_task',
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

test('Escape closes the worker and injects its trace into the original conversation', async () => {
  reset()
  await releaseDesktopControl()

  const parent = makeAgent('s1', 'standard')
  const {
    ctx,
    tools,
    handlers,
    sessions,
    workerEvents,
    prompts,
    cancels,
    archives,
    sections,
  } = makeContext({ sessionWorker: true })
  const cleanup = apply(ctx, {})

  const running = tools.get('computer_task').execute(taskArgs(), execFor(parent))
  await waitFor(() => prompts.length === 1, 'the worker prompt should be admitted')
  assert.equal(prompts.length, 1)
  const childId = prompts[0].sessionId
  assert.equal(sessions.get(childId).agentPreset, 'computer-use')
  workerEvents.set(childId, workerTraceEvents())

  handlers.get('session/event')(
    { header: { id: 's1' } },
    { type: 'turn/end', data: { reason: { kind: 'aborted' } } },
  )
  assert.deepEqual(cancels, [{ sessionId: childId }])

  handlers.get('session/event')(
    { header: { id: childId } },
    { type: 'turn/end', data: { reason: { kind: 'aborted' } } },
  )
  const paused = await running
  assert.equal(paused.status, 'paused')
  assert.equal(paused.childId, childId)
  await waitFor(() => globalThis[CONTROL_KEY]?.attempt === undefined, 'the desktop must be released')
  assert.equal(globalThis[CONTROL_KEY]?.attempt, undefined)

  assert.deepEqual(archives, [
    { sessionId: childId, options: { stopActivity: true } },
  ])
  assert.equal(parent.injected.length, 1)
  assert.equal(parent.notices.length, 0, 'pausing must not create a new visible user turn')
  assert.equal(parent.injected[0].source.kind, 'subagent-settled')
  assert.equal(parent.injected[0].source.form, 'notice')
  assert.equal(parent.injected[0].source.senderSessionId, childId)
  const trace = parent.injected[0].content[0].text
  assert.match(trace, /user pressed Escape/)
  assert.match(trace, /Goal: click Export/)
  assert.match(trace, /screenshot/)
  assert.match(trace, /Calculator shows 56/)
  assert.match(trace, /calculator\.png/)
  assert.match(trace, /closed and is not resumable/)
  assert.match(trace, /submit a new computer_task/)
  assert.equal(sections.has('desktop-bridge-paused'), false)
  assert.equal(tools.has('computer_task_resume'), false)

  const nextRun = tools.get('computer_task').execute(
    taskArgs({ goal: 'enter the remaining value' }),
    execFor(parent),
  )
  await waitFor(() => prompts.length === 2, 'a later GUI request should create a fresh worker')
  assert.notEqual(prompts[1].sessionId, childId)
  workerEvents.set(prompts[1].sessionId, workerTraceEvents())
  handlers.get('session/event')(
    { header: { id: prompts[1].sessionId } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  )
  const next = await nextRun
  assert.equal(next.status, 'completed')
  assert.notEqual(next.childId, childId)
  assert.equal(archives.length, 2)

  await cleanup()
})

test('normal completion closes and archives the worker while returning its trace as the tool result', async () => {
  reset()
  await releaseDesktopControl()

  const parent = makeAgent('s1', 'standard')
  const { ctx, tools, handlers, workerEvents, prompts, archives } = makeContext({ sessionWorker: true })
  const cleanup = apply(ctx, {})
  const running = tools.get('computer_task').execute(taskArgs(), execFor(parent))
  await waitFor(() => prompts.length === 1, 'the worker prompt should be admitted')
  const childId = prompts[0].sessionId
  workerEvents.set(childId, workerTraceEvents())

  handlers.get('session/event')(
    { header: { id: childId } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  )

  const completed = await running
  assert.equal(completed.status, 'completed')
  assert.equal(completed.childId, childId)
  assert.match(completed.result, /worker completed its turn/)
  assert.match(completed.result, /Calculator shows 56/)
  assert.deepEqual(archives, [
    { sessionId: childId, options: { stopActivity: true } },
  ])
  assert.equal(parent.injected.length, 0, 'the normal tool result already carries the trace')
  await cleanup()
})

test('a recoverable worker error closes the worker without creating a paused task record', async () => {
  reset()
  await releaseDesktopControl()

  const parent = makeAgent('s1', 'standard')
  const { ctx, tools, handlers, workerEvents, prompts, archives } = makeContext({ sessionWorker: true })
  const cleanup = apply(ctx, {})
  const running = tools.get('computer_task').execute(taskArgs(), execFor(parent))
  await waitFor(() => prompts.length === 1, 'the worker prompt should be admitted')
  const childId = prompts[0].sessionId
  workerEvents.set(childId, workerTraceEvents())

  handlers.get('session/event')(
    { header: { id: childId } },
    { type: 'turn/end', data: { reason: { kind: 'error' } } },
  )
  const paused = await running
  assert.equal(paused.status, 'paused')
  assert.equal(paused.childId, childId)
  assert.match(paused.result, /worker stopped without completing/)
  assert.deepEqual(archives, [
    { sessionId: childId, options: { stopActivity: true } },
  ])
  assert.equal(parent.injected.length, 0, 'an ordinary tool result does not need a second injected copy')

  await cleanup()
})

test('the worker trace is bounded and keeps screenshot references without copying image bytes', async () => {
  const events = []
  for (let index = 0; index < 60; index += 1) {
    const callId = `bulk-${index}`
    events.push({
      type: 'tool/call',
      data: { callId, name: 'screenshot', arguments: `{"step":${index}}` },
    })
    events.push({
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          toolCallId: callId,
          source: { kind: 'tool', callId },
          content: [
            { type: 'text', text: `observation ${index} `.repeat(60) },
            {
              type: 'image',
              attachment: {
                attachmentId: `image-${index}`,
                name: `screen-${index}.png`,
                width: 800,
                height: 600,
              },
            },
          ],
        },
      },
    })
  }

  const ctx = {
    get(name) {
      if (name !== 'sessionController') return undefined
      return { async inspect() { return { events } } }
    },
  }
  const trace = await readWorkerTrace(ctx, {
    taskId: 'dt-bulk',
    childId: 'desktop-bulk',
    args: {
      goal: 'inspect a very long GUI workflow',
      stop_condition: 'the final dialog is visible',
    },
  }, { status: 'paused', reason: 'user' })

  assert.ok(trace.length <= 12_000)
  assert.match(trace, /middle of trace omitted/)
  assert.match(trace, /Screen observations captured by the worker: 60/)
  assert.match(trace, /Latest screen references: screen-58\.png/)
  assert.match(trace, /closed and is not resumable/)
})
