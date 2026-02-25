import { useState, useEffect, useRef } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfficeLayout, ToolActivity } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { vscode } from '../vscodeApi.js'
import { playDoneSound, setSoundEnabled } from '../notificationSound.js'

export type AgentProvider = 'claude' | 'codex'

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  label: string
}

export interface AgentDiagnostics {
  provider: AgentProvider
  projectDir: string
  jsonlFile: string
  workingDir: string | null
  processMode?: 'pty' | 'stdio'
  lastEventAt?: number
}

export interface ProviderStatus {
  claude: boolean
  codex: boolean
  defaultProvider: AgentProvider
}

export interface AgentTimelineEntry {
  timestamp: number
  role: 'user' | 'assistant' | 'system'
  text: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  agentProviders: Record<number, AgentProvider>
  agentDiagnostics: Record<number, AgentDiagnostics>
  agentTimelines: Record<number, AgentTimelineEntry[]>
  providerStatus: ProviderStatus
  deskDirectories: Record<string, string>
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({})
  const [subagentTools, setSubagentTools] = useState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [agentProviders, setAgentProviders] = useState<Record<number, AgentProvider>>({})
  const [agentDiagnostics, setAgentDiagnostics] = useState<Record<number, AgentDiagnostics>>({})
  const [agentTimelines, setAgentTimelines] = useState<Record<number, AgentTimelineEntry[]>>({})
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({ claude: false, codex: false, defaultProvider: 'claude' })
  const [deskDirectories, setDeskDirectories] = useState<Record<string, string>>({})
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string | null }> = []

    const appendTimeline = (id: number, entry: AgentTimelineEntry): void => {
      setAgentTimelines((prev) => {
        const list = prev[id] || []
        const nextList = [...list, entry].slice(-50)
        return { ...prev, [id]: nextList }
      })
    }

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId ?? undefined, true)
        }
        pendingAgents = []
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        const provider = (msg.provider as AgentProvider | undefined) || 'claude'
        const seatId = (msg.seatId as string | null | undefined) ?? undefined
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedAgent(id)
        os.addAgent(id, undefined, undefined, seatId)
        setAgentProviders((prev) => ({ ...prev, [id]: provider }))
        setAgentDiagnostics((prev) => ({
          ...prev,
          [id]: {
            provider,
            projectDir: String(msg.projectDir ?? ''),
            jsonlFile: String(msg.jsonlFile ?? ''),
            workingDir: (msg.workingDir as string | null | undefined) ?? null,
            processMode: (msg.processMode as 'pty' | 'stdio' | undefined),
            lastEventAt: Date.now(),
          },
        }))
        appendTimeline(id, {
          timestamp: Date.now(),
          role: 'system',
          text: `Agent created (${provider})`,
        })
        saveAgentSeats(os)
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentProviders((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentDiagnostics((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentTimelines((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<string, { palette?: number; hueShift?: number; seatId?: string | null }>
        const providers = (msg.agentProviders || {}) as Record<string, AgentProvider>
        const info = (msg.agentInfo || {}) as Record<string, {
          provider?: AgentProvider
          projectDir?: string
          jsonlFile?: string
          workingDir?: string | null
          processMode?: 'pty' | 'stdio'
        }>
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[String(id)]
          pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId ?? undefined })
        }
        setAgentProviders((prev) => {
          const next = { ...prev }
          for (const id of incoming) {
            const provider = providers[String(id)] || info[String(id)]?.provider
            if (provider) next[id] = provider
          }
          return next
        })
        setAgentDiagnostics((prev) => {
          const next = { ...prev }
          for (const id of incoming) {
            const key = String(id)
            const i = info[key]
            if (!i) continue
            const existing = next[id]
            const provider = providers[key] || i.provider || existing?.provider || 'claude'
            next[id] = {
              provider,
              projectDir: i.projectDir || existing?.projectDir || '',
              jsonlFile: i.jsonlFile || existing?.jsonlFile || '',
              workingDir: i.workingDir ?? existing?.workingDir ?? null,
              processMode: i.processMode ?? existing?.processMode,
              lastEventAt: existing?.lastEventAt,
            }
          }
          return next
        })
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a - b)
        })
      } else if (msg.type === 'agentDiagnostics') {
        const id = msg.id as number
        const incomingProvider = msg.provider as AgentProvider | undefined
        setAgentProviders((prev) => ({ ...prev, [id]: incomingProvider || prev[id] || 'claude' }))
        setAgentDiagnostics((prev) => ({
          ...prev,
          [id]: {
            provider: incomingProvider || prev[id]?.provider || 'claude',
            projectDir: String(msg.projectDir ?? prev[id]?.projectDir ?? ''),
            jsonlFile: String(msg.jsonlFile ?? prev[id]?.jsonlFile ?? ''),
            workingDir: (msg.workingDir as string | null | undefined) ?? prev[id]?.workingDir ?? null,
            processMode: (msg.processMode as 'pty' | 'stdio' | undefined) ?? prev[id]?.processMode,
            lastEventAt: prev[id]?.lastEventAt,
          },
        }))
      } else if (msg.type === 'agentHeartbeat') {
        const id = msg.id as number
        const timestamp = Number(msg.timestamp || Date.now())
        setAgentDiagnostics((prev) => {
          const existing = prev[id]
          if (!existing) return prev
          return {
            ...prev,
            [id]: {
              ...existing,
              jsonlFile: String(msg.jsonlFile ?? existing.jsonlFile),
              lastEventAt: timestamp,
            },
          }
        })
      } else if (msg.type === 'providerStatus') {
        setProviderStatus({
          claude: Boolean(msg.claude),
          codex: Boolean(msg.codex),
          defaultProvider: (msg.defaultProvider as AgentProvider | undefined) || 'claude',
        })
      } else if (msg.type === 'deskDirectoriesLoaded') {
        setDeskDirectories((msg.directories || {}) as Record<string, string>)
      } else if (msg.type === 'agentResynced') {
        const id = msg.id as number
        if (!msg.ok) return
        setAgentDiagnostics((prev) => {
          const existing = prev[id]
          if (!existing) return prev
          return {
            ...prev,
            [id]: {
              ...existing,
              jsonlFile: String(msg.jsonlFile ?? existing.jsonlFile),
              lastEventAt: Date.now(),
            },
          }
        })
        appendTimeline(id, {
          timestamp: Date.now(),
          role: 'system',
          text: 'Transcript resynced',
        })
      } else if (msg.type === 'agentMessage') {
        const id = msg.id as number
        const role = (msg.role as 'user' | 'assistant' | undefined) || 'assistant'
        const text = String(msg.text ?? '').trim()
        if (!text) return
        appendTimeline(id, {
          timestamp: Number(msg.timestamp || Date.now()),
          role,
          text,
        })
      } else if (msg.type === 'agentTeamSync') {
        const sourceId = msg.sourceId as number
        const targetIds = (msg.targetIds as number[] | undefined) || []
        const note = String(msg.note ?? '').trim()
        appendTimeline(sourceId, {
          timestamp: Number(msg.timestamp || Date.now()),
          role: 'system',
          text: `Shared context with agents: ${targetIds.join(', ') || '-'}`,
        })
        for (const targetId of targetIds) {
          appendTimeline(targetId, {
            timestamp: Number(msg.timestamp || Date.now()),
            role: 'system',
            text: `Received context from agent #${sourceId}${note ? ` (${note})` : ''}`,
          })
        }
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const status = msg.status as string
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        const toolName = extractToolName(status)
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.clearPermissionBubble(id)
        appendTimeline(id, {
          timestamp: Date.now(),
          role: 'system',
          text: `Tool started: ${status}`,
        })
        // Create sub-agent character for Task tool subtasks
        if (status.startsWith('Subtask:')) {
          const label = status.slice('Subtask:'.length).trim()
          const subId = os.addSubagent(id, toolId)
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }]
          })
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          }
        })
        appendTimeline(id, {
          timestamp: Date.now(),
          role: 'system',
          text: 'Tool completed',
        })
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
        appendTimeline(id, {
          timestamp: Date.now(),
          role: 'system',
          text: 'Turn cleared',
        })
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number
        const status = msg.status as string
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.showWaitingBubble(id)
          playDoneSound()
          appendTimeline(id, {
            timestamp: Date.now(),
            role: 'system',
            text: 'Waiting for input',
          })
        }
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        os.showPermissionBubble(id)
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      } else if (msg.type === 'serverError') {
        const message = typeof msg.message === 'string' ? msg.message : 'Server error'
        console.error('[Webview] Server error:', message)
        window.alert(message)
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState])

  return {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    agentProviders,
    agentDiagnostics,
    agentTimelines,
    providerStatus,
    deskDirectories,
    layoutReady,
    loadedAssets,
  }
}
