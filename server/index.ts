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
	getProviderStatus,
} from './agentServer.js';
import type { PromptRoute, WebAgentState } from './types.js';
import { resyncAgent, type ProjectScanState } from './fileWatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env['PORT'] ?? '3579', 10);
// The working directory is where the user starts the server
// (their project directory, so claude runs there)
const WORKING_DIR = process.cwd();

// ── Asset path resolution ─────────────────────────────────────
// In development we load from webview-ui/public so source assets are available.
// For built runs, dist/webview contains the bundled app and copied assets.
const PROJECT_ROOT = path.join(__dirname, '..');
const WEBVIEW_PUBLIC = path.join(PROJECT_ROOT, 'webview-ui', 'public');
const WEBVIEW_DIST = path.join(PROJECT_ROOT, 'dist', 'webview');
const ASSETS_ROOT = fs.existsSync(path.join(WEBVIEW_PUBLIC, 'assets'))
	? WEBVIEW_PUBLIC
	: WEBVIEW_DIST;

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
const roundRobinCursor = { current: 0 };

// ── Persistence: sessions + settings ─────────────────────────
const PIXEL_AGENTS_DIR = path.join(os.homedir(), '.pixel-agents');
const SESSIONS_FILE = path.join(PIXEL_AGENTS_DIR, 'sessions.json');
const SETTINGS_FILE = path.join(PIXEL_AGENTS_DIR, 'settings.json');

type AgentMeta = Record<string, { palette?: number; hueShift?: number; seatId?: string | null }>;
type DeskDirectories = Record<string, string>;
let agentMeta: AgentMeta = {};
let soundEnabled = true;
let deskDirectories: DeskDirectories = {};

function resolveWorkingDir(rawPath: string | undefined, fallbackRoot: string): string | null {
	if (!rawPath) return null;
	const trimmed = rawPath.trim();
	if (!trimmed) return null;
	const resolved = path.isAbsolute(trimmed)
		? trimmed
		: path.resolve(fallbackRoot, trimmed);
	try {
		return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

function pickDeskLaunchDefaults(): { workingDir: string | null; seatId: string | null } {
	const occupiedSeats = new Set<string>();
	for (const agentId of agents.keys()) {
		const seatId = agentMeta[String(agentId)]?.seatId;
		if (seatId) occupiedSeats.add(seatId);
	}

	const seatIds = Object.keys(deskDirectories).sort((a, b) => a.localeCompare(b));
	for (const seatId of seatIds) {
		if (occupiedSeats.has(seatId)) continue;
		const workingDir = resolveWorkingDir(deskDirectories[seatId], WORKING_DIR);
		if (!workingDir) continue;
		return { workingDir, seatId };
	}

	return { workingDir: null, seatId: null };
}

function sendPromptToAgent(agent: WebAgentState, prompt: string): void {
	const text = prompt.trim();
	if (!text) return;
	agent.process.write(text + '\r');
}

function buildAgentSummary(agent: WebAgentState): string {
	const activeTools = [...agent.activeToolStatuses.values()];
	const toolSummary = activeTools.length > 0
		? activeTools.map((status) => `- ${status}`).join('\n')
		: '- No active tools';

	return [
		`Agent #${agent.id} (${agent.provider})`,
		`Status: ${agent.isWaiting ? 'waiting for input' : 'active'}`,
		`Working directory: ${agent.workingDir}`,
		`Project transcript root: ${agent.projectDir}`,
		`Current transcript file: ${path.basename(agent.jsonlFile)}`,
		'Active tools:',
		toolSummary,
	].join('\n');
}

function relayAgentInfo(sourceId: number, targetIds: number[], note?: string): void {
	const source = agents.get(sourceId);
	if (!source) {
		broadcast({ type: 'serverError', message: `Agent #${sourceId} not found` });
		return;
	}

	const summary = buildAgentSummary(source);
	const deliveredTo: number[] = [];
	for (const targetId of [...new Set(targetIds)]) {
		if (targetId === sourceId) continue;
		const target = agents.get(targetId);
		if (!target) continue;
		const prompt = [
			`You are collaborating with Agent #${sourceId}.`,
			'Use this status summary from that agent as context:',
			summary,
			note && note.trim() ? `User note: ${note.trim()}` : '',
			'Respond briefly with what you will do next with this context, then continue the task.',
		].filter(Boolean).join('\n\n');
		sendPromptToAgent(target, prompt);
		deliveredTo.push(targetId);
	}

	if (deliveredTo.length > 0) {
		broadcast({
			type: 'agentTeamSync',
			sourceId,
			targetIds: deliveredTo,
			note: typeof note === 'string' ? note : '',
			timestamp: Date.now(),
		});
	}
}

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
			const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as {
				soundEnabled?: boolean;
				deskDirectories?: DeskDirectories;
			};
			soundEnabled = s.soundEnabled ?? true;
			deskDirectories = s.deskDirectories ?? {};
		}
	} catch {
		soundEnabled = true;
		deskDirectories = {};
	}
}

