import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { AgentProcess, WebAgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureProjectScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, INITIAL_PROMPT_DELAY_MS } from './constants.js';

export function getProjectDirPath(workingDir: string): string {
	// Match the extension's project hash: replace :, \, / with -
	const dirName = workingDir.replace(/[:\\/]/g, '-');
	return path.join(os.homedir(), '.claude', 'projects', dirName);
}

function getStringEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === 'string') {
			env[key] = value;
		}
	}
	return env;
}

function getShellExecutable(): string {
	if (process.platform === 'win32') {
		return process.env['ComSpec'] || 'cmd.exe';
	}

	const preferred = process.env['SHELL'];
	const candidates = preferred
		? [preferred, '/bin/bash', '/bin/zsh', '/bin/sh']
		: ['/bin/bash', '/bin/zsh', '/bin/sh'];

	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return '/bin/sh';
}

function getShellArgs(sessionId: string): string[] {
	const command = `claude --session-id ${sessionId}`;
	if (process.platform === 'win32') {
		return ['/d', '/s', '/c', command];
	}
	return ['-lc', command];
}

function hasClaudeCli(): boolean {
	try {
		const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
		const result = spawnSync(lookupCommand, ['claude'], { stdio: 'ignore' });
		return result.status === 0;
	} catch {
		return false;
	}
}

function createPtyClaudeProcess(workingDir: string, sessionId: string): { process: AgentProcess; mode: 'pty' } {
	const ptyProcess: IPty = pty.spawn(
		getShellExecutable(),
		getShellArgs(sessionId),
		{
			name: 'xterm-color',
			cols: 220,
			rows: 50,
			cwd: workingDir,
			env: getStringEnv(),
		},
	);

	return {
		process: {
			write(data: string): void {
				ptyProcess.write(data);
			},
			kill(): void {
				ptyProcess.kill();
			},
			onExit(handler: (event: { exitCode: number }) => void): void {
				ptyProcess.onExit(({ exitCode }) => handler({ exitCode }));
			},
		},
		mode: 'pty',
	};
}

function createStdioClaudeProcess(workingDir: string, sessionId: string): { process: AgentProcess; mode: 'stdio' } {
	const child = spawn(
		getShellExecutable(),
		getShellArgs(sessionId),
		{
			cwd: workingDir,
			env: getStringEnv(),
			stdio: ['pipe', 'ignore', 'ignore'],
		},
	);

	return {
		process: {
			write(data: string): void {
				if (child.stdin && !child.stdin.destroyed) {
					child.stdin.write(data);
				}
			},
			kill(): void {
				if (!child.killed) {
					child.kill();
				}
			},
			onExit(handler: (event: { exitCode: number }) => void): void {
				child.on('exit', (code) => handler({ exitCode: code ?? 0 }));
				child.on('error', () => handler({ exitCode: 1 }));
			},
		},
		mode: 'stdio',
	};
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

	if (!hasClaudeCli()) {
		const msg = 'Could not start agent: Claude CLI was not found in PATH. Install Claude Code and verify `claude --version` works in this terminal.';
		console.error(`[Pixel Agents] ${msg}`);
		send({ type: 'serverError', message: msg });
		return;
	}

	let processHandle: AgentProcess;
	let processMode: 'pty' | 'stdio';
	let launchError: unknown = null;

	try {
		const launched = createPtyClaudeProcess(workingDir, sessionId);
		processHandle = launched.process;
		processMode = launched.mode;
	} catch (err) {
		launchError = err;
		console.warn(`[Pixel Agents] PTY spawn failed for agent #${idx}: ${err}`);
		try {
			const launched = createStdioClaudeProcess(workingDir, sessionId);
			processHandle = launched.process;
			processMode = launched.mode;
			console.warn(`[Pixel Agents] Agent #${idx} is using stdio fallback (no PTY)`);
		} catch (fallbackErr) {
			launchError = fallbackErr;
			const msg = 'Could not start Claude process. Ensure your shell can run `claude --session-id <id>` from this folder.';
			console.error(`[Pixel Agents] ${msg} Error: ${fallbackErr}`);
			send({ type: 'serverError', message: `${msg} (${String(fallbackErr)})` });
			return;
		}
	}

	const projectDir = getProjectDirPath(workingDir);
	const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
	knownJsonlFiles.add(expectedFile);

	const id = nextAgentIdRef.current++;
	const agent: WebAgentState = {
		id,
		process: processHandle,
		processMode,
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

	console.log(`[Pixel Agents] Agent ${id}: spawned claude session ${sessionId} (agent #${idx}, mode=${processMode}) in ${workingDir}`);
	if (launchError) {
		console.warn(`[Pixel Agents] Agent ${id}: recovered from launch error: ${String(launchError)}`);
	}
	send({ type: 'agentCreated', id });

	// If there's an initial prompt, write it after the startup delay
	if (initialPrompt) {
		setTimeout(() => {
			const currentAgent = agents.get(id);
			if (currentAgent) {
				console.log(`[Pixel Agents] Agent ${id}: sending initial prompt`);
				currentAgent.process.write(initialPrompt + '\r');
			}
		}, INITIAL_PROMPT_DELAY_MS);
	}

	// Handle process exit
	const launchedAtMs = Date.now();
	processHandle.onExit(({ exitCode }) => {
		console.log(`[Pixel Agents] Agent ${id}: process exited with code ${exitCode} (mode=${processMode})`);
		const exitedQuickly = Date.now() - launchedAtMs < 5000;
		if (exitCode !== 0 && exitedQuickly && !fs.existsSync(expectedFile)) {
			const msg = 'Claude exited right away. Verify Claude CLI is installed and can run interactively in this terminal.';
			send({ type: 'serverError', message: msg });
		}
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
