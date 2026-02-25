export type AgentProvider = 'claude' | 'codex';
export type PromptRoute = 'active' | 'broadcast' | 'round_robin';

export interface AgentProcess {
	write(data: string): void;
	kill(): void;
	onExit(handler: (event: { exitCode: number }) => void): void;
}

export interface WebAgentState {
	id: number;
	provider: AgentProvider;
	workingDir: string;
	process: AgentProcess;
	processMode: 'pty' | 'stdio';
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
}
