import { useMemo, useState } from 'react'
import type { AgentDiagnostics, AgentProvider, ProviderStatus } from '../hooks/useExtensionMessages.js'

interface ReliabilityPanelProps {
  isOpen: boolean
  onClose: () => void
  agents: number[]
  agentProviders: Record<number, AgentProvider>
  agentDiagnostics: Record<number, AgentDiagnostics>
  providerStatus: ProviderStatus
  deskDirectories: Record<string, string>
  seatIds: string[]
  onFocusAgent: (id: number) => void
  onResyncAgent: (id: number) => void
  onSaveDeskDirectories: (directories: Record<string, string>) => void
}

function formatAge(lastEventAt?: number): string {
  if (!lastEventAt) return 'No events'
  const ageSec = Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000))
  if (ageSec < 5) return 'Just now'
  if (ageSec < 60) return `${ageSec}s ago`
  const min = Math.floor(ageSec / 60)
  const sec = ageSec % 60
  return `${min}m ${sec}s ago`
}

function displayBaseName(value: string | null | undefined): string {
  if (!value) return '-'
  const parts = value.split(/[\\/]/)
  return parts[parts.length - 1] || value
}

export function ReliabilityPanel({
  isOpen,
  onClose,
  agents,
  agentProviders,
  agentDiagnostics,
  providerStatus,
  deskDirectories,
  seatIds,
  onFocusAgent,
  onResyncAgent,
  onSaveDeskDirectories,
}: ReliabilityPanelProps) {
  const [selectedSeat, setSelectedSeat] = useState<string>(seatIds[0] || '')
  const [seatPathInput, setSeatPathInput] = useState('')

  const sortedSeats = useMemo(() => [...seatIds].sort((a, b) => a.localeCompare(b)), [seatIds])
  const sortedMappings = useMemo(
    () => Object.entries(deskDirectories).sort(([a], [b]) => a.localeCompare(b)),
    [deskDirectories],
  )

  if (!isOpen) return null

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.52)',
          zIndex: 61,
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 62,
          width: 'min(860px, 94vw)',
          maxHeight: '82vh',
          overflow: 'auto',
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: 'var(--pixel-shadow)',
          padding: 10,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: '24px', color: 'var(--pixel-text)' }}>Reliability Panel</span>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--pixel-text-dim)',
              fontSize: '22px',
              cursor: 'pointer',
            }}
          >
            X
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 6,
            marginBottom: 12,
          }}
        >
          <div style={{ border: '1px solid var(--pixel-border)', padding: 6, fontSize: '15px' }}>
            Claude CLI: {providerStatus.claude ? 'Available' : 'Missing'}
          </div>
          <div style={{ border: '1px solid var(--pixel-border)', padding: 6, fontSize: '15px' }}>
            Codex CLI: {providerStatus.codex ? 'Available' : 'Missing'}
          </div>
          <div style={{ border: '1px solid var(--pixel-border)', padding: 6, fontSize: '15px' }}>
            Default Provider: {providerStatus.defaultProvider}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '18px', marginBottom: 6 }}>Agent Health</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {agents.length === 0 && (
              <div style={{ border: '1px solid var(--pixel-border)', padding: 6, opacity: 0.75, fontSize: '14px' }}>
                No active agents.
              </div>
            )}
            {agents.map((id) => {
              const diagnostics = agentDiagnostics[id]
              const provider = agentProviders[id] || diagnostics?.provider || 'claude'
              return (
                <div key={id} style={{ border: '1px solid var(--pixel-border)', padding: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: '15px' }}>
                      <strong>Agent #{id}</strong> ({provider})
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => onFocusAgent(id)}
                        style={{
                          fontSize: '14px',
                          padding: '3px 8px',
                          border: '1px solid var(--pixel-border)',
                          background: 'var(--pixel-btn-bg)',
                          color: 'var(--pixel-text)',
                          cursor: 'pointer',
                          borderRadius: 0,
                        }}
                      >
                        Focus
                      </button>
                      <button
                        onClick={() => onResyncAgent(id)}
                        style={{
                          fontSize: '14px',
                          padding: '3px 8px',
                          border: '1px solid var(--pixel-border)',
                          background: 'var(--pixel-btn-bg)',
                          color: 'var(--pixel-text)',
                          cursor: 'pointer',
                          borderRadius: 0,
                        }}
                      >
                        Resync
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: '13px', opacity: 0.8, marginTop: 4 }}>
                    CWD: {displayBaseName(diagnostics?.workingDir)} | Transcript: {displayBaseName(diagnostics?.jsonlFile)} | Last Event: {formatAge(diagnostics?.lastEventAt)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div>
          <div style={{ fontSize: '18px', marginBottom: 6 }}>Desk Directory Mapping</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <select
              value={selectedSeat}
              onChange={(e) => {
                const seatId = e.target.value
                setSelectedSeat(seatId)
                setSeatPathInput(deskDirectories[seatId] || '')
              }}
              style={{
                fontSize: '14px',
                border: '1px solid var(--pixel-border)',
                background: 'var(--pixel-btn-bg)',
                color: 'var(--pixel-text)',
                padding: '4px 6px',
              }}
            >
              {sortedSeats.length === 0 && <option value="">No seats</option>}
              {sortedSeats.map((seatId) => (
                <option key={seatId} value={seatId}>
                  {seatId}
                </option>
              ))}
            </select>
            <input
              value={seatPathInput}
              onChange={(e) => setSeatPathInput(e.target.value)}
              placeholder="Directory or worktree path"
              style={{
                flex: 1,
                minWidth: 260,
                fontSize: '14px',
                border: '1px solid var(--pixel-border)',
                background: 'var(--pixel-input-bg, rgba(255,255,255,0.06))',
                color: 'var(--pixel-text)',
                padding: '4px 6px',
              }}
            />
            <button
              onClick={() => {
                if (!selectedSeat) return
                const next = { ...deskDirectories }
                const trimmed = seatPathInput.trim()
                if (trimmed) next[selectedSeat] = trimmed
                else delete next[selectedSeat]
                onSaveDeskDirectories(next)
              }}
              style={{
                fontSize: '14px',
                border: '1px solid var(--pixel-border)',
                background: 'var(--pixel-btn-bg)',
                color: 'var(--pixel-text)',
                padding: '4px 8px',
                cursor: 'pointer',
                borderRadius: 0,
              }}
            >
              Save
            </button>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            {sortedMappings.length === 0 && (
              <div style={{ border: '1px solid var(--pixel-border)', padding: 6, fontSize: '13px', opacity: 0.75 }}>
                No desk mappings yet.
              </div>
            )}
            {sortedMappings.map(([seatId, mappedPath]) => (
              <div
                key={seatId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  border: '1px solid var(--pixel-border)',
                  padding: 6,
                  fontSize: '13px',
                }}
              >
                <span>{seatId}: {mappedPath}</span>
                <button
                  onClick={() => {
                    const next = { ...deskDirectories }
                    delete next[seatId]
                    onSaveDeskDirectories(next)
                  }}
                  style={{
                    fontSize: '12px',
                    border: '1px solid var(--pixel-border)',
                    background: 'transparent',
                    color: 'var(--pixel-text)',
                    cursor: 'pointer',
                    borderRadius: 0,
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
