import fs from "fs/promises"
import path from "path"
import {
  launchNodePopupNonBlocking,
  POPUP_POSITIONING,
  type PopupOptions as TmuxPopupOptions,
  type PopupResult,
} from "../utils/popup.js"
import { StateManager } from "../shared/StateManager.js"
import { LogService } from "./LogService.js"
import { TmuxService } from "./TmuxService.js"
import {
  DEFAULT_COLOR_THEME_SETTING_KEY,
  getLocalizedSettingDefinitions,
  SETTING_DEFINITIONS,
} from "../utils/settingsManager.js"
import type {
  DmuxPane,
  DmuxThemeName,
  NewPaneInput,
  ProjectSettings,
  SettingDefinition,
  SidebarProject,
} from "../types.js"
import { getPaneMenuActions, type PaneMenuActionId } from "../actions/index.js"
import { INPUT_IGNORE_DELAY } from "../constants/timing.js"
import {
  getAgentDefinitions,
  isAgentName,
  resolveEnabledAgentsSelection,
  type AgentName,
} from "../utils/agentLaunch.js"
import {
  getNotificationSoundDefinitions,
  resolveNotificationSoundsSelection,
  type NotificationSoundId,
} from "../utils/notificationSounds.js"
import { resolveDistPath } from "../utils/runtimePaths.js"
import { getPaneProjectRoot } from "../utils/paneProject.js"
import { getPaneDisplayName } from "../utils/paneTitle.js"
import type { TrackProjectActivity } from "../types/activity.js"
import { SettingsManager } from "../utils/settingsManager.js"
import { DEFAULT_DMUX_THEME, DMUX_THEME_NAMES } from "../theme/themePalette.js"
import {
  AUTO_SIDEBAR_PROJECT_COLOR_THEME_VALUE,
  getSidebarProjectColorThemeSettingValue,
  SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY,
} from "../utils/sidebarProjects.js"
import { resolveProjectColorTheme } from "../utils/paneColors.js"
import type {
  ReopenWorktreePopupResult,
  ReopenWorktreePopupState,
} from "../components/popups/reopenWorktreePopup.js"

export interface PopupManagerConfig {
  sidebarWidth: number
  projectRoot: string
  popupsSupported: boolean
  isDevMode: boolean
  terminalWidth: number
  terminalHeight: number
  controlPaneId?: string
  availableAgents: AgentName[]
  settingsManager: any
  projectSettings: ProjectSettings
  trackProjectActivity: TrackProjectActivity
}

interface PopupOptions {
  width?: number
  height?: number
  title: string
  themeName?: DmuxThemeName
  positioning?: "standard" | "centered" | "large" | "pane"
  targetPaneId?: string
}

interface MergeUncommittedChoiceData {
  kind: "merge_uncommitted"
  repoPath: string
  targetBranch: string
  files: string[]
  diffMode?: "working-tree" | "target-branch"
}

interface LaunchNewPanePopupOptions {
  allowGitOptions?: boolean;
}

function isMergeUncommittedChoiceData(
  data: unknown
): data is MergeUncommittedChoiceData {
  if (!data || typeof data !== "object") return false

  const candidate = data as Record<string, unknown>
  if (candidate.kind !== "merge_uncommitted") return false
  if (typeof candidate.repoPath !== "string" || candidate.repoPath.length === 0) {
    return false
  }
  if (
    typeof candidate.targetBranch !== "string"
    || candidate.targetBranch.length === 0
  ) {
    return false
  }
  if (!Array.isArray(candidate.files) || !candidate.files.every((file) => typeof file === "string")) {
    return false
  }
  if (
    candidate.diffMode !== undefined
    && candidate.diffMode !== "working-tree"
    && candidate.diffMode !== "target-branch"
  ) {
    return false
  }

  return true
}

export class PopupManager {
  private config: PopupManagerConfig
  private setStatusMessage: (msg: string) => void
  private setIgnoreInput: (ignore: boolean) => void
  private trackProjectActivity: TrackProjectActivity

  constructor(
    config: PopupManagerConfig,
    setStatusMessage: (msg: string) => void,
    setIgnoreInput: (ignore: boolean) => void
  ) {
    this.config = config
    this.setStatusMessage = setStatusMessage
    this.setIgnoreInput = setIgnoreInput
    this.trackProjectActivity = config.trackProjectActivity
  }

