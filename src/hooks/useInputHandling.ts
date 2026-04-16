import { useEffect, useRef } from "react"
import path from "path"
import { useInput } from "ink"
import type { DmuxPane, SidebarProject } from "../types.js"
import type { TrackProjectActivity } from "../types/activity.js"
import { StateManager } from "../shared/StateManager.js"
import { TmuxService } from "../services/TmuxService.js"
import {
  STATUS_MESSAGE_DURATION_SHORT,
  STATUS_MESSAGE_DURATION_LONG,
  ANIMATION_DELAY,
} from "../constants/timing.js"
import {
  isPaneAction,
  PaneAction,
  TOGGLE_PANE_VISIBILITY_ACTION,
} from "../actions/index.js"
import { getMainBranch } from "../utils/git.js"
import {
  getResumableBranches,
  type ResumableBranchCandidate,
} from "../utils/resumeBranches.js"
import { enforceControlPaneSize } from "../utils/tmux.js"
import { SIDEBAR_WIDTH } from "../utils/layoutManager.js"
import { suggestCommand } from "../utils/commands.js"
import type { PopupManager } from "../services/PopupManager.js"
import { getPaneProjectName, getPaneProjectRoot } from "../utils/paneProject.js"
import { getPaneDisplayName } from "../utils/paneTitle.js"
import {
  buildProjectActionLayout,
  getProjectActionByIndex,
  type ProjectActionItem,
} from "../utils/projectActions.js"
import { createShellPane, getNextDmuxId } from "../utils/shellPaneDetection.js"
import type { AgentName } from "../utils/agentLaunch.js"
import {
  getBulkVisibilityAction,
  getProjectVisibilityAction,
  partitionPanesByProject,
} from "../utils/paneVisibility.js"
import { buildFilesOnlyCommand } from "../utils/dmuxCommand.js"
import {
  addSidebarProject,
  hasSidebarProject,
  removeSidebarProject,
  sameSidebarProjectRoot,
} from "../utils/sidebarProjects.js"
import {
  drainRemotePaneActions,
  getCurrentTmuxSessionName,
  type RemotePaneActionShortcut,
} from "../utils/remotePaneActions.js"
import { SettingsManager } from "../utils/settingsManager.js"

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
  isDevMode: boolean
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
  refreshDmuxSettings: (projectRoot?: string, nextTheme?: string) => void

  // Services
  popupManager: PopupManager
  actionSystem: ActionSystem
  controlPaneId: string | undefined
  trackProjectActivity: TrackProjectActivity

  // Callbacks
  setStatusMessage: (message: string) => void
  copyNonGitFiles: (worktreePath: string, sourceProjectRoot?: string) => Promise<void>
  runCommandInternal: (type: "test" | "dev", pane: DmuxPane) => Promise<void>
  handlePaneCreationWithAgent: (prompt: string, targetProjectRoot?: string) => Promise<void>
  handleCreateChildWorktree: (pane: DmuxPane) => Promise<void>
  handleReopenWorktree: (
    candidate: ResumableBranchCandidate,
    targetProjectRoot?: string
  ) => Promise<void>
  setDevSourceFromPane: (pane: DmuxPane) => Promise<void>
  savePanes: (panes: DmuxPane[]) => Promise<void>
  sidebarProjects: SidebarProject[]
  saveSidebarProjects: (projects: SidebarProject[]) => Promise<SidebarProject[]>
  loadPanes: () => Promise<void>
  cleanExit: () => void

  // Agent info
  getAvailableAgentsForProject: (projectRoot?: string) => AgentName[]
  panesFile: string

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
    isDevMode,
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
    refreshDmuxSettings,
    popupManager,
    actionSystem,
    controlPaneId,
    trackProjectActivity,
    setStatusMessage,
    copyNonGitFiles,
    runCommandInternal,
    handlePaneCreationWithAgent,
    handleCreateChildWorktree,
    handleReopenWorktree,
    setDevSourceFromPane,
    savePanes,
    sidebarProjects,
    saveSidebarProjects,
    loadPanes,
    cleanExit,
    getAvailableAgentsForProject,
    panesFile,
    projectRoot,
    projectActionItems,
    findCardInDirection,
  } = params

  const layoutRefreshDebounceRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    return () => {
      if (layoutRefreshDebounceRef.current) {
        clearTimeout(layoutRefreshDebounceRef.current)
        layoutRefreshDebounceRef.current = null
      }
    }
  }, [])

  const queueLayoutRefresh = () => {
    if (!controlPaneId) {
      return
    }

    if (layoutRefreshDebounceRef.current) {
      clearTimeout(layoutRefreshDebounceRef.current)
    }

    layoutRefreshDebounceRef.current = setTimeout(async () => {
      layoutRefreshDebounceRef.current = null
      try {
        await enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH, { forceLayout: true })
      } catch (error: any) {
        setStatusMessage(`Setting saved but layout refresh failed: ${error?.message || String(error)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
    }, 250)
  }

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

  const selectProjectAction = (
    targetProjectRoot: string,
    projectsToRender: SidebarProject[] = sidebarProjects
  ) => {
    const actionLayout = buildProjectActionLayout(
      panes,
      projectsToRender,
      projectRoot,
      path.basename(projectRoot)
    )
    const selectedAction = actionLayout.actionItems.find(
      (action) =>
        action.kind === "new-agent" &&
        sameSidebarProjectRoot(action.projectRoot, targetProjectRoot)
    )
    if (selectedAction) {
      setSelectedIndex(selectedAction.index)
    }
  }

  const openTerminalInWorktree = async (selectedPane: DmuxPane) => {
    if (!selectedPane.worktreePath) {
      setStatusMessage("Cannot open terminal: this pane has no worktree")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const targetProjectRoot = getPaneProjectRoot(selectedPane, projectRoot)

    try {
      setIsCreatingPane(true)
      setStatusMessage(`Opening terminal in ${getPaneDisplayName(selectedPane)}...`)

      const tmuxService = TmuxService.getInstance()
      const newPaneId = await tmuxService.splitPane({ cwd: selectedPane.worktreePath })

      // Wait for pane creation to settle
      await new Promise((resolve) => setTimeout(resolve, ANIMATION_DELAY))

      const shellPane = await createShellPane(
        newPaneId,
        getNextDmuxId(panes)
      )
      shellPane.projectRoot = targetProjectRoot
      await savePanes([...panes, shellPane])

      setStatusMessage(`Opened terminal in ${getPaneDisplayName(selectedPane)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)

      // Force a reload to ensure tmux metadata and pane IDs are in sync
      await loadPanes()
    } catch (error: any) {
      setStatusMessage(`Failed to open terminal in worktree: ${error.message}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const openFileBrowserInWorktree = async (selectedPane: DmuxPane) => {
    if (!selectedPane.worktreePath) {
      setStatusMessage("Cannot open file browser: this pane has no worktree")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const existingBrowserPane = panes.find((pane) =>
      pane.browserPath === selectedPane.worktreePath && !pane.hidden
    )

    if (existingBrowserPane) {
      try {
        await TmuxService.getInstance().selectPane(existingBrowserPane.paneId)
        setStatusMessage(`File browser already open for ${getPaneDisplayName(selectedPane)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      } catch (error: any) {
        setStatusMessage(`Failed to focus file browser: ${error?.message || String(error)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
      return
    }

    const targetProjectRoot = getPaneProjectRoot(selectedPane, projectRoot)
    const targetProjectName = path.basename(targetProjectRoot)

    try {
      setIsCreatingPane(true)
      setStatusMessage(`Opening file browser for ${getPaneDisplayName(selectedPane)}...`)

      const tmuxService = TmuxService.getInstance()
      const newPaneId = await tmuxService.splitPane({
        cwd: selectedPane.worktreePath,
        command: buildFilesOnlyCommand(),
      })

      await new Promise((resolve) => setTimeout(resolve, ANIMATION_DELAY))

      const slugBase = `files-${path.basename(selectedPane.worktreePath)}`
      let slug = slugBase
      let suffix = 2
      while (panes.some((pane) => pane.slug === slug)) {
        slug = `${slugBase}-${suffix}`
        suffix += 1
      }

      const browserPane: DmuxPane = {
        id: `dmux-${getNextDmuxId(panes)}`,
        slug,
        prompt: "",
        paneId: newPaneId,
        projectRoot: targetProjectRoot,
        projectName: targetProjectName,
        type: "shell",
        shellType: "fb",
        browserPath: selectedPane.worktreePath,
      }

      await tmuxService.setPaneTitle(newPaneId, slug)
      await savePanes([...panes, browserPane])
      await loadPanes()

      setStatusMessage(`Opened file browser for ${getPaneDisplayName(selectedPane)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to open file browser: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const handleAddProjectToSidebar = async () => {
    const selectedAction = getProjectActionByIndex(projectActionItems, selectedIndex)
    const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
    const defaultProjectPath = selectedPane
      ? getPaneProjectRoot(selectedPane, projectRoot)
      : (selectedAction?.projectRoot || projectRoot)

    const requestedProjectPath = await popupManager.launchProjectSelectPopup(
      defaultProjectPath,
      defaultProjectPath
    )

    if (!requestedProjectPath) {
      return
    }

    try {
      const { resolveProjectRootFromPath } = await import("../utils/projectRoot.js")
      const resolved = resolveProjectRootFromPath(requestedProjectPath, projectRoot)
      const nextProjects = addSidebarProject(sidebarProjects, resolved)

      if (nextProjects === sidebarProjects) {
        selectProjectAction(resolved.projectRoot)
        setStatusMessage(`${resolved.projectName} is already in the sidebar`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        return
      }

      const savedProjects = await saveSidebarProjects(nextProjects)
      selectProjectAction(resolved.projectRoot, savedProjects)
      setStatusMessage(`Added ${resolved.projectName} to the sidebar`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      const {
        createEmptyGitProject,
        inspectProjectCreationTarget,
      } = await import("../utils/projectRoot.js")
      const target = inspectProjectCreationTarget(requestedProjectPath, projectRoot)

      if (target.state !== "missing" && target.state !== "empty_directory") {
        const message = target.state === "directory_not_empty"
          ? `Directory is not a git repository and is not empty: ${target.absolutePath}. New projects can only be created in a missing or empty directory.`
          : (error?.message || "Invalid project path")
        setStatusMessage(message)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
        return
      }

      const confirmMessage = target.state === "missing"
        ? `This project does not exist yet:\n${target.absolutePath}\n\nCreate a new empty git repository here?`
        : `This directory is not a git repository:\n${target.absolutePath}\n\nInitialize a new empty git repository here?`
      const shouldCreateProject = await popupManager.launchConfirmPopup(
        "Create Project",
        confirmMessage,
        "Create Project",
        "Cancel",
        projectRoot
      )

      if (!shouldCreateProject) {
        return
      }

      try {
        setStatusMessage(`Creating ${path.basename(target.absolutePath) || "project"}...`)
        const createdProject = createEmptyGitProject(requestedProjectPath, projectRoot)
        const nextProjects = addSidebarProject(sidebarProjects, createdProject)

        if (nextProjects === sidebarProjects) {
          selectProjectAction(createdProject.projectRoot)
          setStatusMessage(`${createdProject.projectName} is already in the sidebar`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
          return
        }

        const savedProjects = await saveSidebarProjects(nextProjects)
        selectProjectAction(createdProject.projectRoot, savedProjects)
        setStatusMessage(`Created ${createdProject.projectName} and added it to the sidebar`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      } catch (creationError: any) {
        setStatusMessage(creationError?.message || "Failed to create project")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
    }
  }

  const handleRemoveProjectFromSidebar = async (targetProjectRoot: string) => {
    if (sameSidebarProjectRoot(targetProjectRoot, projectRoot)) {
      setStatusMessage("The session project cannot be removed from the sidebar")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const projectHasPanes = panes.some((pane) =>
      sameSidebarProjectRoot(getPaneProjectRoot(pane, projectRoot), targetProjectRoot)
    )
    if (projectHasPanes) {
      setStatusMessage("Close this project's panes before removing it from the sidebar")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      return
    }

    if (!hasSidebarProject(sidebarProjects, targetProjectRoot)) {
      setStatusMessage("Project is not in the sidebar")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const updatedProjects = removeSidebarProject(sidebarProjects, targetProjectRoot)
    const savedProjects = await saveSidebarProjects(updatedProjects)
    selectProjectAction(projectRoot, savedProjects)
    setStatusMessage(`Removed ${path.basename(targetProjectRoot)} from the sidebar`)
    setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
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

  const refreshPaneLayout = async () => {
    if (!controlPaneId) {
      return
    }

    await enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH, {
      forceLayout: true,
      suppressLayoutLogs: true,
    })
  }

  const getPaneShowTarget = async (excludedPaneId?: string): Promise<string | null> => {
    const visiblePaneId = panes.find(
      (pane) => !pane.hidden && pane.paneId !== excludedPaneId
    )?.paneId
    if (visiblePaneId) {
      return visiblePaneId
    }

    if (controlPaneId) {
      return controlPaneId
    }

    try {
      return await TmuxService.getInstance().getCurrentPaneId()
    } catch {
      return null
    }
  }

  const togglePaneVisibility = async (selectedPane: DmuxPane) => {
    const tmuxService = TmuxService.getInstance()

    try {
      setIsCreatingPane(true)
      setStatusMessage(
        selectedPane.hidden
          ? `Showing ${getPaneDisplayName(selectedPane)}...`
          : `Hiding ${getPaneDisplayName(selectedPane)}...`
      )

      if (selectedPane.hidden) {
        const targetPaneId = await getPaneShowTarget(selectedPane.paneId)
        if (!targetPaneId) {
          throw new Error("No target pane is available to show this pane")
        }
        await tmuxService.joinPaneToTarget(selectedPane.paneId, targetPaneId)
      } else {
        await tmuxService.breakPaneToWindow(
          selectedPane.paneId,
          `dmux-hidden-${selectedPane.id}`
        )
      }

      await savePanes(
        panes.map((pane) =>
          pane.id === selectedPane.id
            ? { ...pane, hidden: !selectedPane.hidden }
            : pane
        )
      )
      await refreshPaneLayout()
      await loadPanes()

      setStatusMessage(
        selectedPane.hidden
          ? `Showing ${getPaneDisplayName(selectedPane)}`
          : `Hid ${getPaneDisplayName(selectedPane)}`
      )
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to toggle pane visibility: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const toggleOtherPanesVisibility = async (selectedPane: DmuxPane) => {
    const action = getBulkVisibilityAction(panes, selectedPane)
    if (!action) {
      setStatusMessage("No other panes to toggle")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const targetPanes = panes.filter((pane) =>
      pane.id !== selectedPane.id
        && (action === "hide-others" ? !pane.hidden : pane.hidden)
    )

    if (targetPanes.length === 0) {
      setStatusMessage("No other panes to toggle")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const tmuxService = TmuxService.getInstance()
    const hidden = action === "hide-others"

    try {
      setIsCreatingPane(true)
      setStatusMessage(hidden ? "Hiding other panes..." : "Showing other panes...")

      for (const pane of targetPanes) {
        if (hidden) {
          await tmuxService.breakPaneToWindow(
            pane.paneId,
            `dmux-hidden-${pane.id}`
          )
          continue
        }

        const targetPaneId = await getPaneShowTarget(pane.paneId)
        if (!targetPaneId) {
          throw new Error("No target pane is available to show hidden panes")
        }
        await tmuxService.joinPaneToTarget(pane.paneId, targetPaneId)
      }

      const targetPaneIds = new Set(targetPanes.map((pane) => pane.id))
      await savePanes(
        panes.map((pane) =>
          targetPaneIds.has(pane.id) ? { ...pane, hidden } : pane
        )
      )
      await refreshPaneLayout()
      await loadPanes()

      setStatusMessage(
        hidden
          ? `Hid ${targetPanes.length} other pane${targetPanes.length === 1 ? "" : "s"}`
          : `Showed ${targetPanes.length} other pane${targetPanes.length === 1 ? "" : "s"}`
      )
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to toggle other panes: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const toggleProjectPanesVisibility = async (
    targetProjectRoot: string = getActiveProjectRoot()
  ) => {
    const action = getProjectVisibilityAction(panes, targetProjectRoot, projectRoot)

    if (!action) {
      setStatusMessage("No project panes to toggle")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const { projectPanes, otherPanes } = partitionPanesByProject(
      panes,
      targetProjectRoot,
      projectRoot
    )

    if (projectPanes.length === 0) {
      setStatusMessage("No project panes to toggle")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const projectName = getPaneProjectName(
      projectPanes[0],
      projectRoot
    )
    const panesToShow = action === "focus-project"
      ? projectPanes.filter((pane) => pane.hidden)
      : panes.filter((pane) => pane.hidden)
    const panesToHide = action === "focus-project"
      ? otherPanes.filter((pane) => !pane.hidden)
      : []

    try {
      setIsCreatingPane(true)
      setStatusMessage(
        action === "focus-project"
          ? `Showing ${projectName} panes...`
          : "Showing all panes..."
      )

      // Show target project panes before hiding others so we always have
      // an attached pane available for tmux join targets.
      for (const pane of panesToShow) {
        const targetPaneId = await getPaneShowTarget(pane.paneId)
        if (!targetPaneId) {
          throw new Error("No target pane is available to show hidden panes")
        }
        await TmuxService.getInstance().joinPaneToTarget(pane.paneId, targetPaneId)
      }

      for (const pane of panesToHide) {
        await TmuxService.getInstance().breakPaneToWindow(
          pane.paneId,
          `dmux-hidden-${pane.id}`
        )
      }

      const shownPaneIds = new Set(panesToShow.map((pane) => pane.id))
      const hiddenPaneIds = new Set(panesToHide.map((pane) => pane.id))

      await savePanes(
        panes.map((pane) => {
          if (shownPaneIds.has(pane.id)) {
            return { ...pane, hidden: false }
          }
          if (hiddenPaneIds.has(pane.id)) {
            return { ...pane, hidden: true }
          }
          return pane
        })
      )
      await refreshPaneLayout()
      await loadPanes()

      setStatusMessage(
        action === "focus-project"
          ? panesToHide.length > 0
            ? `Showing only ${projectName} panes`
            : `Showed ${projectName} panes`
          : "Showed all panes"
      )
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to toggle project panes: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const openPaneMenu = async (
    pane: DmuxPane,
    options: { anchorToPane?: boolean } = {}
  ) => {
    const actionId = await popupManager.launchKebabMenuPopup(
      pane,
      panes,
      options
    )
    if (!actionId) {
      return
    }

    if (actionId === TOGGLE_PANE_VISIBILITY_ACTION) {
      await togglePaneVisibility(pane)
      return
    }

    if (actionId === "hide-others" || actionId === "show-others") {
      await toggleOtherPanesVisibility(pane)
      return
    }

    if (actionId === "focus-project" || actionId === "show-all") {
      await toggleProjectPanesVisibility(getPaneProjectRoot(pane, projectRoot))
      return
    }

    if (actionId === PaneAction.SET_SOURCE) {
      await setDevSourceFromPane(pane)
      return
    }

    if (actionId === PaneAction.ATTACH_AGENT) {
      await attachAgentsToPane(pane)
      return
    }

    if (actionId === PaneAction.CREATE_CHILD_WORKTREE) {
      await handleCreateChildWorktree(pane)
      return
    }

    if (actionId === PaneAction.OPEN_TERMINAL_IN_WORKTREE) {
      await openTerminalInWorktree(pane)
      return
    }

    if (actionId === PaneAction.OPEN_FILE_BROWSER) {
      await openFileBrowserInWorktree(pane)
      return
    }

    if (!isPaneAction(actionId)) {
      setStatusMessage(`Unknown menu action: ${actionId}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      return
    }

    await actionSystem.executeAction(actionId, pane, {
      mainBranch: getMainBranch(),
    })
  }

  const attachAgentsToPane = async (selectedPane: DmuxPane) => {
    if (!selectedPane.worktreePath) {
      setStatusMessage("Cannot attach agent: this pane has no worktree")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const targetProjectRoot = getPaneProjectRoot(selectedPane, projectRoot)

    // Warn if agent is actively working
    if (selectedPane.agentStatus === "working") {
      const confirmed = await popupManager.launchConfirmPopup(
        "Agent Active",
        `Agent in "${getPaneDisplayName(selectedPane)}" is currently working. Attach another agent anyway?`,
        "Attach",
        "Cancel",
        targetProjectRoot
      )
      if (!confirmed) return
    }

    let selectedAgents: AgentName[] = []
    const targetAvailableAgents = getAvailableAgentsForProject(targetProjectRoot)
    if (targetAvailableAgents.length === 0) {
      setStatusMessage("No agents available")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    } else if (targetAvailableAgents.length === 1) {
      selectedAgents = [targetAvailableAgents[0]]
    } else {
      const agents = await popupManager.launchAgentChoicePopup(targetProjectRoot)
      if (agents === null) {
        return
      }
      if (agents.length === 0) {
        setStatusMessage("Select at least one agent")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        return
      }
      selectedAgents = agents
    }

    // Prompt input
    const promptValue = await popupManager.launchNewPanePopup(targetProjectRoot)
    if (!promptValue) return

    try {
      setIsCreatingPane(true)
      setStatusMessage(
        selectedAgents.length > 1
          ? `Attaching ${selectedAgents.length} agents...`
          : "Attaching agent..."
      )

      const { attachAgentToWorktree } = await import("../utils/attachAgent.js")
      const createdPanes: DmuxPane[] = []
      const failedAgents: AgentName[] = []

      for (const agent of selectedAgents) {
        try {
          const result = await attachAgentToWorktree({
            targetPane: selectedPane,
            prompt: promptValue,
            agent,
            existingPanes: [...panes, ...createdPanes],
            sessionProjectRoot: projectRoot,
            sessionConfigPath: panesFile,
          })
          createdPanes.push(result.pane)
        } catch {
          failedAgents.push(agent)
        }
      }

      if (createdPanes.length > 0) {
        const updatedPanes = [...panes, ...createdPanes]
        await savePanes(updatedPanes)
        await loadPanes()
      }

      if (failedAgents.length === 0) {
        setStatusMessage(
          `Attached ${createdPanes.length} agent${createdPanes.length === 1 ? "" : "s"} to ${getPaneDisplayName(selectedPane)}`
        )
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      } else if (createdPanes.length === 0) {
        setStatusMessage(
          `Failed to attach agents: ${failedAgents.join(", ")}`
        )
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      } else {
        setStatusMessage(
          `Attached ${createdPanes.length}/${selectedAgents.length} agents to ${getPaneDisplayName(selectedPane)} (${failedAgents.length} failed)`
        )
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
    } catch (error: any) {
      setStatusMessage(`Failed to attach agent: ${error.message}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const isInteractionBlocked = () =>
    ignoreInput
    || isCreatingPane
    || runningCommand
    || isUpdating
    || isLoading
    || showFileCopyPrompt
    || showCommandPrompt !== null

  const reopenClosedWorktreesInProject = async (targetProjectRoot: string) => {
    const activeSlugs = panes
      .filter((pane) => sameSidebarProjectRoot(getPaneProjectRoot(pane, projectRoot), targetProjectRoot))
      .map((pane) => pane.slug)
    const popupState = {
      includeWorktrees: true,
      includeLocalBranches: true,
      includeRemoteBranches: false,
      remoteLoaded: false,
      filterQuery: "",
    }
    const resumableBranches = await trackProjectActivity(
      async () => getResumableBranches(targetProjectRoot, activeSlugs, {
        includeRemoteBranches: false,
      }),
      targetProjectRoot
    )

    const result = await popupManager.launchReopenWorktreePopup(
      resumableBranches,
      targetProjectRoot,
      popupState,
      activeSlugs
    )
    if (!result) {
      return
    }

    await handleReopenWorktree({
      branchName: result.candidate.branchName,
      slug: result.candidate.slug,
      path: result.candidate.path,
      lastModified: result.candidate.lastModified
        ? new Date(result.candidate.lastModified)
        : undefined,
      hasUncommittedChanges: result.candidate.hasUncommittedChanges,
      hasWorktree: result.candidate.hasWorktree,
      hasLocalBranch: result.candidate.hasLocalBranch,
      hasRemoteBranch: result.candidate.hasRemoteBranch,
      isRemote: result.candidate.isRemote,
    }, targetProjectRoot)
  }

  const executePaneShortcut = async (
    shortcut: RemotePaneActionShortcut,
    selectedPane: DmuxPane,
    options: { anchorMenuToPane?: boolean } = {}
  ) => {
    switch (shortcut) {
      case "a":
        await attachAgentsToPane(selectedPane)
        return
      case "b":
        await handleCreateChildWorktree(selectedPane)
        return
      case "f":
        await openFileBrowserInWorktree(selectedPane)
        return
      case "A":
        await openTerminalInWorktree(selectedPane)
        return
      case "m":
        await openPaneMenu(selectedPane, {
          anchorToPane: options.anchorMenuToPane,
        })
        return
      case "h":
        await togglePaneVisibility(selectedPane)
        return
      case "H":
        await toggleOtherPanesVisibility(selectedPane)
        return
      case "P":
        await toggleProjectPanesVisibility(getPaneProjectRoot(selectedPane, projectRoot))
        return
      case "r":
        await reopenClosedWorktreesInProject(getPaneProjectRoot(selectedPane, projectRoot))
        return
      case "S":
        if (!isDevMode) {
          setStatusMessage("Source switching is only available in DEV mode")
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
          return
        }
        await setDevSourceFromPane(selectedPane)
        return
      case "j":
        StateManager.getInstance().setDebugMessage(
          `Jumping to pane: ${getPaneDisplayName(selectedPane)}`
        )
        setTimeout(() => StateManager.getInstance().setDebugMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        await actionSystem.executeAction(PaneAction.VIEW, selectedPane)
        return
      case "x":
        StateManager.getInstance().setDebugMessage(
          `Closing pane: ${getPaneDisplayName(selectedPane)}`
        )
        setTimeout(() => StateManager.getInstance().setDebugMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        await actionSystem.executeAction(PaneAction.CLOSE, selectedPane)
        return
    }
  }

  const remoteDrainRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    const drainQueuedRemoteActions = async () => {
      const sessionName = getCurrentTmuxSessionName()
      if (!sessionName) {
        return
      }

      const queuedActions = await drainRemotePaneActions(sessionName)
      if (queuedActions.length === 0) {
        return
      }

      for (const action of queuedActions) {
        if (isInteractionBlocked()) {
          setStatusMessage(`dmux is busy; ignored remote pane action ${action.shortcut}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
          continue
        }

        const paneIndex = panes.findIndex((pane) => pane.paneId === action.targetPaneId)
        if (paneIndex === -1) {
          setStatusMessage(`Focused pane is not managed by dmux: ${action.targetPaneId}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
          continue
        }

        setSelectedIndex(paneIndex)
        await executePaneShortcut(action.shortcut, panes[paneIndex], {
          anchorMenuToPane: true,
        })
      }
    }

    const queueDrain = () => {
      remoteDrainRef.current = remoteDrainRef.current
        .then(drainQueuedRemoteActions)
        .catch((error: any) => {
          setStatusMessage(`Failed to process remote pane action: ${error?.message || String(error)}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
        })
      return remoteDrainRef.current
    }

    const handleRemoteSignal = () => {
      void queueDrain()
    }

    void queueDrain()
    process.on("dmux-external-command-signal" as any, handleRemoteSignal)

    return () => {
      process.off("dmux-external-command-signal" as any, handleRemoteSignal)
    }
  }, [
    actionSystem,
    handleCreateChildWorktree,
    handleReopenWorktree,
    ignoreInput,
    isCreatingPane,
    isDevMode,
    isLoading,
    isUpdating,
    panes,
    popupManager,
    projectRoot,
    runCommandInternal,
    runningCommand,
    setDevSourceFromPane,
    setSelectedIndex,
    setStatusMessage,
    showCommandPrompt,
    showFileCopyPrompt,
  ])

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

    if (
      selectedIndex < panes.length
      && ["a", "b", "f", "A", "m"].includes(input)
    ) {
      await executePaneShortcut(input as RemotePaneActionShortcut, panes[selectedIndex])
      return
    } else if (input === "s") {
      // Open settings popup
      const result = await popupManager.launchSettingsPopup(async () => {
        // Launch hooks popup
        await popupManager.launchHooksPopup(async () => {
          await launchHooksAuthoringSession()
        }, getActiveProjectRoot())
      }, getActiveProjectRoot())
      if (result) {
        try {
          const activeProjectRoot = getActiveProjectRoot()
          const projectSettingsManager = new SettingsManager(activeProjectRoot)
          const updates = Array.isArray((result as any).updates)
            ? (result as any).updates
            : [result]

          let savedCount = 0
          let layoutBoundsUpdated = false
          let lastScope: "global" | "project" | null = null

          for (const update of updates) {
            if (
              !update
              || typeof update.key !== "string"
              || (update.scope !== "global" && update.scope !== "project")
            ) {
              continue
            }

            projectSettingsManager.updateSetting(
              update.key as keyof import("../types.js").DmuxSettings,
              update.value,
              update.scope
            )
            refreshDmuxSettings(
              activeProjectRoot,
              update.key === "colorTheme" && typeof update.value === "string"
                ? update.value
                : undefined
            )
            savedCount += 1
            lastScope = update.scope

            if (update.key === "minPaneWidth" || update.key === "maxPaneWidth") {
              layoutBoundsUpdated = true
            }
          }

          if (layoutBoundsUpdated) {
            queueLayoutRefresh()
          }

          if (savedCount > 0) {
            const statusMessage =
              savedCount === 1
                ? `Setting saved (${lastScope})`
                : `${savedCount} settings saved`
            setStatusMessage(statusMessage)
            setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
          }
        } catch (error: any) {
          setStatusMessage(`Failed to save setting: ${error?.message || String(error)}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
        }
      }
    } else if (input === "l") {
      // Open logs popup
      await popupManager.launchLogsPopup(getActiveProjectRoot())
    } else if (input === "h") {
      if (selectedIndex < panes.length) {
        await executePaneShortcut("h", panes[selectedIndex])
      } else {
        setStatusMessage("Select a pane to toggle visibility")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      }
    } else if (input === "H") {
      if (selectedIndex < panes.length) {
        await executePaneShortcut("H", panes[selectedIndex])
      } else {
        setStatusMessage("Select a pane to toggle the others")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      }
    } else if (input === "P") {
      if (selectedIndex < panes.length) {
        await executePaneShortcut("P", panes[selectedIndex])
      } else {
        await toggleProjectPanesVisibility()
      }
    } else if (input === "?") {
      // Open keyboard shortcuts popup
      const shortcutsAction = await popupManager.launchShortcutsPopup(
        !!controlPaneId,
        getActiveProjectRoot()
      )
      if (shortcutsAction === "hooks") {
        await launchHooksAuthoringSession()
      }
    } else if (input === "L" && controlPaneId) {
      // Reset layout to sidebar configuration (Shift+L)
      try {
        await enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH, { forceLayout: true })
        setStatusMessage("Layout reset")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      } catch (error: any) {
        setStatusMessage(`Failed to reset layout: ${error?.message || String(error)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
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
    } else if (isDevMode && input === "S" && selectedIndex < panes.length) {
      await executePaneShortcut("S", panes[selectedIndex])
      return
    } else if (input === "r") {
      await reopenClosedWorktreesInProject(getActiveProjectRoot())
      return
    } else if (
      !isLoading &&
      (
        input === "p" ||
        input === "N"
      )
    ) {
      // Add a project to the sidebar ([p], with Shift+N fallback)
      await handleAddProjectToSidebar()
      return
    } else if (!isLoading && input === "R") {
      await handleRemoveProjectFromSidebar(getActiveProjectRoot())
      return
    } else if (!isLoading && input === "n") {
      await handleCreateAgentPane(getActiveProjectRoot())
      return
    } else if (!isLoading && input === "t") {
      await handleCreateTerminalPane(getActiveProjectRoot())
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
      } else if (selectedAction.kind === "remove-project") {
        await handleRemoveProjectFromSidebar(selectedAction.projectRoot)
      }
      return
    } else if (
      selectedIndex < panes.length
      && (input === "j" || input === "x")
    ) {
      await executePaneShortcut(input as RemotePaneActionShortcut, panes[selectedIndex])
      return
    } else if (key.return && selectedIndex < panes.length) {
      // Open pane menu for selected pane
      await openPaneMenu(panes[selectedIndex])
      return
    }
  })
}
