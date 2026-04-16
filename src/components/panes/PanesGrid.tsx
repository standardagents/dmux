import React, { memo, useMemo } from "react"
import { Box, Text } from "ink"
import stringWidth from "string-width"
import type { DmuxPane, SidebarProject } from "../../types.js"
import type { AgentStatusMap } from "../../hooks/useAgentStatus.js"
import PaneCard from "./PaneCard.js"
import { COLORS } from "../../theme/colors.js"
import Spinner from "../indicators/Spinner.js"
import {
  buildProjectActionLayout,
  type ProjectActionItem,
} from "../../utils/projectActions.js"
import { isActiveDevSourcePath } from "../../utils/devSource.js"

interface PanesGridProps {
  panes: DmuxPane[]
  selectedIndex: number
  isLoading: boolean
  themeName: string
  agentStatuses?: AgentStatusMap
  activeDevSourcePath?: string
  sidebarProjects: SidebarProject[]
  fallbackProjectRoot: string
  fallbackProjectName: string
  isProjectBusy?: (projectRoot: string) => boolean
}

const PROJECT_BUSY_FRAMES = ['◴', '◷', '◶', '◵']
const HEADER_WIDTH = 40

const PanesGrid: React.FC<PanesGridProps> = memo(({
  panes,
  selectedIndex,
  isLoading,
  themeName,
  agentStatuses,
  activeDevSourcePath,
  sidebarProjects,
  fallbackProjectRoot,
  fallbackProjectName,
  isProjectBusy,
}) => {
  const actionLayout = useMemo(
    () => buildProjectActionLayout(
      panes,
      sidebarProjects,
      fallbackProjectRoot,
      fallbackProjectName
    ),
    [panes, sidebarProjects, fallbackProjectRoot, fallbackProjectName]
  )
  const paneGroups = actionLayout.groups

  const actionsByProject = useMemo(() => {
    const map = new Map<
      string,
      {
        newAgent?: ProjectActionItem
        terminal?: ProjectActionItem
        removeProject?: ProjectActionItem
      }
    >()
    for (const action of actionLayout.actionItems) {
      const entry = map.get(action.projectRoot) || {}
      if (action.kind === "new-agent") {
        entry.newAgent = action
      } else if (action.kind === "terminal") {
        entry.terminal = action
      } else {
        entry.removeProject = action
      }
      map.set(action.projectRoot, entry)
    }
    return map
  }, [actionLayout.actionItems])

  // Determine which project group the current selection belongs to
  const activeProjectRoot = useMemo(() => {
    // Check if selection is a pane
    const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
    if (selectedPane) {
      const group = paneGroups.find(g => g.panes.some(e => e.index === selectedIndex))
      return group?.projectRoot
    }
    // Check if selection is an action item
    const selectedAction = actionLayout.actionItems.find(a => a.index === selectedIndex)
    return selectedAction?.projectRoot
  }, [selectedIndex, panes, paneGroups, actionLayout.actionItems])

  const renderActionRow = (
    actions: ProjectActionItem[],
    selIdx: number,
    isActiveGroup: boolean
  ) => {
    const renderLabel = (action: ProjectActionItem) => {
      const isSelected = selIdx === action.index
      const showHotkey = isActiveGroup && !!action.hotkey
      const baseColor = action.kind === "remove-project" ? "red" : COLORS.border
      const color = isSelected ? COLORS.selected : baseColor

      if (action.kind === "new-agent") {
        return showHotkey
          ? <Text color={color} bold={isSelected}><Text color="cyan">[n]</Text>ew agent</Text>
          : <Text color={color} bold={isSelected}>new agent</Text>
      }

      if (action.kind === "terminal") {
        return showHotkey
          ? <Text color={color} bold={isSelected}><Text color="cyan">[t]</Text>erminal</Text>
          : <Text color={color} bold={isSelected}>terminal</Text>
      }

      return showHotkey
        ? <Text color={color} bold={isSelected}><Text color="cyan">[R]</Text>emove</Text>
        : <Text color={color} bold={isSelected}>remove</Text>
    }

    return (
      <Box width={40} justifyContent="flex-end">
        {actions.map((action, index) => (
          <React.Fragment key={`${action.projectRoot}-${action.kind}`}>
            {index > 0 && <Text color={COLORS.border}>{"  "}</Text>}
            {renderLabel(action)}
          </React.Fragment>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {paneGroups.map((group, groupIndex) => (
        <Box key={group.projectRoot} flexDirection="column">
          {(() => {
            const isActive = activeProjectRoot === group.projectRoot
            const color = isActive ? COLORS.selected : COLORS.border
            const busy = isProjectBusy?.(group.projectRoot) ?? false
            const spinnerWidth = busy ? 2 : 0
            const nameSection = `⣿⣿ ${group.projectName} `
            const remaining = Math.max(
              0,
              HEADER_WIDTH - stringWidth(nameSection) - spinnerWidth
            )
            const fill = "⣿".repeat(remaining)
            return (
              <Text color={color}>
                <Text dimColor>⣿⣿</Text>
                <Text> {group.projectName} </Text>
                {busy && (
                  <>
                    <Spinner
                      color={isActive ? COLORS.selected : COLORS.accent}
                      frames={PROJECT_BUSY_FRAMES}
                      interval={70}
                    />
                    <Text> </Text>
                  </>
                )}
                <Text dimColor>{fill}</Text>
              </Text>
            )
          })()}

          {group.panes.map((entry) => {
            const pane = entry.pane
            // Apply the runtime status to the pane
            const paneWithStatus = {
              ...pane,
              agentStatus: agentStatuses?.get(pane.id) || pane.agentStatus,
            }
            const paneIndex = entry.index
            const isSelected = selectedIndex === paneIndex
            const isDevSource = isActiveDevSourcePath(
              pane.worktreePath,
              activeDevSourcePath
            )

            return (
              <PaneCard
                key={pane.id}
                pane={paneWithStatus}
                isDevSource={isDevSource}
                selected={isSelected}
                themeName={themeName}
              />
            )
          })}

          {!isLoading && actionLayout.multiProjectMode && (() => {
            const groupActions = actionsByProject.get(group.projectRoot)
            const actions = [
              groupActions?.newAgent,
              groupActions?.terminal,
              groupActions?.removeProject,
            ].filter((action): action is ProjectActionItem => !!action)

            if (actions.length === 0) {
              return null
            }

            return renderActionRow(
              actions,
              selectedIndex,
              activeProjectRoot === group.projectRoot
            )
          })()}

          {groupIndex < paneGroups.length - 1 && <Text>{" "}</Text>}
        </Box>
      ))}

      {!isLoading && !actionLayout.multiProjectMode && (() => {
        const actions = actionLayout.actionItems.filter(
          (item) => item.kind === "new-agent" || item.kind === "terminal"
        )

        if (actions.length === 0) {
          return null
        }

        return renderActionRow(actions, selectedIndex, true)
      })()}
    </Box>
  )
})

export default PanesGrid