  /**
   * Get the popup script path from project root
   */
  private getPopupScriptPath(scriptName: string): string {
    return resolveDistPath("components", "popups", scriptName)
  }

  /**
   * Show temporary status message
   */
  private showTempMessage(message: string, duration: number = 3000) {
    this.setStatusMessage(message)
    setTimeout(() => this.setStatusMessage(""), duration)
  }

  /**
   * Check if popups are supported
   */
  private checkPopupSupport(): boolean {
    if (!this.config.popupsSupported) {
      this.showTempMessage("Popups require tmux 3.2+")
      return false
    }
    return true
  }

  /**
   * Ignore input briefly after popup closes to prevent buffered keys
   */
  private ignoreInputBriefly() {
    this.setIgnoreInput(true)
    setTimeout(() => this.setIgnoreInput(false), INPUT_IGNORE_DELAY)
  }

  private resolveActivityProjectRoot(projectRoot?: string): string {
    return projectRoot || this.config.projectRoot
  }

  private getSettingsManager(projectRoot?: string) {
    const resolvedProjectRoot = projectRoot || this.config.projectRoot
    if (!projectRoot || resolvedProjectRoot === this.config.projectRoot) {
      return this.config.settingsManager
    }

    return new SettingsManager(resolvedProjectRoot)
  }

  private getAvailableAgents(projectRoot?: string): AgentName[] {
    const settings = this.getSettingsManager(projectRoot).getSettings()
    return resolveEnabledAgentsSelection(settings.enabledAgents)
  }

  /**
   * Generic popup launcher with common logic
   */
  private async launchPopup<T>(
    scriptName: string,
    args: string[],
    options: PopupOptions,
    tempData?: any,
    projectRoot?: string
  ): Promise<PopupResult<T>> {
    const popupScriptPath = this.getPopupScriptPath(scriptName)
    let tempFile: string | null = null

    try {
      const popupHandle = await this.trackProjectActivity(async () => {
        // Write temp file if data provided
        if (tempData !== undefined) {
          tempFile = `/tmp/dmux-${scriptName.replace(".js", "")}-${Date.now()}.json`
          await fs.writeFile(tempFile, JSON.stringify(tempData))
          args = [tempFile, ...args]
        }

        let positioning: Partial<TmuxPopupOptions>
        if (options.positioning === "large") {
          const tmuxService = TmuxService.getInstance()
          const dims = await tmuxService.getAllDimensions()
          positioning = POPUP_POSITIONING.large(
            this.config.sidebarWidth,
            dims.clientWidth,
            dims.clientHeight
          )
        } else if (options.positioning === "centered") {
          positioning = POPUP_POSITIONING.centeredWithSidebar(
            this.config.sidebarWidth
          )
        } else if (
          options.positioning === "pane"
          && options.targetPaneId
        ) {
          const tmuxService = TmuxService.getInstance()
          const [dims, panePositions] = await Promise.all([
            tmuxService.getAllDimensions(),
            tmuxService.getPanePositions(),
          ])
          const targetPane = panePositions.find(
            (pane) => pane.paneId === options.targetPaneId
          )

          positioning = targetPane
            ? POPUP_POSITIONING.overPane(
                targetPane,
                {
                  width: options.width ?? 80,
                  height: options.height ?? 20,
                },
                {
                  width: dims.clientWidth,
                  height: dims.clientHeight,
                }
              )
            : POPUP_POSITIONING.standard(this.config.sidebarWidth)
        } else {
          positioning = POPUP_POSITIONING.standard(this.config.sidebarWidth)
        }

        const popupOptions: TmuxPopupOptions = {
          ...positioning,
          title: options.title,
          themeName: options.themeName,
          cwd: projectRoot || this.config.projectRoot,
        }

        if (positioning.width !== undefined || options.width !== undefined) {
          popupOptions.width = positioning.width ?? options.width
        }

        if (positioning.height !== undefined || options.height !== undefined) {
          popupOptions.height = positioning.height ?? options.height
        }

        const popupHandle = launchNodePopupNonBlocking<T>(
          popupScriptPath,
          args,
          popupOptions
        )
        await popupHandle.readyPromise
        return popupHandle
      }, this.resolveActivityProjectRoot(projectRoot))

      // Wait for result
      const result = await popupHandle.resultPromise

      // Clean up temp file
      if (tempFile) {
        try {
          await fs.unlink(tempFile)
        } catch {
          // Intentionally silent - temp file cleanup is optional
        }
      }

      return result
    } catch (error: any) {
      // Clean up temp file on error
      if (tempFile) {
        try {
          await fs.unlink(tempFile)
        } catch {
          // Intentionally silent - temp file cleanup is optional
        }
      }
      throw error
    }
  }

