#!/usr/bin/env node

import { execSync, spawnSync } from 'child_process';
import chalk from 'chalk';
import fs from 'fs/promises';
import * as fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { render } from 'ink';
import React from 'react';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { createInterface } from 'node:readline/promises';
import DmuxApp from './DmuxApp.js';
import { AutoUpdater } from './services/AutoUpdater.js';
import { StateManager } from './shared/StateManager.js';
import { LogService } from './services/LogService.js';
import { TmuxService } from './services/TmuxService.js';
import { createWelcomePane, destroyWelcomePane } from './utils/welcomePane.js';
import { TMUX_COLORS } from './theme/colors.js';
import { SIDEBAR_WIDTH } from './utils/layoutManager.js';
import { validateSystemRequirements, printValidationResults } from './utils/systemCheck.js';
import { getUntrackedPanes } from './utils/shellPaneDetection.js';

import { getAvailableAgents } from './utils/agentDetection.js';
import { createPane } from './utils/paneCreation.js';
import { SettingsManager } from './utils/settingsManager.js';
import { atomicWriteJson } from './utils/atomicWrite.js';
import type { DmuxConfig, DmuxPane } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

interface ExistingSessionContext {
  sessionName: string;
  sessionProjectRoot: string;
  sessionProjectName: string;
  sessionConfigPath: string;
}

class Dmux {
  private panesFile: string;
  private settingsFile: string;
  private projectName: string;
  private sessionName: string;
  private projectRoot: string;
  private autoUpdater: AutoUpdater;
  private stateManager: StateManager;

  constructor() {
    // Get git root directory to determine project scope
    // NOTE: No caching - must be re-evaluated per instance to support multiple projects
    this.projectRoot = this.getProjectRoot();
    // Get project name from git root directory
    this.projectName = path.basename(this.projectRoot);

    // Create a stable, collision-safe session name for this project root
    this.sessionName = this.buildSessionNameForRoot(this.projectRoot);

    // Store config in .dmux directory inside project root
    const dmuxDir = path.join(this.projectRoot, '.dmux');
    const configFile = path.join(dmuxDir, 'dmux.config.json');

    // Always use the .dmux directory config location
    this.panesFile = configFile;
    this.settingsFile = configFile; // Same file for all config

    // Initialize auto-updater with config file
    this.autoUpdater = new AutoUpdater(configFile);

    // Initialize state manager
    this.stateManager = StateManager.getInstance();
  }

