import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import type { AgentProvider, AgentState, PersistedAgent } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureProjectScan, type ProjectScanState } from './fileWatcher.js';
import {
	JSONL_POLL_INTERVAL_MS,
	TERMINAL_NAME_PREFIX,
	CODEX_TERMINAL_NAME_PREFIX,
	WORKSPACE_KEY_AGENTS,
	WORKSPACE_KEY_AGENT_SEATS,
} from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';

const PROVIDER_ENV_KEY = 'PIXEL_AGENTS_PROVIDER';
const CLAUDE_PROMPT_DELAY_MS = 1000;
const CODEX_PROMPT_DELAY_MS = 2500;

export interface ProviderStatus {
	claude: boolean;
	codex: boolean;
	defaultProvider: AgentProvider;
}

function normalizeProvider(raw?: string): AgentProvider | null {
	if (!raw) return null;
	const value = raw.trim().toLowerCase();
	if (value === 'claude' || value === 'codex') return value;
	return null;
}

function hasCli(command: 'claude' | 'codex'): boolean {
	try {
		const lookup = process.platform === 'win32' ? 'where' : 'which';
		const result = spawnSync(lookup, [command], { stdio: 'ignore' });
		return result.status === 0;
	} catch {
		return false;
	}
}

export function getDefaultAgentProvider(): AgentProvider {
	const forced = normalizeProvider(process.env[PROVIDER_ENV_KEY]);
	if (forced) return forced;

	if (hasCli('claude')) return 'claude';
	if (hasCli('codex')) return 'codex';
	return 'claude';
}

export function getProviderStatus(): ProviderStatus {
	const claude = hasCli('claude');
	const codex = hasCli('codex');
	return {
		claude,
		codex,
		defaultProvider: claude ? 'claude' : codex ? 'codex' : 'claude',
	};
}

function resolveProvider(preferred?: AgentProvider): AgentProvider {
	const forced = normalizeProvider(process.env[PROVIDER_ENV_KEY]);
	const candidates: AgentProvider[] = [];
	for (const candidate of [preferred, forced, 'claude', 'codex'] as Array<AgentProvider | null | undefined>) {
		if (!candidate) continue;
		if (!candidates.includes(candidate)) {
			candidates.push(candidate);
		}
	}
	for (const candidate of candidates) {
		if (hasCli(candidate)) return candidate;
	}
	return preferred ?? forced ?? 'claude';
}

function getProviderPrefix(provider: AgentProvider): string {
	return provider === 'codex' ? CODEX_TERMINAL_NAME_PREFIX : TERMINAL_NAME_PREFIX;
}

function buildLaunchCommand(provider: AgentProvider, sessionId: string): string {
	if (provider === 'codex') {
		return 'codex';
	}
	return `claude --session-id ${sessionId}`;
}

function shouldPollExpectedJsonl(provider: AgentProvider): boolean {
	return provider === 'claude';
}