  /**
   * Handle standard popup result (success/cancelled/error)
   */
  private handleResult<T>(
    result: PopupResult<T>,
    onSuccess?: (data: T) => T | null,
    onError?: (error: string) => void
  ): T | null {
    if (result.success && result.data !== undefined) {
      return onSuccess ? onSuccess(result.data) : result.data
    } else if (result.cancelled) {
      return null
    } else if (result.error) {
      const errorMsg = `Popup error: ${result.error}`
      if (onError) {
        onError(errorMsg)
      } else {
        this.showTempMessage(errorMsg)
      }
      return null
    }
    return null
  }

  private normalizeNewPaneInput(data: unknown): NewPaneInput | null {
    if (typeof data === "string") {
      return { prompt: data }
    }

    if (!data || typeof data !== "object") {
      return null
    }

    const candidate = data as Record<string, unknown>
    if (typeof candidate.prompt !== "string") {
      return null
    }

    const normalized: NewPaneInput = { prompt: candidate.prompt }
    if (typeof candidate.baseBranch === "string") {
      const value = candidate.baseBranch.trim()
      if (value) normalized.baseBranch = value
    }
    if (typeof candidate.branchName === "string") {
      const value = candidate.branchName.trim()
      if (value) normalized.branchName = value
    }

    return normalized
  }

  async launchNewPanePopup(
    projectPath?: string,
    options: LaunchNewPanePopupOptions = {}
  ): Promise<NewPaneInput | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const popupHeight = Math.floor(this.config.terminalHeight * 0.8)
      const effectivePath = projectPath || this.config.projectRoot
      const settings = this.getSettingsManager(effectivePath).getSettings()
      const shouldPromptForGitOptions =
        (settings.promptForGitOptionsOnCreate ?? false) && (options.allowGitOptions ?? true)
      const popupArgs = [effectivePath, shouldPromptForGitOptions ? "1" : "0"]
      const projectName = effectivePath ? path.basename(effectivePath) : "dmux"
      const result = await this.launchPopup<unknown>(
        "newPanePopup.js",
        popupArgs,
        {
          width: 90,
          height: popupHeight,
          title: `  ✨ New Pane — ${projectName}  `,
          positioning: "centered",
        },
        undefined,
        projectPath
      )

      this.ignoreInputBriefly()
      const data = this.handleResult(result)
      return this.normalizeNewPaneInput(data)
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchKebabMenuPopup(
    pane: DmuxPane,
    panes: DmuxPane[],
    options: { anchorToPane?: boolean } = {}
  ): Promise<PaneMenuActionId | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const actions = getPaneMenuActions(
        pane,
        panes,
        this.config.projectSettings,
        this.config.isDevMode,
        this.config.projectRoot
      )
      const result = await this.launchPopup<string>(
        "kebabMenuPopup.js",
        [getPaneDisplayName(pane), JSON.stringify(actions)],
        {
          width: 60,
          height: Math.min(26, actions.length + 6),
          title: `Menu: ${getPaneDisplayName(pane)}`,
          positioning: options.anchorToPane ? "pane" : "standard",
          targetPaneId: options.anchorToPane ? pane.paneId : undefined,
        },
        undefined,
        getPaneProjectRoot(pane, this.config.projectRoot)
      )