  async init() {
    // Set up global signal handlers for clean exit
    this.setupGlobalSignalHandlers();

    // Ensure .dmux directory exists and is in .gitignore
    await this.ensureDmuxDirectory();

    // Check for migration from old config location
    await this.migrateOldConfig();

    // Inject OpenRouter API key from settings into process.env (for slug generation)
    {
      const startupSettings = new SettingsManager(this.projectRoot);
      const savedApiKey = startupSettings.getSetting('openrouterApiKey');
      if (savedApiKey && !process.env.OPENROUTER_API_KEY) {
        process.env.OPENROUTER_API_KEY = savedApiKey;
      }
    }

    // Initialize config file if it doesn't exist
    if (!await this.fileExists(this.panesFile)) {
      const initialConfig = {
        projectName: this.projectName,
        projectRoot: this.projectRoot,
        panes: [],
        settings: {},
        lastUpdated: new Date().toISOString(),
        controlPaneId: undefined,
        controlPaneSize: 40  // Sidebar width
      };
      await fs.writeFile(this.panesFile, JSON.stringify(initialConfig, null, 2));
    }

    const inTmux = process.env.TMUX !== undefined;
    const isDev = process.env.DMUX_DEV === 'true';
    const currentTmuxSessionName = inTmux
      ? this.getCurrentTmuxSessionName()
      : null;
    const sessionNameForCurrentTmux = currentTmuxSessionName || this.sessionName;

    // Running dmux from another project while already inside a dmux session:
    // offer to attach this project to the current sidebar/session instead.
    if (
      inTmux &&
      currentTmuxSessionName &&
      currentTmuxSessionName.startsWith('dmux-') &&
      currentTmuxSessionName !== this.sessionName
    ) {
      const shouldAttachToCurrent = await this.promptYesNo(
        `Detected active dmux session '${currentTmuxSessionName}'. Add project '${this.projectName}' to this session?`,
        true
      );

      if (shouldAttachToCurrent) {
        const attached = await this.attachProjectToExistingSession(currentTmuxSessionName);
        if (attached) {
          return;
        }
      }
    }

    // Check for updates in background if needed
    this.checkForUpdatesBackground();

    // Set up hooks for this session (if in tmux)
    if (inTmux) {
      this.setupResizeHook(sessionNameForCurrentTmux);
      this.setupPaneSplitHook(sessionNameForCurrentTmux);
    }

    if (!inTmux) {
      // Check if project-specific session already exists
      try {
        execSync(`tmux has-session -t ${this.sessionName} 2>/dev/null`, { stdio: 'pipe' });
        // Session exists, will attach
      } catch {
        // Expected - session doesn't exist, create new one
        // Create new session first
        execSync(`tmux new-session -d -s ${this.sessionName}`, { stdio: 'inherit' });
        // Batch all session configuration commands into a single tmux call for faster startup
        // This reduces 5 process spawns to 1, significantly improving startup time
        const sessionOptions = [
          `set-option -t ${this.sessionName} pane-border-status top`,
          `set-option -t ${this.sessionName} pane-active-border-style "fg=colour${TMUX_COLORS.activeBorder}"`,
          `set-option -t ${this.sessionName} pane-border-style "fg=colour${TMUX_COLORS.inactiveBorder}"`,
          `set-option -t ${this.sessionName} pane-border-format " #{pane_title} "`,
          `select-pane -t ${this.sessionName} -T "dmux v${packageJson.version} - ${this.projectName}"`,
        ].join(' \\; ');
        execSync(`tmux ${sessionOptions}`, { stdio: 'inherit' });
        // Send dmux command to the new session (use dev command if in dev mode)
        // In dev mode, use current directory if we're in a worktree, otherwise use projectRoot
        let devDirectory = this.projectRoot;
        if (isDev && this.isWorktree()) {
          devDirectory = process.cwd();
        }

        // Determine the dmux command to use
        let dmuxCommand: string;
        if (isDev) {
          dmuxCommand = `cd "${devDirectory}" && pnpm dev:watch`;
        } else {
          // Check if we're running from a local installation
          // __dirname is 'dist' when compiled, so '../dmux' points to the wrapper
          const localDmuxPath = path.join(__dirname, '..', 'dmux');
          if (fsSync.existsSync(localDmuxPath)) {
            // Use absolute path to local dmux (works for both local builds and global installs)
            dmuxCommand = `"${localDmuxPath}"`;
          } else {
            // Fallback to global dmux command
            dmuxCommand = 'dmux';
          }
        }

        execSync(`tmux send-keys -t ${this.sessionName} "${dmuxCommand}" Enter`, { stdio: 'inherit' });
      }
      execSync(`tmux attach-session -t ${this.sessionName}`, { stdio: 'inherit' });
      return;
    }

    // Enable pane borders to show titles
    // NOTE: Temporarily disabled to test if border updates cause UI shifts
    // try {
    //   execSync(`tmux set-option pane-border-status top`, { stdio: 'pipe' });
    // } catch {
    //   // Ignore if it fails
    // }

    // Set pane title for the current pane running dmux
    // TODO(future): Re-enable control pane title once UI shift issue is resolved
    // Setting the title can cause visual artifacts in some tmux configurations
    // Original code: execSync(`tmux select-pane -T "dmux v${version} - ${project}"`)
    // See: Title updates are currently handled by enforcePaneTitles() in usePaneSync.ts

    // Get current pane ID (control pane for left sidebar)
    let controlPaneId: string | undefined;

    try {
      // Get current pane ID
      const tmuxService = TmuxService.getInstance();
      controlPaneId = await tmuxService.getCurrentPaneId();

      // Load existing config
      const configContent = await fs.readFile(this.panesFile, 'utf-8');
      const config = JSON.parse(configContent);

      // Ensure panes array exists
      if (!config.panes) {
        config.panes = [];
      }

      // ALWAYS update controlPaneId with current pane (it changes on restart)
      // This ensures layout manager always has the correct control pane ID
      const oldControlPaneId = config.controlPaneId;
      const needsUpdate = oldControlPaneId !== controlPaneId;

      if (needsUpdate) {
        if (oldControlPaneId) {
          LogService.getInstance().info(
            `Control pane ID changed: ${oldControlPaneId} → ${controlPaneId}`,
            'Setup'
          );
        } else {
          LogService.getInstance().info(
            `Setting initial control pane ID: ${controlPaneId}`,
            'Setup'
          );
        }
      }

      config.controlPaneId = controlPaneId;
      config.controlPaneSize = SIDEBAR_WIDTH;

      // If this is initial load or control pane changed, resize the sidebar
      if (needsUpdate) {
        // Resize control pane to sidebar width
        await tmuxService.resizePane(controlPaneId, { width: SIDEBAR_WIDTH });
        // Refresh client
        await tmuxService.refreshClient();
        // Save updated config
        config.lastUpdated = new Date().toISOString();
        await fs.writeFile(this.panesFile, JSON.stringify(config, null, 2));
      }

      // Create welcome pane if there are no dmux panes and no existing welcome pane
      // Check if welcome pane actually exists, not just if it's in config (handles tmux restarts)
      const { welcomePaneExists } = await import('./utils/welcomePane.js');

      // Validate welcome pane existence
      let hasValidWelcomePane = false;
      if (config.welcomePaneId) {
        hasValidWelcomePane = await welcomePaneExists(config.welcomePaneId);

        if (!hasValidWelcomePane) {
          LogService.getInstance().info(
            `Welcome pane ${config.welcomePaneId} no longer exists, will create new one`,
            'Setup'
          );
          // Clear stale welcome pane ID from config
          const staleWelcomePaneId = config.welcomePaneId;
          config.welcomePaneId = undefined;
          config.lastUpdated = new Date().toISOString();
          await fs.writeFile(this.panesFile, JSON.stringify(config, null, 2));
          LogService.getInstance().debug(
            `Cleared stale welcome pane ID ${staleWelcomePaneId} from config`,
            'Setup'
          );
        } else {
          LogService.getInstance().debug(
            `Welcome pane ${config.welcomePaneId} exists`,
            'Setup'
          );
        }
      }

      // Check for untracked panes (terminal panes created outside dmux tracking)
      const trackedPaneIds = config.panes?.map((p: any) => p.paneId) ?? [];
      const untrackedPanes = await getUntrackedPanes(
        sessionNameForCurrentTmux,
        trackedPaneIds,
        controlPaneId,
        config.welcomePaneId
      );

      // Only show welcome pane if there are no tracked AND no untracked panes
      const hasAnyPanes = (config.panes?.length ?? 0) > 0 || untrackedPanes.length > 0;

      if (controlPaneId && !hasAnyPanes) {
        if (!hasValidWelcomePane) {
          // Create new welcome pane
          const welcomePaneId = await createWelcomePane(controlPaneId);
          if (welcomePaneId) {
            config.welcomePaneId = welcomePaneId;
            config.lastUpdated = new Date().toISOString();
            await fs.writeFile(this.panesFile, JSON.stringify(config, null, 2));
            LogService.getInstance().info(`Created welcome pane: ${welcomePaneId}`, 'Setup');
          }
        } else {
          // Welcome pane exists from previous session - fix the layout
          LogService.getInstance().debug('Welcome pane exists, applying correct layout', 'Setup');

          // Apply correct layout: sidebar (40) | welcome pane (rest)
          // Use "latest" mode so window auto-follows terminal size
          // Batch layout commands into single tmux call for better performance
          execSync(`tmux set-window-option window-size latest \\; set-window-option main-pane-width ${SIDEBAR_WIDTH} \\; select-layout main-vertical`, { stdio: 'pipe' });
          await tmuxService.refreshClient();
        }
      } else if (hasValidWelcomePane && hasAnyPanes) {
        // If welcome pane exists but there are other panes, destroy it
        LogService.getInstance().info('Destroying welcome pane because other panes exist', 'Setup');
        await destroyWelcomePane(config.welcomePaneId);
        config.welcomePaneId = undefined;
        config.lastUpdated = new Date().toISOString();
        await fs.writeFile(this.panesFile, JSON.stringify(config, null, 2));
      }
    } catch (error) {
      // Ignore errors in sidebar setup - will work without it
      LogService.getInstance().error('Failed to set up sidebar layout', 'Setup', undefined, error instanceof Error ? error : undefined);
    }

    const metadataSessionName = currentTmuxSessionName || this.getCurrentTmuxSessionName() || this.sessionName;
    const shouldPublishMetadata =
      !metadataSessionName.startsWith('dmux-') || metadataSessionName === this.sessionName;
    if (shouldPublishMetadata) {
      this.publishSessionMetadata(metadataSessionName);
    }

    // Update state manager with project info
    this.stateManager.updateProjectInfo(this.projectName, this.sessionName, this.projectRoot, this.panesFile);

    // Logging system is ready (removed debug logs to reduce clutter)

    // Suppress console output from LogService to prevent interference with Ink UI
    LogService.getInstance().setSuppressConsole(true);

    // Clear screen before launching Ink - minimal clearing to avoid artifacts
    // Don't use \x1b[3J as it can cause layout shifts
    process.stdout.write('\x1b[2J\x1b[H');  // Clear screen and move cursor to home

    // Ensure cursor is truly at home position and scrollback is clear
    process.stdout.write('\x1b[1;1H');  // Force cursor to row 1, column 1

    // Launch the Ink app
    const appProps = {
      panesFile: this.panesFile,
      settingsFile: this.settingsFile,
      projectName: this.projectName,
      sessionName: this.sessionName,
      projectRoot: this.projectRoot,
      autoUpdater: this.autoUpdater,
      controlPaneId,
    };

    const app = render(React.createElement(DmuxApp, appProps), {
      exitOnCtrlC: false  // Disable automatic exit on Ctrl+C
    });

    // Clean shutdown on app exit
    app.waitUntilExit().then(async () => {
      process.exit(0);
    });
  }

