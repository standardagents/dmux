import { useInput } from "ink"
import type { DmuxPane } from "../types.js"
import { StateManager } from "../shared/StateManager.js"
import { TmuxService } from "../services/TmuxService.js"
import {
  STATUS_MESSAGE_DURATION_SHORT,
  STATUS_MESSAGE_DURATION_LONG,
  ANIMATION_DELAY,
} from "../constants/timing.js"
import { PaneAction } from "../actions/index.js"
import { getMainBranch, getOrphanedWorktrees } from "../utils/git.js"
import { persistEnvToShell } from "../utils/shellKeyPersist.js"
import { enforceControlPaneSize } from "../utils/tmux.js"
import { SIDEBAR_WIDTH } from "../utils/layoutManager.js"
import { suggestCommand } from "../utils/commands.js"
import type { PopupManager } from "../services/PopupManager.js"
import { getPaneProjectRoot } from "../utils/paneProject.js"
import {
  getProjectActionByIndex,
  type ProjectActionItem,
} from "../utils/projectActions.js"
import { createShellPane, getNextDmuxId } from "../utils/shellPaneDetection.js"

// Type for the action system returned by useActionSystem hook
interface ActionSystem {
  actionState: any
  executeAction: (actionId: any, pane: DmuxPane, params?: any) => Promise<void>
  executeCallback: (callback: (() => Promise<any>) | null, options?: { showProgress?: boolean; progressMessage?: string }) => Promise<void>
  clearDialog: (dialogType: any) => void
  clearStatus: () => void
  setActionState: (state: any) => void
}

interface UseInputHandlingParams {
  // State
  panes: DmuxPane[]
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  isCreatingPane: boolean
  setIsCreatingPane: (value: boolean) => void
  runningCommand: boolean
  isUpdating: boolean
  isLoading: boolean
  ignoreInput: boolean
  quitConfirmMode: boolean
  setQuitConfirmMode: (value: boolean) => void

  // Dialog state
  showCommandPrompt: "test" | "dev" | null
  setShowCommandPrompt: (value: "test" | "dev" | null) => void
  commandInput: string
  setCommandInput: (value: string) => void
  showFileCopyPrompt: boolean
  setShowFileCopyPrompt: (value: boolean) => void
  currentCommandType: "test" | "dev" | null
  setCurrentCommandType: (value: "test" | "dev" | null) => void

  // Settings
  projectSettings: any
  saveSettings: (settings: any) => Promise<void>
  settingsManager: any

  // Services
  popupManager: PopupManager
  actionSystem: ActionSystem
  controlPaneId: string | undefined

  // Callbacks
  setStatusMessage: (message: string) => void
  copyNonGitFiles: (worktreePath: string, sourceProjectRoot?: string) => Promise<void>
  runCommandInternal: (type: "test" | "dev", pane: DmuxPane) => Promise<void>
  handlePaneCreationWithAgent: (prompt: string, targetProjectRoot?: string) => Promise<void>
  handleReopenWorktree: (slug: string, worktreePath: string, targetProjectRoot?: string) => Promise<void>
  savePanes: (panes: DmuxPane[]) => Promise<void>
  loadPanes: () => Promise<void>
  cleanExit: () => void

  // Project info
  projectRoot: string
  projectActionItems: ProjectActionItem[]

  // Navigation
  findCardInDirection: (currentIndex: number, direction: "up" | "down" | "left" | "right") => number | null
}

/**
 * Hook that handles all keyboard input for the TUI
 * Extracted from DmuxApp.tsx to reduce component complexity
 */