      const actionId = this.handleResult(
        result,
        (data) => {
          LogService.getInstance().debug(`Action selected: ${data}`, "KebabMenu")
          return data
        },
        (error) => {
          LogService.getInstance().error(error, "KebabMenu")
          this.showTempMessage(error)
        }
      )
      return actionId as PaneMenuActionId | null
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchConfirmPopup(
    title: string,
    message: string,
    yesLabel?: string,
    noLabel?: string,
    projectRoot?: string
  ): Promise<boolean> {
    if (!this.checkPopupSupport()) return false

    try {
      // Calculate height based on message content
      // Count newlines + estimate wrapped lines (assuming ~75 chars per line for width 80)
      const messageLines = message.split('\n').reduce((count, line) => {
        return count + Math.max(1, Math.ceil(line.length / 75))
      }, 0)
      // Add space for title, buttons, padding (about 6 lines)
      const calculatedHeight = Math.min(35, Math.max(12, messageLines + 6))

      const result = await this.launchPopup<boolean>(
        "confirmPopup.js",
        [],
        {
          width: 80,
          height: calculatedHeight,
          title: title || "Confirm",
        },
        { title, message, yesLabel, noLabel },
        projectRoot
      )

      return this.handleResult(result) ?? false
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return false
    }
  }

  async launchAgentChoicePopup(projectRoot?: string): Promise<AgentName[] | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const availableAgents = this.getAvailableAgents(projectRoot)
      if (availableAgents.length === 0) {
        return []
      }

      const agentsJson = JSON.stringify(availableAgents)
      const settings = this.getSettingsManager(projectRoot).getSettings()
      const defaultAgent = settings.defaultAgent
      const initialSelectedAgents =
        defaultAgent &&
        isAgentName(defaultAgent) &&
        availableAgents.includes(defaultAgent)
          ? [defaultAgent]
          : []
      const popupHeight = Math.max(12, availableAgents.length + 8)

      const result = await this.launchPopup<AgentName[]>(
        "agentChoicePopup.js",
        [agentsJson, JSON.stringify(initialSelectedAgents)],
        {
          width: 72,
          height: popupHeight,
          title: "Select Agent(s)",
        },
        undefined,
        projectRoot
      )

      return this.handleResult(result)
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchSingleAgentChoicePopup(
    title: string = "Select Agent",
    message?: string,
    projectRoot?: string
  ): Promise<AgentName | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const availableAgents = this.getAvailableAgents(projectRoot)
      if (availableAgents.length === 0) return null

      const settings = this.getSettingsManager(projectRoot).getSettings()
      const defaultAgent = settings.defaultAgent
      const popupHeight = Math.max(12, Math.min(20, availableAgents.length + 8))

      const result = await this.launchPopup<AgentName>(
        "singleAgentChoicePopup.js",
        [],
        {
          width: 72,
          height: popupHeight,
          title,
        },
        {
          title,
          message,
          options: availableAgents.map((agent) => ({
            id: agent,
            default: defaultAgent === agent,
          })),
        },
        projectRoot
      )

      return this.handleResult(result)
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchHooksPopup(
    onEditHooks: () => Promise<void>,
    projectRoot?: string
  ): Promise<void> {
    if (!this.checkPopupSupport()) return

    try {
      const { hasHook } = await import("../utils/hooks.js")
      const hooksProjectRoot = this.resolveActivityProjectRoot(projectRoot)
      const allHookTypes = [
        "before_pane_create",
        "pane_created",
        "worktree_created",
        "before_pane_close",
        "pane_closed",
        "before_worktree_remove",
        "worktree_removed",
        "pre_merge",
        "post_merge",
        "run_test",
        "run_dev",
      ]

      const hooks = allHookTypes.map((hookName) => ({
        name: hookName,
        active: hasHook(
          hooksProjectRoot || process.cwd(),
          hookName as any
        ),
      }))

      const result = await this.launchPopup<{ action?: "edit" | "view" }>(
        "hooksPopup.js",
        [JSON.stringify(hooks)],
        {
          width: 70,
          height: 24,
          title: "🪝 Manage Hooks",
        },
        undefined,
        projectRoot
      )

      const data = this.handleResult(result)
      if (data?.action === "edit") {
        await onEditHooks()
      } else if (data?.action === "view") {
        this.showTempMessage("View in editor not yet implemented", 2000)
      }
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
    }
  }

