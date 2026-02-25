import { useMemo, useState } from 'react'
import type { ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import type {
  AgentDiagnostics,
  AgentProvider,
  AgentTimelineEntry,
} from '../hooks/useExtensionMessages.js'

interface AgentInspectorPanelProps {
  officeState: OfficeState
  agents: number[]
  selectedAgent: number | null
  agentProviders: Record<number, AgentProvider>
  agentStatuses: Record<number, string>
  agentTools: Record<number, ToolActivity[]>
  agentDiagnostics: Record<number, AgentDiagnostics>
  agentTimelines: Record<number, AgentTimelineEntry[]>
  onFocusAgent: (id: number) => void
  onResyncAgent: (id: number) => void
  onSendPromptToAgent: (id: number, prompt: string) => void
  onRelayToAgent: (sourceId: number, targetId: number, note?: string) => void
  onRelayToAll: (sourceId: number, note?: string) => void
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function previewPath(value: string | null | undefined): string {
  if (!value) return '-'
  const parts = value.split(/[\\/]/)
  return parts.slice(-3).join('/')
}

export function AgentInspectorPanel({
  officeState,
  agents,
  selectedAgent,
  agentProviders,
  agentStatuses,
  agentTools,
  agentDiagnostics,
  agentTimelines,
  onFocusAgent,
  onResyncAgent,
  onSendPromptToAgent,
  onRelayToAgent,
  onRelayToAll,
}: AgentInspectorPanelProps) {
  const [directPrompt, setDirectPrompt] = useState('')
  const [relayNote, setRelayNote] = useState('')
  const [relayTarget, setRelayTarget] = useState<number | null>(null)

  const selectedId = selectedAgent
  const diagnostics = selectedId !== null ? agentDiagnostics[selectedId] : undefined
  const provider = selectedId !== null ? agentProviders[selectedId] || diagnostics?.provider : undefined
  const status = selectedId !== null ? (agentStatuses[selectedId] || 'active') : 'active'
  const tools = selectedId !== null ? (agentTools[selectedId] || []) : []
  const timeline = selectedId !== null ? (agentTimelines[selectedId] || []) : []
  const availableTargets = useMemo(() => {
    if (selectedId === null) return []
    return agents.filter((id) => id !== selectedId)
  }, [agents, selectedId])

  return (
    <div
      style={{
        position: 'absolute',
        top: 66,
        right: 10,
        zIndex: 61,
        width: 'min(430px, calc(100vw - 24px))',
        maxHeight: '72vh',
        overflow: 'auto',
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        boxShadow: 'var(--pixel-shadow)',
        padding: 8,
      }}
    >
      <div style={{ fontSize: '20px', marginBottom: 8 }}>
        Agent Info
      </div>

      {selectedId === null && (
        <div style={{ fontSize: '15px', opacity: 0.8 }}>
          Click an agent in the office to inspect details.
        </div>
      )}

      {selectedId !== null && (
        <>
          <div style={{ fontSize: '16px', marginBottom: 6 }}>
            <strong>Agent #{selectedId}</strong> ({provider || 'unknown'}) • {status}
          </div>
          <div style={{ fontSize: '13px', opacity: 0.85, display: 'grid', gap: 3, marginBottom: 8 }}>
            <span>Seat: {officeState.characters.get(selectedId)?.seatId || '-'}</span>
            <span>Working dir: {previewPath(diagnostics?.workingDir)}</span>
            <span>Transcript: {previewPath(diagnostics?.jsonlFile)}</span>
            <span>Project: {previewPath(diagnostics?.projectDir)}</span>
            <span>Last event: {diagnostics?.lastEventAt ? formatTime(diagnostics.lastEventAt) : 'No events yet'}</span>
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button
              onClick={() => onFocusAgent(selectedId)}
              style={{
                fontSize: '14px',
                padding: '4px 8px',
                border: '1px solid var(--pixel-border)',
                background: 'var(--pixel-btn-bg)',
                color: 'var(--pixel-text)',
                cursor: 'pointer',
              }}
            >
              Focus
            </button>
            <button
              onClick={() => onResyncAgent(selectedId)}
              style={{
                fontSize: '14px',
                padding: '4px 8px',
                border: '1px solid var(--pixel-border)',
                background: 'var(--pixel-btn-bg)',
                color: 'var(--pixel-text)',
                cursor: 'pointer',
              }}
            >
              Resync
            </button>
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '15px', marginBottom: 4 }}>Current Tools</div>
            <div style={{ fontSize: '13px', opacity: 0.85, display: 'grid', gap: 3 }}>
              {tools.length === 0 && <span>No active tools</span>}
              {tools.slice(-5).map((tool) => (
                <span key={tool.toolId}>{tool.done ? 'Done' : 'Running'}: {tool.status}</span>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '15px', marginBottom: 4 }}>Send Direct Prompt</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={directPrompt}
                onChange={(e) => setDirectPrompt(e.target.value)}
                placeholder="Ask this agent something..."
                style={{
                  flex: 1,
                  fontSize: '13px',
                  border: '1px solid var(--pixel-border)',
                  background: 'var(--pixel-input-bg, rgba(255,255,255,0.06))',
                  color: 'var(--pixel-text)',
                  padding: '4px 6px',
                }}
              />
              <button
                onClick={() => {
                  const text = directPrompt.trim()
                  if (!text) return
                  onSendPromptToAgent(selectedId, text)
                  setDirectPrompt('')
                }}
                style={{
                  fontSize: '13px',
                  border: '1px solid var(--pixel-border)',
                  background: 'var(--pixel-agent-bg)',
                  color: 'var(--pixel-agent-text)',
                  padding: '4px 8px',
                  cursor: 'pointer',
                }}
              >
                Send
              </button>
            </div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '15px', marginBottom: 4 }}>Team Sync</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <select
                value={relayTarget ?? ''}
                onChange={(e) => setRelayTarget(e.target.value ? Number(e.target.value) : null)}
                style={{
                  fontSize: '13px',
                  border: '1px solid var(--pixel-border)',
                  background: 'var(--pixel-btn-bg)',
                  color: 'var(--pixel-text)',
                  padding: '4px 6px',
                }}
              >
                <option value="">Select agent</option>
                {availableTargets.map((id) => (
                  <option key={id} value={id}>
                    Agent #{id}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  if (relayTarget === null) return
                  onRelayToAgent(selectedId, relayTarget, relayNote)
                }}
                disabled={relayTarget === null}
                style={{
                  fontSize: '13px',
                  border: '1px solid var(--pixel-border)',
                  background: relayTarget === null ? 'var(--pixel-btn-bg)' : 'var(--pixel-active-bg)',
                  color: 'var(--pixel-text)',
                  padding: '4px 8px',
                  cursor: relayTarget === null ? 'default' : 'pointer',
                  opacity: relayTarget === null ? 0.6 : 1,
                }}
              >
                Share to One
              </button>
              <button
                onClick={() => onRelayToAll(selectedId, relayNote)}
                style={{
                  fontSize: '13px',
                  border: '1px solid var(--pixel-border)',
                  background: 'var(--pixel-active-bg)',
                  color: 'var(--pixel-text)',
                  padding: '4px 8px',
                  cursor: 'pointer',
                }}
              >
                Share to All
              </button>
            </div>
            <input
              value={relayNote}
              onChange={(e) => setRelayNote(e.target.value)}
              placeholder="Optional note for receiving agents"
              style={{
                width: '100%',
                fontSize: '13px',
                border: '1px solid var(--pixel-border)',
                background: 'var(--pixel-input-bg, rgba(255,255,255,0.06))',
                color: 'var(--pixel-text)',
                padding: '4px 6px',
              }}
            />
          </div>

          <div>
            <div style={{ fontSize: '15px', marginBottom: 4 }}>Recent Timeline</div>
            <div style={{ display: 'grid', gap: 4 }}>
              {timeline.length === 0 && (
                <div style={{ fontSize: '13px', opacity: 0.7 }}>No transcript events yet.</div>
              )}
              {timeline.slice(-10).reverse().map((entry, index) => (
                <div
                  key={`${entry.timestamp}-${index}`}
                  style={{
                    fontSize: '12px',
                    border: '1px solid var(--pixel-border)',
                    padding: '4px 6px',
                    background: 'rgba(255,255,255,0.03)',
                  }}
                >
                  <strong>{formatTime(entry.timestamp)}</strong> [{entry.role}] {entry.text}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
