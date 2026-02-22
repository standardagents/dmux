import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { execSync, exec } from 'child_process';
import CleanTextInput from '../inputs/CleanTextInput.js';
import chalk from 'chalk';
import { callAgent } from '../../utils/agentHarness.js';
import { SettingsManager } from '../../utils/settingsManager.js';
import { getPermissionFlags } from '../../utils/agentLaunch.js';

interface MergePaneProps {
  pane: {
    id: string;
    slug: string;
    branchName?: string;
    prompt: string;
    paneId: string;
    worktreePath?: string;
  };
  onComplete: () => void;
  onCancel: () => void;
  mainBranch: string;
}

type MergeStatus =
  | 'checking'
  | 'uncommitted-changes'
  | 'committing'
  | 'switching-branch'
  | 'merging'
  | 'merge-conflict'
  | 'conflict-resolution-prompt'
  | 'resolving-with-agent'
  | 'manual-resolution'
  | 'completing'
  | 'success'
  | 'error';

interface CommandOutput {
  command: string;
  output: string;
  error?: string;
  timestamp: Date;
}

export default function MergePane({ pane, onComplete, onCancel, mainBranch }: MergePaneProps) {
  const { exit } = useApp();
  const [status, setStatus] = useState<MergeStatus>('checking');
  const [commandHistory, setCommandHistory] = useState<CommandOutput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);
  const [showResolutionPrompt, setShowResolutionPrompt] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [showAgentPromptInput, setShowAgentPromptInput] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [showCommitInput, setShowCommitInput] = useState(false);

  const addCommandOutput = (command: string, output: string, error?: string) => {
    setCommandHistory(prev => [...prev, {
      command,
      output,
      error,
      timestamp: new Date()
    }]);
  };

  const runCommand = (command: string, cwd?: string): { success: boolean; output: string; error?: string } => {
    try {
      const output = execSync(command, {
        cwd: cwd || pane.worktreePath,
        encoding: 'utf8',
        stdio: 'pipe'
      });
      addCommandOutput(command, output);
      return { success: true, output };
    } catch (err: any) {
      const errorMsg = err.stderr || err.message;
      addCommandOutput(command, '', errorMsg);
      return { success: false, output: '', error: errorMsg };
    }
  };

  const checkForConflicts = (cwd?: string): boolean => {
    const result = runCommand('git status --porcelain', cwd);
    if (result.success) {
      const conflicts = result.output
        .split('\n')
        .filter(line => line.startsWith('UU ') || line.startsWith('AA '))
        .map(line => line.substring(3).trim());

      if (conflicts.length > 0) {
        setConflictFiles(conflicts);
        return true;
      }
    }
    return false;
  };

  const generateCommitMessage = async (): Promise<string> => {
    const fallback = `chore: merge ${pane.slug} into ${mainBranch}`;

    try {
      const diff = runCommand('git diff --staged');
      if (!diff.success) {
        return fallback;
      }

      const prompt = `Generate a concise, semantic commit message for these changes. Follow conventional commits format (feat:, fix:, chore:, etc). Be specific about what changed. Respond with ONLY the commit message, nothing else:\n\n${diff.output.substring(0, 4000)}`;

      const model = diff.output.length > 3000 ? 'mid' as const : 'cheap' as const;
      const message = await callAgent(prompt, { timeout: 60000, model });
      if (message) {
        const cleaned = message.replace(/^["']|["']$/g, '').trim();
        if (cleaned) return cleaned;
      }

      return fallback;
    } catch {
      return fallback;
    }
  };

  const performMerge = async () => {
    setStatus('checking');

    // Step 1: Check for uncommitted changes in the worktree
    const statusResult = runCommand('git status --porcelain');
    if (statusResult.success && statusResult.output.trim()) {
      setStatus('uncommitted-changes');

      // Generate commit message
      setStatus('committing');
      const message = await generateCommitMessage();
      const finalMessage = message || 'chore: automated commit';
      setCommitMessage(finalMessage);

      // Stage and commit changes in the worktree
      runCommand('git add -A');
      const commitResult = runCommand(`git commit -m "${finalMessage}"`);
      if (!commitResult.success) {
        setError('Failed to commit changes');
        setStatus('error');
        return;
      }
    }

    // Step 2: Get the main repository path (parent of .dmux/worktrees)
    const mainRepoPath = pane.worktreePath?.replace(/\/\.dmux\/worktrees\/[^/]+$/, '');
    if (!mainRepoPath) {
      setError('Could not determine main repository path');
      setStatus('error');
      return;
    }

    // Step 3: Switch to main repository and checkout main branch
    setStatus('switching-branch');
    const checkoutResult = runCommand(`git checkout ${mainBranch}`, mainRepoPath);
    if (!checkoutResult.success) {
      // If main is already checked out, that's fine
      if (!checkoutResult.error?.includes('already on')) {
        setError(`Failed to switch to ${mainBranch} branch: ${checkoutResult.error}`);
        setStatus('error');
        return;
      }
    }

    // Step 4: Attempt merge in the main repository
    setStatus('merging');
    const mergeBranch = pane.branchName || pane.slug;
    const mergeResult = runCommand(`git merge "${mergeBranch}" --no-ff`, mainRepoPath);

    if (!mergeResult.success) {
      // Check if it's a merge conflict
      if (mergeResult.error?.includes('Automatic merge failed') || checkForConflicts(mainRepoPath)) {
        setStatus('merge-conflict');
        setShowResolutionPrompt(true);
        return;
      } else {
        setError('Merge failed: ' + mergeResult.error);
        setStatus('error');
        return;
      }
    }

    // Step 5: Success - worktree cleanup will happen if user confirms pane closure
    setStatus('success');
  };

  const handleAgentResolution = () => {
    setShowResolutionPrompt(false);
    setShowAgentPromptInput(true);
  };

  const submitAgentResolution = () => {
    setShowAgentPromptInput(false);
    setStatus('resolving-with-agent');

    // Get the main repository path
    const mainRepoPath = pane.worktreePath?.replace(/\/\.dmux\/worktrees\/[^/]+$/, '');

    // Exit the app and launch agent with conflict resolution prompt
    const fullPrompt = agentPrompt || `Fix the merge conflicts in the following files: ${conflictFiles.join(', ')}. Resolve them appropriately based on the changes from branch ${pane.slug} (${pane.prompt}) and ensure the code remains functional.`;
    const escapedPrompt = fullPrompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$');

    // Clear screen and exit
    process.stdout.write('\x1b[2J\x1b[H');

    // Launch Claude to resolve conflicts in the main repository
    try {
      const settings = new SettingsManager(mainRepoPath || process.cwd()).getSettings();
      const permissionFlags = getPermissionFlags('claude', settings.permissionMode);
      const permissionSuffix = permissionFlags ? ` ${permissionFlags}` : '';

      execSync(`claude "${escapedPrompt}"${permissionSuffix}`, {
        stdio: 'inherit',
        cwd: mainRepoPath || process.cwd()
      });
    } catch {
      // Try opencode as fallback
      try {
        execSync(`opencode --prompt "${escapedPrompt}"`, {
          stdio: 'inherit',
          cwd: mainRepoPath || process.cwd()
        });
      } catch {}
    }

    exit();
  };

  const handleManualResolution = () => {
    setShowResolutionPrompt(false);
    setStatus('manual-resolution');

    // Show instructions and exit
    process.stdout.write('\x1b[2J\x1b[H');

    exit();
  };

  useEffect(() => {
    performMerge();
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (showResolutionPrompt && !showAgentPromptInput) {
      if (input === 'a' || input === 'A') {
        handleAgentResolution();
      } else if (input === 'm' || input === 'M') {
        handleManualResolution();
      } else if (input === 'c' || input === 'C') {
        onCancel();
      }
    }

    if (status === 'success') {
      if (input === 'y' || input === 'Y' || key.return) {
        onComplete();
      } else if (input === 'n' || input === 'N') {
        onCancel();
      }
    }

    if (status === 'error' && key.return) {
      onCancel();
    }
  });

  const getStatusColor = (s: MergeStatus): string => {
    switch(s) {
      case 'error':
      case 'merge-conflict':
        return 'red';
      case 'success':
        return 'green';
      case 'checking':
      case 'committing':
      case 'switching-branch':
      case 'merging':
      case 'completing':
        return 'yellow';
      default:
        return 'white';
    }
  };

  const getStatusText = (s: MergeStatus): string => {
    switch(s) {
      case 'checking': return 'Checking repository status...';
      case 'uncommitted-changes': return 'Found uncommitted changes, committing...';
      case 'committing': return `Committing changes: ${commitMessage}`;
      case 'switching-branch': return `Switching to ${mainBranch} branch...`;
      case 'merging': return `Merging ${pane.slug} into ${mainBranch}...`;
      case 'merge-conflict': return 'Merge conflict detected!';
      case 'conflict-resolution-prompt': return 'Choose conflict resolution method';
      case 'resolving-with-agent': return 'Launching agent to resolve conflicts...';
      case 'manual-resolution': return 'Manual resolution selected';
      case 'completing': return 'Cleaning up worktree and branch...';
      case 'success': return 'Merge completed successfully!';
      case 'error': return `Error: ${error}`;
      default: return '';
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Merging: {pane.slug} → {mainBranch}
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="gray" flexDirection="column" padding={1} marginBottom={1}>
        <Text color={getStatusColor(status)} bold>
          Status: {getStatusText(status)}
        </Text>
      </Box>

      {commandHistory.length > 0 && (
        <Box borderStyle="single" borderColor="gray" flexDirection="column" padding={1} marginBottom={1} height={10}>
          <Text dimColor>Command Output:</Text>
          {commandHistory.slice(-5).map((cmd, i) => (
            <Box key={i} flexDirection="column">
              <Text color="blue">$ {cmd.command}</Text>
              {cmd.output && <Text dimColor>{cmd.output.substring(0, 200)}</Text>}
              {cmd.error && <Text color="red">{cmd.error.substring(0, 200)}</Text>}
            </Box>
          ))}
        </Box>
      )}

      {showResolutionPrompt && !showAgentPromptInput && (
        <Box borderStyle="double" borderColor="yellow" flexDirection="column" padding={1}>
          <Text color="yellow" bold>Merge Conflict Resolution Required</Text>
          <Text>Conflicted files:</Text>
          {conflictFiles.map(file => (
            <Text key={file} color="red">  • {file}</Text>
          ))}
          <Text> </Text>
          <Text>Choose resolution method:</Text>
          <Text color="cyan">  (A) Resolve with AI agent</Text>
          <Text color="green">  (M) Resolve manually</Text>
          <Text color="gray">  (C) Cancel merge</Text>
        </Box>
      )}

      {showAgentPromptInput && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" padding={1}>
          <Text>Enter prompt for agent (or press Enter for default):</Text>
          <CleanTextInput
            value={agentPrompt}
            onChange={setAgentPrompt}
            onSubmit={submitAgentResolution}
            placeholder={`Fix merge conflicts from ${pane.slug} branch`}
          />
        </Box>
      )}

      {status === 'success' && (
        <Box borderStyle="double" borderColor="green" flexDirection="column" padding={1}>
          <Text color="green" bold>✓ Merge completed successfully!</Text>
          <Text>Branch {pane.slug} has been merged into {mainBranch}</Text>
          <Text> </Text>
          <Text>Close the pane "{pane.slug}"? (Y/n)</Text>
        </Box>
      )}

      {status === 'error' && (
        <Box borderStyle="double" borderColor="red" flexDirection="column" padding={1}>
          <Text color="red" bold>✗ Merge failed</Text>
          <Text>{error}</Text>
          <Text> </Text>
          <Text dimColor>Press Enter to return to main menu</Text>
        </Box>
      )}
    </Box>
  );
}