  async launchLogsPopup(projectRoot?: string): Promise<void> {
    if (!this.checkPopupSupport()) return

    try {
      const stateManager = StateManager.getInstance()
      const logsData = {
        logs: stateManager.getLogs(),
        stats: stateManager.getLogStats(),
        panes: stateManager.getPanes(), // Include panes for slug lookup
      }

      const result = await this.launchPopup<{ clearLogs?: boolean }>(
        "logsPopup.js",
        [],
        {
          title: "🪵 dmux Logs",
          positioning: "large",
        },
        logsData,
        projectRoot
      )

      if (result.success) {
        stateManager.markAllLogsAsRead()

        // Check if user requested to clear logs
        if (result.data?.clearLogs) {
          LogService.getInstance().clearAll()
          this.showTempMessage('✓ Logs cleared', 2000)
        }
      }
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
    }
  }

  async launchShortcutsPopup(
    hasSidebarLayout: boolean,
    projectRoot?: string
  ): Promise<"hooks" | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const popupHeight = this.config.isDevMode ? 22 : 21
      const result = await this.launchPopup<{ action?: "hooks" }>(
        "shortcutsPopup.js",
        [],
        {
          width: 50,
          height: popupHeight,
          title: "⌨️  Keyboard Shortcuts",
        },
        {
          hasSidebarLayout,
          isDevMode: this.config.isDevMode,
        },
        projectRoot
      )