  private buildSessionNameForRoot(projectRoot: string): string {
    const projectName = path.basename(projectRoot);
    const projectHash = createHash('md5').update(projectRoot).digest('hex').substring(0, 8);
    const projectIdentifier = `${projectName}-${projectHash}`;
    const sanitizedProjectIdentifier = projectIdentifier.replace(/\./g, '-');
    return `dmux-${sanitizedProjectIdentifier}`;
  }

  private getCurrentTmuxSessionName(): string | null {
    try {
      const result = spawnSync('tmux', ['display-message', '-p', '#S'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) return null;
      const sessionName = (result.stdout || '').trim();
      return sessionName || null;
    } catch {
      return null;
    }
  }

  private getTmuxOptionValue(sessionName: string, optionName: string): string | null {
    try {
      const result = spawnSync('tmux', ['show-options', '-v', '-t', sessionName, optionName], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) return null;
      const value = (result.stdout || '').trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private publishSessionMetadata(sessionName: string): void {
    try {
      spawnSync('tmux', ['set-option', '-t', sessionName, '@dmux_project_root', this.projectRoot], { stdio: 'pipe' });
      spawnSync('tmux', ['set-option', '-t', sessionName, '@dmux_project_name', this.projectName], { stdio: 'pipe' });
      spawnSync('tmux', ['set-option', '-t', sessionName, '@dmux_config_path', this.panesFile], { stdio: 'pipe' });
    } catch {
      // Metadata is best-effort only
    }
  }

  private async promptYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return false;
    }

    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (!answer) return defaultYes;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      return defaultYes;
    } finally {
      rl.close();
    }
  }

