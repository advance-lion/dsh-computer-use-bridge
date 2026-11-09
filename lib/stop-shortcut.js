import { fork } from 'node:child_process'

/** Each task gets its own helper and IPC channel: late keys cannot stop a successor. */
export async function startStopShortcut(onStop, { spawn = fork, timeoutMs = 8000 } = {}) {
  const child = spawn(new URL('./stop-shortcut-helper.js', import.meta.url), [], {
    execArgv: [],
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  let active = true
  let ready = false
  let timer
  let diagnostic = ''
  child.stderr?.on('data', (data) => { diagnostic = `${diagnostic}${data}`.slice(-1500) })
  const dispose = async () => {
    if (!active) return
    active = false
    clearTimeout(timer)
    if (child.pid === undefined && child.spawnfile) return
    if (child.exitCode !== null && child.exitCode !== undefined) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    if (child.connected) child.send({ type: 'dispose' }, () => {})
    const kill = setTimeout(() => child.kill(), 1000)
    kill.unref?.()
    await exited
    clearTimeout(kill)
  }
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Shift+Esc helper startup timed out')), timeoutMs)
      child.on('message', (message) => {
        if (!active) return
        if (message?.type === 'ready') { ready = true; clearTimeout(timer); resolve() }
        if (message?.type === 'error') reject(new Error(message.error))
        if (message?.type === 'stop' && ready) {
          void Promise.resolve().then(() => onStop('Shift+Esc')).catch((error) => console.error(`[desktop-bridge] stop failed: ${error}`))
        }
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (!ready) reject(new Error(`Shift+Esc helper exited (${code}): ${diagnostic}`))
        else if (active) {
          // Fail closed if the emergency entry point disappears during a task.
          void Promise.resolve().then(() => onStop('helper-loss')).catch((error) => console.error(`[desktop-bridge] helper exit stop failed: ${error}`))
        }
      })
    })
    return dispose
  } catch (error) {
    await dispose()
    throw new Error(`Cannot enable Shift+Esc: ${error.message}. Close the conflicting shortcut owner, or set stopShortcut: false and use the original chat Stop button.`)
  }
}