function inferProvider(persisted: PersistedAgent): AgentProvider {
	if (persisted.provider) return persisted.provider;
	if (persisted.jsonlFile.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`)) return 'codex';
	if (persisted.terminalName.startsWith(CODEX_TERMINAL_NAME_PREFIX)) return 'codex';
	return 'claude';
}

export function getProjectDirPath(cwd?: string, provider: AgentProvider = getDefaultAgentProvider()): string | null {
	if (provider === 'codex') {
		return path.join(os.homedir(), '.codex', 'sessions');
	}
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) return null;
	const dirName = workspacePath.replace(/[:\\/]/g, '-');
	return path.join(os.homedir(), '.claude', 'projects', dirName);
}

export function launchNewTerminal(
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanStateRef: ProjectScanState,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	prompt?: string,
	providerArg?: AgentProvider,
	workingDirArg?: string | null,
	preferredSeatId?: string | null,
): void {
	const provider = resolveProvider(providerArg);
	const idx = nextTerminalIndexRef.current++;
	const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const cwd = workingDirArg ?? workspaceCwd;
	const terminal = vscode.window.createTerminal({
		name: `${getProviderPrefix(provider)} #${idx}`,
		cwd,
	});
	terminal.show();

	const sessionId = crypto.randomUUID();
	terminal.sendText(buildLaunchCommand(provider, sessionId));

	const projectDir = getProjectDirPath(cwd, provider);
	if (!projectDir) {
		console.log('[Pixel Agents] No project dir, cannot track agent');
		return;
	}

	const expectedFile = provider === 'claude'
		? path.join(projectDir, `${sessionId}.jsonl`)
		: path.join(projectDir, `pending-${sessionId}.jsonl`);
	if (provider === 'claude') {
		// Pre-register expected JSONL file so project scan won't treat it as a /clear file.
		knownJsonlFiles.add(expectedFile);
	}

	// Create agent immediately (before JSONL file exists).
	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		provider,
		workingDir: cwd ?? null,
		terminalRef: terminal,
		projectDir,
		jsonlFile: expectedFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		pendingPrompt: prompt,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();
	console.log(`[Pixel Agents] Agent ${id}: created for terminal ${terminal.name} (provider=${provider})`);
	webview?.postMessage({
		type: 'agentCreated',
		id,
		provider,
		seatId: preferredSeatId ?? undefined,
		projectDir,
		jsonlFile: expectedFile,
		workingDir: cwd ?? null,
	});

	ensureProjectScan(
		projectDir, knownJsonlFiles, projectScanStateRef, activeAgentIdRef,
		nextAgentIdRef, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		webview, persistAgents, provider, cwd ?? null,
	);

	if (!shouldPollExpectedJsonl(provider)) {
		if (agent.pendingPrompt) {
			const pendingText = agent.pendingPrompt;
			agent.pendingPrompt = undefined;
			setTimeout(() => {
				agent.terminalRef.sendText(pendingText);
			}, CODEX_PROMPT_DELAY_MS);
		}
		return;
	}

	// Poll for the specific JSONL file to appear.
	const pollTimer = setInterval(() => {
		try {
			if (fs.existsSync(agent.jsonlFile)) {
				console.log(`[Pixel Agents] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
				readNewLines(id, agents, waitingTimers, permissionTimers, webview);
				if (agent.pendingPrompt) {
					const pendingText = agent.pendingPrompt;
					agent.pendingPrompt = undefined;
					setTimeout(() => {
						agent.terminalRef.sendText(pendingText);
					}, CLAUDE_PROMPT_DELAY_MS);
				}
			}
		} catch {
			// file may not exist yet
		}
	}, JSONL_POLL_INTERVAL_MS);
	jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) {
		clearInterval(jpTimer);
	}
	jsonlPollTimers.delete(agentId);

	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) {
		clearInterval(pt);
	}
	pollingTimers.delete(agentId);

	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	agents.delete(agentId);
	persistAgents();
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			provider: agent.provider,
			workingDir: agent.workingDir,
			terminalName: agent.terminalRef.name,
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanStateRef: ProjectScanState,
	activeAgentIdRef: { current: number | null },
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) return;

	const liveTerminals = vscode.window.terminals;
	let maxId = 0;
	let maxIdx = 0;
	let restoredScanConfig: { projectDir: string; provider: AgentProvider; workspacePath: string | null } | null = null;
	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

	for (const p of persisted) {
		const terminal = liveTerminals.find(t => t.name === p.terminalName);
		if (!terminal) continue;

		const provider = inferProvider(p);
		const agent: AgentState = {
			id: p.id,
			provider,
			workingDir: p.workingDir ?? null,
			terminalRef: terminal,
			projectDir: p.projectDir,
			jsonlFile: p.jsonlFile,
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
		};

		agents.set(p.id, agent);
		knownJsonlFiles.add(p.jsonlFile);
		console.log(`[Pixel Agents] Restored agent ${p.id} → terminal "${p.terminalName}" (provider=${provider})`);

		if (p.id > maxId) maxId = p.id;
		const match = p.terminalName.match(/#(\d+)$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) maxIdx = idx;
		}

		restoredScanConfig = {
			projectDir: p.projectDir,
			provider,
			workspacePath,
		};

		try {
			if (fs.existsSync(p.jsonlFile)) {
				const stat = fs.statSync(p.jsonlFile);
				agent.fileOffset = stat.size;
				startFileWatching(p.id, p.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
			} else if (provider === 'claude') {
				const pollTimer = setInterval(() => {
					try {
						if (fs.existsSync(agent.jsonlFile)) {
							console.log(`[Pixel Agents] Restored agent ${p.id}: found JSONL file`);
							clearInterval(pollTimer);
							jsonlPollTimers.delete(p.id);
							const stat = fs.statSync(agent.jsonlFile);
							agent.fileOffset = stat.size;
							startFileWatching(p.id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
						}
					} catch {
						// file may not exist yet
					}
				}, JSONL_POLL_INTERVAL_MS);
				jsonlPollTimers.set(p.id, pollTimer);
			}
		} catch {
			// ignore errors during restore
		}
	}

	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}
	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	doPersist();

	if (restoredScanConfig) {
		ensureProjectScan(
			restoredScanConfig.projectDir,
			knownJsonlFiles,
			projectScanStateRef,
			activeAgentIdRef,
			nextAgentIdRef,
			agents,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			doPersist,
			restoredScanConfig.provider,
			restoredScanConfig.workspacePath,
		);
	}
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; hueShift?: number; seatId?: string | null }>>(WORKSPACE_KEY_AGENT_SEATS, {});
	const agentProviders: Record<string, AgentProvider> = {};
	const agentInfo: Record<string, { provider: AgentProvider; workingDir: string | null; projectDir: string; jsonlFile: string }> = {};
	for (const [id, agent] of agents) {
		agentProviders[String(id)] = agent.provider;
		agentInfo[String(id)] = {
			provider: agent.provider,
			workingDir: agent.workingDir,
			projectDir: agent.projectDir,
			jsonlFile: agent.jsonlFile,
		};
	}
	console.log(`[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		agentProviders,
		agentInfo,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	for (const [agentId, agent] of agents) {
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) return;
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