  private getAncestorPaths(startPath: string): string[] {
    const ancestors: string[] = [];
    let cursor = path.resolve(startPath);

    while (true) {
      ancestors.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }

    return ancestors;
  }

  private inferSessionContextFromPanePaths(sessionName: string): ExistingSessionContext | null {
    try {
      const listResult = spawnSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_current_path}'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (listResult.status !== 0) {
        return null;
      }

      const panePaths = (listResult.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const seenRoots = new Set<string>();
      for (const panePath of panePaths) {
        for (const candidateRoot of this.getAncestorPaths(panePath)) {
          if (seenRoots.has(candidateRoot)) continue;
          seenRoots.add(candidateRoot);

          const configPath = path.join(candidateRoot, '.dmux', 'dmux.config.json');
          if (!fsSync.existsSync(configPath)) {
            continue;
          }

          if (this.buildSessionNameForRoot(candidateRoot) !== sessionName) {
            continue;
          }

          return {
            sessionName,
            sessionProjectRoot: candidateRoot,
            sessionProjectName: path.basename(candidateRoot),
            sessionConfigPath: configPath,
          };
        }
      }
    } catch {
      // Fall through to null
    }

    return null;
  }

  private getExistingSessionContext(sessionName: string): ExistingSessionContext | null {
    const optionProjectRoot = this.getTmuxOptionValue(sessionName, '@dmux_project_root');
    const optionProjectName = this.getTmuxOptionValue(sessionName, '@dmux_project_name');
    const optionConfigPath = this.getTmuxOptionValue(sessionName, '@dmux_config_path');

    const sessionProjectRoot =
      optionProjectRoot
      || (optionConfigPath ? path.dirname(path.dirname(optionConfigPath)) : undefined);
    const sessionConfigPath =
      optionConfigPath
      || (sessionProjectRoot ? path.join(sessionProjectRoot, '.dmux', 'dmux.config.json') : undefined);

    if (
      sessionProjectRoot &&
      sessionConfigPath &&
      fsSync.existsSync(sessionConfigPath)
    ) {
      return {
        sessionName,
        sessionProjectRoot,
        sessionProjectName: optionProjectName || path.basename(sessionProjectRoot),
        sessionConfigPath,
      };
    }

    return this.inferSessionContextFromPanePaths(sessionName);
  }

  private getPreferredAttachAgent(
    availableAgents: Array<'claude' | 'opencode' | 'codex'>
  ): 'claude' | 'opencode' | 'codex' | undefined {
    if (availableAgents.length === 0) {
      return undefined;
    }

    const settings = new SettingsManager(this.projectRoot).getSettings();
    if (settings.defaultAgent && availableAgents.includes(settings.defaultAgent)) {
      return settings.defaultAgent;
    }

    return availableAgents[0];
  }

  private async attachProjectToExistingSession(sessionName: string): Promise<boolean> {
    const context = this.getExistingSessionContext(sessionName);
    if (!context) {
      console.log(chalk.yellow(
        `Unable to locate config for session '${sessionName}'. Run dmux inside that project once, then try again.`
      ));
      return false;
    }

    if (path.resolve(context.sessionProjectRoot) === path.resolve(this.projectRoot)) {
      return false;
    }

    try {
      const configRaw = await fs.readFile(context.sessionConfigPath, 'utf-8');
      const config: DmuxConfig = JSON.parse(configRaw);
      const existingPanes = Array.isArray(config.panes) ? config.panes : [];
      const availableAgents = await getAvailableAgents();
      let selectedAgent = this.getPreferredAttachAgent(availableAgents);

      const prompt = `Explore ${this.projectName} and ask what to work on first.`;
      let creation = await createPane(
        {
          prompt,
          agent: selectedAgent,
          projectName: context.sessionProjectName,
          existingPanes,
          projectRoot: this.projectRoot,
          sessionConfigPath: context.sessionConfigPath,
          sessionProjectRoot: context.sessionProjectRoot,
        },
        availableAgents
      );

      if (creation.needsAgentChoice) {
        selectedAgent = availableAgents[0];
        if (!selectedAgent) {
          throw new Error('No supported agent CLI found (claude, opencode, codex)');
        }

        creation = await createPane(
          {
            prompt,
            agent: selectedAgent,
            projectName: context.sessionProjectName,
            existingPanes,
            projectRoot: this.projectRoot,
            sessionConfigPath: context.sessionConfigPath,
            sessionProjectRoot: context.sessionProjectRoot,
          },
          availableAgents
        );
      }

      const latestConfigRaw = await fs.readFile(context.sessionConfigPath, 'utf-8');
      const latestConfig: DmuxConfig = JSON.parse(latestConfigRaw);
      const latestPanes = Array.isArray(latestConfig.panes) ? latestConfig.panes : [];

      const alreadyPersisted = latestPanes.some((pane: DmuxPane) =>
        pane.id === creation.pane.id || pane.paneId === creation.pane.paneId
      );

      if (!alreadyPersisted) {
        latestConfig.panes = [...latestPanes, creation.pane];
        latestConfig.lastUpdated = new Date().toISOString();
        await atomicWriteJson(context.sessionConfigPath, latestConfig);
      }

      console.log(chalk.green(
        `Added project '${this.projectName}' to session '${sessionName}'.`
      ));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Failed to add project '${this.projectName}': ${message}`));
      return false;
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      // Expected - file doesn't exist
      return false;
    }
  }

  private isWorktree(): boolean {
    try {
      // Check if current directory is different from project root
      const cwd = process.cwd();
      if (cwd === this.projectRoot) {
        return false;
      }

      // Check if we're in a git worktree by checking if .git is a file (not a directory)
      const gitPath = path.join(cwd, '.git');
      if (fsSync.existsSync(gitPath)) {
        const stats = fsSync.statSync(gitPath);
        // In a worktree, .git is a file, not a directory
        return stats.isFile();
      }

      return false;
    } catch {
      // Expected - errors during git/file checks
      return false;
    }
  }

  private getProjectRoot(): string {
    try {
      // First, try to get the main worktree if we're in a git repository
      // This ensures we always use the main repository root, even when run from a worktree
      const worktreeList = execSync('git worktree list --porcelain', {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();

      // The first line contains the main worktree path
      const mainWorktreeLine = worktreeList.split('\n')[0];
      if (mainWorktreeLine && mainWorktreeLine.startsWith('worktree ')) {
        const mainWorktreePath = mainWorktreeLine.substring(9).trim();
        return mainWorktreePath;
      }

      // Fallback to git rev-parse if worktree list fails
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
      return gitRoot;
    } catch {
      // Fallback to current directory if not in a git repo
      return process.cwd();
    }
  }

  private async ensureDmuxDirectory() {
    const dmuxDir = path.join(this.projectRoot, '.dmux');
    const worktreesDir = path.join(dmuxDir, 'worktrees');
    const promptsDir = path.join(dmuxDir, 'prompts');

    // Create .dmux directory if it doesn't exist
    if (!await this.fileExists(dmuxDir)) {
      await fs.mkdir(dmuxDir, { recursive: true });
    }

    // Create worktrees directory if it doesn't exist
    if (!await this.fileExists(worktreesDir)) {
      await fs.mkdir(worktreesDir, { recursive: true });
    }

    // Create prompts directory for file-backed initial agent prompts
    if (!await this.fileExists(promptsDir)) {
      await fs.mkdir(promptsDir, { recursive: true });
    }

    // Check if .dmux is ignored by either this repo's .gitignore or global gitignore
    const isIgnored = spawnSync('git', ['check-ignore', '--quiet', dmuxDir], {
      cwd: this.projectRoot
    }).status === 0;

    if (isIgnored) {
      return;
    }

    // Auto-add .dmux to .gitignore if not already present
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    if (await this.fileExists(gitignorePath)) {
      const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
      const lines = gitignoreContent.split('\n');

      // Check if .dmux is already in .gitignore (exact match or pattern match)
      const hasDmuxEntry = lines.some(line => {
        const trimmed = line.trim();
        return trimmed === '.dmux/' || trimmed === '.dmux' || trimmed === '/.dmux/';
      });

      if (!hasDmuxEntry) {
        // Add .dmux/ to .gitignore
        const newGitignore = gitignoreContent.endsWith('\n')
          ? gitignoreContent + '.dmux/\n'
          : gitignoreContent + '\n.dmux/\n';
        await fs.writeFile(gitignorePath, newGitignore);
        LogService.getInstance().debug('Added .dmux/ to .gitignore', 'Setup');
      }
    } else {
      // No .gitignore exists, create one with .dmux/ entry
      await fs.writeFile(gitignorePath, '.dmux/\n');
      LogService.getInstance().debug('Created .gitignore with .dmux/ entry', 'Setup');
    }
  }


  private async migrateOldConfig() {
    // Check if we're using the new config location
    const dmuxDir = path.join(this.projectRoot, '.dmux');
    const newConfigFile = path.join(dmuxDir, 'dmux.config.json');
    const oldParentConfigFile = path.join(path.dirname(this.projectRoot), 'dmux.config.json');
    const homeDmuxDir = path.join(process.env.HOME!, '.dmux');

    if (this.panesFile === newConfigFile && !await this.fileExists(newConfigFile)) {
      // Look for old config files to migrate
      const projectHash = createHash('md5').update(this.projectRoot).digest('hex').substring(0, 8);
      const projectIdentifier = `${this.projectName}-${projectHash}`;
      const oldPanesFile = path.join(homeDmuxDir, `${projectIdentifier}-panes.json`);
      const oldSettingsFile = path.join(homeDmuxDir, `${projectIdentifier}-settings.json`);
      const oldUpdateSettingsFile = path.join(homeDmuxDir, 'update-settings.json');
      
      let panes = [];
      let settings = {};
      let updateSettings = {};
      
      // Try to read old panes file
      if (await this.fileExists(oldPanesFile)) {
        try {
          const oldPanesContent = await fs.readFile(oldPanesFile, 'utf-8');
          panes = JSON.parse(oldPanesContent);
        } catch {
          // Intentionally silent - migration is best-effort
        }
      }
      
      // Try to read old settings file
      if (await this.fileExists(oldSettingsFile)) {
        try {
          const oldSettingsContent = await fs.readFile(oldSettingsFile, 'utf-8');
          settings = JSON.parse(oldSettingsContent);
        } catch {
          // Intentionally silent - migration is best-effort
        }
      }
      
      // Try to read old update settings file
      if (await this.fileExists(oldUpdateSettingsFile)) {
        try {
          const oldUpdateContent = await fs.readFile(oldUpdateSettingsFile, 'utf-8');
          updateSettings = JSON.parse(oldUpdateContent);
        } catch {
          // Intentionally silent - migration is best-effort
        }
      }
      
      // Check for config from previous parent directory location
      if (await this.fileExists(oldParentConfigFile)) {
        try {
          const oldConfig = JSON.parse(await fs.readFile(oldParentConfigFile, 'utf-8'));
          if (oldConfig.panes) panes = oldConfig.panes;
          if (oldConfig.settings) settings = oldConfig.settings;
          if (oldConfig.updateSettings) updateSettings = oldConfig.updateSettings;
        } catch {
          // Intentionally silent - migration is best-effort
        }
      }

      // If we found old config, migrate it
      if (panes.length > 0 || Object.keys(settings).length > 0 || Object.keys(updateSettings).length > 0) {
        const migratedConfig = {
          projectName: this.projectName,
          projectRoot: this.projectRoot,
          panes: panes,
          settings: settings,
          updateSettings: updateSettings,
          lastUpdated: new Date().toISOString(),
          migratedFrom: 'dmux-legacy'
        };
        await fs.writeFile(newConfigFile, JSON.stringify(migratedConfig, null, 2));

        // Clean up old files after successful migration
        try {
          await fs.unlink(oldPanesFile);
        } catch {
          // Intentionally silent - cleanup is best-effort
        }
        try {
          await fs.unlink(oldSettingsFile);
        } catch {
          // Intentionally silent - cleanup is best-effort
        }
        try {
          await fs.unlink(oldUpdateSettingsFile);
        } catch {
          // Intentionally silent - cleanup is best-effort
        }
        try {
          await fs.unlink(oldParentConfigFile);
        } catch {
          // Intentionally silent - cleanup is best-effort
        }
      }
    }
  }

  private checkForUpdatesBackground() {
    // Run update check in background without blocking startup
    setImmediate(async () => {
      try {
        const shouldCheck = await this.autoUpdater.shouldCheckForUpdates();
        if (shouldCheck) {
          // Check for updates asynchronously
          this.autoUpdater.checkForUpdates().catch(() => {
            // Silently ignore update check failures
          });
        }
      } catch {
        // Silently ignore errors in background update check
      }
    });
  }

  async getUpdateInfo() {
    return await this.autoUpdater.checkForUpdates();
  }

  async performUpdate() {
    const updateInfo = await this.autoUpdater.checkForUpdates();
    return await this.autoUpdater.performUpdate(updateInfo);
  }

  async skipUpdate(version: string) {
    return await this.autoUpdater.skipVersion(version);
  }

  getAutoUpdater() {
    return this.autoUpdater;
  }

  private setupResizeHook(sessionName: string = this.sessionName) {
    try {
      // Set up session-specific hook that sends SIGUSR1 to dmux process on resize
      // This works inside tmux where normal SIGWINCH may not propagate
      const pid = process.pid;
      execSync(`tmux set-hook -t '${sessionName}' client-resized 'run-shell "kill -USR1 ${pid} 2>/dev/null || true"'`, { stdio: 'pipe' });
      // LogService.getInstance().debug(`Set up resize hook for session ${this.sessionName}`, 'Setup');
    } catch (error) {
      LogService.getInstance().warn('Failed to set up resize hook', 'Setup');
    }
  }

  private setupPaneSplitHook(sessionName: string = this.sessionName) {
    try {
      // Set up hooks that send SIGUSR2 to dmux process for pane events
      // This allows immediate detection of pane changes
      const pid = process.pid;

      // Detect manually created panes via Ctrl+b %
      execSync(`tmux set-hook -t '${sessionName}' after-split-window 'run-shell "kill -USR2 ${pid} 2>/dev/null || true"'`, { stdio: 'pipe' });

      // Detect pane closures via Ctrl+b x or process exit
      execSync(`tmux set-hook -t '${sessionName}' pane-exited 'run-shell "kill -USR2 ${pid} 2>/dev/null || true"'`, { stdio: 'pipe' });

      // LogService.getInstance().debug(`Set up pane detection hooks for session ${this.sessionName}`, 'Setup');
    } catch (error) {
      LogService.getInstance().warn('Failed to set up pane hooks', 'Setup');
    }
  }

  private cleanupResizeHook(sessionName: string = this.getCurrentTmuxSessionName() || this.sessionName) {
    try {
      // Remove session-specific hook
      execSync(`tmux set-hook -u -t '${sessionName}' client-resized`, { stdio: 'pipe' });
      LogService.getInstance().debug('Cleaned up resize hook', 'Setup');
    } catch {
      // Ignore cleanup errors
    }
  }

  private cleanupPaneSplitHook(sessionName: string = this.getCurrentTmuxSessionName() || this.sessionName) {
    try {
      // Remove pane hooks
      execSync(`tmux set-hook -u -t '${sessionName}' after-split-window`, { stdio: 'pipe' });
      execSync(`tmux set-hook -u -t '${sessionName}' pane-exited`, { stdio: 'pipe' });
      LogService.getInstance().debug('Cleaned up pane hooks', 'Setup');
    } catch {
      // Ignore cleanup errors
    }
  }

  private setupGlobalSignalHandlers() {
    const cleanTerminalExit = async () => {
      // Clean up hooks
      if (process.env.TMUX) {
        this.cleanupResizeHook();
        this.cleanupPaneSplitHook();
      }

      // Clear screen multiple times to ensure no artifacts
      process.stdout.write('\x1b[2J\x1b[H'); // Clear screen and move to home
      process.stdout.write('\x1b[3J'); // Clear scrollback buffer
      process.stdout.write('\n'.repeat(100)); // Push any remaining content off screen

      // Clear tmux pane if we're in tmux
      if (process.env.TMUX) {
        try {
          const tmuxService = TmuxService.getInstance();
          tmuxService.clearHistorySync();
          await tmuxService.sendKeys('', 'C-l');
        } catch {
          // Intentionally silent - cleanup is best-effort
        }
      }

      // Wait a moment for clearing to settle, then show goodbye message
      setTimeout(() => {
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write('\n\n  dmux session ended.\n\n');
        process.exit(0);
      }, 100);
    };

    // Handle Ctrl+C and SIGTERM
    process.on('SIGINT', cleanTerminalExit);
    process.on('SIGTERM', cleanTerminalExit);

    // Handle SIGUSR2 for pane split detection
    // This signal is sent by tmux hook when a new pane is created
    process.on('SIGUSR2', () => {
      // Log that a pane split was detected
      LogService.getInstance().debug('Pane split detected via SIGUSR2, triggering immediate detection', 'shellDetection');
      // Emit a custom event to trigger immediate shell pane detection
      process.emit('pane-split-detected' as any);
    });

    // Handle uncaught exceptions and unhandled rejections
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      cleanTerminalExit();
    });

    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection:', reason);
      cleanTerminalExit();
    });
  }
}

// Validate system requirements before starting
(async () => {
  const validationResult = await validateSystemRequirements();
  printValidationResults(validationResult);

  // Only proceed if system requirements are met
  if (validationResult.canRun) {
    const dmux = new Dmux();
    dmux.init().catch(() => process.exit(1));
  }
})();
