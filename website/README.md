# Pixel Agents — Web

Standalone local web server for Pixel Agents. Open a browser, type a prompt, and watch pixel art characters animate as `claude` CLI agents work on your code.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` in PATH)
- Node.js ≥ 20
- Xcode Command Line Tools (macOS): `xcode-select --install` (needed for `node-pty` native compilation)

## Setup

```bash
cd website
npm run install:all
```

## Running (dev mode)

Open two terminals:

**Terminal 1 — Server:**
```bash
cd website/server
npm run dev
```

**Terminal 2 — Client:**
```bash
cd website/client
npm run dev
```

Then open **http://localhost:5173** in your browser.

Or start both with one command from the `website/` folder:
```bash
cd website
npm run dev
```

## Running (production)

```bash
cd website
npm run build
# Start from your project directory:
cd /path/to/your/project
node /path/to/pixel-agents/website/server/dist/index.js
```

Or use the convenience script (builds then starts from current directory):
```bash
cd /path/to/your/project
npm --prefix /path/to/pixel-agents/website start
```

The server runs on port **3579** by default (`PORT` env var to override).

## How it works

1. Type a prompt in the text box at the bottom and press **Enter**
2. A pixel agent spawns in the office (matrix effect) and starts working
3. The `claude` CLI runs in your current directory — it has full access to your project files
4. Watch the characters animate as they read files, run commands, and write code
5. Use **+ Agent** to spawn additional agents for parallel work