function saveSettings(): void {
	try {
		ensurePixelAgentsDir();
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ soundEnabled, deskDirectories }, null, 2), 'utf-8');
	} catch { /* ignore */ }
}

function persistAgents(): void {
	// Agents are process-local in standalone server mode.
	// No need to persist the agent list — only seat/palette metadata matters.
}

// ── Express server ────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Serve built standalone web UI when available.
if (fs.existsSync(path.join(WEBVIEW_DIST, 'index.html'))) {
	app.use(express.static(WEBVIEW_DIST));
	app.use((_req, res) => {
		res.sendFile(path.join(WEBVIEW_DIST, 'index.html'));
	});
} else {
	app.get('/', (_req, res) => {
		res.type('text/plain').send('Pixel Agents server is running. Build the UI with "npm run build:webview" or run "cd webview-ui && npm run dev".');
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
	const providerStatus = getProviderStatus();
	send({
		type: 'providerStatus',
		claude: providerStatus.claude,
		codex: providerStatus.codex,
		defaultProvider: providerStatus.defaultProvider,
	});
	send({ type: 'deskDirectoriesLoaded', directories: deskDirectories });

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
			const explicitWorkingDir = resolveWorkingDir(
				typeof msg['workingDir'] === 'string' ? msg['workingDir'] : undefined,
				WORKING_DIR,
			);
			const useDeskMapping = msg['useDeskMapping'] !== false;
			const deskDefaults = useDeskMapping
				? pickDeskLaunchDefaults()
				: { workingDir: null, seatId: null };
			launchNewAgent(
				nextAgentId, nextTerminalIndex, agents, activeAgentId,
				knownJsonlFiles, fileWatchers, pollingTimers, waitingTimers,
				permissionTimers, jsonlPollTimers, projectScanState,
				WORKING_DIR, broadcast, persistAgents,
				undefined,
				provider,
				explicitWorkingDir ?? deskDefaults.workingDir ?? undefined,
				(typeof msg['seatId'] === 'string' ? msg['seatId'] : null) ?? deskDefaults.seatId,
			);

		} else if (type === 'sendPrompt') {
			const prompt = String(msg['prompt'] ?? '').trim();
			if (!prompt) return;
			const route = (msg['route'] as PromptRoute | undefined) ?? 'active';
			const preferredProvider = msg['provider'] as 'claude' | 'codex' | undefined;

			if (agents.size === 0) {
				// Auto-create agent with the initial prompt
				const deskDefaults = pickDeskLaunchDefaults();
				launchNewAgent(
					nextAgentId, nextTerminalIndex, agents, activeAgentId,
					knownJsonlFiles, fileWatchers, pollingTimers, waitingTimers,
					permissionTimers, jsonlPollTimers, projectScanState,
					WORKING_DIR, broadcast, persistAgents,
					prompt,
					preferredProvider,
					deskDefaults.workingDir ?? undefined,
					deskDefaults.seatId,
				);
				return;
			}

			if (route === 'broadcast') {
				for (const agent of agents.values()) {
					console.log(`[Server] Broadcasting prompt to agent ${agent.id}`);
					agent.process.write(prompt + '\r');
				}
				return;
			}

			if (route === 'round_robin') {
				const sortedIds = [...agents.keys()].sort((a, b) => a - b);
				if (sortedIds.length > 0) {
					const idx = roundRobinCursor.current % sortedIds.length;
					const chosenId = sortedIds[idx];
					roundRobinCursor.current = (idx + 1) % sortedIds.length;
					const chosenAgent = agents.get(chosenId);
					if (chosenAgent) {
						activeAgentId.current = chosenId;
						console.log(`[Server] Round-robin prompt to agent ${chosenAgent.id}`);
						chosenAgent.process.write(prompt + '\r');
						return;
					}
				}
			}

			let targetAgent: WebAgentState | undefined;
			if (activeAgentId.current !== null) {
				targetAgent = agents.get(activeAgentId.current);
			}
			if (!targetAgent) {
				targetAgent = [...agents.values()].find((agent) => agent.isWaiting);
			}
			if (!targetAgent) {
				targetAgent = [...agents.values()].find((agent) => agent.activeToolIds.size === 0 && agent.activeToolStatuses.size === 0);
			}
			if (!targetAgent) {
				const lastId = [...agents.keys()].sort((a, b) => a - b).at(-1);
				targetAgent = lastId !== undefined ? agents.get(lastId) : undefined;
			}
			if (targetAgent) {
				activeAgentId.current = targetAgent.id;
				console.log(`[Server] Writing prompt to agent ${targetAgent.id}`);
				sendPromptToAgent(targetAgent, prompt);
			}

		} else if (type === 'focusAgent') {
			// Standalone backend only tracks active id for routing and /clear behavior.
			const id = msg['id'] as number | undefined;
			if (id !== undefined) {
				activeAgentId.current = id;
				broadcast({ type: 'agentSelected', id });
			}

		} else if (type === 'closeAgent') {
			const id = msg['id'] as number | undefined;
			if (id === undefined) return;
			const agent = agents.get(id);
			if (agent) {
				// agentClosed is emitted from process onExit in agentServer.ts
				try {
					agent.process.kill();
				} catch {
					removeAgent(id, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, jsonlPollTimers, persistAgents);
					broadcast({ type: 'agentClosed', id });
				}
			}

		} else if (type === 'saveAgentSeats') {
			agentMeta = (msg['seats'] as AgentMeta) ?? {};
			saveSessionsFile();
		} else if (type === 'saveDeskDirectories') {
			deskDirectories = (msg['directories'] as DeskDirectories) ?? {};
			saveSettings();
			broadcast({ type: 'deskDirectoriesLoaded', directories: deskDirectories });

		} else if (type === 'saveLayout') {
			layoutWatcher?.markOwnWrite();
			writeLayoutToFile(msg['layout'] as Record<string, unknown>);

		} else if (type === 'setSoundEnabled') {
			soundEnabled = Boolean(msg['enabled']);
			saveSettings();
		} else if (type === 'sendPromptToAgent') {
			const id = Number(msg['id']);
			const prompt = String(msg['prompt'] ?? '').trim();
			if (!Number.isFinite(id) || !prompt) return;
			const agent = agents.get(id);
			if (!agent) return;
			activeAgentId.current = id;
			sendPromptToAgent(agent, prompt);
			broadcast({ type: 'agentSelected', id });
		} else if (type === 'relayAgentInfo') {
			const sourceId = Number(msg['sourceId']);
			const targetId = Number(msg['targetId']);
			if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) return;
			relayAgentInfo(sourceId, [targetId], typeof msg['note'] === 'string' ? msg['note'] : undefined);
		} else if (type === 'relayAgentInfoAll') {
			const sourceId = Number(msg['sourceId']);
			if (!Number.isFinite(sourceId)) return;
			const targetIds = [...agents.keys()].filter((id) => id !== sourceId);
			relayAgentInfo(sourceId, targetIds, typeof msg['note'] === 'string' ? msg['note'] : undefined);
		} else if (type === 'resyncAgent') {
			const id = Number(msg['id']);
			if (!Number.isFinite(id)) return;
			resyncAgent(
				id,
				agents,
				knownJsonlFiles,
				fileWatchers,
				pollingTimers,
				waitingTimers,
				permissionTimers,
				broadcast,
				persistAgents,
				projectScanState.workspacePath,
			);
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
		try { agent.process.kill(); } catch { /* ignore */ }
	}
	process.exit(0);
});