export function useInputHandling(params: UseInputHandlingParams) {
  const {
    panes,
    selectedIndex,
    setSelectedIndex,
    isCreatingPane,
    setIsCreatingPane,
    runningCommand,
    isUpdating,
    isLoading,
    ignoreInput,
    quitConfirmMode,
    setQuitConfirmMode,
    showCommandPrompt,
    setShowCommandPrompt,
    commandInput,
    setCommandInput,
    showFileCopyPrompt,
    setShowFileCopyPrompt,
    currentCommandType,
    setCurrentCommandType,
    projectSettings,
    saveSettings,
    settingsManager,
    popupManager,
    actionSystem,
    controlPaneId,
    setStatusMessage,
    copyNonGitFiles,
    runCommandInternal,
    handlePaneCreationWithAgent,
    handleReopenWorktree,
    savePanes,
    loadPanes,
    cleanExit,
    projectRoot,
    projectActionItems,
    findCardInDirection,
  } = params

  const handleCreateAgentPane = async (targetProjectRoot: string) => {
    const promptValue = await popupManager.launchNewPanePopup(targetProjectRoot)
    if (promptValue) {
      await handlePaneCreationWithAgent(promptValue, targetProjectRoot)
    }
  }

  const handleCreateTerminalPane = async (targetProjectRoot: string) => {
    try {
      setIsCreatingPane(true)
      setStatusMessage("Creating terminal pane...")

      const tmuxService = TmuxService.getInstance()
      const newPaneId = await tmuxService.splitPane({ cwd: targetProjectRoot })

      // Wait for pane creation to settle
      await new Promise((resolve) => setTimeout(resolve, ANIMATION_DELAY))

      // Persist shell pane immediately with project metadata so grouping is stable.
      const shellPane = await createShellPane(
        newPaneId,
        getNextDmuxId(panes)
      )
      shellPane.projectRoot = targetProjectRoot
      await savePanes([...panes, shellPane])

      setIsCreatingPane(false)
      setStatusMessage("Terminal pane created")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)

      // Force a reload to ensure tmux metadata and pane IDs are in sync
      await loadPanes()
    } catch (error: any) {
      setIsCreatingPane(false)
      setStatusMessage(`Failed to create terminal pane: ${error.message}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    }
  }

  const handleCreatePaneInProject = async () => {
    const selectedAction = getProjectActionByIndex(projectActionItems, selectedIndex)
    const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
    const defaultProjectPath = selectedPane
      ? getPaneProjectRoot(selectedPane, projectRoot)
      : (selectedAction?.projectRoot || projectRoot)

    const requestedProjectPath = await popupManager.launchProjectSelectPopup(
      defaultProjectPath
    )

    if (!requestedProjectPath) {
      return
    }

    try {
      const { resolveProjectRootFromPath } = await import("../utils/projectRoot.js")
      const resolved = resolveProjectRootFromPath(requestedProjectPath, projectRoot)

      const promptValue = await popupManager.launchNewPanePopup(resolved.projectRoot)
      if (!promptValue) {
        return
      }

      await handlePaneCreationWithAgent(promptValue, resolved.projectRoot)
    } catch (error: any) {
      setStatusMessage(error?.message || "Invalid project path")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    }
  }

  const getActiveProjectRoot = (): string => {
    const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
    if (selectedPane) {
      return getPaneProjectRoot(selectedPane, projectRoot)
    }

    const selectedAction = getProjectActionByIndex(projectActionItems, selectedIndex)
    return selectedAction?.projectRoot || projectRoot
  }

  const launchHooksAuthoringSession = async (targetProjectRoot?: string) => {
    const hooksProjectRoot = targetProjectRoot || getActiveProjectRoot()
    const { initializeHooksDirectory } = await import("../utils/hooks.js")
    initializeHooksDirectory(hooksProjectRoot)

    const prompt =
      "I would like to create or edit my dmux hooks in .dmux-hooks. Please read AGENTS.md or CLAUDE.md first, then ask me what I want to create or modify."
    await handlePaneCreationWithAgent(prompt, hooksProjectRoot)
  }

  useInput(async (input: string, key: any) => {
    // Ignore input temporarily after popup operations (prevents buffered keys from being processed)
    if (ignoreInput) {
      return
    }

    // Handle Ctrl+C for quit confirmation (must be first, before any other checks)
    if (key.ctrl && input === "c") {
      if (quitConfirmMode) {
        // Second Ctrl+C - actually quit
        cleanExit()
      } else {
        // First Ctrl+C - show confirmation
        setQuitConfirmMode(true)
        // Reset after 3 seconds if user doesn't press Ctrl+C again
        setTimeout(() => {
          setQuitConfirmMode(false)
        }, 3000)
      }
      return
    }

    if (isCreatingPane || runningCommand || isUpdating || isLoading) {
      // Disable input while performing operations or loading
      return
    }

    // Handle quit confirm mode - ESC cancels it
    if (quitConfirmMode) {
      if (key.escape) {
        setQuitConfirmMode(false)
        return
      }
      // Allow other inputs to continue (don't return early)
    }

    if (showFileCopyPrompt) {
      if (input === "y" || input === "Y") {
        setShowFileCopyPrompt(false)
        const selectedPane = panes[selectedIndex]
        if (selectedPane && selectedPane.worktreePath && currentCommandType) {
          const paneProjectRoot = getPaneProjectRoot(selectedPane, projectRoot)
          await copyNonGitFiles(selectedPane.worktreePath, paneProjectRoot)

          // Mark as not first run and continue with command
          const newSettings = {
            ...projectSettings,
            [currentCommandType === "test" ? "firstTestRun" : "firstDevRun"]:
              true,
          }
          await saveSettings(newSettings)

          // Now run the actual command
          await runCommandInternal(currentCommandType, selectedPane)
        }
        setCurrentCommandType(null)
      } else if (input === "n" || input === "N" || key.escape) {
        setShowFileCopyPrompt(false)
        const selectedPane = panes[selectedIndex]
        if (selectedPane && currentCommandType) {
          // Mark as not first run and continue without copying
          const newSettings = {
            ...projectSettings,
            [currentCommandType === "test" ? "firstTestRun" : "firstDevRun"]:
              true,
          }
          await saveSettings(newSettings)

          // Now run the actual command
          await runCommandInternal(currentCommandType, selectedPane)
        }
        setCurrentCommandType(null)
      }
      return
    }

    if (showCommandPrompt) {
      if (key.escape) {
        setShowCommandPrompt(null)
        setCommandInput("")
      } else if (key.return) {
        if (commandInput.trim() === "") {
          // If empty, suggest a default command based on package manager
          const suggested = await suggestCommand(showCommandPrompt)
          if (suggested) {
            setCommandInput(suggested)
          }
        } else {
          // User provided manual command
          const newSettings = {
            ...projectSettings,
            [showCommandPrompt === "test" ? "testCommand" : "devCommand"]:
              commandInput.trim(),
          }
          await saveSettings(newSettings)
          const selectedPane = panes[selectedIndex]
          if (selectedPane) {
            // Check if first run
            const isFirstRun =
              showCommandPrompt === "test"
                ? !projectSettings.firstTestRun
                : !projectSettings.firstDevRun
            if (isFirstRun) {
              setCurrentCommandType(showCommandPrompt)
              setShowCommandPrompt(null)
              setShowFileCopyPrompt(true)
            } else {
              await runCommandInternal(showCommandPrompt, selectedPane)
              setShowCommandPrompt(null)
              setCommandInput("")
            }
          } else {
            setShowCommandPrompt(null)
            setCommandInput("")
          }
        }
      }
      return
    }

    // Handle directional navigation with spatial awareness based on card grid layout
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      let targetIndex: number | null = null

      if (key.upArrow) {
        targetIndex = findCardInDirection(selectedIndex, "up")
      } else if (key.downArrow) {
        targetIndex = findCardInDirection(selectedIndex, "down")
      } else if (key.leftArrow) {
        targetIndex = findCardInDirection(selectedIndex, "left")
      } else if (key.rightArrow) {
        targetIndex = findCardInDirection(selectedIndex, "right")
      }

      if (targetIndex !== null) {
        setSelectedIndex(targetIndex)
      }
      return
    }

    if (input === "m" && selectedIndex < panes.length) {
      // Open kebab menu popup for selected pane
      const selectedPane = panes[selectedIndex]
      const actionId = await popupManager.launchKebabMenuPopup(selectedPane)
      if (actionId) {
        await actionSystem.executeAction(actionId, selectedPane, {
          mainBranch: getMainBranch(),
        })
      }
    } else if (input === "s") {
      // Open settings popup
      const result = await popupManager.launchSettingsPopup(async () => {
        // Launch hooks popup
        await popupManager.launchHooksPopup(async () => {
          await launchHooksAuthoringSession()
        })
      })
      if (result) {
        settingsManager.updateSetting(
          result.key as keyof import("../types.js").DmuxSettings,
          result.value,
          result.scope
        )
        if (result.key === 'openrouterApiKey' && result.value) {
          process.env.OPENROUTER_API_KEY = result.value as string;
          persistEnvToShell('OPENROUTER_API_KEY', result.value as string);
        }
        setStatusMessage(`Setting saved (${result.scope})`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      }
    } else if (input === "l") {
      // Open logs popup
      await popupManager.launchLogsPopup()
    } else if (input === "h") {
      // Launch hooks authoring session directly
      await launchHooksAuthoringSession()
    } else if (input === "?") {
      // Open keyboard shortcuts popup
      const shortcutsAction = await popupManager.launchShortcutsPopup(!!controlPaneId)
      if (shortcutsAction === "hooks") {
        await launchHooksAuthoringSession()
      }
    } else if (input === "L" && controlPaneId) {
      // Reset layout to sidebar configuration (Shift+L)
      enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH)
      setStatusMessage("Layout reset")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } else if (input === "T") {
      // Demo toasts (Shift+T) - cycles through different types
      const stateManager = StateManager.getInstance()
      const demos = [
        { msg: "Pane created successfully", severity: "success" as const },
        { msg: "Failed to merge: conflicts detected", severity: "error" as const },
        { msg: "Warning: API key not configured", severity: "warning" as const },
        { msg: "This is a longer informational message that will wrap to multiple lines if needed to demonstrate how toasts handle longer content", severity: "info" as const },
      ]
      // Queue all demo toasts
      demos.forEach(demo => stateManager.showToast(demo.msg, demo.severity))
    } else if (input === "q") {
      cleanExit()
    } else if (input === "r") {
      // Reopen closed worktree popup
      const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
      const targetProjectRoot = selectedPane
        ? getPaneProjectRoot(selectedPane, projectRoot)
        : projectRoot
      const activeSlugs = panes
        .filter((p) => getPaneProjectRoot(p, projectRoot) === targetProjectRoot)
        .map((p) => p.slug)
      const orphanedWorktrees = getOrphanedWorktrees(targetProjectRoot, activeSlugs)

      if (orphanedWorktrees.length === 0) {
        setStatusMessage(`No closed worktrees in ${targetProjectRoot}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        return
      }

      const result = await popupManager.launchReopenWorktreePopup(orphanedWorktrees)
      if (result) {
        await handleReopenWorktree(result.slug, result.path, targetProjectRoot)
      }
      return
    } else if (
      !isLoading &&
      (
        input === "p" ||
        input === "N"
      )
    ) {
      // Create pane in another project ([p], with Shift+N fallback)
      await handleCreatePaneInProject()
      return
    } else if (!isLoading && input === "n") {
      // Main session hotkey only
      await handleCreateAgentPane(projectRoot)
      return
    } else if (!isLoading && input === "t") {
      // Main session hotkey only
      await handleCreateTerminalPane(projectRoot)
      return
    } else if (
      !isLoading &&
      key.return &&
      !!getProjectActionByIndex(projectActionItems, selectedIndex)
    ) {
      const selectedAction = getProjectActionByIndex(projectActionItems, selectedIndex)!
      if (selectedAction.kind === "new-agent") {
        await handleCreateAgentPane(selectedAction.projectRoot)
      } else if (selectedAction.kind === "terminal") {
        await handleCreateTerminalPane(selectedAction.projectRoot)
      }
      return
    } else if (input === "j" && selectedIndex < panes.length) {
      // Jump to pane (NEW: using action system)
      StateManager.getInstance().setDebugMessage(
        `Jumping to pane: ${panes[selectedIndex].slug}`
      )
      setTimeout(() => StateManager.getInstance().setDebugMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      actionSystem.executeAction(PaneAction.VIEW, panes[selectedIndex])
    } else if (input === "x" && selectedIndex < panes.length) {
      // Close pane (NEW: using action system)
      StateManager.getInstance().setDebugMessage(
        `Closing pane: ${panes[selectedIndex].slug}`
      )
      setTimeout(() => StateManager.getInstance().setDebugMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      actionSystem.executeAction(PaneAction.CLOSE, panes[selectedIndex])
    } else if (key.return && selectedIndex < panes.length) {
      // Jump to pane (NEW: using action system)
      StateManager.getInstance().setDebugMessage(
        `Jumping to pane: ${panes[selectedIndex].slug}`
      )
      setTimeout(() => StateManager.getInstance().setDebugMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      actionSystem.executeAction(PaneAction.VIEW, panes[selectedIndex])
    }
  })
}
