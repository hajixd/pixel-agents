import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentProvider, AgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS } from './constants.js';

export interface ProjectScanState {
	current: ReturnType<typeof setInterval> | null;
	provider: AgentProvider | null;
	projectDir: string | null;
	workspacePath: string | null;
}

const CODEX_SESSIONS_MARKER = `${path.sep}.codex${path.sep}sessions${path.sep}`;

function detectProviderFromJsonlFile(filePath: string): AgentProvider {
	return filePath.includes(CODEX_SESSIONS_MARKER) ? 'codex' : 'claude';
}

function listJsonlFilesInDir(projectDir: string): string[] {
	try {
		return fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
	} catch {
		return [];
	}
}

function listCodexJsonlFiles(projectDir: string): string[] {
	const files: string[] = [];
	let years: fs.Dirent[];
	try {
		years = fs.readdirSync(projectDir, { withFileTypes: true });
	} catch {
		return files;
	}

	for (const year of years) {
		if (!year.isDirectory()) continue;
		const yearDir = path.join(projectDir, year.name);
		let months: fs.Dirent[];
		try {
			months = fs.readdirSync(yearDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const month of months) {
			if (!month.isDirectory()) continue;
			const monthDir = path.join(yearDir, month.name);
			let days: fs.Dirent[];
			try {
				days = fs.readdirSync(monthDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const day of days) {
				if (!day.isDirectory()) continue;
				const dayDir = path.join(monthDir, day.name);
				let entries: fs.Dirent[];
				try {
					entries = fs.readdirSync(dayDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
					files.push(path.join(dayDir, entry.name));
				}
			}
		}
	}
	return files;
}

function isCodexSessionForWorkspace(jsonlFile: string, workspacePath: string | null): boolean {
	if (!workspacePath) return true;
	try {
		const fd = fs.openSync(jsonlFile, 'r');
		const buf = Buffer.alloc(16384);
		const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
		fs.closeSync(fd);
		if (bytesRead <= 0) return false;
		const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0]?.trim();
		if (!firstLine) return false;
		const meta = JSON.parse(firstLine) as {
			type?: string;
			payload?: { cwd?: string };
		};
		if (meta.type !== 'session_meta') return false;
		return meta.payload?.cwd === workspacePath;
	} catch {
		return false;
	}
}

function listProjectJsonlFiles(projectDir: string, provider: AgentProvider, workspacePath: string | null): string[] {
	if (provider === 'codex') {
		return listCodexJsonlFiles(projectDir).filter((f) => isCodexSessionForWorkspace(f, workspacePath));
	}
	return listJsonlFilesInDir(projectDir);
}

function getNewestJsonlFile(files: string[]): string | null {
	let newest: string | null = null;
	let newestMtime = -1;
	for (const file of files) {
		try {
			const mtime = fs.statSync(file).mtimeMs;
			if (mtime > newestMtime) {
				newestMtime = mtime;
				newest = file;
			}
		} catch {
			// ignore files that vanish mid-scan
		}
	}
	return newest;
}

export function startFileWatching(
	agentId: number,
	filePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	try {
		const watcher = fs.watch(filePath, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	const interval = setInterval(() => {
		if (!agents.has(agentId)) { clearInterval(interval); return; }
		readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

export function readNewLines(
	agentId: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const stat = fs.statSync(agent.jsonlFile);
		if (stat.size <= agent.fileOffset) return;

		const buf = Buffer.alloc(stat.size - agent.fileOffset);
		const fd = fs.openSync(agent.jsonlFile, 'r');
		fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
		fs.closeSync(fd);
		agent.fileOffset = stat.size;

		const text = agent.lineBuffer + buf.toString('utf-8');
		const lines = text.split('\n');
		agent.lineBuffer = lines.pop() || '';

		const hasLines = lines.some(l => l.trim());
		if (hasLines) {
			webview?.postMessage({ type: 'agentHeartbeat', id: agentId, timestamp: Date.now(), jsonlFile: agent.jsonlFile });
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

export function resyncAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	workspacePath: string | null,
): void {
	const agent = agents.get(agentId);
	if (!agent) {
		webview?.postMessage({ type: 'agentResynced', id: agentId, ok: false, reason: 'Agent not found' });
		return;
	}

	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const interval = pollingTimers.get(agentId);
	if (interval) {
		clearInterval(interval);
	}
	pollingTimers.delete(agentId);

	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	if (!fs.existsSync(agent.jsonlFile)) {
		const candidates = listProjectJsonlFiles(agent.projectDir, agent.provider, workspacePath);
		const newest = getNewestJsonlFile(candidates);
		if (!newest) {
			webview?.postMessage({
				type: 'agentResynced',
				id: agentId,
				ok: false,
				reason: 'No transcript files found for this agent/provider.',
			});
			return;
		}

		agent.provider = detectProviderFromJsonlFile(newest);
		agent.jsonlFile = newest;
		agent.fileOffset = 0;
		agent.lineBuffer = '';
		knownJsonlFiles.add(newest);
		persistAgents();
	}

	startFileWatching(agentId, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);

	webview?.postMessage({
		type: 'agentDiagnostics',
		id: agentId,
		provider: agent.provider,
		projectDir: agent.projectDir,
		jsonlFile: agent.jsonlFile,
		workingDir: agent.workingDir,
	});
	webview?.postMessage({ type: 'agentResynced', id: agentId, ok: true, jsonlFile: agent.jsonlFile });
}

export function ensureProjectScan(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	projectScanStateRef: ProjectScanState,
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	provider: AgentProvider = 'claude',
	workspacePath: string | null = null,
): void {
	if (
		projectScanStateRef.current
		&& projectScanStateRef.provider === provider
		&& projectScanStateRef.projectDir === projectDir
		&& projectScanStateRef.workspacePath === workspacePath
	) {
		return;
	}

	if (projectScanStateRef.current) {
		clearInterval(projectScanStateRef.current);
		projectScanStateRef.current = null;
	}

	const seededFiles = listProjectJsonlFiles(projectDir, provider, workspacePath);
	for (const f of seededFiles) {
		knownJsonlFiles.add(f);
	}

	projectScanStateRef.provider = provider;
	projectScanStateRef.projectDir = projectDir;
	projectScanStateRef.workspacePath = workspacePath;
	projectScanStateRef.current = setInterval(() => {
		scanForNewJsonlFiles(
			projectDir,
			knownJsonlFiles,
			activeAgentIdRef,
			nextAgentIdRef,
			agents,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			persistAgents,
			provider,
			workspacePath,
		);
	}, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewJsonlFiles(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	provider: AgentProvider,
	workspacePath: string | null,
): void {
	const files = listProjectJsonlFiles(projectDir, provider, workspacePath);
	for (const file of files) {
		if (knownJsonlFiles.has(file)) continue;
		knownJsonlFiles.add(file);
		const fileProvider = detectProviderFromJsonlFile(file);

		if (activeAgentIdRef.current !== null) {
			const activeAgent = agents.get(activeAgentIdRef.current);
			if (activeAgent && activeAgent.provider !== fileProvider) {
				continue;
			}
			console.log(`[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning to agent ${activeAgentIdRef.current}`);
			reassignAgentToFile(
				activeAgentIdRef.current,
				file,
				agents,
				fileWatchers,
				pollingTimers,
				waitingTimers,
				permissionTimers,
				webview,
				persistAgents,
			);
			continue;
		}

		const activeTerminal = vscode.window.activeTerminal;
		if (!activeTerminal) continue;
		let owned = false;
		for (const agent of agents.values()) {
			if (agent.terminalRef === activeTerminal) {
				owned = true;
				break;
			}
		}
		if (owned) continue;
		adoptTerminalForFile(
			activeTerminal,
			file,
			projectDir,
			fileProvider,
			nextAgentIdRef,
			agents,
			activeAgentIdRef,
			fileWatchers,
			pollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
			persistAgents,
		);
	}
}

function adoptTerminalForFile(
	terminal: vscode.Terminal,
	jsonlFile: string,
	projectDir: string,
	provider: AgentProvider,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		provider,
		workingDir: null,
		terminalRef: terminal,
		projectDir,
		jsonlFile,
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

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	console.log(`[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)} (provider=${provider})`);
	webview?.postMessage({
		type: 'agentCreated',
		id,
		provider,
		projectDir,
		jsonlFile,
		workingDir: null,
	});

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) {
		clearInterval(pt);
	}
	pollingTimers.delete(agentId);

	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	clearAgentActivity(agent, agentId, permissionTimers, webview);

	agent.provider = detectProviderFromJsonlFile(newFilePath);
	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	persistAgents();

	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
