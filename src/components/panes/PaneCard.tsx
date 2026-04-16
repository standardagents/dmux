import React, { memo } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { DmuxPane, DmuxThemeName } from '../../types.js';
import { COLORS } from '../../theme/colors.js';
import { getDmuxThemeAccent } from '../../theme/colors.js';
import { getAgentShortLabel } from '../../utils/agentLaunch.js';
import { getPaneDisplayName } from '../../utils/paneTitle.js';

interface PaneCardProps {
  pane: DmuxPane;
  isDevSource: boolean;
  selected: boolean;
  themeName?: string;
  projectThemeName?: DmuxThemeName;
}

const ROW_WIDTH = 40;
const RIGHT_COLUMN_WIDTH = 10;
const LEFT_COLUMN_WIDTH = ROW_WIDTH - RIGHT_COLUMN_WIDTH;

const clipToWidth = (value: string, maxWidth: number): string => {
  if (maxWidth <= 0) return '';
  if (stringWidth(value) <= maxWidth) return value;

  let clipped = '';
  let currentWidth = 0;

  for (const char of value) {
    const charWidth = stringWidth(char);
    if (currentWidth + charWidth > maxWidth) {
      break;
    }
    clipped += char;
    currentWidth += charWidth;
  }

  return clipped;
};

const PaneCard: React.FC<PaneCardProps> = memo(({
  pane,
  isDevSource,
  selected,
  projectThemeName,
}) => {
  // Get status indicator
  const getStatusIcon = () => {
    if (pane.agentStatus === 'working') return { icon: '✻', color: COLORS.working };
    if (pane.agentStatus === 'analyzing') return { icon: '⟳', color: COLORS.analyzing };
    if (pane.agentStatus === 'waiting') return { icon: '△', color: COLORS.waiting };
    if (pane.testStatus === 'running') return { icon: '⧖', color: COLORS.warning };
    if (pane.testStatus === 'failed') return { icon: '✗', color: COLORS.error };
    if (pane.testStatus === 'passed') return { icon: '✓', color: COLORS.success };
    if (pane.devStatus === 'running') return { icon: '▶', color: COLORS.success };
    return { icon: '◌', color: COLORS.border };
  };

  const status = getStatusIcon();
  const isFileBrowserPane = pane.type === 'shell' && pane.shellType === 'fb';
  const paneName = getPaneDisplayName(pane);

  // Right-aligned columns: [cc] = 4 chars, (ap) = 4 chars, space between = 1
  const hasAgent = pane.type === 'shell' || !!pane.agent;
  const agentTag = pane.type === 'shell'
    ? (pane.shellType || 'sh').substring(0, 2)
    : pane.agent ? getAgentShortLabel(pane.agent) : null;
  const apTag = pane.autopilot ? 'ap' : null;

  // Keep non-title segments fixed; only slug is allowed to clip.
  const prefix = selected ? '▸' : ' ';
  const statusText = `${status.icon} `;
  const attentionText = pane.needsAttention ? '! ' : '';
  const sourceText = isDevSource ? '★ ' : '';
  const hiddenText = pane.hidden ? ' (hidden)' : '';
  const agentText = hasAgent ? ` [${agentTag}]` : '     ';
  const autopilotText = apTag ? ` (${apTag})` : '     ';
  const shellPrefixText = isFileBrowserPane ? ' ' : '';
  const fixedLeftWidth = stringWidth(prefix + statusText + attentionText + sourceText + shellPrefixText + hiddenText);
  const maxSlugWidth = Math.max(0, LEFT_COLUMN_WIDTH - fixedLeftWidth);
  const slugText = clipToWidth(paneName, maxSlugWidth);
  const projectSelectedColor = projectThemeName
    ? getDmuxThemeAccent(projectThemeName)
    : COLORS.selected;
  const paneSelectedColor = pane.colorTheme
    ? getDmuxThemeAccent(pane.colorTheme)
    : projectSelectedColor;
  const slugColor = isFileBrowserPane
    ? 'cyan'
    : selected
      ? paneSelectedColor
      : COLORS.unselected;
  const shellTagColor = isFileBrowserPane ? 'yellow' : pane.type === 'shell' ? 'cyan' : 'gray';

  return (
    <Box width={ROW_WIDTH}>
      <Box width={LEFT_COLUMN_WIDTH}>
        <Text color={selected ? paneSelectedColor : COLORS.border}>{prefix}</Text>
        <Text color={status.color}>{statusText}</Text>
        {pane.needsAttention && (
          <Text color={COLORS.warning}>{attentionText}</Text>
        )}
        {isDevSource && (
          <Text color="yellow">{sourceText}</Text>
        )}
        {isFileBrowserPane && (
          <Text color="cyan">{shellPrefixText}</Text>
        )}
        <Text color={slugColor} bold={selected || isFileBrowserPane}>
          {slugText}
        </Text>
        {pane.hidden && (
          <Text color="yellow" dimColor>
            {hiddenText}
          </Text>
        )}
      </Box>
      <Box width={RIGHT_COLUMN_WIDTH} justifyContent="flex-end">
        {agentTag
          ? <Text color={shellTagColor}>{agentText}</Text>
          : <Text>{agentText}</Text>
        }
        {apTag
          ? <Text color={COLORS.success}>{autopilotText}</Text>
          : <Text>{autopilotText}</Text>
        }
      </Box>
    </Box>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.pane.id === nextProps.pane.id &&
    prevProps.pane.slug === nextProps.pane.slug &&
    prevProps.pane.displayName === nextProps.pane.displayName &&
    prevProps.pane.agentStatus === nextProps.pane.agentStatus &&
    prevProps.pane.needsAttention === nextProps.pane.needsAttention &&
    prevProps.pane.testStatus === nextProps.pane.testStatus &&
    prevProps.pane.devStatus === nextProps.pane.devStatus &&
    prevProps.pane.autopilot === nextProps.pane.autopilot &&
    prevProps.pane.hidden === nextProps.pane.hidden &&
    prevProps.pane.type === nextProps.pane.type &&
    prevProps.pane.shellType === nextProps.pane.shellType &&
    prevProps.pane.agent === nextProps.pane.agent &&
    prevProps.pane.colorTheme === nextProps.pane.colorTheme &&
    prevProps.isDevSource === nextProps.isDevSource &&
    prevProps.selected === nextProps.selected &&
    prevProps.themeName === nextProps.themeName &&
    prevProps.projectThemeName === nextProps.projectThemeName
  );
});

export default PaneCard;
