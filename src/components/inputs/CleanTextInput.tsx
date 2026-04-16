import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useFocus, useStdout } from 'ink';
import stringWidth from 'string-width';
import { wrapText, findCursorInWrappedLines, findCharIndexAtWidth, preprocessPastedContent } from '../../utils/input.js';

interface CleanTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (expandedValue?: string) => void;
  placeholder?: string;
  maxWidth?: number;
  maxVisibleLines?: number;
  cursorPosition?: number; // Optional cursor position override
  disableArrowKeys?: boolean; // Disable ALL arrow key navigation (for external controls)
  disableUpDownArrows?: boolean; // Disable only up/down arrows (for external controls)
  onCursorChange?: (position: number) => void; // Callback when cursor position changes
  disableEscape?: boolean; // Disable ESC key (for external controls)
  ignoreFocus?: boolean; // Always accept input regardless of focus state
  onCancel?: () => void; // Callback when Ctrl+C is pressed with empty input
}

interface PastedContent {
  id: number;
  content: string;
  lineCount: number;
  timestamp: number;
}

const CleanTextInput: React.FC<CleanTextInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  maxWidth: propMaxWidth,
  maxVisibleLines: propMaxVisibleLines,
  cursorPosition,
  disableArrowKeys = false,
  disableUpDownArrows = false,
  onCursorChange,
  disableEscape = false,
  ignoreFocus = false,
  onCancel
}) => {
  // Use id to maintain focus even when other components mount/unmount
  const { isFocused } = useFocus({ autoFocus: true, id: 'clean-text-input' });
  const [cursor, setCursor] = useState(value.length);
  const { stdout } = useStdout();
  const [pastedItems, setPastedItems] = useState<Map<number, PastedContent>>(new Map());
  const [nextPasteId, setNextPasteId] = useState(1);
  const [isProcessingPaste, setIsProcessingPaste] = useState(false);
  const [topVisibleLine, setTopVisibleLine] = useState(0);
  // Only ignore first input in production (not in tests)
  // Check for common test environment indicators
  const isTestEnvironment = process.env.NODE_ENV === 'test' || 
                           process.env.VITEST === 'true' || 
                           typeof process.env.VITEST !== 'undefined';
  const [ignoreNextInput, setIgnoreNextInput] = useState(!isTestEnvironment);
  
  // Paste buffering state
  const [pasteBuffer, setPasteBuffer] = useState<string>('');
  const [isPasting, setIsPasting] = useState(false);
  const [pasteTimeout, setPasteTimeout] = useState<NodeJS.Timeout | null>(null);
  const [inBracketedPaste, setInBracketedPaste] = useState(false);
  
  // Calculate available width for text (terminal width - borders - padding - prompt)
  // Subtract 2 for borders, 2 for padding, 2 for "> " prompt = 6 total
  // The prompt is always rendered separately, so we need to account for it
  // Use process.stdout.columns as fallback since useStdout might not update
  // Allow override via prop for popup usage
  const terminalWidth = process.stdout.columns || (stdout ? stdout.columns : 80);
  // Reduce by 1 more to prevent edge case where text exactly fills width
  const maxWidth = propMaxWidth || Math.max(20, terminalWidth - 7);

  // Keep cursor in bounds
  useEffect(() => {
    if (cursor > value.length) {
      setCursor(value.length);
    } else if (cursor < 0) {
      setCursor(0);
    }
  }, [value.length, cursor]);

  // Update cursor when cursorPosition prop changes
  useEffect(() => {
    if (cursorPosition !== undefined) {
      const boundedPosition = Math.max(0, Math.min(cursorPosition, value.length));
      setCursor(boundedPosition);
    }
  }, [cursorPosition, value.length]);

  // Notify parent when cursor changes
  useEffect(() => {
    onCursorChange?.(cursor);
  }, [cursor, onCursorChange]);

  // Enable bracketed paste mode with small delay to avoid blocking UI
  useEffect(() => {
    let bracketedPasteTimer: NodeJS.Timeout | null = null;
    
    if (isFocused) {
      // Small delay to let UI settle before enabling bracketed paste
      bracketedPasteTimer = setTimeout(() => {
        process.stdout.write('\x1b[?2004h');
      }, 10);
      
      // Clear the ignore flag after a short delay to allow normal input
      // In tests, the flag is already false, so no need to clear it
      if (!isTestEnvironment) {
        setTimeout(() => {
          setIgnoreNextInput(false);
        }, 50);
      }
    }
    
    return () => {
      if (bracketedPasteTimer) {
        clearTimeout(bracketedPasteTimer);
      }
      process.stdout.write('\x1b[?2004l');
      // Clean up paste timeout if component unmounts
      if (pasteTimeout) {
        clearTimeout(pasteTimeout);
      }
    };
  }, [isFocused, pasteTimeout]);

  // Preprocess pasted content to remove formatting artifacts
  const preprocessPastedContent = (input: string): string => {
    // Remove ANSI escape sequences (colors, cursor movements, etc)
    let cleaned = input.replace(/\x1b\[[0-9;]*m/g, ''); // Remove color codes
    cleaned = cleaned.replace(/\x1b\[[\d;]*[A-Za-z]/g, ''); // Remove cursor movements
    
    // Normalize line endings
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Check if this looks like code/JSON (has braces, brackets, or consistent indentation)
    const looksLikeCode = cleaned.match(/[{}\[\]]/) || 
                         cleaned.split('\n').some(line => line.startsWith('  ') || line.startsWith('\t'));
    
    if (looksLikeCode) {
      // For code/JSON, preserve formatting exactly
      return cleaned;
    }
    
    // For regular text, do more aggressive cleaning
    // Remove box drawing characters
    const boxChars = /[╭╮╰╯│─┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋]/g;
    cleaned = cleaned.replace(boxChars, '');
    
    // Split into lines for processing
    let lines = cleaned.split('\n');
    
    // Remove common prompt patterns and clean each line
    lines = lines.map(line => {
      // Remove leading prompt indicators
      line = line.replace(/^[>$#]\s+/, '');
      // Trim whitespace
      return line.trim();
    });
    
    // Remove empty lines at start and end
    while (lines.length > 0 && lines[0] === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    
    // Handle wrapped lines (lines that were split by terminal width)
    const unwrappedLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const currentLine = lines[i];
      const nextLine = lines[i + 1];
      
      // If current line doesn't end with punctuation and next line starts lowercase,
      // it's likely a wrapped line
      if (nextLine && 
          currentLine.length > 0 &&
          !currentLine.match(/[.!?;:,]$/) && 
          nextLine[0] && 
          nextLine[0] === nextLine[0].toLowerCase()) {
        // Join wrapped lines
        unwrappedLines.push(currentLine + ' ' + nextLine);
        i++; // Skip next line since we merged it
      } else {
        unwrappedLines.push(currentLine);
      }
    }
    
    return unwrappedLines.join('\n');
  };

  // Expand paste references to their actual content
  const expandPasteReferences = (text: string): string => {
    let expanded = text;
    const tagPattern = /\[#(\d+) Pasted, \d+ lines?\]/g;
    let match;
    
    while ((match = tagPattern.exec(text)) !== null) {
      const pasteId = parseInt(match[1]);
      const pastedContent = pastedItems.get(pasteId);
      
      if (pastedContent) {
        expanded = expanded.replace(match[0], pastedContent.content);
      }
    }
    
    return expanded;
  };

  // Process complete pasted content once buffering is done
  const processPastedContent = (fullContent: string) => {
    // Always preprocess pasted content
    const cleaned = preprocessPastedContent(fullContent);
    const lines = cleaned.split('\n');
    
    if (lines.length > 15) {
      // Large paste - create reference tag
      const pasteId = nextPasteId;
      const pasteRef: PastedContent = {
        id: pasteId,
        content: cleaned,
        lineCount: lines.length,
        timestamp: Date.now()
      };
      
      setPastedItems(prev => {
        const newMap = new Map(prev);
        newMap.set(pasteId, pasteRef);
        return newMap;
      });
      setNextPasteId(pasteId + 1);
      
      // Insert reference tag
      const tag = `[#${pasteId} Pasted, ${lines.length} lines]`;
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      onChange(before + tag + after);
      setCursor(cursor + tag.length);
    } else {
      // Small paste - insert cleaned content directly
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      onChange(before + cleaned + after);
      setCursor(cursor + cleaned.length);
    }
    
    // Reset paste state
    setPasteBuffer('');
    setIsPasting(false);
    setInBracketedPaste(false);
  };

  useInput((input, key) => {
    if (!isFocused && !ignoreFocus) {
      return;
    }

    // Note: Ctrl+C (SIGINT) is handled at the process level in newPanePopup, not here
    // This is because SIGINT bypasses Ink's input system

    // Escape clears (unless disabled by external control)
    if (key.escape) {
      if (!disableEscape) {
        onChange('');
        setCursor(0);
        return;
      }
    }

    // Shift+Enter adds newline
    if (key.return && key.shift) {
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      const newValue = before + '\n' + after;
      onChange(newValue);
      setCursor(cursor + 1);
      return;
    }

    // Enter submits with expanded content
    if (key.return) {
      const expandedValue = expandPasteReferences(value);
      onSubmit?.(expandedValue);
      return;
    }

    // Backspace deletes BEFORE cursor
    // IMPORTANT: Some terminals send 'delete' key when backspace is pressed
    // Handle both key.backspace and key.delete as backspace
    if (key.backspace || key.delete || input === '\x7f' || input === '\x08') {
      // Clear any paste state when delete is pressed
      if (isPasting) {
        setIsPasting(false);
        setPasteBuffer('');
        if (pasteTimeout) {
          clearTimeout(pasteTimeout);
          setPasteTimeout(null);
        }
      }
      
      if (cursor > 0) {
        const before = value.slice(0, cursor - 1);
        const after = value.slice(cursor);
        const newValue = before + after;
        onChange(newValue);
        setCursor(cursor - 1);
      }
      return;
    }

    // Forward delete (actual delete key behavior) - removed since we're treating delete as backspace
    // If you need forward delete, use a different key combination

    // Ctrl-A: Jump to beginning of current visual line
    if (key.ctrl && input === 'a') {
      const wrapped = wrapText(value, maxWidth);
      const currentPos = findCursorInWrappedLines(wrapped, cursor);
      
      // Find absolute position of start of current visual line
      let absolutePos = 0;
      for (let i = 0; i < currentPos.line; i++) {
        absolutePos += wrapped[i]!.line.length + wrapped[i]!.gapSize;
      }
      setCursor(absolutePos);
      return;
    }

    // Ctrl-E: Jump to end of current visual line
    if (key.ctrl && input === 'e') {
      const wrapped = wrapText(value, maxWidth);
      const currentPos = findCursorInWrappedLines(wrapped, cursor);
      
      // Find absolute position of end of current visual line
      let absolutePos = 0;
      for (let i = 0; i <= currentPos.line; i++) {
        absolutePos += wrapped[i]!.line.length;
        if (i < currentPos.line) {
          absolutePos += wrapped[i]!.gapSize;
        }
      }
      // For forced breaks (gapSize=0, not last line), cursor at lineLength
      // would map to the next line. Stay on the last character instead.
      const currentWrapped = wrapped[currentPos.line]!;
      const isLastLine = currentPos.line === wrapped.length - 1;
      if (currentWrapped.gapSize === 0 && !isLastLine && currentWrapped.line.length > 0) {
        absolutePos -= 1;
      }
      setCursor(Math.min(absolutePos, value.length));
      return;
    }

    // Left arrow
    if (key.leftArrow && !disableArrowKeys) {
      setCursor(Math.max(0, cursor - 1));
      return;
    }

    // Right arrow
    if (key.rightArrow && !disableArrowKeys) {
      setCursor(Math.min(value.length, cursor + 1));
      return;
    }

    // Up/Down arrows for navigation (works with both hard and soft wrapped lines)
    if ((key.upArrow || key.downArrow) && !disableArrowKeys && !disableUpDownArrows) {
      // Get wrapped lines to understand visual layout
      const wrapped = wrapText(value, maxWidth);
      const currentPos = findCursorInWrappedLines(wrapped, cursor);
      
      // Use display width for column tracking so mixed-width text
      // (CJK + ASCII) maintains the correct visual column position.
      const currentVisualCol = stringWidth(wrapped[currentPos.line]!.line.slice(0, currentPos.col));
      
      if (key.upArrow && currentPos.line > 0) {
        // Move up one visual line
        const targetLine = currentPos.line - 1;
        const targetWrapped = wrapped[targetLine]!;
        let targetCol = findCharIndexAtWidth(targetWrapped.line, currentVisualCol);
        // Cap for forced-break lines to stay on this line
        const isTargetLastLine = targetLine === wrapped.length - 1;
        if (targetWrapped.gapSize === 0 && !isTargetLastLine) {
          targetCol = Math.min(targetCol, Math.max(0, targetWrapped.line.length - 1));
        }
        
        // Convert back to absolute position
        let absolutePos = 0;
        for (let i = 0; i < targetLine; i++) {
          absolutePos += wrapped[i]!.line.length + wrapped[i]!.gapSize;
        }
        absolutePos += targetCol;
        setCursor(Math.min(absolutePos, value.length));
      } else if (key.downArrow && currentPos.line < wrapped.length - 1) {
        // Move down one visual line
        const targetLine = currentPos.line + 1;
        const targetWrapped = wrapped[targetLine]!;
        let targetCol = findCharIndexAtWidth(targetWrapped.line, currentVisualCol);
        // Cap for forced-break lines to stay on this line
        const isTargetLastLine = targetLine === wrapped.length - 1;
        if (targetWrapped.gapSize === 0 && !isTargetLastLine) {
          targetCol = Math.min(targetCol, Math.max(0, targetWrapped.line.length - 1));
        }
        
        // Convert back to absolute position
        let absolutePos = 0;
        for (let i = 0; i < targetLine; i++) {
          absolutePos += wrapped[i]!.line.length + wrapped[i]!.gapSize;
        }
        absolutePos += targetCol;
        setCursor(Math.min(absolutePos, value.length));
      }
      return;
    }

    // Regular text input with paste detection and buffering
    if (input && !key.ctrl && !key.meta) {
      // Ignore the first character input if flag is set (prevents 'n' from dmux menu)
      if (ignoreNextInput && input.length === 1) {
        setIgnoreNextInput(false);
        return;
      }
      
      // First, check if this looks like a malformed paste sequence we should ignore
      // Pattern: [200- or [201- followed by content (missing the ~)
      if (input.startsWith('[200-') || input.startsWith('[201-')) {
        // This is a malformed paste marker - strip it and process the rest as normal content
        const cleanedInput = input.replace(/^\[20[01]-/, '');
        if (cleanedInput) {
          // Process as a regular paste if it has content
          const hasNewlines = cleanedInput.includes('\n');
          const isVeryLong = cleanedInput.length > 10;
          if (hasNewlines || isVeryLong) {
            processPastedContent(cleanedInput);
            return;
          }
          // Otherwise treat as normal input
          const before = value.slice(0, cursor);
          const after = value.slice(cursor);
          onChange(before + cleanedInput + after);
          setCursor(cursor + cleanedInput.length);
        }
        return;
      }
      
      // Detect bracketed paste sequences - handle multiple formats
      const PASTE_START = '\x1b[200~';
      const PASTE_END = '\x1b[201~';
      // Also check for the pattern without escape char (some terminals strip it)
      const PASTE_START_ALT = '[200~';
      const PASTE_END_ALT = '[201~';
      
      // Check for bracketed paste markers (both formats)
      const hasPasteStart = input.includes(PASTE_START) || input.includes(PASTE_START_ALT);
      const hasPasteEnd = input.includes(PASTE_END) || input.includes(PASTE_END_ALT);
      
      // Handle bracketed paste mode
      if (hasPasteStart) {
        setInBracketedPaste(true);
        // Extract content after paste start marker (check both formats)
        let startIdx = -1;
        let markerLength = 0;
        
        if (input.includes(PASTE_START)) {
          startIdx = input.indexOf(PASTE_START);
          markerLength = PASTE_START.length;
        } else if (input.includes(PASTE_START_ALT)) {
          startIdx = input.indexOf(PASTE_START_ALT);
          markerLength = PASTE_START_ALT.length;
        }
        
        let endIdx = -1;
        if (hasPasteEnd) {
          if (input.includes(PASTE_END)) {
            endIdx = input.indexOf(PASTE_END);
          } else if (input.includes(PASTE_END_ALT)) {
            endIdx = input.indexOf(PASTE_END_ALT);
          }
        }
        
        const content = hasPasteEnd ? 
          input.substring(startIdx + markerLength, endIdx) :
          input.substring(startIdx + markerLength);
        setPasteBuffer(content);
        
        if (hasPasteEnd) {
          // Complete paste in single chunk
          processPastedContent(pasteBuffer + content);
          setPasteBuffer('');
          setInBracketedPaste(false);
        }
        return;
      }
      
      if (hasPasteEnd && inBracketedPaste) {
        // End of bracketed paste - check both formats
        let endIdx = -1;
        if (input.includes(PASTE_END)) {
          endIdx = input.indexOf(PASTE_END);
        } else if (input.includes(PASTE_END_ALT)) {
          endIdx = input.indexOf(PASTE_END_ALT);
        }
        
        if (endIdx >= 0) {
          const finalContent = input.substring(0, endIdx);
          processPastedContent(pasteBuffer + finalContent);
          setPasteBuffer('');
          setInBracketedPaste(false);
          return;
        }
      }
      
      if (inBracketedPaste) {
        // Continue buffering bracketed paste content
        setPasteBuffer(prev => prev + input);
        return;
      }
      
      // Detect non-bracketed paste (fallback for terminals without bracketed paste mode)
      // Exclude delete/backspace key sequences from paste detection
      const isDeleteSequence = input === '\x7f' || input === '\x08' || 
                              input.split('').every(c => c === '\x7f' || c === '\x08');
      
      // Better heuristics for paste detection:
      // - Must have newlines OR be quite long (>10 chars at once)
      // - Single chars or small groups (2-3) are likely fast typing
      // - Already in paste mode should continue
      const hasNewlines = input.includes('\n');
      const isVeryLong = input.length > 10;
      const isLikelyPaste = !isDeleteSequence && (
                           (hasNewlines && input.length > 2) ||  // Multi-line content
                           isVeryLong ||                          // Very long single chunk
                           (isPasting && input.length > 0));      // Continue existing paste
      
      if (isLikelyPaste && !inBracketedPaste) {
        // Clear any existing timeout
        if (pasteTimeout) {
          clearTimeout(pasteTimeout);
        }
        
        // Add to paste buffer
        setPasteBuffer(prev => prev + input);
        setIsPasting(true);
        
        // Set timeout to detect end of paste (when no more input arrives)
        const timeout = setTimeout(() => {
          // Process the complete buffered paste
          if (pasteBuffer || input) {
            processPastedContent(pasteBuffer + input);
          }
          setPasteBuffer('');
          setIsPasting(false);
        }, 100); // 100ms timeout to collect all chunks
        
        setPasteTimeout(timeout);
        return;
      }
      
      // Normal single character input (or fast typing)
      if (!isPasting && !inBracketedPaste) {
        const before = value.slice(0, cursor);
        const after = value.slice(cursor);
        onChange(before + input + after);
        setCursor(cursor + input.length);
      } else if (isPasting && !isLikelyPaste && !inBracketedPaste) {
        // If we're in paste mode but this doesn't look like a paste,
        // it's probably just fast typing - cancel paste mode
        if (pasteTimeout) {
          clearTimeout(pasteTimeout);
          setPasteTimeout(null);
        }
        setPasteBuffer('');
        setIsPasting(false);
        
        // Process as normal input
        const before = value.slice(0, cursor);
        const after = value.slice(cursor);
        onChange(before + input + after);
        setCursor(cursor + input.length);
      }
    }
  });

  // wrapText and findCursorInWrappedLines are imported from utils/input.ts

  // Helper to render text with highlighted paste tags
  const renderTextWithTags = (text: string, isInverse: boolean = false): React.ReactNode[] => {
    const tagPattern = /(\[#\d+ Pasted, \d+ lines?\])/g;
    const parts = text.split(tagPattern);
    
    return parts.map((part, i) => {
      if (part.match(tagPattern)) {
        // Render paste tag with special styling
        return <Text key={i} color="cyan" dimColor>{part}</Text>;
      }
      // Regular text
      return isInverse ? <Text key={i} inverse>{part}</Text> : <Text key={i}>{part}</Text>;
    });
  };

  // Memoize wrapped text to avoid recalculating on every render
  const wrappedLines = useMemo(() => wrapText(value, maxWidth), [value, maxWidth]);
  const hasMultipleLines = wrappedLines.length > 1;

  // Default to showing all lines if maxVisibleLines not specified
  const maxVisibleLines = propMaxVisibleLines || wrappedLines.length;

  // Find cursor position in wrapped lines
  const cursorPos = findCursorInWrappedLines(wrappedLines, cursor);

  // Update visible window when cursor moves outside it
  useEffect(() => {
    if (!propMaxVisibleLines) return; // No scrolling if maxVisibleLines not set

    const cursorLine = cursorPos.line;

    // If cursor is above the visible window, scroll up
    if (cursorLine < topVisibleLine) {
      setTopVisibleLine(cursorLine);
    }
    // If cursor is below the visible window, scroll down
    else if (cursorLine >= topVisibleLine + maxVisibleLines) {
      setTopVisibleLine(cursorLine - maxVisibleLines + 1);
    }
  }, [cursorPos.line, topVisibleLine, maxVisibleLines, propMaxVisibleLines]);

  // Calculate which lines to render (visible window)
  const visibleLines = wrappedLines.slice(topVisibleLine, topVisibleLine + maxVisibleLines);
  const hasMoreAbove = topVisibleLine > 0;
  const hasMoreBelow = topVisibleLine + maxVisibleLines < wrappedLines.length;

  if (value === '') {
    // Show cursor for empty input (no placeholder)
    return (
      <Box>
        <Box width={2}>
          <Text>{'> '}</Text>
        </Box>
        <Box>
          <Text inverse>{' '}</Text>
        </Box>
      </Box>
    );
  }

  // Render wrapped lines
  return (
    <Box flexDirection="column">
      {hasMoreAbove && (
        <Box>
          <Box width={2}>
            <Text dimColor>⋮ </Text>
          </Box>
          <Text dimColor italic>(scroll up for more)</Text>
        </Box>
      )}
      {visibleLines.map((wrappedLine, visibleIdx) => {
        const idx = visibleIdx + topVisibleLine; // Actual index in wrappedLines
        const isFirst = idx === 0;
        const hasCursor = idx === cursorPos.line;
        const line = wrappedLine.line;
        
        if (hasCursor) {
          // Ensure cursor position is valid
          const actualCol = Math.min(cursorPos.col, line.length);
          const before = line.slice(0, actualCol);
          const at = line[actualCol] || ' ';
          const after = line.slice(actualCol + 1);
          
          // Check if cursor is within a paste tag
          const tagPattern = /\[#\d+ Pasted, \d+ lines?\]/g;
          let match;
          let cursorInTag = false;
          
          while ((match = tagPattern.exec(line)) !== null) {
            if (actualCol >= match.index && actualCol < match.index + match[0].length) {
              cursorInTag = true;
              break;
            }
          }
          
          return (
            <Box key={idx}>
              <Box width={2}>
                <Text>{isFirst ? '> ' : '  '}</Text>
              </Box>
              <Box>
                {cursorInTag ? (
                  // Cursor is within a paste tag - render specially
                  <>
                    {renderTextWithTags(before)}
                    <Text inverse color="cyan">{at}</Text>
                    {renderTextWithTags(after)}
                  </>
                ) : (
                  // Normal rendering with tag highlighting
                  <>
                    {renderTextWithTags(before)}
                    <Text inverse>{at}</Text>
                    {renderTextWithTags(after)}
                  </>
                )}
              </Box>
            </Box>
          );
        }
        
        return (
          <Box key={idx}>
            <Box width={2}>
              <Text>{isFirst ? '> ' : '  '}</Text>
            </Box>
            <Box>
              {line ? renderTextWithTags(line) : <Text>{' '}</Text>}
            </Box>
          </Box>
        );
      })}
      {hasMoreBelow && (
        <Box>
          <Box width={2}>
            <Text dimColor>⋮ </Text>
          </Box>
          <Text dimColor italic>(scroll down for more)</Text>
        </Box>
      )}
    </Box>
  );
};

export default CleanTextInput;