import path from 'path';
import * as os from 'os';
import type { DmuxPane, NewPaneInput, MergeTargetReference } from '../types.js';
import { createPane } from '../utils/paneCreation.js';
import { LogService } from '../services/LogService.js';
import { getAgentSlugSuffix, type AgentName } from '../utils/agentLaunch.js';
import { generateSlug } from '../utils/slug.js';

interface Params {
  panes: DmuxPane[];
  savePanes: (p: DmuxPane[]) => Promise<void>;
  projectName: string;
  sessionProjectRoot: string;
  panesFile: string;
  setIsCreatingPane: (v: boolean) => void;
  setStatusMessage: (msg: string) => void;
  loadPanes: () => Promise<void>;
  availableAgents: AgentName[];
}

interface CreateNewPaneOptions {
  existingPanes?: DmuxPane[];
  slugSuffix?: string;
  slugBase?: string;
  baseBranchOverride?: string;
  branchNameOverride?: string;
  targetProjectRoot?: string;
  skipAgentSelection?: boolean;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
}

const MAX_PARALLEL_PANE_CREATIONS = 4;

function getParallelPaneCreationLimit(totalAgents: number): number {
  if (totalAgents <= 1) {
    return 1;
  }

  const overrideRaw = process.env.DMUX_PANE_CREATE_CONCURRENCY;
  if (overrideRaw) {
    const override = Number.parseInt(overrideRaw, 10);
    if (Number.isFinite(override) && override > 0) {
      return Math.min(totalAgents, override);
    }
  }

  const maybeAvailableParallelism = (os as any).availableParallelism;
  const cpuCount = typeof maybeAvailableParallelism === 'function'
    ? maybeAvailableParallelism.call(os)
    : os.cpus().length;
  const conservativeLimit = Math.max(1, Math.floor(cpuCount / 2));

  return Math.max(
    1,
    Math.min(totalAgents, MAX_PARALLEL_PANE_CREATIONS, conservativeLimit)
  );
}

