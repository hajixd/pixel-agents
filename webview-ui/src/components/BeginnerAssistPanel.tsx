interface BeginnerAssistPanelProps {
  onRunPrompt: (prompt: string) => void
}

const QUICK_START_PROMPTS = [
  'Build a simple personal portfolio website with a home page, projects section, and contact form.',
  'Create a to-do app with add/edit/delete tasks and local storage persistence.',
  'Find and fix the current build/test error in this project, then explain what changed in plain English.',
  'Read this codebase and create a beginner-friendly README with setup and usage steps.',
]

export function BeginnerAssistPanel({ onRunPrompt }: BeginnerAssistPanelProps) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 10,
        bottom: 86,
        zIndex: 58,
        width: 'min(430px, calc(100vw - 24px))',
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        boxShadow: 'var(--pixel-shadow)',
        padding: 8,
      }}
    >
      <div style={{ fontSize: '18px', marginBottom: 6 }}>Beginner Mode</div>
      <div style={{ fontSize: '13px', opacity: 0.8, marginBottom: 8 }}>
        Click a starter task. Agents will handle the coding and you can watch progress in real time.
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {QUICK_START_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onRunPrompt(prompt)}
            style={{
              textAlign: 'left',
              fontSize: '13px',
              border: '1px solid var(--pixel-border)',
              background: 'var(--pixel-btn-bg)',
              color: 'var(--pixel-text)',
              padding: '6px 8px',
              cursor: 'pointer',
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}