      this.ignoreInputBriefly()
      const data = this.handleResult(result)
      return data?.action === "hooks" ? "hooks" : null
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchSettingsPopup(
    onLaunchHooks: () => Promise<void>,
    projectRoot?: string,
    sidebarProjects: SidebarProject[] = []
  ): Promise<
    | { key: string; value: any; scope: "global" | "project" | "session" }
    | { updates: Array<{ key: string; value: any; scope: "global" | "project" | "session" }> }
    | null
  > {
    if (!this.checkPopupSupport()) return null

    try {
      const resolvedProjectRoot = projectRoot || this.config.projectRoot
      const settingsManager = new SettingsManager(resolvedProjectRoot)
      const resolveSavedProjectTheme = (targetProjectRoot: string) =>
        new SettingsManager(targetProjectRoot).getSettings().colorTheme
      const effectiveProjectTheme = resolveProjectColorTheme(
        resolvedProjectRoot,
        sidebarProjects
      )
      const localizedDefinitions = getLocalizedSettingDefinitions()
      const colorThemeSettingIndex = localizedDefinitions.findIndex(
        (definition) => definition.key === "colorTheme"
      )
      const settingDefinitions: SettingDefinition[] = localizedDefinitions
        .filter((definition) => definition.key !== "colorTheme")

      const defaultColorThemeSetting: SettingDefinition = {
        key: DEFAULT_COLOR_THEME_SETTING_KEY,
        label: "Default Color Theme",
        description: "Fallback color used when a project does not have its own saved theme",
        type: "select",
        scopeBehavior: "global",
        options: DMUX_THEME_NAMES.map((themeName) => ({
          value: themeName,
          label: themeName.charAt(0).toUpperCase() + themeName.slice(1),
        })),
      }
      const projectColorThemeSetting: SettingDefinition = {
        key: SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY,
        label: "Project Color Theme",
        description: "Color for this project in the current dmux session. Auto picks an unused color; inherit follows the project's saved/default theme.",
        type: "select",
        scopeBehavior: "session",
        options: [
          { value: AUTO_SIDEBAR_PROJECT_COLOR_THEME_VALUE, label: "Auto" },
          { value: "", label: "Inherit Default Theme" },
          ...DMUX_THEME_NAMES.map((themeName) => ({
            value: themeName,
            label: themeName.charAt(0).toUpperCase() + themeName.slice(1),
          })),
        ],
      }
      const currentSessionProjectThemeSetting = getSidebarProjectColorThemeSettingValue(
        sidebarProjects,
        resolvedProjectRoot,
        resolveSavedProjectTheme
      )
      const insertIndex = colorThemeSettingIndex === -1
        ? settingDefinitions.length
        : colorThemeSettingIndex
      settingDefinitions.splice(
        insertIndex,
        0,
        defaultColorThemeSetting,
        projectColorThemeSetting
      )

      let settingsPopupWidth = 84
      try {
        // Use tmux client dimensions, not the dmux pane's stdout width.
        const dims = await TmuxService.getInstance().getAllDimensions()
        const maxAvailableWidth = dims.clientWidth - this.config.sidebarWidth - 2
        settingsPopupWidth = Math.max(70, Math.min(84, maxAvailableWidth))
      } catch {
        // Keep a wider fallback and never regress below the previous fixed width.
        settingsPopupWidth = 84
      }
      const result = await this.launchPopup<any>(
        "settingsPopup.js",
        [],
        {
          width: settingsPopupWidth,
          height: Math.min(25, settingDefinitions.length + 8),
          title: "⚙️  Settings",
          themeName: effectiveProjectTheme,
        },
        {
          settingDefinitions,
          settings: {
            ...settingsManager.getSettings(),
            [DEFAULT_COLOR_THEME_SETTING_KEY]:
              settingsManager.getGlobalSettings().colorTheme
              ?? settingsManager.getTeamDefaults().colorTheme
              ?? DEFAULT_DMUX_THEME,
            [SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY]:
              currentSessionProjectThemeSetting
              || settingsManager.getProjectSettings().colorTheme
              || "",
          } as Record<string, unknown>,
          globalSettings: settingsManager.getGlobalSettings(),
          projectSettings: settingsManager.getProjectSettings(),
          projectRoot: resolvedProjectRoot,
          controlPaneId: this.config.controlPaneId,
        },
        resolvedProjectRoot
      )

      if (result.success) {
        const data = result.data ?? {}
        const pendingUpdates = Array.isArray(data.updates)
          ? data.updates.filter(
              (update: any) =>
                typeof update?.key === "string"
                && (
                  update?.scope === "global"
                  || update?.scope === "project"
                  || update?.scope === "session"
                )
            )
          : []

        // Check if this is an action result
        if (data.action === "hooks") {
          await onLaunchHooks()
          return pendingUpdates.length > 0 ? { updates: pendingUpdates } : null
        }

        if (data.action === "enabledAgents") {
          const enabledAgentsUpdate = await this.launchEnabledAgentsPopup(resolvedProjectRoot)
          if (enabledAgentsUpdate) {
            pendingUpdates.push(enabledAgentsUpdate)
          }
          return pendingUpdates.length > 0 ? { updates: pendingUpdates } : null
        }

        if (data.action === "enabledNotificationSounds") {
          const notificationSoundsUpdate = await this.launchNotificationSoundsPopup(resolvedProjectRoot)
          if (notificationSoundsUpdate) {
            pendingUpdates.push(notificationSoundsUpdate)
          }
          return pendingUpdates.length > 0 ? { updates: pendingUpdates } : null
        }

        if (
          typeof data.key === "string"
          && (
            data.scope === "global"
            || data.scope === "project"
            || data.scope === "session"
          )
        ) {
          if (pendingUpdates.length > 0) {
            return {
              updates: [
                ...pendingUpdates,
                { key: data.key, value: data.value, scope: data.scope },
              ],
            }
          }
          return { key: data.key, value: data.value, scope: data.scope }
        }

        if (pendingUpdates.length > 0) {
          return { updates: pendingUpdates }
        }
      }
      return null
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchEnabledAgentsPopup(
    projectRoot?: string
  ): Promise<{
    key: "enabledAgents";
    value: AgentName[];
    scope: "global" | "project";
  } | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const settings = this.getSettingsManager(projectRoot).getSettings()
      const configuredEnabled = resolveEnabledAgentsSelection(settings.enabledAgents)
      const definitions = getAgentDefinitions().map((definition) => ({
        id: definition.id,
        name: definition.name,
        defaultEnabled: definition.defaultEnabled,
      }))

      const result = await this.launchPopup<{
        enabledAgents: AgentName[];
        scope: "global" | "project";
      }>(
        "enabledAgentsPopup.js",
        [],
        {
          width: 74,
          height: Math.min(30, definitions.length + 12),
          title: "Enabled Agents",
        },
        {
          agents: definitions,
          enabledAgents: configuredEnabled,
        },
        projectRoot
      )

      const data = this.handleResult(result)
      if (!data) return null

      return {
        key: "enabledAgents",
        value: data.enabledAgents,
        scope: data.scope,
      }
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchNotificationSoundsPopup(
    projectRoot?: string
  ): Promise<{
    key: "enabledNotificationSounds";
    value: NotificationSoundId[];
    scope: "global" | "project";
  } | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const settings = this.getSettingsManager(projectRoot).getSettings()
      const configuredEnabled = resolveNotificationSoundsSelection(settings.enabledNotificationSounds)
      const definitions = getNotificationSoundDefinitions().map((definition) => ({
        id: definition.id,
        label: definition.label,
        defaultEnabled: definition.defaultEnabled,
      }))

      const result = await this.launchPopup<{
        enabledNotificationSounds: NotificationSoundId[];
        scope: "global" | "project";
      }>(
        "notificationSoundsPopup.js",
        [],
        {
          width: 76,
          height: Math.min(30, definitions.length + 12),
          title: "Notification Sounds",
        },
        {
          sounds: definitions,
          enabledNotificationSounds: configuredEnabled,
        },
        projectRoot
      )

      const data = this.handleResult(result)
      if (!data) return null

      return {
        key: "enabledNotificationSounds",
        value: data.enabledNotificationSounds,
        scope: data.scope,
      }
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }


  async launchChoicePopup(
    title: string,
    message: string,
    options: Array<{
      id: string
      label: string
      description?: string
      danger?: boolean
      default?: boolean
    }>,
    data?: unknown,
    projectRoot?: string
  ): Promise<string | null> {
    if (!this.checkPopupSupport()) return null

    try {
      if (isMergeUncommittedChoiceData(data)) {
        const result = await this.launchPopup<string>(
          "mergeUncommittedChoicePopup.js",
          [],
          {
            width: 94,
            height: 30,
            title: title || "Uncommitted Changes",
          },
          {
            title,
            message,
            options,
            ...data,
          },
          projectRoot
        )

        return this.handleResult(result)
      }

      const isConflictAgentChoice =
        /conflict resolution/i.test(title || "") &&
        options.length > 0 &&
        options.every((option) => isAgentName(option.id))

      if (isConflictAgentChoice) {
        const result = await this.launchPopup<string>(
          "singleAgentChoicePopup.js",
          [],
          {
            width: 72,
            height: Math.max(12, Math.min(20, options.length + 8)),
            title: title || "Choose Agent",
          },
          {
            title,
            message,
            options: options.map((option) => ({
              id: option.id,
              label: option.label,
              description: option.description,
              default: option.default,
            })),
          },
          projectRoot
        )

        return this.handleResult(result)
      }

      const messageLines = message.split("\n").reduce((count, line) => {
        return count + Math.max(1, Math.ceil(line.length / 65))
      }, 0)
      const optionLines = options.reduce((count, option, index) => {
        const optionRowHeight = option.description ? 2 : 1
        const optionSpacing = index < options.length - 1 ? 1 : 0
        return count + optionRowHeight + optionSpacing
      }, 0)
      const maxHeight = Math.max(12, Math.min(35, this.config.terminalHeight - 4))
      const calculatedHeight = Math.max(
        12,
        Math.min(maxHeight, messageLines + optionLines + 6)
      )

      const result = await this.launchPopup<string>(
        "choicePopup.js",
        [],
        {
          width: 70,
          height: calculatedHeight,
          title: title || "Choose Option",
        },
        { title, message, options },
        projectRoot
      )

      return this.handleResult(result)
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchProjectSelectPopup(
    defaultValue?: string,
    projectRoot?: string
  ): Promise<string | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const result = await this.launchPopup<string>(
        "projectSelectPopup.js",
        [],
        {
          width: 80,
          height: 25,
          title: "  Select Project  ",
          positioning: "centered",
        },
        { defaultValue: defaultValue || "" },
        projectRoot || defaultValue
      )

      this.ignoreInputBriefly()
      return this.handleResult(result)
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchPRReviewPopup(
    data: {
      title: string
      message: string
      defaultValue: string
      repoPath: string
      sourceBranch: string
      targetBranch: string
      files: string[]
      aiFailed?: boolean
    },
    projectRoot?: string
  ): Promise<string | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const sidebar = this.config.sidebarWidth
      const client = TmuxService.getInstance().getTerminalDimensionsSync()
      const clientWidth = client.width || this.config.terminalWidth
      const clientHeight = client.height || this.config.terminalHeight
      const available = Math.max(0, clientWidth - sidebar - 2)
      const width = Math.max(72, Math.floor(available * 0.4))
      const height = Math.max(24, Math.min(clientHeight - 2, 48))

      const result = await this.launchPopup<string>(
        "prReviewPopup.js",
        [],
        {
          width,
          height,
          title: data.title || "Pull Request",
        },
        data,
        projectRoot
      )

      return this.handleResult(result)
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchInputPopup(
    title: string,
    message: string,
    placeholder?: string,
    defaultValue?: string,
    projectRoot?: string,
    maxVisibleLines?: number
  ): Promise<string | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const messageLines = message ? message.split("\n").length : 1
      const scrollable = typeof maxVisibleLines === "number" && maxVisibleLines > 0

      // Overhead: borders(2) + container padding(2) + input border(2) + input padding(0) +
      // section spacing(1) + input bottom margin(1) + help line(1) + safety(1) = ~10
      const overhead = 10
      const inputLines = scrollable ? maxVisibleLines! : 1
      const desiredHeight = messageLines + inputLines + overhead
      const maxHeight = Math.max(10, this.config.terminalHeight - 2)
      const height = Math.min(maxHeight, Math.max(15, desiredHeight))

      const desiredWidth = scrollable
        ? Math.min(this.config.terminalWidth - this.config.sidebarWidth - 4, 100)
        : 70
      const width = Math.max(50, desiredWidth)

      const result = await this.launchPopup<string>(
        "inputPopup.js",
        [],
        {
          width,
          height,
          title: title || "Input",
        },
        { title, message, placeholder, defaultValue, maxVisibleLines },
        projectRoot
      )

      return this.handleResult(result)
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }

  async launchProgressPopup(
    message: string,
    type: "info" | "success" | "error" = "info",
    timeout: number = 2000,
    projectRoot?: string
  ): Promise<void> {
    if (!this.config.popupsSupported) {
      this.showTempMessage(message, timeout)
      return
    }

    try {
      const lines = Math.ceil(message.length / 60) + 3
      const titleText =
        type === "success"
          ? "✓ Success"
          : type === "error"
          ? "✗ Error"
          : "ℹ Info"

      await this.launchPopup<void>(
        "progressPopup.js",
        [],
        {
          width: 70,
          height: Math.min(15, lines + 4),
          title: titleText,
        },
        { message, type, timeout },
        projectRoot
      )
    } catch (error: any) {
      this.showTempMessage(message, timeout)
    }
  }

  async launchReopenWorktreePopup(
    worktrees: Array<{
      branchName: string
      slug?: string
      path?: string
      lastModified?: Date
      hasUncommittedChanges: boolean
      hasWorktree: boolean
      hasLocalBranch: boolean
      hasRemoteBranch: boolean
      isRemote: boolean
    }>,
    projectRoot?: string,
    initialState: ReopenWorktreePopupState = {
      includeWorktrees: true,
      includeLocalBranches: true,
      includeRemoteBranches: true,
      remoteLoaded: false,
      filterQuery: "",
    },
    activePaneSlugs: string[] = []
  ): Promise<ReopenWorktreePopupResult | null> {
    if (!this.checkPopupSupport()) return null

    try {
      const popupProjectRoot = projectRoot || this.config.projectRoot
      const popupProjectName = path.basename(popupProjectRoot) || popupProjectRoot
      const maxVisibleRows = 8

      const worktreesData = worktrees.map((wt) => ({
        ...wt,
        lastModified: wt.lastModified?.toISOString(),
      }))

      const result = await this.launchPopup<ReopenWorktreePopupResult>(
        "reopenWorktreePopup.js",
        [],
        {
          width: 78,
          height: Math.max(25, Math.min(28, Math.min(worktrees.length, maxVisibleRows) + 17)),
          title: `Resume Branch: ${popupProjectName}`,
        },
        {
          projectName: popupProjectName,
          worktrees: worktreesData,
          initialState,
          projectRoot: popupProjectRoot,
          activePaneSlugs,
        },
        projectRoot
      )

      return this.handleResult(result)
    } catch (error: any) {
      this.showTempMessage(`Failed to launch popup: ${error.message}`)
      return null
    }
  }
}
