import React, { memo } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { Toast } from '../../services/ToastService.js';
import ToastNotification from './ToastNotification.js';

interface FooterHelpProps {
  show: boolean;
  gridInfo?: string;
  footerTip?: string;
  quitConfirmMode?: boolean;
  unreadErrorCount?: number;
  unreadWarningCount?: number;
  currentToast?: Toast | null;
  toastQueueLength?: number;
  toastQueuePosition?: number | null;
}

const FooterHelp: React.FC<FooterHelpProps> = memo(({
  show,
  gridInfo,
  footerTip,
  quitConfirmMode = false,
  unreadErrorCount = 0,
  unreadWarningCount = 0,
  currentToast,
  toastQueueLength = 0,
  toastQueuePosition
}) => {
  if (!show) return null;

  if (quitConfirmMode) {
    return (
      <Box marginTop={1}>
        <Text color="yellow" bold>
          Press Ctrl+C again to exit
        </Text>
      </Box>
    );
  }

  const hasErrors = unreadErrorCount > 0;
  const hasWarnings = unreadWarningCount > 0;

  // Divider component - uses borderStyle for full width
  const Divider = () => (
    <Box borderStyle="single" borderColor="gray" borderTop={false} borderLeft={false} borderRight={false} borderBottom={true} />
  );

  // Calculate toast height to reserve proper space (including header)
  const getToastHeight = () => {
    if (!currentToast) {
      // If no current toast but we have queued toasts, just show header (1 line)
      return toastQueueLength > 0 ? 1 : 0;
    }

    // Toast format: "✓ message"
    const iconAndSpaceWidth = 2;
    const toastTextWidth = iconAndSpaceWidth + stringWidth(currentToast.message);

    // Available width (sidebar is 40, minus some padding)
    const availableWidth = 38;
    const wrappedLines = Math.ceil(toastTextWidth / availableWidth);

    // Add 1 for header line
    return wrappedLines + 1;
  };

  const toastHeight = getToastHeight();

  // Generate notifications header with dynamic dashes
  const renderNotificationsHeader = () => {
    const totalCount = (currentToast ? 1 : 0) + toastQueueLength;
    if (totalCount === 0) return null;

    const countText = `(${totalCount})`;
    const label = 'Notifications';

    // Sidebar width is 40, calculate dashes to fill the line
    const sidebarWidth = 40;
    const contentLength = label.length + countText.length; // "Notifications(4)"
    const totalDashes = sidebarWidth - contentLength;

    // Distribute dashes: left (1) + middle + right (1)
    const leftDashes = 1;
    const rightDashes = 1;
    const middleDashes = Math.max(0, totalDashes - leftDashes - rightDashes);

    return (
      <Text dimColor>
        {'─'.repeat(leftDashes)}{label}{'─'.repeat(middleDashes)}{countText}{'─'.repeat(rightDashes)}
      </Text>
    );
  };

  // Check if we should show the notifications section
  const hasNotifications = currentToast !== null || toastQueueLength > 0;

  return (
    <Box flexDirection="column">
      {/* Toast notification section - show header even when transitioning between toasts */}
      {hasNotifications ? (
        <Box height={toastHeight} marginBottom={1} flexDirection="column">
          {renderNotificationsHeader()}
          {currentToast && (
            <ToastNotification
              toast={currentToast}
              queuePosition={toastQueuePosition}
              totalInQueue={toastQueueLength}
            />
          )}
        </Box>
      ) : null}

      {/* Logs section with top border */}
      <Divider />
      <Box justifyContent="space-between">
        <Text>
          <Text>🪵 </Text>
          <Text color="cyan">[l]</Text>
          <Text bold>ogs</Text>
          <Text dimColor>  •  </Text>
          <Text color="cyan">[p]</Text>
          <Text bold>rojects</Text>
        </Text>
        {(hasErrors || hasWarnings) && (
          <Text>
            {hasErrors && <Text color="red" bold>{unreadErrorCount}</Text>}
            {hasErrors && hasWarnings && <Text dimColor> | </Text>}
            {hasWarnings && <Text color="yellow" bold>{unreadWarningCount}</Text>}
            <Text> </Text>
          </Text>
        )}
      </Box>

      {/* Keyboard shortcuts */}
      <Text dimColor>
        Press <Text color="cyan">[?]</Text> for keyboard shortcuts
      </Text>

      {footerTip && (
        <Text dimColor wrap="truncate-end">
          <Text color="green">Tip:</Text> {footerTip}
        </Text>
      )}

      {/* Debug info */}
      {gridInfo && (
        <Text dimColor>{gridInfo}</Text>
      )}
    </Box>
  );
});

export default FooterHelp;
