import type * as vscode from 'vscode';

export type AgentProvider = 'claude' | 'codex';
export type PromptRoute = 'active' | 'broadcast' | 'round_robin';

export interface AgentState {
	id: number;
	provider: AgentProvider;
	workingDir: string | null;
	terminalRef: vscode.Terminal;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	pendingPrompt?: string;
}

export interface PersistedAgent {
	id: number;
	provider?: AgentProvider;
	workingDir?: string | null;
	terminalName: string;
	jsonlFile: string;
	projectDir: string;
}
