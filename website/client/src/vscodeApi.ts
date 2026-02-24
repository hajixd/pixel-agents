// WebSocket relay — replaces the VS Code acquireVsCodeApi() bridge.
//
// useExtensionMessages.ts uses window.addEventListener('message', handler)
// and calls vscode.postMessage(msg). Both work transparently here:
//   - Incoming WS messages → window.dispatchEvent(MessageEvent) → picked up by the hook
//   - vscode.postMessage(msg) → ws.send(JSON.stringify(msg)) → server handles it

// Use /ws path so the Vite dev proxy can route to the backend server
const WS_URL = `ws://${window.location.host}/ws`

let ws: WebSocket | null = null
const queue: unknown[] = []
let connected = false

function connect(): void {
  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    connected = true
    console.log('[Pixel Agents] WebSocket connected')
    for (const msg of queue) {
      ws!.send(JSON.stringify(msg))
    }
    queue.length = 0
  }

  ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string) as unknown
      // Dispatch as a window message event — useExtensionMessages.ts picks this up
      window.dispatchEvent(new MessageEvent('message', { data }))
    } catch {
      // Ignore malformed messages
    }
  }

  ws.onclose = () => {
    connected = false
    console.log('[Pixel Agents] WebSocket disconnected, reconnecting in 2s...')
    setTimeout(connect, 2000)
  }

  ws.onerror = () => {
    // onclose fires after onerror; reconnect is handled there
  }
}

connect()

export const vscode = {
  postMessage(msg: unknown): void {
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    } else {
      queue.push(msg)
    }
  },
}
