import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebAgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureProjectScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, INITIAL_PROMPT_DELAY_MS } from './constants.js';

export function getProjectDirPath(workingDir: string): string {
	// Match the extension's project hash: replace :, \, / with -
	const dirName = workingDir.replace(/[:\\/]/g, '-');
	return path.join(os.homedir(), '.claude', 'projects', dirName);
}

export function launchNewAgent(
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, WebAgentState>,
	activeAgentIdRef: { current: number | null },
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	workingDir: string,
	send: (msg: unknown) => void,
	persistAgents: () => void,
	initialPrompt?: string,
): void {
	const idx = nextTerminalIndexRef.current++;
	const sessionId = crypto.randomUUID();

	// Spawn claude with node-pty so it thinks it's in a real terminal
	let ptyProcess: IPty;
	try {
		ptyProcess = pty.spawn(
			process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
			['-c', `claude --session-id ${sessionId}`],
			{
				name: 'xterm-color',
				cols: 220,
				rows: 50,
				cwd: workingDir,
				env: process.env as Record<string, string>,
			},
		);
	} catch (err) {
		console.error(`[Pixel Agents] Failed to spawn PTY for agent #${idx}: ${err}`);
		return;
	}

	const projectDir = getProjectDirPath(workingDir);
	const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
	knownJsonlFiles.add(expectedFile);

	const id = nextAgentIdRef.current++;
	const agent: WebAgentState = {
		id,
		ptyProcess,
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
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	console.log(`[Pixel Agents] Agent ${id}: spawned claude session ${sessionId} (terminal #${idx}) in ${workingDir}`);
	send({ type: 'agentCreated', id });

	// If there's an initial prompt, write it after the startup delay
	if (initialPrompt) {
		setTimeout(() => {
			const currentAgent = agents.get(id);
			if (currentAgent) {
				console.log(`[Pixel Agents] Agent ${id}: sending initial prompt`);
				currentAgent.ptyProcess.write(initialPrompt + '\r');
			}
		}, INITIAL_PROMPT_DELAY_MS);
	}

	// Handle PTY exit
	ptyProcess.onExit(({ exitCode }) => {
		console.log(`[Pixel Agents] Agent ${id}: PTY exited with code ${exitCode}`);
		removeAgent(id, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, jsonlPollTimers, persistAgents);
		send({ type: 'agentClosed', id });
	});

	ensureProjectScan(
		projectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
		nextAgentIdRef, agents, fileWatchers, pollingTimers, waitingTimers,
		permissionTimers, send, persistAgents,
	);

	// Poll for the JSONL file to appear (claude writes it on first turn)
	const pollTimer = setInterval(() => {
		try {
			if (fs.existsSync(agent.jsonlFile)) {
				console.log(`[Pixel Agents] Agent ${id}: found JSONL file`);
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, send);
				readNewLines(id, agents, waitingTimers, permissionTimers, send);
			}
		} catch { /* file may not exist yet */ }
	}, JSONL_POLL_INTERVAL_MS);
	jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
	agentId: number,
	agents: Map<number, WebAgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	persistAgents: () => void,
): void {
	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) clearInterval(jpTimer);
	jsonlPollTimers.delete(agentId);

	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) clearInterval(pt);
	pollingTimers.delete(agentId);

	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	agents.delete(agentId);
	persistAgents();
}

export function sendExistingAgents(
	agents: Map<number, WebAgentState>,
	agentMeta: Record<string, { palette?: number; hueShift?: number; seatId?: string | null }>,
	send: (msg: unknown) => void,
): void {
	const agentIds: number[] = [];
	for (const id of agents.keys()) agentIds.push(id);
	agentIds.sort((a, b) => a - b);
	send({ type: 'existingAgents', agents: agentIds, agentMeta });
}
