import React, { useState, useEffect, useMemo, useRef } from "react"
import { Box, Text, useApp, useStdout, useInput } from "ink"
import stringWidth from "string-width"
import { TmuxService } from "./services/TmuxService.js"

// Hooks
import usePanes from "./hooks/usePanes.js"
import useProjectSettings from "./hooks/useProjectSettings.js"
import useTerminalWidth from "./hooks/useTerminalWidth.js"
import useNavigation from "./hooks/useNavigation.js"
import useAutoUpdater from "./hooks/useAutoUpdater.js"
import useAgentStatus from "./hooks/useAgentStatus.js"
import usePaneRunner from "./hooks/usePaneRunner.js"
import usePaneCreation from "./hooks/usePaneCreation.js"
import useActionSystem from "./hooks/useActionSystem.js"
import { useStatusMessages } from "./hooks/useStatusMessages.js"
import { useLayoutManagement } from "./hooks/useLayoutManagement.js"
import { useInputHandling } from "./hooks/useInputHandling.js"
import { useDialogState } from "./hooks/useDialogState.js"
import { useDebugInfo } from "./hooks/useDebugInfo.js"
import { useProjectActivity } from "./hooks/useProjectActivity.js"

// Utils
import { SIDEBAR_WIDTH } from "./utils/layoutManager.js"
import { supportsPopups } from "./utils/popup.js"
import { StateManager } from "./shared/StateManager.js"
import {
  STATUS_MESSAGE_DURATION_SHORT,
} from "./constants/timing.js"
import {
  getStatusDetector,
  type StatusUpdateEvent,
} from "./services/StatusDetector.js"
import {
  type ActionResult,
} from "./actions/index.js"
import { SettingsManager } from "./utils/settingsManager.js"
import { useServices } from "./hooks/useServices.js"
import { PaneLifecycleManager } from "./services/PaneLifecycleManager.js"
import { DmuxFocusService } from "./services/DmuxFocusService.js"
import {
  DmuxAttentionService,
  type PaneAttentionChangedEvent,
} from "./services/DmuxAttentionService.js"
import { reopenWorktree } from "./utils/reopenWorktree.js"
import {
  resumeBranchWorkspace,
  type ResumableBranchCandidate,
} from "./utils/resumeBranches.js"
import { fileURLToPath } from "url"
import { dirname, resolve as resolvePath } from "path"
import {
  resolveEnabledAgentsSelection,
  type AgentName,
} from "./utils/agentLaunch.js"
import { resolveNextDevSourcePath } from "./utils/devSource.js"
import { buildDevWatchRespawnCommand } from "./utils/devWatchCommand.js"
import { getPaneBranchName } from "./utils/git.js"
import { getGitStatus } from "./utils/mergeValidation.js"
import { createMergeTargetChain } from "./utils/mergeTargets.js"
import { claimProcessShutdown } from "./utils/processShutdown.js"
import { getPaneDisplayName } from "./utils/paneTitle.js"
import {
  FOOTER_TIP_ROTATION_INTERVAL,
  getFooterTips,
  getNextFooterTipIndex,
  getRandomFooterTipIndex,
} from "./utils/footerTips.js"
import { setLocale, t, type Locale } from "./i18n/index.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ACTIVE_PANE_SYNC_INTERVAL_MS = 125
import type {
  DmuxPane,
  DmuxAppProps,
  NewPaneInput,
  DmuxThemeName,
  MergeTargetReference,
} from "./types.js"
import PanesGrid from "./components/panes/PanesGrid.js"
import CommandPromptDialog from "./components/dialogs/CommandPromptDialog.js"
import FileCopyPrompt from "./components/ui/FileCopyPrompt.js"
import FooterHelp from "./components/ui/FooterHelp.js"
import TmuxHooksPromptDialog from "./components/dialogs/TmuxHooksPromptDialog.js"
import { PaneEventService } from "./services/PaneEventService.js"
import {
  buildProjectActionLayout,
  buildVisualNavigationRows,
  buildGroupStartRows,
  getProjectActionByIndex,
  resolveSelectionAfterPaneClose,
} from "./utils/projectActions.js"
import { getPaneProjectRoot } from "./utils/paneProject.js"
import {
  applyDmuxTheme,
  getDmuxThemePalette,
} from "./theme/colors.js"
import {
  applyTmuxThemeToSession,
  refreshWelcomePaneTheme,
} from "./utils/welcomePane.js"
import { syncWelcomePaneVisibility } from "./utils/welcomePaneManager.js"
import {
  getPaneColorTheme,
  resolveProjectColorTheme,
} from "./utils/paneColors.js"
import {
  getPaneTitlePrefixValue,
  paneNeedsAnimatedTitlePrefix,
  PANE_TITLE_BUSY_FRAMES,
} from "./utils/paneTitlePrefix.js"
import { getPaneTmuxDisplayTitle } from "./utils/paneTitle.js"

