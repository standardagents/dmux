import type { DmuxPane } from '../types.js';
import type { AgentName, PermissionMode } from './agentLaunch.js';

export const DMUX_BOOTSTRAP_PANE_TITLE_PREFIX = 'dmux-bootstrap:';

export interface PaneBootstrapConfig {
  version: 1;
  projectRoot: string;
  worktreePath: string;
  branchName: string;
  slug: string;
  prompt: string;
  agent?: AgentName;
  permissionMode?: PermissionMode;
  goalMode?: boolean;
  pane: DmuxPane;
  tmuxTitle: string;
  existingWorktree: boolean;
  resolvedStartPoint?: string;
  isHooksEditingSession: boolean;
  metadata: {
    agent?: AgentName;
    permissionMode?: PermissionMode;
    goalMode?: boolean;
    displayName?: string;
    branchName?: string;
    mergeTargetChain?: DmuxPane['mergeTargetChain'];
    linkedRepoPaths?: string[];
  };
  hookExtraEnv?: Record<string, string>;
}
