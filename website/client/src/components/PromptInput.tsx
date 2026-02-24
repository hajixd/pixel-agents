import { useState, useCallback, useRef } from 'react'
import { vscode } from '../vscodeApi.js'

interface PromptInputProps {
  agentCount: number
}

export function PromptInput({ agentCount }: PromptInputProps) {
  const [prompt, setPrompt] = useState('')
  const [isSending, setIsSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const text = prompt.trim()
    if (!text) return

    vscode.postMessage({ type: 'sendPrompt', prompt: text })
    setPrompt('')
    setIsSending(true)
    setTimeout(() => setIsSending(false), 1000)
    textareaRef.current?.focus()
  }, [prompt])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        gap: 6,
        alignItems: 'flex-end',
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        padding: '6px 8px',
        boxShadow: 'var(--pixel-shadow)',
        width: 'min(600px, 80vw)',
      }}
    >
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          agentCount === 0
            ? 'Type a prompt to spawn an agent... (Enter to send)'
            : 'Send a message to agents... (Enter to send, Shift+Enter for newline)'
        }
        rows={2}
        style={{
          flex: 1,
          resize: 'none',
          background: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid var(--pixel-border)',
          borderRadius: 0,
          color: 'rgba(255, 255, 255, 0.85)',
          fontFamily: 'FS Pixel Sans, monospace',
          fontSize: '18px',
          padding: '4px 8px',
          outline: 'none',
          lineHeight: 1.4,
        }}
      />
      <button
        onClick={handleSend}
        disabled={!prompt.trim() || isSending}
        style={{
          padding: '6px 14px',
          fontSize: '18px',
          background: isSending ? 'rgba(90, 200, 140, 0.3)' : 'rgba(90, 200, 140, 0.12)',
          border: '2px solid rgba(90, 200, 140, 0.6)',
          borderRadius: 0,
          color: 'rgba(180, 255, 210, 0.95)',
          cursor: prompt.trim() && !isSending ? 'pointer' : 'default',
          opacity: prompt.trim() && !isSending ? 1 : 0.5,
          flexShrink: 0,
          fontFamily: 'FS Pixel Sans, monospace',
          whiteSpace: 'nowrap',
          boxShadow: prompt.trim() && !isSending ? '2px 2px 0px #0a0a14' : 'none',
        }}
      >
        {isSending ? 'Sent!' : 'Send'}
      </button>
    </div>
  )
}
