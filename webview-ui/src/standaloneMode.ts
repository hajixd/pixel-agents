/**
 * Standalone mode for browser use without VS Code extension host.
 * This now bridges to the local Node backend via WebSocket instead of
 * injecting synthetic messages.
 */

export interface StandaloneBridge {
  postMessage(msg: unknown): void
}

const STANDALONE_SERVER_PORT = '3579'
const WS_RECONNECT_DELAY_MS = 2000

let bridge: StandaloneBridge | null = null

export function isStandaloneMode(): boolean {
  return (globalThis as Record<string, unknown>)['acquireVsCodeApi'] === undefined
}

function getStandaloneWebSocketUrl(): string {
  const fromEnv = import.meta.env.VITE_PIXEL_AGENTS_WS_URL as string | undefined
  if (fromEnv) return fromEnv

  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('ws')
  if (fromQuery) return fromQuery

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname
  const currentPort = window.location.port
  if (import.meta.env.DEV && currentPort && currentPort !== STANDALONE_SERVER_PORT) {
    return `${protocol}//${host}:${STANDALONE_SERVER_PORT}/ws`
  }
  return `${protocol}//${window.location.host}/ws`
}

function createStandaloneBridge(): StandaloneBridge {
  const wsUrl = getStandaloneWebSocketUrl()
  const queue: unknown[] = []
  let ws: WebSocket | null = null
  let connected = false

  const connect = (): void => {
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      connected = true
      for (const queued of queue) {
        ws!.send(JSON.stringify(queued))
      }
      queue.length = 0
      console.log(`[standalone] WebSocket connected: ${wsUrl}`)
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as unknown
        window.dispatchEvent(new MessageEvent('message', { data }))
      } catch {
        // Ignore malformed payloads
      }
    }

    ws.onclose = () => {
      connected = false
      setTimeout(connect, WS_RECONNECT_DELAY_MS)
    }
  }

  connect()

  return {
    postMessage(msg: unknown): void {
      if (connected && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      } else {
        queue.push(msg)
      }
    },
  }
}

export function getStandaloneBridge(): StandaloneBridge | null {
  if (!isStandaloneMode()) return null
  if (!bridge) {
    bridge = createStandaloneBridge()
  }
  return bridge
}

export async function initStandaloneMode(): Promise<void> {
  // Keep this hook so main.ts can explicitly initialize standalone transport.
  getStandaloneBridge()
}
