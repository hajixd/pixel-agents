import { useState, useRef } from 'react'
import { vscode } from '../vscodeApi.js'

export function PromptBar() {
  const [prompt, setPrompt] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = () => {
    const text = prompt.trim()
    if (!text) return
    vscode.postMessage({ type: 'sendPrompt', prompt: text })
    setPrompt('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 'var(--pixel-controls-z)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        padding: '4px 6px',
        boxShadow: 'var(--pixel-shadow)',
        width: 'min(480px, calc(100vw - 120px))',
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What should your agents do?"
        style={{
          flex: 1,
          fontSize: '20px',
          background: 'var(--pixel-input-bg, rgba(255,255,255,0.06))',
          color: 'var(--pixel-text)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          padding: '4px 8px',
          outline: 'none',
          fontFamily: 'inherit',
        }}
      />
      <button
        onClick={handleSubmit}
        disabled={!prompt.trim()}
        style={{
          padding: '5px 12px',
          fontSize: '20px',
          background: prompt.trim() ? 'var(--pixel-agent-bg)' : 'var(--pixel-btn-bg)',
          color: prompt.trim() ? 'var(--pixel-agent-text)' : 'var(--pixel-text-dim)',
          border: `2px solid ${prompt.trim() ? 'var(--pixel-agent-border)' : 'transparent'}`,
          borderRadius: 0,
          cursor: prompt.trim() ? 'pointer' : 'default',
          opacity: prompt.trim() ? 1 : 'var(--pixel-btn-disabled-opacity)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        Send
      </button>
    </div>
  )
}