const DmuxApp: React.FC<DmuxAppProps> = ({
  panesFile,
  projectName,
  sessionName,
  settingsFile,
  projectRoot,
  autoUpdater,
  controlPaneId,
}) => {
  const { stdout } = useStdout()
  const terminalHeight = stdout?.rows || 40
  const isDevMode = process.env.DMUX_DEV === "true"
  const sessionProjectRoot = projectRoot || process.cwd()

  /* panes state moved to usePanes */
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const { statusMessage, setStatusMessage } = useStatusMessages()
  const [isCreatingPane, setIsCreatingPane] = useState(false)
  const {
    trackProjectActivity,
    isProjectBusy: isTrackedProjectBusy,
  } = useProjectActivity(sessionProjectRoot)

  // Settings state
  const [settingsManager] = useState(() => new SettingsManager(projectRoot))
  const { projectSettings, saveSettings } = useProjectSettings(settingsFile)
  const [themeRefreshNonce, setThemeRefreshNonce] = useState(0)
  const [settings, setSettings] = useState(() => new SettingsManager(sessionProjectRoot).getSettings())
  const paneTitlePrefixCacheRef = useRef(new Map<string, string>())
  const paneTitleLabelCacheRef = useRef(new Map<string, string>())
  const paneActiveBorderStyleCacheRef = useRef(new Map<string, string>())
  const paneTitleSpinnerFrameRef = useRef(0)

  // Apply i18n language reactively when the locale setting changes.
  useEffect(() => {
    const language = settings.language || 'en'
    setLocale(language as Locale)
  }, [settings.language])

  // Dialog state management
  const dialogState = useDialogState()
  const {
    showCommandPrompt,
    setShowCommandPrompt,
    commandInput,
    setCommandInput,
    showFileCopyPrompt,
    setShowFileCopyPrompt,
    currentCommandType,
    setCurrentCommandType,
    runningCommand,
    setRunningCommand,
    quitConfirmMode,
    setQuitConfirmMode,
  } = dialogState

  // Debug/development info
  const { debugMessage, setDebugMessage, currentBranch } = useDebugInfo(__dirname)
  // Update state handled by hook
  const {
    updateInfo,
    isUpdating,
    updateAvailable,
  } = useAutoUpdater(autoUpdater, setStatusMessage)
  const { exit } = useApp()

  // Flag to ignore input temporarily after popup closes (prevents buffered keys)
  const [ignoreInput, setIgnoreInput] = useState(false)

  // Agent selection is settings-driven.
  // Installation checks are performed lazily in the Enabled Agents settings popup.
  const availableAgents = resolveEnabledAgentsSelection(
    settings.enabledAgents
  )
  const getAvailableAgentsForProject = (targetProjectRoot: string = selectedProjectRoot) =>
    resolveEnabledAgentsSelection(new SettingsManager(targetProjectRoot).getSettings().enabledAgents)
  const footerTips = useMemo(() => getFooterTips(isDevMode), [isDevMode])
  const showFooterTips = settings.showFooterTips !== false && footerTips.length > 0
  const [footerTipIndex, setFooterTipIndex] = useState(() => getRandomFooterTipIndex(footerTips.length))
  const currentFooterTip = showFooterTips && footerTipIndex >= 0
    ? footerTips[footerTipIndex]
    : undefined

  // Popup support detection
  const [popupsSupported, setPopupsSupported] = useState(false)

  // Track terminal dimensions for responsive layout
  const terminalWidth = useTerminalWidth()

  // Track unread error and warning counts for logs badge
  const [unreadErrorCount, setUnreadErrorCount] = useState(0)
  const [unreadWarningCount, setUnreadWarningCount] = useState(0)

  // Track toast state
  const [currentToast, setCurrentToast] = useState<any>(null)
  const [toastQueueLength, setToastQueueLength] = useState(0)
  const [toastQueuePosition, setToastQueuePosition] = useState<number | null>(null)

  // Tmux hooks prompt state
  const [showHooksPrompt, setShowHooksPrompt] = useState(false)
  const [hooksPromptIndex, setHooksPromptIndex] = useState(0)
  // undefined = not yet determined, true = use hooks, false = use polling
  const [useHooks, setUseHooks] = useState<boolean | undefined>(undefined)
  const [focusService] = useState(() => new DmuxFocusService({ projectName, projectRoot }))
  const [attentionService] = useState(
    () => new DmuxAttentionService({ focusService })
  )

  useEffect(() => {
    if (!showFooterTips || footerTips.length <= 1) {
      return
    }

    const timer = setInterval(() => {
      setFooterTipIndex((currentIndex) => getNextFooterTipIndex(currentIndex, footerTips.length))
    }, FOOTER_TIP_ROTATION_INTERVAL)

    return () => {
      clearInterval(timer)
    }
  }, [showFooterTips, footerTips.length])

  // Subscribe to StateManager for unread error/warning count and toast updates
  useEffect(() => {
    const stateManager = StateManager.getInstance()

    const updateState = () => {
      const state = stateManager.getState()
      setUnreadErrorCount((prev) => prev === state.unreadErrorCount ? prev : state.unreadErrorCount)
      setUnreadWarningCount((prev) => prev === state.unreadWarningCount ? prev : state.unreadWarningCount)
      setCurrentToast((prev: any) => prev === state.currentToast ? prev : state.currentToast)
      setToastQueueLength((prev) => prev === state.toastQueueLength ? prev : state.toastQueueLength)
      setToastQueuePosition((prev) => prev === state.toastQueuePosition ? prev : state.toastQueuePosition)
    }

    // Initial state
    updateState()

    // Subscribe to changes
    const unsubscribe = stateManager.subscribe(updateState)

    return () => {
      unsubscribe()
    }
  }, [])

  // Panes state and persistence (skipLoading will be updated after actionSystem is initialized)
  const {
    panes,
    setPanes,
    sidebarProjects,
    isLoading,
    loadPanes,
    savePanes,
    saveSidebarProjects,
    eventMode,
  } = usePanes(
    panesFile,
    false,
    sessionName,
    controlPaneId,
    useHooks
  )

  // Check for tmux hooks preference on startup
  useEffect(() => {
    const checkHooksPreference = async () => {
      // Check if user already has a preference
      const settings = new SettingsManager(sessionProjectRoot).getSettings()

      if (settings.useTmuxHooks !== undefined) {
        // User has already decided
        setUseHooks(settings.useTmuxHooks)
        return
      }

      // Check if hooks are already installed (from previous session)
      const paneEventService = PaneEventService.getInstance()
      paneEventService.initialize({ sessionName, controlPaneId })

      const hooksInstalled = await paneEventService.canUseHooks()

      if (hooksInstalled) {
        // Hooks already installed, use them automatically
        setUseHooks(true)
        // Save the preference
        settingsManager.updateSetting('useTmuxHooks', true, 'global')
        refreshDmuxSettings()
      } else {
        // Need to ask user - show prompt
        setShowHooksPrompt(true)
      }
    }

    checkHooksPreference()
  }, [sessionName, controlPaneId, settingsManager])

  useEffect(() => {
    void focusService.start()
    attentionService.start()

    return () => {
      attentionService.stop()
      focusService.stop()
    }
  }, [attentionService, focusService])

  useEffect(() => {
    const handleAttentionChanged = (event: PaneAttentionChangedEvent) => {
      setPanes((prevPanes) => {
        const paneIndex = prevPanes.findIndex((pane) => pane.id === event.paneId)
        if (paneIndex === -1) return prevPanes

        const pane = prevPanes[paneIndex]
        if (pane.needsAttention === event.needsAttention) {
          return prevPanes
        }

        const updatedPane: DmuxPane = {
          ...pane,
          needsAttention: event.needsAttention,
        }

        const nextPanes = [...prevPanes]
        nextPanes[paneIndex] = updatedPane
        return nextPanes
      })
    }

    attentionService.on('attention-changed', handleAttentionChanged)
    return () => {
      attentionService.off('attention-changed', handleAttentionChanged)
    }
  }, [attentionService, setPanes])

  // Pane lifecycle manager - handles locking to prevent race conditions
  // Replaces the old timeout-based intentionallyClosedPanes Set
  const lifecycleManager = React.useMemo(() => PaneLifecycleManager.getInstance(), [])

  // Clean up stale lifecycle operations periodically
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      lifecycleManager.cleanupStaleOperations()
    }, 60000) // Every 60 seconds

    return () => clearInterval(cleanupInterval)
  }, [lifecycleManager])

  // Pane runner
  const {
    copyNonGitFiles,
    runCommandInternal,
  } = usePaneRunner({
    panes,
    savePanes,
    projectSettings,
    setStatusMessage,
    setRunningCommand,
  })

  // Spinner animation and branch detection now handled in hooks

  // Pane creation
  const {
    createNewPane: createNewPaneHook,
    createPanesForAgents: createPanesForAgentsHook,
  } = usePaneCreation({
    panes,
    savePanes,
    projectName,
    sessionProjectRoot: projectRoot || process.cwd(),
    panesFile,
    setIsCreatingPane,
    setStatusMessage,
    loadPanes,
    availableAgents,
  })

  // Initialize services
  const { popupManager } = useServices({
    // PopupManager config
    sidebarWidth: SIDEBAR_WIDTH,
    projectRoot: projectRoot || process.cwd(),
    popupsSupported,
    isDevMode,
    terminalWidth,
    terminalHeight,
    controlPaneId,
    availableAgents,
    settingsManager,
    projectSettings,

    // Callbacks
    setStatusMessage,
    setIgnoreInput,
    trackProjectActivity,
  })

  // Listen for status updates with analysis data and merge into panes
  useEffect(() => {
    const statusDetector = getStatusDetector()

    const handleStatusUpdate = (event: StatusUpdateEvent) => {
      setPanes((prevPanes) => {
        const paneIndex = prevPanes.findIndex((pane) => pane.id === event.paneId)
        if (paneIndex === -1) return prevPanes

        const pane = prevPanes[paneIndex]
        const updated: DmuxPane = {
          ...pane,
          agentStatus: event.status,
        }

        // Only update analysis fields if they're present in the event (not undefined)
        // This prevents simple status changes from overwriting PaneAnalyzer results
        if (event.optionsQuestion !== undefined) {
          updated.optionsQuestion = event.optionsQuestion
        }
        if (event.options !== undefined) {
          updated.options = event.options
        }
        if (event.potentialHarm !== undefined) {
          updated.potentialHarm = event.potentialHarm
        }
        if (event.summary !== undefined) {
          updated.agentSummary = event.summary
        }
        if (event.analyzerError !== undefined) {
          updated.analyzerError = event.analyzerError
        }

        // Clear option dialog data when transitioning away from 'waiting' state
        if (event.status !== "waiting" && pane.agentStatus === "waiting") {
          updated.optionsQuestion = undefined
          updated.options = undefined
          updated.potentialHarm = undefined
        }

        // Clear summary when transitioning away from 'idle' state
        if (event.status !== "idle" && pane.agentStatus === "idle") {
          updated.agentSummary = undefined
        }

        // Clear analyzer error when successfully getting a new analysis
        // or when transitioning to 'working' status
        if (event.status === "working") {
          updated.analyzerError = undefined
        } else if (event.status === "waiting" || event.status === "idle") {
          if (
            event.analyzerError === undefined &&
            (event.optionsQuestion || event.summary)
          ) {
            updated.analyzerError = undefined
          }
        }

        const unchanged =
          pane.agentStatus === updated.agentStatus &&
          pane.optionsQuestion === updated.optionsQuestion &&
          pane.options === updated.options &&
          pane.potentialHarm === updated.potentialHarm &&
          pane.agentSummary === updated.agentSummary &&
          pane.analyzerError === updated.analyzerError

        if (unchanged) {
          return prevPanes
        }

        const next = prevPanes.slice()
        next[paneIndex] = updated
        return next
      })
    }

    statusDetector.on("status-updated", handleStatusUpdate)

    return () => {
      statusDetector.off("status-updated", handleStatusUpdate)
    }
  }, [setPanes])

  // Note: No need to sync panes with StateManager here.
  // The ConfigWatcher automatically updates StateManager when the config file changes.
  // This prevents unnecessary SSE broadcasts on every local state update.

  // Sync settings with StateManager
  useEffect(() => {
    const stateManager = StateManager.getInstance()
    stateManager.updateSettings(projectSettings)
  }, [projectSettings])

  // Expose debug message setter via StateManager
  useEffect(() => {
    const stateManager = StateManager.getInstance()
    stateManager.setDebugMessageCallback(setDebugMessage)
    return () => {
      stateManager.setDebugMessageCallback(undefined)
    }
  }, [])

  // Load panes and settings on mount and refresh periodically
  useEffect(() => {
    // Check if tmux supports popups (3.2+) and enable mouse mode for click-outside-to-close
    const popupSupport = supportsPopups()
    setPopupsSupported(popupSupport)
    if (popupSupport) {
      // Enable mouse mode only for this dmux session (not global)
    }
  }, [])

  // Update checking moved to useAutoUpdater

  // Welcome pane is now fully event-based:
  // - Created at startup (in src/index.ts)
  // - Destroyed when first pane is created (in paneCreation.ts)
  // - Recreated when last pane is closed (in paneActions.ts)
  // No polling needed!

  // loadPanes moved to usePanes

  // getPanePositions moved to utils/tmux

  const activeDevSourcePath = isDevMode ? process.cwd() : undefined
  const projectActionLayout = useMemo(
    () => buildProjectActionLayout(
      panes,
      sidebarProjects,
      sessionProjectRoot,
      projectName
    ),
    [panes, sidebarProjects, sessionProjectRoot, projectName]
  )
  const selectedPane = useMemo(() => {
    for (const group of projectActionLayout.groups) {
      const entry = group.panes.find((candidate) => candidate.index === selectedIndex)
      if (entry) {
        return entry.pane
      }
    }

    return undefined
  }, [projectActionLayout.groups, selectedIndex])
  const selectedProjectRoot = useMemo(() => {
    if (selectedPane) {
      return getPaneProjectRoot(selectedPane, sessionProjectRoot)
    }

    return (
      getProjectActionByIndex(projectActionLayout.actionItems, selectedIndex)?.projectRoot
      || sessionProjectRoot
    )
  }, [selectedPane, selectedIndex, projectActionLayout.actionItems, sessionProjectRoot])
  const focusedPane = useMemo(
    () => focusedPaneId
      ? panes.find((pane) => pane.paneId === focusedPaneId)
      : undefined,
    [focusedPaneId, panes]
  )
  const activeProjectRoot = selectedProjectRoot
  const resolveProjectThemeName = React.useCallback((activeProjectRoot: string) => {
    return resolveProjectColorTheme(activeProjectRoot, sidebarProjects)
  }, [sidebarProjects])
  const activeBorderPane = focusedPane || selectedPane
  const activeBorderPaneId = activeBorderPane?.paneId
  const selectedThemeName = useMemo(
    () => resolveProjectThemeName(activeProjectRoot),
    [
      resolveProjectThemeName,
      activeProjectRoot,
      themeRefreshNonce,
    ]
  )
  const visiblePaneCount = useMemo(
    () => panes.filter((pane) => !pane.hidden).length,
    [panes]
  )
  const controlPaneActiveBorderStyle = useMemo(
    () => `fg=colour${getDmuxThemePalette(selectedThemeName).activeBorder}`,
    [selectedThemeName]
  )
  const projectThemeByRoot = useMemo(() => {
    const themeMap = new Map<string, DmuxThemeName>()

    for (const group of projectActionLayout.groups) {
      const paneTheme = group.panes.find((entry) => entry.pane.colorTheme)?.pane.colorTheme
      themeMap.set(
        group.projectRoot,
        paneTheme || resolveProjectThemeName(group.projectRoot)
      )
    }

    return themeMap
  }, [projectActionLayout.groups, resolveProjectThemeName, themeRefreshNonce])
  applyDmuxTheme(selectedThemeName)

  const refreshDmuxSettings = (_activeProjectRoot: string = selectedProjectRoot) => {
    setSettings(new SettingsManager(sessionProjectRoot).getSettings())
    setThemeRefreshNonce((current) => current + 1)
  }
  const navigationRows = useMemo(
    () => isLoading
      ? projectActionLayout.groups.flatMap((group) =>
          group.panes.map((entry) => [entry.index])
        )
      : buildVisualNavigationRows(projectActionLayout),
    [isLoading, projectActionLayout]
  )
  const groupStartRows = useMemo(
    () => isLoading ? [] : buildGroupStartRows(projectActionLayout),
    [isLoading, projectActionLayout]
  )

  useEffect(() => {
    try {
      applyTmuxThemeToSession(sessionName, activeProjectRoot, selectedThemeName)
    } catch {
      // Theme updates are best-effort at runtime.
    }

    void refreshWelcomePaneTheme(panesFile, activeProjectRoot, selectedThemeName)
  }, [panesFile, activeProjectRoot, selectedThemeName, sessionName])

  useEffect(() => {
    if (isLoading) {
      return
    }

    void syncWelcomePaneVisibility(
      sessionProjectRoot,
      controlPaneId,
      visiblePaneCount === 0,
      selectedThemeName
    )
  }, [
    controlPaneId,
    isLoading,
    selectedThemeName,
    sessionProjectRoot,
    visiblePaneCount,
  ])

  useEffect(() => {
    if (!process.env.TMUX) {
      return
    }

    const tmuxService = TmuxService.getInstance()
    const syncPaneTitlePrefixes = () => {
      const cachedPrefixes = paneTitlePrefixCacheRef.current
      const cachedLabels = paneTitleLabelCacheRef.current
      const cachedActiveBorderStyles = paneActiveBorderStyleCacheRef.current
      const activePaneIds = new Set(panes.map((pane) => pane.paneId))
      const activeBorderStylePaneIds = new Set(activePaneIds)
      if (controlPaneId) {
        activeBorderStylePaneIds.add(controlPaneId)
      }

      for (const paneId of Array.from(cachedPrefixes.keys())) {
        if (!activePaneIds.has(paneId)) {
          tmuxService.unsetPaneOptionSync(paneId, '@dmux_title_prefix')
          cachedPrefixes.delete(paneId)
        }
      }
      for (const paneId of Array.from(cachedLabels.keys())) {
        if (!activePaneIds.has(paneId)) {
          tmuxService.unsetPaneOptionSync(paneId, '@dmux_title_label')
          cachedLabels.delete(paneId)
        }
      }
      for (const paneId of Array.from(cachedActiveBorderStyles.keys())) {
        if (!activeBorderStylePaneIds.has(paneId)) {
          tmuxService.unsetPaneOptionSync(paneId, '@dmux_active_border_style')
          cachedActiveBorderStyles.delete(paneId)
        }
      }

      for (const pane of panes) {
        const paneThemeName = getPaneColorTheme(
          pane,
          sidebarProjects,
          sessionProjectRoot
        )
        const prefixValue = getPaneTitlePrefixValue(
          pane,
          sidebarProjects,
          sessionProjectRoot,
          paneTitleSpinnerFrameRef.current
        )
        const labelValue = getPaneTmuxDisplayTitle(
          pane,
          sessionProjectRoot,
          projectName
        )
        const activeBorderStyle = `fg=colour${getDmuxThemePalette(paneThemeName).activeBorder}`

        if (cachedPrefixes.get(pane.paneId) !== prefixValue) {
          tmuxService.setPaneOptionSync(pane.paneId, '@dmux_title_prefix', prefixValue)
          cachedPrefixes.set(pane.paneId, prefixValue)
        }

        if (cachedLabels.get(pane.paneId) !== labelValue) {
          tmuxService.setPaneOptionSync(pane.paneId, '@dmux_title_label', labelValue)
          cachedLabels.set(pane.paneId, labelValue)
        }

        if (cachedActiveBorderStyles.get(pane.paneId) !== activeBorderStyle) {
          tmuxService.setPaneOptionSync(
            pane.paneId,
            '@dmux_active_border_style',
            activeBorderStyle
          )
          cachedActiveBorderStyles.set(pane.paneId, activeBorderStyle)
        }

        if (pane.paneId === activeBorderPaneId) {
          tmuxService.setSessionOptionSync(
            sessionName,
            'pane-active-border-style',
            activeBorderStyle
          )
        }
      }

      if (controlPaneId && cachedActiveBorderStyles.get(controlPaneId) !== controlPaneActiveBorderStyle) {
        tmuxService.setPaneOptionSync(
          controlPaneId,
          '@dmux_active_border_style',
          controlPaneActiveBorderStyle
        )
        cachedActiveBorderStyles.set(controlPaneId, controlPaneActiveBorderStyle)
      }

      if (!focusedPane) {
        tmuxService.setSessionOptionSync(
          sessionName,
          'pane-active-border-style',
          controlPaneActiveBorderStyle
        )
      }
    }

    const hasAnimatedPrefix = panes.some(paneNeedsAnimatedTitlePrefix)
    if (!hasAnimatedPrefix) {
      paneTitleSpinnerFrameRef.current = 0
    }

    syncPaneTitlePrefixes()

    if (!hasAnimatedPrefix) {
      return
    }

    const interval = setInterval(() => {
      paneTitleSpinnerFrameRef.current = (
        paneTitleSpinnerFrameRef.current + 1
      ) % PANE_TITLE_BUSY_FRAMES.length
      syncPaneTitlePrefixes()
    }, 90)

    return () => {
      clearInterval(interval)
    }
  }, [
    panes,
    sidebarProjects,
    sessionProjectRoot,
    projectName,
    activeBorderPaneId,
    sessionName,
    controlPaneId,
    controlPaneActiveBorderStyle,
    focusedPane,
  ])

  useEffect(() => {
    const maxIndex = Math.max(0, projectActionLayout.totalItems - 1)
    if (selectedIndex > maxIndex) {
      setSelectedIndex(maxIndex)
    }
  }, [projectActionLayout.totalItems, selectedIndex, setSelectedIndex])

  // Navigation logic moved to hook
  const { getCardGridPosition, findCardInDirection } = useNavigation(navigationRows, groupStartRows)

  // findCardInDirection provided by useNavigation

  const syncSelectedIndexToFocusedPane = React.useCallback(async (activePaneId?: string | null) => {
    try {
      const focusedPaneId = activePaneId ?? await TmuxService.getInstance().getActivePaneId()
      if (!focusedPaneId || focusedPaneId === controlPaneId) {
        setFocusedPaneId(null)
        return
      }

      setFocusedPaneId((currentPaneId) =>
        currentPaneId === focusedPaneId ? currentPaneId : focusedPaneId
      )

      const focusedIndex = panes.findIndex((pane) => pane.paneId === focusedPaneId)
      if (focusedIndex === -1) {
        return
      }

      setSelectedIndex((currentIndex) =>
        currentIndex === focusedIndex ? currentIndex : focusedIndex
      )
    } catch {
      // Focus sync is best-effort; pane lifecycle handling will correct stale IDs.
    }
  }, [controlPaneId, panes])

  useEffect(() => {
    const paneEventService = PaneEventService.getInstance()
    return paneEventService.onPaneFocusChanged((event) => {
      void syncSelectedIndexToFocusedPane(event.activePaneId)
    })
  }, [syncSelectedIndexToFocusedPane])

  useEffect(() => {
    if (!process.env.TMUX || panes.length === 0) {
      return
    }

    let syncInFlight = false
    const syncActivePane = () => {
      if (syncInFlight) {
        return
      }

      syncInFlight = true
      void syncSelectedIndexToFocusedPane().finally(() => {
        syncInFlight = false
      })
    }

    syncActivePane()
    const interval = setInterval(syncActivePane, ACTIVE_PANE_SYNC_INTERVAL_MS)
    return () => {
      clearInterval(interval)
    }
  }, [eventMode, panes.length, syncSelectedIndexToFocusedPane])

  // savePanes moved to usePanes

  // applySmartLayout moved to utils/tmux

  // Helper function to handle agent choice and pane creation
  const selectAgentsForPaneCreation = async (
    targetProjectRoot?: string
  ): Promise<AgentName[] | null> => {
    const targetRoot = targetProjectRoot || selectedProjectRoot
    if (getAvailableAgentsForProject(targetRoot).length === 0) {
      return []
    }

    const selectedAgents = await popupManager.launchAgentChoicePopup(
      targetRoot
    )
    if (selectedAgents === null) {
      return null
    }
    if (selectedAgents.length === 0) {
      setStatusMessage("Select at least one agent")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return null
    }

    return selectedAgents
  }

  const createPaneSelection = async (
    paneInput: NewPaneInput,
    selectedAgents: AgentName[],
    targetProjectRoot?: string,
    createOptions?: {
      startPointBranch?: string
      mergeTargetChain?: MergeTargetReference[]
    }
  ): Promise<number> => {
    if (selectedAgents.length === 0) {
      const pane = await createNewPaneHook(paneInput, undefined, {
        targetProjectRoot,
        skipAgentSelection: true,
        startPointBranch: createOptions?.startPointBranch,
        mergeTargetChain: createOptions?.mergeTargetChain,
      })
      return pane ? 1 : 0
    }

    const createdPanes = await createPanesForAgentsHook(paneInput, selectedAgents, {
      existingPanes: panes,
      targetProjectRoot,
      startPointBranch: createOptions?.startPointBranch,
      mergeTargetChain: createOptions?.mergeTargetChain,
    })
    return createdPanes.length
  }

  const handlePaneCreationWithAgent = async (
    paneInput: NewPaneInput,
    targetProjectRoot?: string,
    createOptions?: {
      startPointBranch?: string
      mergeTargetChain?: MergeTargetReference[]
    }
  ) => {
    const selectedAgents = await selectAgentsForPaneCreation(targetProjectRoot)
    if (selectedAgents === null) {
      return
    }

    await createPaneSelection(
      paneInput,
      selectedAgents,
      targetProjectRoot,
      createOptions
    )
  }

  const handleCreateChildWorktree = async (parentPane: DmuxPane) => {
    if (!parentPane.worktreePath) {
      setStatusMessage("Selected pane has no worktree path")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const targetProjectRoot = getPaneProjectRoot(parentPane, sessionProjectRoot)
    const paneInput = await popupManager.launchNewPanePopup(targetProjectRoot)
    if (!paneInput) {
      return
    }

    const selectedAgents = await selectAgentsForPaneCreation(targetProjectRoot)
    if (selectedAgents === null) {
      return
    }

    const createSubWorktree = async (): Promise<ActionResult> => {
      const createdCount = await createPaneSelection(
        paneInput,
        selectedAgents,
        targetProjectRoot,
        {
          startPointBranch: getPaneBranchName(parentPane),
          mergeTargetChain: createMergeTargetChain(parentPane, targetProjectRoot),
        }
      )

      if (createdCount > 0) {
        return {
          type: "success",
          message: `Created ${createdCount} sub-worktree${createdCount === 1 ? "" : "s"} from ${getPaneDisplayName(parentPane)}`,
        }
      }

      return {
        type: "error",
        message: `Failed to create a sub-worktree from ${getPaneDisplayName(parentPane)}`,
        dismissable: true,
      }
    }

    const parentStatus = getGitStatus(parentPane.worktreePath)
    if (!parentStatus.hasChanges) {
      await actionSystem.executeCallback(createSubWorktree, {
        showProgress: false,
        projectRoot: targetProjectRoot,
      })
      return
    }

    const branchFromDirtyResult: ActionResult = {
      type: "choice",
      title: "Parent Worktree Has Uncommitted Changes",
      message: `"${getPaneDisplayName(parentPane)}" has uncommitted changes. Commit them before creating a sub-worktree.`,
      options: [
        {
          id: "commit_automatic",
          label: t("commit.aiCommitAuto"),
          description: "Auto-generate and commit immediately",
          default: true,
        },
        {
          id: "commit_ai_editable",
          label: t("commit.aiCommitEditable"),
          description: "Generate message, edit before commit",
        },
        {
          id: "commit_manual",
          label: t("commit.manualCommit"),
          description: "Write your own commit message",
        },
        {
          id: "cancel",
          label: t("commit.cancel"),
          description: "Keep working in the parent worktree",
        },
      ],
      data: {
        kind: "merge_uncommitted",
        repoPath: parentPane.worktreePath,
        targetBranch: getPaneBranchName(parentPane),
        files: parentStatus.files,
        diffMode: "working-tree",
      },
      onSelect: async (optionId: string) => {
        if (optionId === "cancel") {
          return {
            type: "info",
            message: "Sub-worktree creation cancelled",
            dismissable: true,
          }
        }

        if (
          optionId !== "commit_automatic"
          && optionId !== "commit_ai_editable"
          && optionId !== "commit_manual"
        ) {
          return {
            type: "error",
            message: `Unknown option: ${optionId}`,
            dismissable: true,
          }
        }

        const { handleCommitWithOptions } = await import("./actions/merge/commitMessageHandler.js")
        return handleCommitWithOptions(parentPane.worktreePath!, optionId, createSubWorktree)
      },
      dismissable: true,
    }

    await actionSystem.executeCallback(
      async () => branchFromDirtyResult,
      { showProgress: false, projectRoot: targetProjectRoot }
    )
  }

  // Helper function to reopen a closed worktree
  const handleReopenWorktree = async (
    candidate: ResumableBranchCandidate,
    targetProjectRoot?: string
  ) => {
    const reopenProjectRoot = targetProjectRoot || projectRoot || process.cwd()
    let selectedAgent: AgentName | undefined

    if (!candidate.path) {
      if (getAvailableAgentsForProject(reopenProjectRoot).length === 0) {
        setStatusMessage("No enabled agents available for opening this branch")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        return
      }

      const chosenAgent = await popupManager.launchSingleAgentChoicePopup(
        "Select Agent",
        `Choose the agent to launch for ${candidate.branchName}.`,
        reopenProjectRoot
      )
      if (!chosenAgent) {
        return
      }
      selectedAgent = chosenAgent
    }

    try {
      setIsCreatingPane(true)
      const label = candidate.path ? (candidate.slug || candidate.branchName) : candidate.branchName
      setStatusMessage(`${candidate.path ? "Reopening" : "Opening"} ${label}...`)

      const result = candidate.path
        ? await reopenWorktree({
            slug: candidate.slug || candidate.branchName,
            worktreePath: candidate.path,
            projectRoot: reopenProjectRoot,
            sessionProjectRoot: projectRoot || process.cwd(),
            sessionConfigPath: panesFile,
            existingPanes: panes,
          })
        : await resumeBranchWorkspace({
            agent: selectedAgent!,
            branchName: candidate.branchName,
            projectRoot: reopenProjectRoot,
            sessionProjectRoot: projectRoot || process.cwd(),
            sessionConfigPath: panesFile,
            existingPanes: panes,
          })

      // Save the pane
      const updatedPanes = [...panes, result.pane]
      await savePanes(updatedPanes)

      await loadPanes()

      setStatusMessage(
        `${candidate.path ? "Reopened" : "Opened"} ${getPaneDisplayName(result.pane)}`
      )
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to open branch: ${error.message}`)
      setTimeout(() => setStatusMessage(""), 3000)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const restartDevSessionAtSource = async (sourcePath: string) => {
    if (!isDevMode) return

    const tmuxService = TmuxService.getInstance()
    const sourcePaneId = controlPaneId || await tmuxService.getCurrentPaneId()
    await tmuxService.respawnPane(
      sourcePaneId,
      buildDevWatchRespawnCommand(sourcePath)
    )
  }

  const handleSetDevSourceFromPane = async (pane: DmuxPane) => {
    if (!isDevMode) {
      setStatusMessage("Source switching is only available in dev mode")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    if (!pane.worktreePath) {
      setStatusMessage("Selected pane has no worktree path")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const paneProjectRoot = getPaneProjectRoot(pane, sessionProjectRoot)
    if (paneProjectRoot !== sessionProjectRoot) {
      setStatusMessage("Source can only be set from panes in this project")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const nextSource = resolveNextDevSourcePath(
      pane.worktreePath,
      resolvePath(process.cwd()),
      resolvePath(sessionProjectRoot)
    )

    if (nextSource.toggledToRoot) {
      setStatusMessage("Switching source to project root...")
      await trackProjectActivity(
        () => restartDevSessionAtSource(nextSource.nextSourcePath),
        sessionProjectRoot
      )
      return
    }

    setStatusMessage(`Switching source to "${getPaneDisplayName(pane)}"...`)
    await trackProjectActivity(
      () => restartDevSessionAtSource(nextSource.nextSourcePath),
      paneProjectRoot
    )
  }

  // Helper function to handle action results recursively
  const handleActionResult = async (result: ActionResult): Promise<void> => {
    // Handle ActionResults from background callbacks (e.g., conflict resolution completion)
    // This allows showing dialogs even when not in the normal action flow
    if (!popupsSupported) return

    // Handle the result type and show appropriate dialog
    if (result.type === "confirm") {
      const confirmed = await popupManager.launchConfirmPopup(
        result.title || "Confirm",
        result.message,
        result.confirmLabel,
        result.cancelLabel,
        selectedProjectRoot
      )
      if (confirmed && result.onConfirm) {
        const nextResult = await trackProjectActivity(
          () => result.onConfirm!(),
          selectedProjectRoot
        )
        // Recursively handle nested results
        if (nextResult) {
          await handleActionResult(nextResult)
        }
      } else if (!confirmed && result.onCancel) {
        const nextResult = await trackProjectActivity(
          () => result.onCancel!(),
          selectedProjectRoot
        )
        if (nextResult) {
          await handleActionResult(nextResult)
        }
      }
    } else if (result.type === "choice") {
      if (!result.options || !result.onSelect) return
      const selectedId = await popupManager.launchChoicePopup(
        result.title || "Choose Option",
        result.message,
        result.options,
        result.data,
        selectedProjectRoot
      )
      if (selectedId) {
        const nextResult = await trackProjectActivity(
          () => result.onSelect!(selectedId),
          selectedProjectRoot
        )
        // Recursively handle nested results
        if (nextResult) {
          await handleActionResult(nextResult)
        }
      }
    } else if (result.type === "input") {
      if (!result.onSubmit) return
      const inputValue = await popupManager.launchInputPopup(
        result.title || "Input",
        result.message,
        result.placeholder,
        result.defaultValue,
        selectedProjectRoot,
        result.inputMaxVisibleLines
      )
      if (inputValue !== null) {
        const nextResult = await trackProjectActivity(
          () => result.onSubmit!(inputValue),
          selectedProjectRoot
        )
        // Recursively handle nested results
        if (nextResult) {
          await handleActionResult(nextResult)
        }
      }
    } else if (result.type === "pr_review") {
      if (!result.onSubmit || !result.reviewData) return
      const inputValue = await popupManager.launchPRReviewPopup(
        {
          title: result.title || "Pull Request",
          message: result.message || "",
          defaultValue: result.defaultValue || "",
          repoPath: result.reviewData.repoPath,
          sourceBranch: result.reviewData.sourceBranch,
          targetBranch: result.reviewData.targetBranch,
          files: result.reviewData.files,
          aiFailed: result.reviewData.aiFailed,
        },
        selectedProjectRoot
      )
      if (inputValue !== null) {
        const nextResult = await trackProjectActivity(
          () => result.onSubmit!(inputValue),
          selectedProjectRoot
        )
        if (nextResult) {
          await handleActionResult(nextResult)
        }
      }
    } else if (result.type === "navigation") {
      // Navigate to target pane if specified
      if (result.targetPaneId) {
        const targetPane = panes.find(p => p.id === result.targetPaneId)
        if (targetPane) {
          try {
            TmuxService.getInstance().selectPane(targetPane.paneId)
          } catch {}
        }
      }
      // Show message if dismissable
      if (result.message && result.dismissable) {
        await popupManager.launchProgressPopup(
          result.message,
          "info",
          3000,
          selectedProjectRoot
        )
      }
    } else if (
      result.type === "info" ||
      result.type === "success" ||
      result.type === "error"
    ) {
      // Use toast notification instead of popup for better UX
      const { default: stateManager } = await import("./shared/StateManager.js")
      stateManager.showToast(
        result.message,
        result.type as "success" | "error" | "info"
      )
    }
  }

  // Action system - initialized after services are defined
  const actionSystem = useActionSystem({
    panes,
    savePanes,
    sessionName,
    projectName,
    defaultProjectRoot: sessionProjectRoot,
    onPaneRemove: async (paneId) => {
      const nextSelection = resolveSelectionAfterPaneClose(
        panes,
        paneId,
        sidebarProjects,
        sessionProjectRoot,
        projectName
      )

      if (nextSelection) {
        setSelectedIndex(nextSelection.selectedIndex)
      } else {
        const maxIndex = Math.max(0, projectActionLayout.totalItems - 2)
        if (selectedIndex > maxIndex) {
          setSelectedIndex(maxIndex)
        }
      }

      const targetPaneId = nextSelection?.pane && !nextSelection.pane.hidden
        ? nextSelection.pane.paneId
        : controlPaneId

      if (targetPaneId) {
        try {
          await TmuxService.getInstance().selectPane(targetPaneId)
        } catch {
          // Ignore - the target pane might have closed during cleanup
        }
      }
    },
    onActionResult: handleActionResult,
    trackProjectActivity,
    popupLaunchers: popupsSupported
      ? {
          launchConfirmPopup: popupManager.launchConfirmPopup.bind(popupManager),
          launchChoicePopup: popupManager.launchChoicePopup.bind(popupManager),
          launchInputPopup: popupManager.launchInputPopup.bind(popupManager),
          launchPRReviewPopup: popupManager.launchPRReviewPopup.bind(popupManager),
          launchProgressPopup:
            popupManager.launchProgressPopup.bind(popupManager),
        }
      : undefined,
  })

  const isProjectHeaderBusy = useMemo(() => {
    const isSelectedProjectBusy = isCreatingPane || runningCommand

    return (projectRoot: string) => {
      if (isLoading || isUpdating) {
        return true
      }

      if (isTrackedProjectBusy(projectRoot)) {
        return true
      }

      return isSelectedProjectBusy && resolvePath(projectRoot) === resolvePath(selectedProjectRoot)
    }
  }, [
    isCreatingPane,
    isLoading,
    isTrackedProjectBusy,
    isUpdating,
    runningCommand,
    selectedProjectRoot,
  ])

  // Auto-show new pane dialog removed - users can press 'n' to create panes via popup

  // Periodic enforcement of control pane size and content pane rebalancing (left sidebar at 40 chars)
  useLayoutManagement({
    controlPaneId,
    hasActiveDialog:
      actionSystem.actionState.showConfirmDialog ||
      actionSystem.actionState.showChoiceDialog ||
      actionSystem.actionState.showInputDialog ||
      actionSystem.actionState.showProgressDialog ||
      !!showCommandPrompt ||
      showFileCopyPrompt ||
      isCreatingPane ||
      runningCommand ||
      isUpdating,
  })

  // Monitor agent status across panes (returns a map of pane ID to status)
  const agentStatuses = useAgentStatus({
    panes,
    suspend:
      actionSystem.actionState.showConfirmDialog ||
      actionSystem.actionState.showChoiceDialog ||
      actionSystem.actionState.showInputDialog ||
      actionSystem.actionState.showProgressDialog ||
      !!showCommandPrompt ||
      showFileCopyPrompt,
    onPaneRemoved: (paneId: string) => {
      // Check if this pane is being closed intentionally or is locked
      // If so, don't re-save - the close action already handled it
      if (lifecycleManager.isClosing(paneId) || lifecycleManager.isLocked(paneId)) {
        return
      }

      // Pane was removed unexpectedly (e.g., user killed tmux pane manually)
      // Remove it from our tracking
      const updatedPanes = panes.filter((p) => p.id !== paneId)
      savePanes(updatedPanes)

      const removedPane = panes.find((p) => p.id === paneId)
      if (
        isDevMode &&
        removedPane?.worktreePath &&
        removedPane.worktreePath === process.cwd()
      ) {
        void restartDevSessionAtSource(sessionProjectRoot)
      }
    },
  })

  // jumpToPane and runCommand functions removed - now handled by action system and pane runner

  // Update handling moved to useAutoUpdater

  // clearScreen function removed - no longer used (was only used by removed jumpToPane function)

  // Cleanup function for exit
  const cleanExit = () => {
    if (!claimProcessShutdown("app-clean-exit")) {
      return
    }

    // Clear screen before exiting Ink
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H")

    // Exit the Ink app (this cleans up the React tree)
    exit()

    // Give Ink a moment to clean up its rendering, then do final cleanup
    setTimeout(() => {
      // Multiple aggressive clearing strategies
      process.stdout.write("\x1b[2J\x1b[H") // Clear screen and move cursor to home
      process.stdout.write("\x1b[3J") // Clear scrollback buffer
      process.stdout.write("\x1b[0m") // Reset all attributes

      // Never inject control keys into the pane during shutdown.
      // An orphaned dmux dev process can outlive the UI and replay them forever.
      if (process.env.TMUX) {
        try {
          const tmuxService = TmuxService.getInstance()
          tmuxService.clearHistorySync()
        } catch {}
      }

      // One more final clear
      process.stdout.write("\x1b[2J\x1b[H")

      // Show clean goodbye message
      process.stdout.write("\n  Run dmux again to resume. Goodbye 👋\n\n")

      // Exit process
      process.exit(0)
    }, 100)
  }

  // Handle tmux hooks prompt input
  useInput(
    (input, key) => {
      if (!showHooksPrompt) return

      if (key.upArrow || input === 'k') {
        setHooksPromptIndex(Math.max(0, hooksPromptIndex - 1))
      } else if (key.downArrow || input === 'j') {
        setHooksPromptIndex(Math.min(1, hooksPromptIndex + 1))
      } else if (input === 'y') {
        // Yes - install hooks
        setShowHooksPrompt(false)
        setUseHooks(true)
        settingsManager.updateSetting('useTmuxHooks', true, 'global')
        refreshDmuxSettings()
      } else if (input === 'n') {
        // No - use polling
        setShowHooksPrompt(false)
        setUseHooks(false)
        settingsManager.updateSetting('useTmuxHooks', false, 'global')
        refreshDmuxSettings()
      } else if (key.return) {
        // Select current option
        setShowHooksPrompt(false)
        const selected = hooksPromptIndex === 0
        setUseHooks(selected)
        settingsManager.updateSetting('useTmuxHooks', selected, 'global')
        refreshDmuxSettings()
      }
    },
    { isActive: showHooksPrompt }
  )

  // Input handling - extracted to dedicated hook
  useInputHandling({
    panes,
    selectedIndex,
    setSelectedIndex,
    isCreatingPane,
    setIsCreatingPane,
    runningCommand,
    isUpdating,
    isLoading,
    ignoreInput: ignoreInput || showHooksPrompt, // Block other input when hooks prompt is shown
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
    setDevSourceFromPane: handleSetDevSourceFromPane,
    savePanes,
    sidebarProjects,
    saveSidebarProjects,
    loadPanes,
    cleanExit,
    getAvailableAgentsForProject,
    panesFile,
    projectRoot: sessionProjectRoot,
    activeProjectRoot: selectedProjectRoot,
    projectActionItems: projectActionLayout.actionItems,
    findCardInDirection,
  })

  // Calculate available height for content (terminal height - footer lines - active status messages)
  // Footer height varies based on state:
  // - Quit confirm mode: 2 lines (marginTop + 1 text line)
  // - Normal mode calculation:
  //   - Base footer: 4 lines (marginTop + logs divider + logs line + keyboard shortcuts)
  //   - Footer tip: +1 line when footer tips are enabled
  //   - Toast (active): wrapped lines + header + marginBottom
  //   - Toast (queued, transitioning): header + marginBottom (2 lines)
  //   - Debug info: +1 line if DEBUG_DMUX
  //   - Status line: +1 line if updateAvailable/currentBranch/debugMessage
  //   - Status messages: +1 line per active message
  const showFooterHelp = !showCommandPrompt
  let footerLines = 2
  if (quitConfirmMode) {
    footerLines = 2
  } else {
    footerLines = 0

    if (showFooterHelp) {
      footerLines = 3 // logs divider + logs + shortcuts

      if (currentFooterTip) {
        footerLines += 1
      }

      // Add toast notification (calculate wrapped lines + header)
      if (currentToast) {
        // Toast format: "✓ message" - icon (1) + space (1) + message
        // Use stringWidth for CJK-aware display width calculation
        const iconAndSpaceWidth = 2;
        const toastDisplayWidth = iconAndSpaceWidth + stringWidth(currentToast.message);

        // Available width is sidebar width (40) minus padding/margins (~2)
        const availableWidth = SIDEBAR_WIDTH - 2;
        const wrappedLines = Math.ceil(toastDisplayWidth / availableWidth);

        footerLines += wrappedLines + 1 + 1; // wrapped lines + header line + marginBottom
      } else if (toastQueueLength > 0) {
        // When there are queued toasts but no current toast (transition state),
        // FooterHelp still renders the notification header + marginBottom
        footerLines += 1 + 1; // header line + marginBottom
      }

      // Add debug info
      if (process.env.DEBUG_DMUX) {
        footerLines += 1
      }
    }

    // Add status line
    if (isDevMode || updateAvailable || currentBranch || debugMessage) {
      footerLines += 1
    }
    // Add line for each active status message
    if (statusMessage) {
      footerLines += 1
    }
    if (actionSystem.actionState.statusMessage) {
      footerLines += 1
    }
  }
  const contentHeight = Math.max(terminalHeight - footerLines, 10)

  return (
    <Box key={`theme-${selectedThemeName}-${themeRefreshNonce}`} flexDirection="column" height={terminalHeight}>
      {/* Main content area - height dynamically adjusts for status messages */}
      <Box flexDirection="column" height={contentHeight} overflow="hidden">
        <PanesGrid
          panes={panes}
          selectedIndex={selectedIndex}
          activeProjectRoot={activeProjectRoot}
          isLoading={isLoading}
          themeName={selectedThemeName}
          projectThemeByRoot={projectThemeByRoot}
          agentStatuses={agentStatuses}
          activeDevSourcePath={activeDevSourcePath}
          sidebarProjects={sidebarProjects}
          fallbackProjectRoot={projectRoot || process.cwd()}
          fallbackProjectName={projectName}
          isProjectBusy={isProjectHeaderBusy}
        />

        {showCommandPrompt && (
          <CommandPromptDialog
            type={showCommandPrompt}
            value={commandInput}
            onChange={setCommandInput}
          />
        )}

        {showFileCopyPrompt && <FileCopyPrompt />}

        {/* Tmux hooks prompt - shown on first startup */}
        {showHooksPrompt && (
          <TmuxHooksPromptDialog selectedIndex={hooksPromptIndex} />
        )}
      </Box>

      {/* Status messages - only render when present */}
      {statusMessage && (
        <Box>
          <Text color="green">{statusMessage}</Text>
        </Box>
      )}
      {actionSystem.actionState.statusMessage && (
        <Box>
          <Text
            color={
              actionSystem.actionState.statusType === "error"
                ? "red"
                : actionSystem.actionState.statusType === "success"
                ? "green"
                : "cyan"
            }
          >
            {actionSystem.actionState.statusMessage}
          </Text>
        </Box>
      )}

      {/* Footer - always at bottom */}
      <FooterHelp
        show={showFooterHelp}
        quitConfirmMode={quitConfirmMode}
        unreadErrorCount={unreadErrorCount}
        unreadWarningCount={unreadWarningCount}
        currentToast={currentToast}
        toastQueueLength={toastQueueLength}
        toastQueuePosition={toastQueuePosition}
        footerTip={currentFooterTip}
        gridInfo={(() => {
          if (!process.env.DEBUG_DMUX) return undefined
          const rows = navigationRows.length
          const cols = Math.max(1, ...navigationRows.map((row) => row.length))
          const pos = getCardGridPosition(selectedIndex)
          return `Grid: ${cols} cols × ${rows} rows | Selected: row ${pos.row}, col ${pos.col} | Terminal: ${terminalWidth}w`
        })()}
      />

      {/* Status line - only for updates, branch info, and debug messages */}
      {(isDevMode || updateAvailable || currentBranch || debugMessage) && (
        <Text dimColor>
          {isDevMode && (
            <Text color="yellow" bold>
              DEV MODE{" "}
            </Text>
          )}
          {updateAvailable && updateInfo && (
            <Text color="red" bold>
              Update available: npm i -g dmux@latest{" "}
            </Text>
          )}
          {currentBranch && (
            <Text color="magenta">
              source: {currentBranch}
            </Text>
          )}
          {debugMessage && <Text dimColor> • {debugMessage}</Text>}
        </Text>
      )}
    </Box>
  )
}

export default DmuxApp
