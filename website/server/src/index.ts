import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
	loadFurnitureAssets,
	loadCharacterSprites,
	loadFloorTiles,
	loadWallTiles,
	loadDefaultLayout,
} from './assetLoader.js';
import {
	migrateAndLoadLayout,
	writeLayoutToFile,
	watchLayoutFile,
	type LayoutWatcher,
} from './layoutPersistence.js';
import {
	launchNewAgent,
	removeAgent,
	sendExistingAgents,
	getProjectDirPath,
} from './agentManager.js';
import type { WebAgentState } from './types.js';
import type { ProjectScanState } from './fileWatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env['PORT'] ?? '3579', 10);
// The working directory is where the user starts the server
// (their project directory, so claude runs there)
const WORKING_DIR = process.cwd();

// ── Asset path resolution ─────────────────────────────────────
// In production: assets are in the webview-ui public dir (sibling of website/)
// In dev: same location
const WEBVIEW_PUBLIC = path.join(__dirname, '..', '..', '..', 'webview-ui', 'public');
const ASSETS_ROOT = fs.existsSync(path.join(WEBVIEW_PUBLIC, 'assets'))
	? WEBVIEW_PUBLIC
	: path.join(__dirname, '..', '..', 'client', 'dist');

// ── Shared server state ───────────────────────────────────────
const agents = new Map<number, WebAgentState>();
const fileWatchers = new Map<number, fs.FSWatcher>();
const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
const knownJsonlFiles = new Set<string>();
const projectScanState: ProjectScanState = {
	current: null,
	provider: null,
	projectDir: null,
	workspacePath: null,
};
const nextAgentId = { current: 1 };
const nextTerminalIndex = { current: 1 };
const activeAgentId: { current: number | null } = { current: null };

// ── Persistence: sessions + settings ─────────────────────────
const PIXEL_AGENTS_DIR = path.join(os.homedir(), '.pixel-agents');
const SESSIONS_FILE = path.join(PIXEL_AGENTS_DIR, 'sessions.json');
const SETTINGS_FILE = path.join(PIXEL_AGENTS_DIR, 'settings.json');

type AgentMeta = Record<string, { palette?: number; hueShift?: number; seatId?: string | null }>;
let agentMeta: AgentMeta = {};
let soundEnabled = true;

function ensurePixelAgentsDir(): void {
	if (!fs.existsSync(PIXEL_AGENTS_DIR)) {
		fs.mkdirSync(PIXEL_AGENTS_DIR, { recursive: true });
	}
}

function loadSessionsFile(): void {
	try {
		if (fs.existsSync(SESSIONS_FILE)) {
			agentMeta = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')) as AgentMeta;
		}
	} catch { agentMeta = {}; }
}

function saveSessionsFile(): void {
	try {
		ensurePixelAgentsDir();
		fs.writeFileSync(SESSIONS_FILE, JSON.stringify(agentMeta, null, 2), 'utf-8');
	} catch { /* ignore */ }
}

function loadSettings(): void {
	try {
		if (fs.existsSync(SETTINGS_FILE)) {
			const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as { soundEnabled?: boolean };
			soundEnabled = s.soundEnabled ?? true;
		}
	} catch { soundEnabled = true; }
}

function saveSettings(): void {
	try {
		ensurePixelAgentsDir();
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ soundEnabled }, null, 2), 'utf-8');
	} catch { /* ignore */ }
}

function persistAgents(): void {
	// In website mode, agents die when the server restarts.
	// No need to persist the agent list — only seat/palette metadata matters.
}

// ── Express server ────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Serve built React client (for production use)
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
	app.use(express.static(clientDist));
	app.get('*', (_req, res) => {
		res.sendFile(path.join(clientDist, 'index.html'));
	});
}

// ── WebSocket server ──────────────────────────────────────────
// /ws path matches the Vite dev proxy and client WS URL
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg: unknown): void {
	const json = JSON.stringify(msg);
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(json);
		}
	}
}

