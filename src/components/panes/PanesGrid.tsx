import React, { memo, useMemo } from "react"
import { Box, Text } from "ink"
import type { DmuxPane } from "../../types.js"
import type { AgentStatusMap } from "../../hooks/useAgentStatus.js"
import PaneCard from "./PaneCard.js"
import { COLORS } from "../../theme/colors.js"
import {
  buildProjectActionLayout,
  type ProjectActionItem,
} from "../../utils/projectActions.js"

interface PanesGridProps {
  panes: DmuxPane[]
  selectedIndex: number
  isLoading: boolean
  agentStatuses?: AgentStatusMap
  fallbackProjectRoot: string
  fallbackProjectName: string
}

const PanesGrid: React.FC<PanesGridProps> = memo(({
  panes,
  selectedIndex,
  isLoading,
  agentStatuses,
  fallbackProjectRoot,
  fallbackProjectName,
}) => {
  const actionLayout = useMemo(
    () => buildProjectActionLayout(panes, fallbackProjectRoot, fallbackProjectName),
    [panes, fallbackProjectRoot, fallbackProjectName]
  )
  const paneGroups = actionLayout.groups

  // Compute sibling count map: how many other panes share the same worktree
  const siblingCountMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const pane of panes) {
      if (!pane.worktreePath) continue
      const count = panes.filter(p => p.worktreePath === pane.worktreePath).length - 1
      map.set(pane.id, count)
    }
    return map
  }, [panes])

  const actionsByProject = useMemo(() => {
    const map = new Map<string, { newAgent?: ProjectActionItem; terminal?: ProjectActionItem }>()
    for (const action of actionLayout.actionItems) {
      const entry = map.get(action.projectRoot) || {}
      if (action.kind === "new-agent") {
        entry.newAgent = action
      } else {
        entry.terminal = action
      }
      map.set(action.projectRoot, entry)
    }
    return map
  }, [actionLayout.actionItems])

  const renderActionLabel = (action: ProjectActionItem | undefined, label: "new-agent" | "terminal") => {
    if (!action) return null

    if (label === "new-agent") {
      if (action.hotkey === "n") {
        return <><Text color={COLORS.accent}>[n]</Text>ew agent</>
      }
      return <>new agent</>
    }

    if (action.hotkey === "t") {
      return <><Text color={COLORS.accent}>[t]</Text>erminal</>
    }
    return <>terminal</>
  }

  return (
    <Box flexDirection="column">
      {paneGroups.map((group, groupIndex) => (
        <Box key={group.projectRoot} flexDirection="column">
          {paneGroups.length > 1 && (
            <Box flexDirection="column">
              {groupIndex > 0 && (
                <Text color={COLORS.border}>{"─".repeat(40)}</Text>
              )}
              <Box width={40}>
                <Text color={COLORS.accent}> {group.projectName}</Text>
              </Box>
            </Box>
          )}

          {group.panes.map((entry, localIndex) => {
            const pane = entry.pane
            // Apply the runtime status to the pane
            const paneWithStatus = {
              ...pane,
              agentStatus: agentStatuses?.get(pane.id) || pane.agentStatus,
            }
            const paneIndex = entry.index
            const isSelected = selectedIndex === paneIndex
            const isFirstPane = localIndex === 0
            const isLastPane = localIndex === group.panes.length - 1
            const nextPaneIndex = group.panes[localIndex + 1]?.index
            const isNextSelected = nextPaneIndex !== undefined && selectedIndex === nextPaneIndex

            return (
              <PaneCard
                key={pane.id}
                pane={paneWithStatus}
                selected={isSelected}
                isFirstPane={isFirstPane}
                isLastPane={isLastPane}
                isNextSelected={isNextSelected}
                siblingCount={siblingCountMap.get(pane.id) || 0}
              />
            )
          })}

          {!isLoading && actionLayout.multiProjectMode && (() => {
            const groupActions = actionsByProject.get(group.projectRoot)
            const newAgentAction = groupActions?.newAgent
            const terminalAction = groupActions?.terminal

            if (!newAgentAction || !terminalAction) {
              return null
            }

            return (
              <Box marginTop={1} flexDirection="row" gap={1}>
                <Box
                  borderStyle="round"
                  borderColor={
                    selectedIndex === newAgentAction.index
                      ? COLORS.borderSelected
                      : COLORS.border
                  }
                  paddingX={1}
                >
                  <Text
                    color={
                      selectedIndex === newAgentAction.index
                        ? COLORS.success
                        : COLORS.border
                    }
                  >
                    +{" "}
                  </Text>
                  <Text
                    color={
                      selectedIndex === newAgentAction.index
                        ? COLORS.selected
                        : COLORS.unselected
                    }
                    bold={selectedIndex === newAgentAction.index}
                  >
                    {renderActionLabel(newAgentAction, "new-agent")}
                  </Text>
                </Box>
                <Box
                  borderStyle="round"
                  borderColor={
                    selectedIndex === terminalAction.index
                      ? COLORS.borderSelected
                      : COLORS.border
                  }
                  paddingX={1}
                >
                  <Text
                    color={
                      selectedIndex === terminalAction.index
                        ? COLORS.success
                        : COLORS.border
                    }
                  >
                    +{" "}
                  </Text>
                  <Text
                    color={
                      selectedIndex === terminalAction.index
                        ? COLORS.selected
                        : COLORS.unselected
                    }
                    bold={selectedIndex === terminalAction.index}
                  >
                    {renderActionLabel(terminalAction, "terminal")}
                  </Text>
                </Box>
              </Box>
            )
          })()}
        </Box>
      ))}

      {!isLoading && !actionLayout.multiProjectMode && (() => {
        const newAgentAction = actionLayout.actionItems.find((item) => item.kind === "new-agent")
        const terminalAction = actionLayout.actionItems.find((item) => item.kind === "terminal")

        if (!newAgentAction || !terminalAction) {
          return null
        }

        return (
        <Box marginTop={panes.length === 0 ? 1 : 0} flexDirection="row" gap={1}>
          <Box
            borderStyle="round"
            borderColor={
              selectedIndex === newAgentAction.index
                ? COLORS.borderSelected
                : COLORS.border
            }
            paddingX={1}
          >
            <Text
              color={
                selectedIndex === newAgentAction.index ? COLORS.success : COLORS.border
              }
            >
              +{" "}
            </Text>
            <Text
              color={
                selectedIndex === newAgentAction.index
                  ? COLORS.selected
                  : COLORS.unselected
              }
              bold={selectedIndex === newAgentAction.index}
            >
              <Text color={COLORS.accent}>[n]</Text>ew agent
            </Text>
          </Box>
          <Box
            borderStyle="round"
            borderColor={
              selectedIndex === terminalAction.index
                ? COLORS.borderSelected
                : COLORS.border
            }
            paddingX={1}
          >
            <Text
              color={
                selectedIndex === terminalAction.index
                  ? COLORS.success
                  : COLORS.border
              }
            >
              +{" "}
            </Text>
            <Text
              color={
                selectedIndex === terminalAction.index
                  ? COLORS.selected
                  : COLORS.unselected
              }
              bold={selectedIndex === terminalAction.index}
            >
              <Text color={COLORS.accent}>[t]</Text>erminal
            </Text>
          </Box>
        </Box>
        )
      })()}
    </Box>
  )
})

export default PanesGrid
