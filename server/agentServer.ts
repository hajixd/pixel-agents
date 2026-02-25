import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { AgentProcess, AgentProvider, WebAgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureProjectScan, type ProjectScanState } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, INITIAL_PROMPT_DELAY_MS } from './constants.js';

const PROVIDER_ENV_KEY = 'PIXEL_AGENTS_PROVIDER';

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
		const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
		const result = spawnSync(lookupCommand, [command], { stdio: 'ignore' });
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

function resolveProvider(preferred?: AgentProvider): AgentProvider | null {
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
	return null;
}

function getLaunchCommand(provider: AgentProvider, sessionId: string): string {
	if (provider === 'codex') {
		return 'codex';
	}
	return `claude --session-id ${sessionId}`;
}

function shouldPollExpectedJsonl(provider: AgentProvider): boolean {
	return provider === 'claude';
}

export function getProjectDirPath(workingDir: string, provider: AgentProvider = getDefaultAgentProvider()): string {
	if (provider === 'codex') {
		return path.join(os.homedir(), '.codex', 'sessions');
	}
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

function getShellArgs(command: string): string[] {
	if (process.platform === 'win32') {
		return ['/d', '/s', '/c', command];
	}
	return ['-lc', command];
}

function createPtyProcess(workingDir: string, command: string): { process: AgentProcess; mode: 'pty' } {
	const ptyProcess: IPty = pty.spawn(
		getShellExecutable(),
		getShellArgs(command),
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

function createStdioProcess(workingDir: string, command: string): { process: AgentProcess; mode: 'stdio' } {
	const child = spawn(
		getShellExecutable(),
		getShellArgs(command),
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
	projectScanStateRef: ProjectScanState,
	workingDir: string,
	send: (msg: unknown) => void,
	persistAgents: () => void,
	initialPrompt?: string,
	providerArg?: AgentProvider,
	workingDirArg?: string,
	preferredSeatId?: string | null,
): void {
	const resolvedProvider = resolveProvider(providerArg);
	if (!resolvedProvider) {
		const msg = 'Could not start agent: neither `claude` nor `codex` was found in PATH.';
		console.error(`[Pixel Agents] ${msg}`);
		send({ type: 'serverError', message: msg });
		return;
	}

	const provider = resolvedProvider;
	const idx = nextTerminalIndexRef.current++;
	const sessionId = crypto.randomUUID();
	const launchCommand = getLaunchCommand(provider, sessionId);
	const effectiveWorkingDir = workingDirArg ?? workingDir;

	let processHandle: AgentProcess;
	let processMode: 'pty' | 'stdio';
	let launchError: unknown = null;

	try {
		const launched = createPtyProcess(effectiveWorkingDir, launchCommand);
		processHandle = launched.process;
		processMode = launched.mode;
	} catch (err) {
		launchError = err;
		console.warn(`[Pixel Agents] PTY spawn failed for agent #${idx}: ${err}`);
		try {
			const launched = createStdioProcess(effectiveWorkingDir, launchCommand);
			processHandle = launched.process;
			processMode = launched.mode;
			console.warn(`[Pixel Agents] Agent #${idx} is using stdio fallback (no PTY)`);
		} catch (fallbackErr) {
			launchError = fallbackErr;
			const msg = `Could not start ${provider} process. Ensure your shell can run \`${launchCommand}\` from this folder.`;
			console.error(`[Pixel Agents] ${msg} Error: ${fallbackErr}`);
			send({ type: 'serverError', message: `${msg} (${String(fallbackErr)})` });
			return;
		}
	}

	const projectDir = getProjectDirPath(effectiveWorkingDir, provider);
	const expectedFile = provider === 'claude'
		? path.join(projectDir, `${sessionId}.jsonl`)
		: path.join(projectDir, `pending-${sessionId}.jsonl`);
	if (provider === 'claude') {
		knownJsonlFiles.add(expectedFile);
	}

	const id = nextAgentIdRef.current++;
	const agent: WebAgentState = {
		id,
		provider,
		workingDir: effectiveWorkingDir,
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

	console.log(`[Pixel Agents] Agent ${id}: spawned ${provider} session ${sessionId} (agent #${idx}, mode=${processMode}) in ${effectiveWorkingDir}`);
	if (launchError) {
		console.warn(`[Pixel Agents] Agent ${id}: recovered from launch error: ${String(launchError)}`);
	}
	send({
		type: 'agentCreated',
		id,
		provider,
		seatId: preferredSeatId ?? undefined,
		projectDir,
		jsonlFile: expectedFile,
		workingDir: effectiveWorkingDir,
		processMode,
	});

	if (initialPrompt) {
		setTimeout(() => {
			const currentAgent = agents.get(id);
			if (currentAgent) {
				console.log(`[Pixel Agents] Agent ${id}: sending initial prompt`);
				currentAgent.process.write(initialPrompt + '\r');
			}
		}, INITIAL_PROMPT_DELAY_MS);
	}

	const launchedAtMs = Date.now();
	processHandle.onExit(({ exitCode }) => {
		console.log(`[Pixel Agents] Agent ${id}: process exited with code ${exitCode} (mode=${processMode}, provider=${provider})`);
		const exitedQuickly = Date.now() - launchedAtMs < 5000;
		if (exitCode !== 0 && exitedQuickly && provider === 'claude' && !fs.existsSync(expectedFile)) {
			const msg = 'Claude exited right away. Verify Claude CLI is installed and can run interactively in this terminal.';
			send({ type: 'serverError', message: msg });
		}
		removeAgent(id, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, jsonlPollTimers, persistAgents);
		send({ type: 'agentClosed', id });
	});

	ensureProjectScan(
		projectDir,
		knownJsonlFiles,
		projectScanStateRef,
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
		effectiveWorkingDir,
	);

	if (!shouldPollExpectedJsonl(provider)) {
		return;
	}

	const pollTimer = setInterval(() => {
		try {
			if (fs.existsSync(agent.jsonlFile)) {
				console.log(`[Pixel Agents] Agent ${id}: found JSONL file`);
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, send);
				readNewLines(id, agents, waitingTimers, permissionTimers, send);
			}
		} catch {
			// file may not exist yet
		}
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
	const agentProviders: Record<string, AgentProvider> = {};
	const agentInfo: Record<string, {
		provider: AgentProvider;
		workingDir: string;
		projectDir: string;
		jsonlFile: string;
		processMode: 'pty' | 'stdio';
	}> = {};
	for (const [id, agent] of agents) {
		agentProviders[String(id)] = agent.provider;
		agentInfo[String(id)] = {
			provider: agent.provider,
			workingDir: agent.workingDir,
			projectDir: agent.projectDir,
			jsonlFile: agent.jsonlFile,
			processMode: agent.processMode,
		};
	}
	send({ type: 'existingAgents', agents: agentIds, agentMeta, agentProviders, agentInfo });
}