async function sendAssetsToClient(ws: WebSocket): Promise<void> {
	function send(msg: unknown): void {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	console.log('[Server] Loading and sending assets from:', ASSETS_ROOT);

	try {
		const charSprites = await loadCharacterSprites(ASSETS_ROOT);
		if (charSprites) {
			send({ type: 'characterSpritesLoaded', characters: charSprites.characters });
		}

		const floorTiles = await loadFloorTiles(ASSETS_ROOT);
		if (floorTiles) {
			send({ type: 'floorTilesLoaded', sprites: floorTiles.sprites });
		}

		const wallTiles = await loadWallTiles(ASSETS_ROOT);
		if (wallTiles) {
			send({ type: 'wallTilesLoaded', sprites: wallTiles.sprites });
		}

		const furnitureAssets = await loadFurnitureAssets(ASSETS_ROOT);
		if (furnitureAssets) {
			const spritesObj: Record<string, string[][]> = {};
			for (const [id, data] of furnitureAssets.sprites) {
				spritesObj[id] = data;
			}
			send({
				type: 'furnitureAssetsLoaded',
				catalog: furnitureAssets.catalog,
				sprites: spritesObj,
			});
		}
	} catch (err) {
		console.error('[Server] Error loading assets:', err);
	}

	// Send layout
	const defaultLayout = loadDefaultLayout(ASSETS_ROOT);
	const layout = migrateAndLoadLayout(defaultLayout ?? undefined);
	send({ type: 'layoutLoaded', layout });

	// Send settings
	send({ type: 'settingsLoaded', soundEnabled });

	// Send existing agents (on reconnect, agents from a live server session)
	sendExistingAgents(agents, agentMeta, send);
}

wss.on('connection', (ws) => {
	console.log('[Server] Browser connected');

	ws.on('message', (raw) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString()) as Record<string, unknown>;
		} catch {
			return;
		}

		const type = msg['type'] as string | undefined;

		if (type === 'webviewReady') {
			void sendAssetsToClient(ws);

		} else if (type === 'openClaude' || type === 'openCodex' || type === 'openAgent') {
			const provider = type === 'openCodex'
				? 'codex'
				: type === 'openClaude'
					? 'claude'
					: (msg['provider'] as 'claude' | 'codex' | undefined);
			launchNewAgent(
				nextAgentId, nextTerminalIndex, agents, activeAgentId,
				knownJsonlFiles, fileWatchers, pollingTimers, waitingTimers,
				permissionTimers, jsonlPollTimers, projectScanState,
				WORKING_DIR, broadcast, persistAgents,
				undefined,
				provider,
			);

		} else if (type === 'sendPrompt') {
			const prompt = String(msg['prompt'] ?? '').trim();
			if (!prompt) return;

			if (agents.size === 0) {
				// Auto-create agent with the initial prompt
				launchNewAgent(
					nextAgentId, nextTerminalIndex, agents, activeAgentId,
					knownJsonlFiles, fileWatchers, pollingTimers, waitingTimers,
					permissionTimers, jsonlPollTimers, projectScanState,
					WORKING_DIR, broadcast, persistAgents,
					prompt,
				);
			} else {
				// Write to the active (or most recent) agent's PTY
				const agentId = activeAgentId.current ?? [...agents.keys()][agents.size - 1];
				const agent = agentId !== undefined ? agents.get(agentId) : undefined;
				if (agent) {
					console.log(`[Server] Writing prompt to agent ${agent.id}`);
					agent.ptyProcess.write(prompt + '\r');
				}
			}

		} else if (type === 'focusAgent') {
			// In website mode, just track which agent is "active"
			const id = msg['id'] as number | undefined;
			if (id !== undefined) {
				activeAgentId.current = id;
			}

		} else if (type === 'closeAgent') {
			const id = msg['id'] as number | undefined;
			if (id === undefined) return;
			const agent = agents.get(id);
			if (agent) {
				try { agent.ptyProcess.kill(); } catch { /* already dead */ }
			}
			// agentClosed is sent by ptyProcess.onExit handler in agentManager
			removeAgent(id, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, jsonlPollTimers, persistAgents);
			broadcast({ type: 'agentClosed', id });

		} else if (type === 'saveAgentSeats') {
			agentMeta = (msg['seats'] as AgentMeta) ?? {};
			saveSessionsFile();

		} else if (type === 'saveLayout') {
			layoutWatcher?.markOwnWrite();
			writeLayoutToFile(msg['layout'] as Record<string, unknown>);

		} else if (type === 'setSoundEnabled') {
			soundEnabled = Boolean(msg['enabled']);
			saveSettings();
		}
	});

	ws.on('close', () => {
		console.log('[Server] Browser disconnected');
	});
});

// ── Layout file watcher ───────────────────────────────────────
let layoutWatcher: LayoutWatcher | null = watchLayoutFile((layout) => {
	broadcast({ type: 'layoutLoaded', layout });
});

// ── Start ─────────────────────────────────────────────────────
loadSessionsFile();
loadSettings();

// Ensure the project directory is seeded in knownJsonlFiles on startup
// so we don't re-adopt old JSONL files
const projectDir = getProjectDirPath(WORKING_DIR);
try {
	if (fs.existsSync(projectDir)) {
		const files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
		for (const f of files) knownJsonlFiles.add(f);
	}
} catch { /* dir may not exist */ }

server.listen(PORT, () => {
	console.log('');
	console.log('╔═══════════════════════════════════════╗');
	console.log('║        Pixel Agents Web Server        ║');
	console.log('╠═══════════════════════════════════════╣');
	console.log(`║  http://localhost:${PORT}                 ║`);
	console.log(`║  Working dir: ${WORKING_DIR.slice(0, 22).padEnd(22)} ║`);
	console.log('╚═══════════════════════════════════════╝');
	console.log('');
});

process.on('SIGINT', () => {
	console.log('\n[Server] Shutting down...');
	layoutWatcher?.dispose();
	layoutWatcher = null;
	if (projectScanState.current) {
		clearInterval(projectScanState.current);
		projectScanState.current = null;
	}
	for (const agent of agents.values()) {
		try { agent.ptyProcess.kill(); } catch { /* ignore */ }
	}
	process.exit(0);
});
