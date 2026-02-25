import * as fs from 'fs';
import * as path from 'path';
import type { AgentProvider, WebAgentState } from './types.js';
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

export function startFileWatching(
	agentId: number,
	filePath: string,
	agents: Map<number, WebAgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
): void {
	try {
		const watcher = fs.watch(filePath, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, send);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	const interval = setInterval(() => {
		if (!agents.has(agentId)) { clearInterval(interval); return; }
		readNewLines(agentId, agents, waitingTimers, permissionTimers, send);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

export function readNewLines(
	agentId: number,
	agents: Map<number, WebAgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
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
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				send({ type: 'agentToolPermissionClear', id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, send);
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

export function ensureProjectScan(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	projectScanStateRef: ProjectScanState,
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, WebAgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
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

	for (const f of listProjectJsonlFiles(projectDir, provider, workspacePath)) {
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
			send,
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
	_nextAgentIdRef: { current: number },
	agents: Map<number, WebAgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
	persistAgents: () => void,
	provider: AgentProvider,
	workspacePath: string | null,
): void {
	for (const file of listProjectJsonlFiles(projectDir, provider, workspacePath)) {
		if (knownJsonlFiles.has(file)) continue;
		knownJsonlFiles.add(file);
		const fileProvider = detectProviderFromJsonlFile(file);

		if (activeAgentIdRef.current === null) continue;
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
			send,
			persistAgents,
		);
	}
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	agents: Map<number, WebAgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
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
	clearAgentActivity(agent, agentId, permissionTimers, send);

	agent.provider = detectProviderFromJsonlFile(newFilePath);
	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	persistAgents();

	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, send);
	readNewLines(agentId, agents, waitingTimers, permissionTimers, send);
}
