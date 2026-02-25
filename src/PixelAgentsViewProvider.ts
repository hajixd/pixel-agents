import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentProvider, AgentState, PromptRoute } from './types.js';
import {
	launchNewTerminal,
	removeAgent,
	restoreAgents,
	persistAgents,
	sendExistingAgents,
	sendLayout,
	getProjectDirPath,
	getDefaultAgentProvider,
	getProviderStatus,
} from './agentManager.js';
import { ensureProjectScan, resyncAgent, type ProjectScanState } from './fileWatcher.js';
import { loadFurnitureAssets, sendAssetsToWebview, loadFloorTiles, sendFloorTilesToWebview, loadWallTiles, sendWallTilesToWebview, loadCharacterSprites, sendCharacterSpritesToWebview, loadDefaultLayout } from './assetLoader.js';
import { WORKSPACE_KEY_AGENT_SEATS, WORKSPACE_KEY_DESK_DIRECTORIES, GLOBAL_KEY_SOUND_ENABLED } from './constants.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';

type AgentSeatMeta = Record<string, { palette?: number; hueShift?: number; seatId?: string | null }>;
type DeskDirectories = Record<string, string>;

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
	nextAgentId = { current: 1 };
	nextTerminalIndex = { current: 1 };
	agents = new Map<number, AgentState>();
	webviewView: vscode.WebviewView | undefined;

	// Per-agent timers
	fileWatchers = new Map<number, fs.FSWatcher>();
	pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
	waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
	jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
	permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

	// /clear detection: project-level scan for new JSONL files
	activeAgentId = { current: null as number | null };
	roundRobinCursor = { current: 0 };
	knownJsonlFiles = new Set<string>();
	projectScanState: ProjectScanState = {
		current: null,
		provider: null,
		projectDir: null,
		workspacePath: null,
	};

	// Bundled default layout (loaded from assets/default-layout.json)
	defaultLayout: Record<string, unknown> | null = null;

	// Cross-window layout sync
	layoutWatcher: LayoutWatcher | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	private get webview(): vscode.Webview | undefined {
		return this.webviewView?.webview;
	}

	private persistAgents = (): void => {
		persistAgents(this.agents, this.context);
	};

	private getAgentSeatMeta(): AgentSeatMeta {
		return this.context.workspaceState.get<AgentSeatMeta>(WORKSPACE_KEY_AGENT_SEATS, {});
	}

	private getDeskDirectories(): DeskDirectories {
		return this.context.workspaceState.get<DeskDirectories>(WORKSPACE_KEY_DESK_DIRECTORIES, {});
	}

	private resolveWorkingDir(rawPath: string | undefined, fallbackRoot: string | null): string | null {
		if (!rawPath) return null;
		const trimmed = rawPath.trim();
		if (!trimmed) return null;
		const resolved = path.isAbsolute(trimmed)
			? trimmed
			: fallbackRoot
				? path.resolve(fallbackRoot, trimmed)
				: path.resolve(trimmed);
		try {
			return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : null;
		} catch {
			return null;
		}
	}

	private pickDeskLaunchDefaults(): { workingDir: string | null; seatId: string | null } {
		const deskDirectories = this.getDeskDirectories();
		const seatMeta = this.getAgentSeatMeta();
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

		const occupiedSeats = new Set<string>();
		for (const agentId of this.agents.keys()) {
			const seatId = seatMeta[String(agentId)]?.seatId;
			if (seatId) occupiedSeats.add(seatId);
		}

		const seatIds = Object.keys(deskDirectories).sort((a, b) => a.localeCompare(b));
		for (const seatId of seatIds) {
			if (occupiedSeats.has(seatId)) continue;
			const workingDir = this.resolveWorkingDir(deskDirectories[seatId], workspaceRoot);
			if (!workingDir) continue;
			return { workingDir, seatId };
		}

		return { workingDir: null, seatId: null };
	}

	private sendPromptToAgent(agent: AgentState, prompt: string): void {
		const text = prompt.trim();
		if (!text) return;
		agent.terminalRef.show();
		agent.terminalRef.sendText(text);
	}

	private buildAgentSummary(agent: AgentState): string {
		const activeTools = [...agent.activeToolStatuses.values()];
		const toolSummary = activeTools.length > 0
			? activeTools.map((status) => `- ${status}`).join('\n')
			: '- No active tools';

		return [
			`Agent #${agent.id} (${agent.provider})`,
			`Status: ${agent.isWaiting ? 'waiting for input' : 'active'}`,
			`Working directory: ${agent.workingDir ?? 'unknown'}`,
			`Project transcript root: ${agent.projectDir}`,
			`Current transcript file: ${path.basename(agent.jsonlFile)}`,
			'Active tools:',
			toolSummary,
		].join('\n');
	}

	private relayAgentInfo(sourceId: number, targetIds: number[], note?: string): void {
		const source = this.agents.get(sourceId);
		if (!source) {
			this.webview?.postMessage({ type: 'serverError', message: `Agent #${sourceId} not found` });
			return;
		}

		const uniqueTargets = [...new Set(targetIds)].filter((targetId) => targetId !== sourceId);
		const deliveredTo: number[] = [];
		const summary = this.buildAgentSummary(source);
		for (const targetId of uniqueTargets) {
			const target = this.agents.get(targetId);
			if (!target) continue;
			const prompt = [
				`You are collaborating with Agent #${sourceId}.`,
				'Use this status summary from that agent as context:',
				summary,
				note && note.trim() ? `User note: ${note.trim()}` : '',
				'Respond briefly with what you will do next with this context, then continue the task.',
			].filter(Boolean).join('\n\n');
			this.sendPromptToAgent(target, prompt);
			deliveredTo.push(targetId);
		}

		if (deliveredTo.length > 0) {
			this.webview?.postMessage({
				type: 'agentTeamSync',
				sourceId,
				targetIds: deliveredTo,
				note: typeof note === 'string' ? note : '',
				timestamp: Date.now(),
			});
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			if (message.type === 'openClaude' || message.type === 'openCodex' || message.type === 'openAgent') {
				const requestedProvider = (
					message.type === 'openCodex'
						? 'codex'
						: message.type === 'openClaude'
							? 'claude'
							: (message.provider as AgentProvider | undefined)
				);
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
				const explicitWorkingDir = this.resolveWorkingDir(
					typeof message.workingDir === 'string' ? message.workingDir : undefined,
					workspaceRoot,
				);
				const useDeskMapping = message.useDeskMapping !== false;
				const deskDefaults = useDeskMapping
					? this.pickDeskLaunchDefaults()
					: { workingDir: null, seatId: null };
				launchNewTerminal(
					this.nextAgentId, this.nextTerminalIndex,
					this.agents, this.activeAgentId, this.knownJsonlFiles,
					this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
					this.jsonlPollTimers, this.projectScanState,
					this.webview, this.persistAgents,
					undefined,
					requestedProvider,
					explicitWorkingDir ?? deskDefaults.workingDir,
					(typeof message.seatId === 'string' ? message.seatId : undefined) ?? deskDefaults.seatId,
				);
			} else if (message.type === 'sendPrompt') {
				const prompt = String(message.prompt ?? '').trim();
				if (!prompt) return;
				const route = (message.route as PromptRoute | undefined) ?? 'active';
				const requestedProvider = message.provider as AgentProvider | undefined;

				if (this.agents.size === 0) {
					const deskDefaults = this.pickDeskLaunchDefaults();
					launchNewTerminal(
						this.nextAgentId, this.nextTerminalIndex,
						this.agents, this.activeAgentId, this.knownJsonlFiles,
						this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
						this.jsonlPollTimers, this.projectScanState,
						this.webview, this.persistAgents,
						prompt,
						requestedProvider ?? getDefaultAgentProvider(),
						deskDefaults.workingDir,
						deskDefaults.seatId,
					);
					return;
				}

				if (route === 'broadcast') {
					for (const agent of this.agents.values()) {
						agent.terminalRef.show();
						agent.terminalRef.sendText(prompt);
					}
					return;
				}

				if (route === 'round_robin') {
					const sortedIds = [...this.agents.keys()].sort((a, b) => a - b);
					if (sortedIds.length > 0) {
						const idx = this.roundRobinCursor.current % sortedIds.length;
						const targetId = sortedIds[idx];
						this.roundRobinCursor.current = (idx + 1) % sortedIds.length;
						const agent = this.agents.get(targetId);
						if (agent) {
							this.activeAgentId.current = targetId;
							agent.terminalRef.show();
							agent.terminalRef.sendText(prompt);
							return;
						}
					}
				}

				let targetAgent: AgentState | null = null;
				if (this.activeAgentId.current !== null) {
					targetAgent = this.agents.get(this.activeAgentId.current) ?? null;
				}
				if (!targetAgent) {
					// Backward-compatible fallback: prefer a waiting/idle agent
					for (const agent of this.agents.values()) {
						if (agent.isWaiting) { targetAgent = agent; break; }
					}
				}
				if (!targetAgent) {
					for (const agent of this.agents.values()) {
						if (agent.activeToolIds.size === 0 && agent.activeToolStatuses.size === 0) {
							targetAgent = agent;
							break;
						}
					}
				}
				if (!targetAgent) {
					const lastId = [...this.agents.keys()].sort((a, b) => a - b).at(-1);
					targetAgent = lastId !== undefined ? this.agents.get(lastId) ?? null : null;
				}

				if (targetAgent) {
					this.activeAgentId.current = targetAgent.id;
					targetAgent.terminalRef.show();
					targetAgent.terminalRef.sendText(prompt);
				}
			} else if (message.type === 'focusAgent') {
				const agent = this.agents.get(message.id);
				if (agent) {
					this.activeAgentId.current = message.id;
					agent.terminalRef.show();
					this.webview?.postMessage({ type: 'agentSelected', id: message.id });
				}
			} else if (message.type === 'closeAgent') {
				const agent = this.agents.get(message.id);
				if (agent) {
					agent.terminalRef.dispose();
				}
			} else if (message.type === 'sendPromptToAgent') {
				const id = Number(message.id);
				const prompt = String(message.prompt ?? '').trim();
				if (!Number.isFinite(id) || !prompt) return;
				const agent = this.agents.get(id);
				if (!agent) return;
				this.activeAgentId.current = id;
				this.sendPromptToAgent(agent, prompt);
				this.webview?.postMessage({ type: 'agentSelected', id });
			} else if (message.type === 'relayAgentInfo') {
				const sourceId = Number(message.sourceId);
				const targetId = Number(message.targetId);
				if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) return;
				this.relayAgentInfo(sourceId, [targetId], typeof message.note === 'string' ? message.note : undefined);
			} else if (message.type === 'relayAgentInfoAll') {
				const sourceId = Number(message.sourceId);
				if (!Number.isFinite(sourceId)) return;
				const targets = [...this.agents.keys()].filter((id) => id !== sourceId);
				this.relayAgentInfo(sourceId, targets, typeof message.note === 'string' ? message.note : undefined);
			} else if (message.type === 'saveAgentSeats') {
				// Store seat assignments in a separate key (never touched by persistAgents)
				console.log(`[Pixel Agents] saveAgentSeats:`, JSON.stringify(message.seats));
				this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
			} else if (message.type === 'saveDeskDirectories') {
				const directories = (message.directories || {}) as DeskDirectories;
				this.context.workspaceState.update(WORKSPACE_KEY_DESK_DIRECTORIES, directories);
				this.webview?.postMessage({ type: 'deskDirectoriesLoaded', directories });
			} else if (message.type === 'saveLayout') {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(message.layout as Record<string, unknown>);
			} else if (message.type === 'setSoundEnabled') {
				this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
			} else if (message.type === 'resyncAgent') {
				const id = Number(message.id);
				if (!Number.isFinite(id)) return;
				resyncAgent(
					id,
					this.agents,
					this.knownJsonlFiles,
					this.fileWatchers,
					this.pollingTimers,
					this.waitingTimers,
					this.permissionTimers,
					this.webview,
					this.persistAgents,
					this.projectScanState.workspacePath,
				);
			} else if (message.type === 'webviewReady') {
				restoreAgents(
					this.context,
					this.nextAgentId, this.nextTerminalIndex,
					this.agents, this.knownJsonlFiles,
					this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
					this.jsonlPollTimers, this.projectScanState, this.activeAgentId,
					this.webview, this.persistAgents,
				);
				// Send persisted settings to webview
				const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
				this.webview?.postMessage({ type: 'settingsLoaded', soundEnabled });
				const providerStatus = getProviderStatus();
				this.webview?.postMessage({
					type: 'providerStatus',
					claude: providerStatus.claude,
					codex: providerStatus.codex,
					defaultProvider: providerStatus.defaultProvider,
				});
				this.webview?.postMessage({
					type: 'deskDirectoriesLoaded',
					directories: this.getDeskDirectories(),
				});

				// Ensure project scan runs even with no restored agents (to adopt external terminals)
				const defaultProvider = getDefaultAgentProvider();
				const projectDir = getProjectDirPath(undefined, defaultProvider);
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				console.log('[Extension] workspaceRoot:', workspaceRoot);
				console.log('[Extension] projectDir:', projectDir);
				if (projectDir) {
					ensureProjectScan(
						projectDir, this.knownJsonlFiles, this.projectScanState, this.activeAgentId,
						this.nextAgentId, this.agents,
						this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
						this.webview, this.persistAgents,
						defaultProvider,
						workspaceRoot ?? null,
					);

					// Load furniture assets BEFORE sending layout
					(async () => {
						try {
							console.log('[Extension] Loading furniture assets...');
							const extensionPath = this.extensionUri.fsPath;
							console.log('[Extension] extensionPath:', extensionPath);

							// Check bundled location first: extensionPath/dist/assets/
							const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
							let assetsRoot: string | null = null;
							if (fs.existsSync(bundledAssetsDir)) {
								console.log('[Extension] Found bundled assets at dist/');
								assetsRoot = path.join(extensionPath, 'dist');
							} else if (workspaceRoot) {
								// Fall back to workspace root (development or external assets)
								console.log('[Extension] Trying workspace for assets...');
								assetsRoot = workspaceRoot;
							}

							if (!assetsRoot) {
								console.log('[Extension] ⚠️  No assets directory found');
								if (this.webview) {
									sendLayout(this.context, this.webview, this.defaultLayout);
									this.startLayoutWatcher();
								}
								return;
							}

							console.log('[Extension] Using assetsRoot:', assetsRoot);

							// Load bundled default layout
							this.defaultLayout = loadDefaultLayout(assetsRoot);

							// Load character sprites
							const charSprites = await loadCharacterSprites(assetsRoot);
							if (charSprites && this.webview) {
								console.log('[Extension] Character sprites loaded, sending to webview');
								sendCharacterSpritesToWebview(this.webview, charSprites);
							}

							// Load floor tiles
							const floorTiles = await loadFloorTiles(assetsRoot);
							if (floorTiles && this.webview) {
								console.log('[Extension] Floor tiles loaded, sending to webview');
								sendFloorTilesToWebview(this.webview, floorTiles);
							}

							// Load wall tiles
							const wallTiles = await loadWallTiles(assetsRoot);
							if (wallTiles && this.webview) {
								console.log('[Extension] Wall tiles loaded, sending to webview');
								sendWallTilesToWebview(this.webview, wallTiles);
							}

							const assets = await loadFurnitureAssets(assetsRoot);
							if (assets && this.webview) {
								console.log('[Extension] ✅ Assets loaded, sending to webview');
								sendAssetsToWebview(this.webview, assets);
							}
						} catch (err) {
							console.error('[Extension] ❌ Error loading assets:', err);
						}
						// Always send saved layout (or null for default)
						if (this.webview) {
							console.log('[Extension] Sending saved layout');
							sendLayout(this.context, this.webview, this.defaultLayout);
							this.startLayoutWatcher();
						}
					})();
				} else {
					// No project dir — still try to load floor/wall tiles, then send saved layout
					(async () => {
						try {
							const ep = this.extensionUri.fsPath;
							const bundled = path.join(ep, 'dist', 'assets');
							if (fs.existsSync(bundled)) {
								const distRoot = path.join(ep, 'dist');
								this.defaultLayout = loadDefaultLayout(distRoot);
								const cs = await loadCharacterSprites(distRoot);
								if (cs && this.webview) {
									sendCharacterSpritesToWebview(this.webview, cs);
								}
								const ft = await loadFloorTiles(distRoot);
								if (ft && this.webview) {
									sendFloorTilesToWebview(this.webview, ft);
								}
								const wt = await loadWallTiles(distRoot);
								if (wt && this.webview) {
									sendWallTilesToWebview(this.webview, wt);
								}
							}
						} catch { /* ignore */ }
						if (this.webview) {
							sendLayout(this.context, this.webview, this.defaultLayout);
							this.startLayoutWatcher();
						}
					})();
				}
				sendExistingAgents(this.agents, this.context, this.webview);
				for (const agent of this.agents.values()) {
					this.webview?.postMessage({
						type: 'agentDiagnostics',
						id: agent.id,
						provider: agent.provider,
						projectDir: agent.projectDir,
						jsonlFile: agent.jsonlFile,
						workingDir: agent.workingDir,
					});
				}
			} else if (message.type === 'openSessionsFolder') {
				const activeAgent = this.activeAgentId.current !== null ? this.agents.get(this.activeAgentId.current) : undefined;
				const fallbackProvider = activeAgent?.provider ?? getDefaultAgentProvider();
				const projectDir = getProjectDirPath(undefined, fallbackProvider);
				if (projectDir && fs.existsSync(projectDir)) {
					vscode.env.openExternal(vscode.Uri.file(projectDir));
				}
			} else if (message.type === 'exportLayout') {
				const layout = readLayoutFromFile();
				if (!layout) {
					vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
					return;
				}
				const uri = await vscode.window.showSaveDialog({
					filters: { 'JSON Files': ['json'] },
					defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
				});
				if (uri) {
					fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
					vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
				}
			} else if (message.type === 'importLayout') {
				const uris = await vscode.window.showOpenDialog({
					filters: { 'JSON Files': ['json'] },
					canSelectMany: false,
				});
				if (!uris || uris.length === 0) return;
				try {
					const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
					const imported = JSON.parse(raw) as Record<string, unknown>;
					if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
						vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
						return;
					}
					this.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
					vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
				} catch {
					vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
				}
			}
		});

		vscode.window.onDidChangeActiveTerminal((terminal) => {
			this.activeAgentId.current = null;
			if (!terminal) return;
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === terminal) {
					this.activeAgentId.current = id;
					webviewView.webview.postMessage({ type: 'agentSelected', id });
					break;
				}
			}
		});

		vscode.window.onDidCloseTerminal((closed) => {
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === closed) {
					if (this.activeAgentId.current === id) {
						this.activeAgentId.current = null;
					}
					removeAgent(
						id, this.agents,
						this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
						this.jsonlPollTimers, this.persistAgents,
					);
					webviewView.webview.postMessage({ type: 'agentClosed', id });
				}
			}
		});
	}

	/** Export current saved layout to webview-ui/public/assets/default-layout.json (dev utility) */
	exportDefaultLayout(): void {
		const layout = readLayoutFromFile();
		if (!layout) {
			vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
			return;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
			return;
		}
		const targetPath = path.join(workspaceRoot, 'webview-ui', 'public', 'assets', 'default-layout.json');
		const json = JSON.stringify(layout, null, 2);
		fs.writeFileSync(targetPath, json, 'utf-8');
		vscode.window.showInformationMessage(`Pixel Agents: Default layout exported to ${targetPath}`);
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) return;
		this.layoutWatcher = watchLayoutFile((layout) => {
			console.log('[Pixel Agents] External layout change — pushing to webview');
			this.webview?.postMessage({ type: 'layoutLoaded', layout });
		});
	}

	dispose() {
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		for (const id of [...this.agents.keys()]) {
			removeAgent(
				id, this.agents,
				this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
				this.jsonlPollTimers, this.persistAgents,
			);
		}
		if (this.projectScanState.current) {
			clearInterval(this.projectScanState.current);
			this.projectScanState.current = null;
			this.projectScanState.provider = null;
			this.projectScanState.projectDir = null;
			this.projectScanState.workspacePath = null;
		}
	}
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}
