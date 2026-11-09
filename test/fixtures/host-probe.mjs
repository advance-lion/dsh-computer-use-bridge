// Opt-in smoke probe mounted in an isolated stock-orb DSH profile, never in a user's profile.
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { TaskGate } from '../../lib/task-gate.js'
export const name = 'desktop-bridge-host-probe'
export const inject = ['tools', 'sessionController']
export function apply(ctx) {
  ctx.effect(() => {
    const gate = new TaskGate()
    let agentId
    const state = {}
    const detach = ctx.on('tools/execute', (exec, next) => exec.agent?.id === agentId ? gate.run(exec, next) : next())
    const remove = ctx.tools.register({
      name: 'bridge_stop_probe', description: 'Internal isolated-profile cancellation probe.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', properties: {} }, render: () => [] },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        state.entered = true
        try {
          queueMicrotask(() => gate.stop())
          await new Promise((resolve) => exec.signal.addEventListener('abort', resolve, { once: true }))
          state.aborted = exec.signal.aborted
          exec.signal.throwIfAborted()
        } finally {
          await new Promise((resolve) => setTimeout(resolve, 100))
          state.cleaned = true
        }
      },
    })
    void (async () => {
      const controller = ctx.sessionController
      const created = await controller.create({ agentPreset: 'standard' })
      const resolved = await controller.resolveAgent(created.sessionId)
      const agent = resolved.agent ?? resolved
      agentId = agent.id
      state.taskToolRegistered = !!ctx.tools.get('computer_task', agent)
      state.statusToolRegistered = !!ctx.tools.get('computer_desktop_status', agent)
      const result = await ctx.tools.execute({
        agent, name: 'bridge_stop_probe', arguments: {}, callId: randomUUID(), signal: new AbortController().signal,
      })
      await gate.whenIdle()
      state.errorResult = result.isError === true
      state.passed = state.entered && state.aborted && state.cleaned && state.errorResult
        && state.taskToolRegistered && state.statusToolRegistered
      await writeFile(process.env.BRIDGE_PROBE_RESULT, JSON.stringify(state, null, 2))
    })().catch(async (error) => {
      await writeFile(process.env.BRIDGE_PROBE_RESULT, JSON.stringify({ ...state, error: String(error.stack ?? error) }, null, 2))
    })
    return () => { gate.stop(); detach?.(); remove?.() }
  })
}
