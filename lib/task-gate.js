/** Cancellation and quiescence at DSH's public tools/execute boundary. */
export class TaskGate {
  controller = new AbortController()
  pending = new Set()

  stop() {
    this.controller.abort(new Error('Computer Use stopped; no further worker tools are allowed.'))
  }

  async run(exec, next) {
    this.controller.signal.throwIfAborted()
    const upstream = exec.signal
    exec.signal = AbortSignal.any([upstream, this.controller.signal])
    const done = Promise.withResolvers()
    this.pending.add(done.promise)
    try {
      exec.signal.throwIfAborted()
      return await next()
    } finally {
      exec.signal = upstream
      this.pending.delete(done.promise)
      done.resolve()
    }
  }

  async whenIdle() {
    while (this.pending.size) await Promise.all([...this.pending])
  }
}
