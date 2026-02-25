import { useState } from 'react'
import { SettingsModal } from './SettingsModal.js'

export type ProviderPreference = 'auto' | 'claude' | 'codex'

interface TopRightControlsProps {
  isEditMode: boolean
  onOpenAgent: (provider?: 'claude' | 'codex') => void
  providerPreference: ProviderPreference
  onProviderPreferenceChange: (next: ProviderPreference) => void
  isHealthOpen: boolean
  onToggleHealthPanel: () => void
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
}

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '24px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
}


export function BottomToolbar({
  isEditMode,
  onOpenAgent,
  providerPreference,
  onProviderPreferenceChange,
  isHealthOpen,
  onToggleHealthPanel,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
}: TopRightControlsProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  return (
    <div style={panelStyle}>
      <button
        onClick={() => onOpenAgent(providerPreference === 'auto' ? undefined : providerPreference)}
        onMouseEnter={() => setHovered('agent')}
        onMouseLeave={() => setHovered(null)}
        style={{
          ...btnBase,
          padding: '5px 12px',
          background:
            hovered === 'agent'
              ? 'var(--pixel-agent-hover-bg)'
              : 'var(--pixel-agent-bg)',
          border: '2px solid var(--pixel-agent-border)',
          color: 'var(--pixel-agent-text)',
        }}
      >
        + Agent
      </button>
      <select
        value={providerPreference}
        onChange={(e) => onProviderPreferenceChange(e.target.value as ProviderPreference)}
        style={{
          ...btnBase,
          fontSize: '18px',
          padding: '5px 6px',
          width: 102,
          outline: 'none',
          background: 'var(--pixel-btn-bg)',
        }}
        title="Provider for new agents"
      >
        <option value="auto">Auto</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <button
        onClick={onToggleHealthPanel}
        onMouseEnter={() => setHovered('health')}
        onMouseLeave={() => setHovered(null)}
        style={
          isHealthOpen
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'health' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Health / reliability"
      >
        Health
      </button>
      <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        Layout
      </button>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => !v)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background: hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
        />
      </div>
    </div>
  )
}
