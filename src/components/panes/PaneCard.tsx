import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { DmuxPane } from '../../types.js';
import { COLORS } from '../../theme/colors.js';

interface PaneCardProps {
  pane: DmuxPane;
  selected: boolean;
  isFirstPane: boolean;
  isLastPane: boolean;
  isNextSelected: boolean;
  siblingCount: number;
}

const PaneCard: React.FC<PaneCardProps> = memo(({ pane, selected, isFirstPane, isLastPane, isNextSelected, siblingCount }) => {
  // Get status indicator
  const getStatusIcon = () => {
    if (pane.agentStatus === 'working') return { icon: '✻', color: COLORS.working };
    if (pane.agentStatus === 'analyzing') return { icon: '⟳', color: COLORS.analyzing };
    if (pane.agentStatus === 'waiting') return { icon: '⚠', color: COLORS.waiting };
    if (pane.testStatus === 'running') return { icon: '⏳', color: COLORS.warning };
    if (pane.testStatus === 'failed') return { icon: '✗', color: COLORS.error };
    if (pane.testStatus === 'passed') return { icon: '✓', color: COLORS.success };
    if (pane.devStatus === 'running') return { icon: '▶', color: COLORS.success };
    return { icon: '◌', color: COLORS.border };
  };

  const status = getStatusIcon();
  const borderColor = selected ? COLORS.borderSelected : COLORS.border;
  const bottomBorderColor = (selected || isNextSelected) ? COLORS.borderSelected : COLORS.border;
  const lineWidth = 38; // 40 - 2 for border characters
  const contentWidth = 36; // 38 - 2 for spaces after borders

  return (
    <Box flexDirection="column" width="100%">
      {isFirstPane && (
        <Box>
          <Text color={borderColor}>╭</Text>
          <Text color={borderColor}>{'─'.repeat(lineWidth)}</Text>
          <Text color={borderColor}>╮</Text>
        </Box>
      )}
      <Box width={40}>
        <Text color={borderColor}>│ </Text>
        <Box width={contentWidth}>
          <Text color={status.color}>{status.icon} </Text>
          <Text color={selected ? COLORS.selected : COLORS.unselected} bold={selected}>
            {pane.slug.substring(0, 25)}
          </Text>
          {pane.type === 'shell' ? (
            <Text color="cyan"> [{pane.shellType || 'shell'}]</Text>
          ) : pane.agent && (
            <Text color="gray"> [{pane.agent === 'claude' ? 'cc' : 'oc'}]</Text>
          )}
          {pane.autopilot && (
            <Text color={COLORS.success}> (ap)</Text>
          )}
          {siblingCount > 0 && (
            <Text color="gray"> ({siblingCount + 1})</Text>
          )}
        </Box>
        <Text color={borderColor}> │</Text>
      </Box>
      <Box>
        <Text color={bottomBorderColor}>{isLastPane ? '╰' : '├'}</Text>
        <Text color={bottomBorderColor}>{'─'.repeat(lineWidth)}</Text>
        <Text color={bottomBorderColor}>{isLastPane ? '╯' : '┤'}</Text>
      </Box>
    </Box>
  );
}, (prevProps, nextProps) => {
  // Custom comparison for memoization - only re-render if relevant props changed
  return (
    prevProps.pane.id === nextProps.pane.id &&
    prevProps.pane.slug === nextProps.pane.slug &&
    prevProps.pane.agentStatus === nextProps.pane.agentStatus &&
    prevProps.pane.testStatus === nextProps.pane.testStatus &&
    prevProps.pane.devStatus === nextProps.pane.devStatus &&
    prevProps.pane.autopilot === nextProps.pane.autopilot &&
    prevProps.pane.type === nextProps.pane.type &&
    prevProps.pane.shellType === nextProps.pane.shellType &&
    prevProps.pane.agent === nextProps.pane.agent &&
    prevProps.selected === nextProps.selected &&
    prevProps.isFirstPane === nextProps.isFirstPane &&
    prevProps.isLastPane === nextProps.isLastPane &&
    prevProps.isNextSelected === nextProps.isNextSelected &&
    prevProps.siblingCount === nextProps.siblingCount
  );
});

export default PaneCard;