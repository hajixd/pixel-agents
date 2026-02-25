import type { ToolActivity } from '../office/types.js'
import type { AgentProvider } from '../hooks/useExtensionMessages.js'

interface ApprovalQueueProps {
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  agentProviders: Record<number, AgentProvider>
  onFocusAgent: (id: number) => void
}

export function ApprovalQueue({ agents, agentTools, agentProviders, onFocusAgent }: ApprovalQueueProps) {
  const pending = agents.filter((id) => (agentTools[id] || []).some((tool) => tool.permissionWait && !tool.done))
  if (pending.length === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 60,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-status-permission)',
        borderRadius: 0,
        padding: '6px 8px',
        boxShadow: 'var(--pixel-shadow)',
        minWidth: 180,
      }}
    >
      <div style={{ fontSize: '18px', marginBottom: 4, color: 'var(--pixel-text)' }}>
        Needs Approval ({pending.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {pending.slice(0, 4).map((id) => {
          const provider = agentProviders[id]
          const providerText = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'Agent'
          return (
            <button
              key={id}
              onClick={() => onFocusAgent(id)}
              style={{
                width: '100%',
                textAlign: 'left',
                fontSize: '16px',
                border: '1px solid var(--pixel-border)',
                background: 'var(--pixel-btn-bg)',
                color: 'var(--pixel-text)',
                padding: '4px 6px',
                borderRadius: 0,
                cursor: 'pointer',
              }}
              title="Focus agent terminal for approval"
            >
              {providerText} #{id}
            </button>
          )
        })}
      </div>
      <div style={{ fontSize: '13px', marginTop: 6, opacity: 0.7 }}>
        Tip: focus the agent and approve in terminal.
      </div>
    </div>
  )
}
