import { getStandaloneBridge } from './standaloneMode.js'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

const _noOpApi = { postMessage: (_msg: unknown) => {} }
const standaloneBridge = getStandaloneBridge()

export const vscode =
  (globalThis as Record<string, unknown>)['acquireVsCodeApi'] !== undefined
    ? acquireVsCodeApi()
    : standaloneBridge ?? _noOpApi