export default function usePaneCreation({
  panes,
  savePanes,
  projectName,
  sessionProjectRoot,
  panesFile,
  setIsCreatingPane,
  setStatusMessage,
  loadPanes,
  availableAgents,
}: Params) {
  const openInEditor = async (currentPrompt: string, setPrompt: (v: string) => void) => {
    try {
      const fs = await import('fs');
      const tmpFile = path.join(os.tmpdir(), `dmux-prompt-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, currentPrompt || '# Enter your Claude prompt here\n\n');
      const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
      process.stdout.write('\x1b[2J\x1b[H');
      const { spawn } = await import('child_process');
      const editorProcess = spawn(editor, [tmpFile], { stdio: 'inherit', shell: true });
      editorProcess.on('close', () => {
        try {
          const content = fs.readFileSync(tmpFile, 'utf8').replace(/^# Enter your Claude prompt here\s*\n*/m, '').trim();
          setPrompt(content);
          fs.unlinkSync(tmpFile);
          process.stdout.write('\x1b[2J\x1b[H');
        } catch {}
      });
    } catch {}
  };

  const createPaneInternal = async (
    prompt: string,
    agent?: AgentName,
    options: CreateNewPaneOptions = {}
  ): Promise<DmuxPane> => {
    const panesForCreation = options.existingPanes ?? panes;
    const result = await createPane(
      {
        prompt,
        agent,
        projectName,
        existingPanes: panesForCreation,
        slugSuffix: options.slugSuffix,
        slugBase: options.slugBase,
        baseBranchOverride: options.baseBranchOverride,
        branchNameOverride: options.branchNameOverride,
        projectRoot: options.targetProjectRoot,
        skipAgentSelection: options.skipAgentSelection,
        startPointBranch: options.startPointBranch,
        mergeTargetChain: options.mergeTargetChain,
        sessionProjectRoot,
        sessionConfigPath: panesFile,
      },
      availableAgents
    );

    if (result.needsAgentChoice) {
      throw new Error('Agent choice is required');
    }

    return result.pane;
  };

  const createNewPane = async (
    paneInput: NewPaneInput,
    agent?: AgentName,
    options: CreateNewPaneOptions = {}
  ): Promise<DmuxPane | null> => {
    const prompt = paneInput.prompt;
    const panesForCreation = options.existingPanes ?? panes;
    const resolvedOptions: CreateNewPaneOptions = {
      ...options,
      baseBranchOverride: options.baseBranchOverride ?? paneInput.baseBranch,
      branchNameOverride: options.branchNameOverride ?? paneInput.branchName,
    };

    try {
      setIsCreatingPane(true)
      setStatusMessage("Creating pane...")

      const pane = await createPaneInternal(prompt, agent, resolvedOptions);

      // Save the pane
      const updatedPanes = [...panesForCreation, pane];
      await savePanes(updatedPanes);

      await loadPanes();
      setStatusMessage("Pane created")
      setTimeout(() => setStatusMessage(""), 2000)
      return pane;
    } catch (error) {
      const msg = 'Failed to create pane';
      LogService.getInstance().error(msg, 'usePaneCreation', undefined, error instanceof Error ? error : undefined);
      setStatusMessage(`Failed to create pane: ${error}`);
      setTimeout(() => setStatusMessage(''), 3000);
      return null;
    } finally {
      setIsCreatingPane(false)
    }
  };

  const createPanesForAgents = async (
    paneInput: NewPaneInput,
    selectedAgents: AgentName[],
    options: Pick<
      CreateNewPaneOptions,
      'existingPanes' | 'targetProjectRoot' | 'startPointBranch' | 'mergeTargetChain'
    > = {}
  ): Promise<DmuxPane[]> => {
    const prompt = paneInput.prompt;
    const panesForCreation = options.existingPanes ?? panes;
    const dedupedAgents = selectedAgents.filter(
      (agent, index) => selectedAgents.indexOf(agent) === index
    );

    if (dedupedAgents.length === 0) {
      return [];
    }

    const isMultiLaunch = dedupedAgents.length > 1;
    const slugBase = isMultiLaunch ? await generateSlug(prompt) : undefined;
    const parallelLimit = getParallelPaneCreationLimit(dedupedAgents.length);

    try {
      setIsCreatingPane(true);
      if (parallelLimit > 1) {
        setStatusMessage(
          `Creating ${dedupedAgents.length} panes (${parallelLimit} parallel)...`
        );
      } else {
        setStatusMessage(`Creating ${dedupedAgents.length} pane${dedupedAgents.length === 1 ? '' : 's'}...`);
      }

      const createdByIndex: Array<DmuxPane | null> = new Array(dedupedAgents.length).fill(null);

      const firstAgent = dedupedAgents[0];
      const firstPane = await createPaneInternal(prompt, firstAgent, {
        existingPanes: panesForCreation,
        slugSuffix: isMultiLaunch ? getAgentSlugSuffix(firstAgent) : undefined,
        slugBase,
        baseBranchOverride: paneInput.baseBranch,
        branchNameOverride: paneInput.branchName,
        targetProjectRoot: options.targetProjectRoot,
        startPointBranch: options.startPointBranch,
        mergeTargetChain: options.mergeTargetChain,
      });
      createdByIndex[0] = firstPane;

      const remainingAgents = dedupedAgents.slice(1);
      const workerCount = Math.min(parallelLimit, remainingAgents.length);
      let nextTaskIndex = 0;
      const failures: Array<{ agent: AgentName; error: unknown }> = [];

      const workers = Array.from({ length: workerCount }, async () => {
        while (nextTaskIndex < remainingAgents.length) {
          const currentTaskIndex = nextTaskIndex;
          nextTaskIndex += 1;
          const selectedAgent = remainingAgents[currentTaskIndex];
          const agentResultIndex = currentTaskIndex + 1;

          try {
            const createdSoFar = createdByIndex.filter(
              (pane): pane is DmuxPane => pane !== null
            );
            const pane = await createPaneInternal(prompt, selectedAgent, {
              existingPanes: [...panesForCreation, ...createdSoFar],
              slugSuffix: getAgentSlugSuffix(selectedAgent),
              slugBase,
              baseBranchOverride: paneInput.baseBranch,
              branchNameOverride: paneInput.branchName,
              targetProjectRoot: options.targetProjectRoot,
              startPointBranch: options.startPointBranch,
              mergeTargetChain: options.mergeTargetChain,
            });
            createdByIndex[agentResultIndex] = pane;
          } catch (error) {
            failures.push({ agent: selectedAgent, error });
            LogService.getInstance().error(
              `Failed to create pane for agent ${selectedAgent}`,
              'usePaneCreation',
              undefined,
              error instanceof Error ? error : undefined
            );
          }
        }
      });

      await Promise.all(workers);

      const createdPanes = createdByIndex.filter(
        (pane): pane is DmuxPane => pane !== null
      );

      if (createdPanes.length > 0) {
        const updatedPanes = [...panesForCreation, ...createdPanes];
        await savePanes(updatedPanes);
        await loadPanes();
      }

      if (failures.length > 0) {
        setStatusMessage(
          `Created ${createdPanes.length}/${dedupedAgents.length} panes (${failures.length} failed)`
        );
      } else {
        setStatusMessage(
          `Created ${createdPanes.length} pane${createdPanes.length === 1 ? '' : 's'}`
        );
      }
      setTimeout(() => setStatusMessage(""), 3000);

      return createdPanes;
    } catch (error) {
      LogService.getInstance().error(
        'Failed to create panes',
        'usePaneCreation',
        undefined,
        error instanceof Error ? error : undefined
      );
      setStatusMessage(`Failed to create panes: ${error}`);
      setTimeout(() => setStatusMessage(''), 3000);
      return [];
    } finally {
      setIsCreatingPane(false);
    }
  };

  return { openInEditor, createNewPane, createPanesForAgents } as const;
}
