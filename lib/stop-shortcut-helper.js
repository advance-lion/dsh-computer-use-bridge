// Runs in a separate Node process. No orb imports, UI clicks, or private socket access.
import koffi from 'koffi'

let release = () => {}
let timer
let closed = false
function close() {
  if (closed) return
  closed = true
  clearInterval(timer)
  release()
  process.exit(0)
}
const emitStop = () => { if (process.connected) process.send({ type: 'stop' }) }

function windows() {
  const api = koffi.load('user32.dll')
  const MSG = koffi.struct('BridgeMSG', {
    hwnd: 'void *', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t',
    time: 'uint32', x: 'int32', y: 'int32', lPrivate: 'uint32',
  })
  const register = api.func('int __stdcall RegisterHotKey(void *, int, uint32, uint32)')
  const unregister = api.func('int __stdcall UnregisterHotKey(void *, int)')
  const peek = api.func('int __stdcall PeekMessageW(_Out_ BridgeMSG *, void *, uint32, uint32, uint32)')
  if (!register(null, 1, 0x4000 | 0x0004, 0x1B)) throw new Error('Shift+Esc registration failed (possibly already in use)')
  release = () => unregister(null, 1)
  timer = setInterval(() => {
    const msg = {}
    while (peek(msg, null, 0x0312, 0x0312, 1)) {
      if (Number(msg.wParam) === 1) emitStop()
    }
  }, 20)
}

function macos() {
  const api = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon')
  const ID = koffi.struct('BridgeHotKeyID', { signature: 'uint32', id: 'uint32' })
  koffi.struct('BridgeEventType', { eventClass: 'uint32', eventKind: 'uint32' })
  const target = api.func('void *GetApplicationEventTarget()')
  const register = api.func('int32 RegisterEventHotKey(uint32, uint32, BridgeHotKeyID, void *, uint32, _Out_ void **)')
  const unregister = api.func('int32 UnregisterEventHotKey(void *)')
  const receive = api.func('int32 ReceiveNextEvent(uint32, const BridgeEventType *, double, bool, _Out_ void **)')
  const parameter = api.func('int32 GetEventParameter(void *, uint32, uint32, void *, uint32, void *, _Out_ BridgeHotKeyID *)')
  const releaseEvent = api.func('void ReleaseEvent(void *)')
  const ref = [null]
  const signature = 0x64736272 // dsbr
  const result = register(53, 1 << 9, { signature, id: 1 }, target(), 0, ref)
  if (result !== 0) throw new Error(`Shift+Esc registration failed (${result})`)
  release = () => unregister(ref[0])
  timer = setInterval(() => {
    const event = [null]
    while (receive(1, { eventClass: 0x6B657962, eventKind: 6 }, 0, true, event) === 0) {
      try {
        const id = {}
        if (parameter(event[0], 0x2D2D2D2D, 0x686B6964, null, koffi.sizeof(ID), null, id) === 0
          && id.signature === signature && id.id === 1) emitStop()
      } finally { releaseEvent(event[0]) }
    }
  }, 20)
}

process.on('message', (message) => { if (message?.type === 'dispose') close() })
process.on('disconnect', close)
process.on('SIGTERM', close)
process.on('SIGINT', close)
try {
  if (process.platform === 'win32') windows()
  else if (process.platform === 'darwin') macos()
  else throw new Error(`Global Shift+Esc is unsupported on ${process.platform}`)
  if (process.connected) process.send({ type: 'ready' })
  else close()
} catch (error) {
  if (process.connected) process.send({ type: 'error', error: String(error.message) }, close)
  else close()
}
