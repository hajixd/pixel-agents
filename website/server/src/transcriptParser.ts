import * as path from 'path';
import type { WebAgentState } from './types.js';
import {
	cancelWaitingTimer,
	startWaitingTimer,
	clearAgentActivity,
	startPermissionTimer,
	cancelPermissionTimer,
} from './timerManager.js';
import {
	TOOL_DONE_DELAY_MS,
	TEXT_IDLE_DELAY_MS,
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
	TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'AskUserQuestion']);
const CODEX_PERMISSION_SENSITIVE_TOOLS = new Set(['exec_command', 'shell_command']);

function safeJsonParseObject(raw: unknown): Record<string, unknown> {
	if (typeof raw !== 'string' || !raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function formatCodexToolStatus(toolName: string, rawArgs: unknown): string {
	const args = safeJsonParseObject(rawArgs);
	switch (toolName) {
		case 'exec_command': {
			const cmd = (args.cmd as string) || '';
			return cmd
				? `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`
				: 'Running command';
		}
		case 'shell_command': {
			const cmd = (args.command as string) || '';
			return cmd
				? `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`
				: 'Running command';
		}
		case 'write_stdin':
			return 'Interacting with command';
		case 'update_plan':
			return 'Updating plan';
		case 'apply_patch':
			return 'Editing files';
		default:
			return `Using ${toolName}`;
	}
}

function setWaitingStatus(
	agentId: number,
	agent: WebAgentState,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
): void {
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	if (agent.activeToolIds.size > 0) {
		agent.activeToolIds.clear();
		agent.activeToolStatuses.clear();
		agent.activeToolNames.clear();
		agent.activeSubagentToolIds.clear();
		agent.activeSubagentToolNames.clear();
		send({ type: 'agentToolsClear', id: agentId });
	}
	agent.isWaiting = true;
	agent.permissionSent = false;
	agent.hadToolsInTurn = false;
	send({ type: 'agentStatus', id: agentId, status: 'waiting' });
}

function processCodexTranscriptLine(
	agentId: number,
	record: Record<string, unknown>,
	agent: WebAgentState,
	agents: Map<number, WebAgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
): void {
	if (record.type === 'event_msg') {
		const payload = record.payload as Record<string, unknown> | undefined;
		const eventType = payload?.type as string | undefined;
		if (eventType === 'user_message' || eventType === 'turn_aborted') {
			cancelWaitingTimer(agentId, waitingTimers);
			clearAgentActivity(agent, agentId, permissionTimers, send);
			agent.hadToolsInTurn = false;
			return;
		}
		if (eventType === 'task_complete') {
			setWaitingStatus(agentId, agent, waitingTimers, permissionTimers, send);
		}
		return;
	}

	if (record.type !== 'response_item') return;

	const payload = record.payload as Record<string, unknown> | undefined;
	const payloadType = payload?.type as string | undefined;
	if (!payload || !payloadType) return;

	if (payloadType === 'function_call') {
		const toolId = payload.call_id as string | undefined;
		const toolName = payload.name as string | undefined;
		if (!toolId || !toolName) return;

		const status = formatCodexToolStatus(toolName, payload.arguments);
		agent.activeToolIds.add(toolId);
		agent.activeToolStatuses.set(toolId, status);
		agent.activeToolNames.set(toolId, toolName);
		agent.isWaiting = false;
		agent.hadToolsInTurn = true;
		send({ type: 'agentStatus', id: agentId, status: 'active' });
		send({
			type: 'agentToolStart',
			id: agentId,
			toolId,
			status,
		});
		if (CODEX_PERMISSION_SENSITIVE_TOOLS.has(toolName)) {
			startPermissionTimer(agentId, agents, permissionTimers, CODEX_PERMISSION_SENSITIVE_TOOLS, send);
		}
		return;
	}

	if (payloadType === 'function_call_output') {
		const toolId = payload.call_id as string | undefined;
		if (!toolId) return;
		const existed = agent.activeToolIds.has(toolId);
		agent.activeToolIds.delete(toolId);
		agent.activeToolStatuses.delete(toolId);
		agent.activeToolNames.delete(toolId);
		if (existed) {
			setTimeout(() => {
				send({ type: 'agentToolDone', id: agentId, toolId });
			}, TOOL_DONE_DELAY_MS);
		}
		if (agent.activeToolIds.size === 0) {
			agent.hadToolsInTurn = false;
		}
		return;
	}

	if (payloadType === 'message' && payload.role === 'assistant') {
		const phase = payload.phase as string | undefined;
		if (phase === 'final_answer') {
			setWaitingStatus(agentId, agent, waitingTimers, permissionTimers, send);
			return;
		}
		if (!agent.hadToolsInTurn) {
			startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, send);
		}
	}
}

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	switch (toolName) {
		case 'Read': return `Reading ${base(input.file_path)}`;
		case 'Edit': return `Editing ${base(input.file_path)}`;
		case 'Write': return `Writing ${base(input.file_path)}`;
		case 'Bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'Glob': return 'Searching files';
		case 'Grep': return 'Searching code';
		case 'WebFetch': return 'Fetching web content';
		case 'WebSearch': return 'Searching the web';
		case 'Task': {
			const desc = typeof input.description === 'string' ? input.description : '';
			return desc ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}` : 'Running subtask';
		}
		case 'AskUserQuestion': return 'Waiting for your answer';
		case 'EnterPlanMode': return 'Planning';
		case 'NotebookEdit': return `Editing notebook`;
		default: return `Using ${toolName}`;
	}
}

export function processTranscriptLine(
	agentId: number,
	line: string,
	agents: Map<number, WebAgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const record = JSON.parse(line);
		if (agent.provider === 'codex') {
			processCodexTranscriptLine(agentId, record, agent, agents, waitingTimers, permissionTimers, send);
			return;
		}

		if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
			const blocks = record.message.content as Array<{
				type: string; id?: string; name?: string; input?: Record<string, unknown>;
			}>;
			const hasToolUse = blocks.some(b => b.type === 'tool_use');

			if (hasToolUse) {
				cancelWaitingTimer(agentId, waitingTimers);
				agent.isWaiting = false;
				agent.hadToolsInTurn = true;
				send({ type: 'agentStatus', id: agentId, status: 'active' });
				let hasNonExemptTool = false;
				for (const block of blocks) {
					if (block.type === 'tool_use' && block.id) {
						const toolName = block.name || '';
						const status = formatToolStatus(toolName, block.input || {});
						console.log(`[Pixel Agents] Agent ${agentId} tool start: ${block.id} ${status}`);
						agent.activeToolIds.add(block.id);
						agent.activeToolStatuses.set(block.id, status);
						agent.activeToolNames.set(block.id, toolName);
						if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
							hasNonExemptTool = true;
						}
						send({
							type: 'agentToolStart',
							id: agentId,
							toolId: block.id,
							status,
						});
					}
				}
				if (hasNonExemptTool) {
					startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, send);
				}
			} else if (blocks.some(b => b.type === 'text') && !agent.hadToolsInTurn) {
				// Text-only response — use silence-based timer for turn-end detection
				startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, send);
			}
		} else if (record.type === 'progress') {
			processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers, send);
		} else if (record.type === 'user') {
			const content = record.message?.content;
			if (Array.isArray(content)) {
				const blocks = content as Array<{ type: string; tool_use_id?: string }>;
				const hasToolResult = blocks.some(b => b.type === 'tool_result');
				if (hasToolResult) {
					for (const block of blocks) {
						if (block.type === 'tool_result' && block.tool_use_id) {
							console.log(`[Pixel Agents] Agent ${agentId} tool done: ${block.tool_use_id}`);
							const completedToolId = block.tool_use_id;
							// If the completed tool was a Task, clear its subagent tools
							if (agent.activeToolNames.get(completedToolId) === 'Task') {
								agent.activeSubagentToolIds.delete(completedToolId);
								agent.activeSubagentToolNames.delete(completedToolId);
								send({
									type: 'subagentClear',
									id: agentId,
									parentToolId: completedToolId,
								});
							}
							agent.activeToolIds.delete(completedToolId);
							agent.activeToolStatuses.delete(completedToolId);
							agent.activeToolNames.delete(completedToolId);
							const toolId = completedToolId;
							setTimeout(() => {
								send({
									type: 'agentToolDone',
									id: agentId,
									toolId,
								});
							}, TOOL_DONE_DELAY_MS);
						}
					}
					// All tools completed — allow text-idle timer as fallback
					if (agent.activeToolIds.size === 0) {
						agent.hadToolsInTurn = false;
					}
				} else {
					// New user text prompt — new turn starting
					cancelWaitingTimer(agentId, waitingTimers);
					clearAgentActivity(agent, agentId, permissionTimers, send);
					agent.hadToolsInTurn = false;
				}
			} else if (typeof content === 'string' && content.trim()) {
				// New user text prompt — new turn starting
				cancelWaitingTimer(agentId, waitingTimers);
				clearAgentActivity(agent, agentId, permissionTimers, send);
				agent.hadToolsInTurn = false;
			}
		} else if (record.type === 'system' && record.subtype === 'turn_duration') {
			setWaitingStatus(agentId, agent, waitingTimers, permissionTimers, send);
		}
	} catch {
		// Ignore malformed lines
	}
}

function processProgressRecord(
	agentId: number,
	record: Record<string, unknown>,
	agents: Map<number, WebAgentState>,
	_waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	send: (msg: unknown) => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	const parentToolId = record.parentToolUseID as string | undefined;
	if (!parentToolId) return;

	const data = record.data as Record<string, unknown> | undefined;
	if (!data) return;

	// bash_progress / mcp_progress: tool is actively executing, not stuck on permission
	const dataType = data.type as string | undefined;
	if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
		if (agent.activeToolIds.has(parentToolId)) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, send);
		}
		return;
	}

	// Verify parent is an active Task tool (agent_progress handling)
	if (agent.activeToolNames.get(parentToolId) !== 'Task') return;

	const msg = data.message as Record<string, unknown> | undefined;
	if (!msg) return;

	const msgType = msg.type as string;
	const innerMsg = msg.message as Record<string, unknown> | undefined;
	const content = innerMsg?.content;
	if (!Array.isArray(content)) return;

	if (msgType === 'assistant') {
		let hasNonExemptSubTool = false;
		for (const block of content) {
			if (block.type === 'tool_use' && block.id) {
				const toolName = block.name || '';
				const status = formatToolStatus(toolName, block.input || {});
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`);

				let subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (!subTools) {
					subTools = new Set();
					agent.activeSubagentToolIds.set(parentToolId, subTools);
				}
				subTools.add(block.id);

				let subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (!subNames) {
					subNames = new Map();
					agent.activeSubagentToolNames.set(parentToolId, subNames);
				}
				subNames.set(block.id, toolName);

				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptSubTool = true;
				}

				send({
					type: 'subagentToolStart',
					id: agentId,
					parentToolId,
					toolId: block.id,
					status,
				});
			}
		}
		if (hasNonExemptSubTool) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, send);
		}
	} else if (msgType === 'user') {
		for (const block of content) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`);

				const subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (subTools) {
					subTools.delete(block.tool_use_id);
				}
				const subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (subNames) {
					subNames.delete(block.tool_use_id);
				}

				const toolId = block.tool_use_id;
				setTimeout(() => {
					send({
						type: 'subagentToolDone',
						id: agentId,
						parentToolId,
						toolId,
					});
				}, 300);
			}
		}
		// If there are still active non-exempt sub-agent tools, restart the permission timer
		let stillHasNonExempt = false;
		for (const [, subNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subNames) {
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					stillHasNonExempt = true;
					break;
				}
			}
			if (stillHasNonExempt) break;
		}
		if (stillHasNonExempt) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, send);
		}
	}
}
