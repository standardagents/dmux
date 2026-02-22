#!/usr/bin/env node

/**
 * Standalone popup for creating a new dmux pane
 * Runs in a tmux popup modal and writes result to a file
 */

import React, { useState, useEffect } from "react"
import { render, Box, Text, useApp, useInput } from "ink"
import {
  PopupContainer,
  PopupInputBox,
  PopupWrapper,
  writeSuccessAndExit,
  FileList,
} from "./shared/index.js"
import { PopupFooters, POPUP_CONFIG } from "./config.js"
import CleanTextInput from "../inputs/CleanTextInput.js"
import { scanProjectFiles, fuzzyMatchFiles } from "../../utils/fileScanner.js"
import fs from "fs"
import path from "path"

const PROJECT_PATH_ARG = process.argv[3]
const FILE_SCAN_ROOT = PROJECT_PATH_ARG || process.cwd()
const PROJECT_NAME = path.basename(FILE_SCAN_ROOT)

// Debug logging to file
const DEBUG_LOG = path.join(FILE_SCAN_ROOT, '.dmux', 'file-picker-debug.log')
function debugLog(message: string, data?: any) {
  const timestamp = new Date().toISOString()
  const logLine = `[${timestamp}] ${message} ${data ? JSON.stringify(data, null, 2) : ''}\n`
  try {
    fs.appendFileSync(DEBUG_LOG, logLine)
  } catch (e) {
    // Ignore write errors
  }
}

const NewPanePopupApp: React.FC<{ resultFile: string }> = ({ resultFile }) => {
  const [prompt, setPrompt] = useState("")
  const { exit } = useApp()

  // File autocomplete state
  const [isFileListActive, setIsFileListActive] = useState(false)
  const [filteredFiles, setFilteredFiles] = useState<string[]>([])
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [atPosition, setAtPosition] = useState(-1) // Position of @ in text
  const [cursorPosition, setCursorPosition] = useState<number | undefined>(undefined)
  const [currentCursor, setCurrentCursor] = useState(0) // Track cursor position from CleanTextInput


  // Reset cursor position override after it's been applied
  useEffect(() => {
    if (cursorPosition !== undefined) {
      // Clear the override on next render to allow normal cursor movement
      const timer = setTimeout(() => setCursorPosition(undefined), 0);
      return () => clearTimeout(timer);
    }
  }, [cursorPosition]);

  // Detect @ and scan files (cursor-aware)
  useEffect(() => {
    debugLog('[@Detection] Running with:', {
      prompt,
      currentCursor,
      promptLength: prompt.length
    })

    // Find the @ symbol that is before the cursor position
    // Cursor position N means cursor is BETWEEN index N-1 and N
    // So we search backwards from index N-1
    let atBeforeCursor = -1
    for (let i = currentCursor - 1; i >= 0; i--) {
      if (prompt[i] === '@') {
        atBeforeCursor = i
        debugLog('[@Detection] Found @ at position:', { position: i })
        break
      }
    }

    if (atBeforeCursor !== -1) {
      // Get the text after @ (until space or end of string)
      const afterAt = prompt.slice(atBeforeCursor + 1)
      const match = afterAt.match(/^([^\s]*)/)
      const query = match ? match[1] : ''
      const endOfQuery = atBeforeCursor + 1 + query.length

      debugLog('[@Detection] After @:', {
        afterAt,
        query,
        atBeforeCursor,
        endOfQuery,
        cursorInRange: currentCursor >= atBeforeCursor && currentCursor <= endOfQuery
      })

      // Only show file list if cursor is within the @ reference
      if (currentCursor >= atBeforeCursor && currentCursor <= endOfQuery) {
        // Check if there's a space after the query (means reference is complete)
        const charAfterQuery = afterAt[query.length]
        const spacePosition = atBeforeCursor + 1 + query.length
        debugLog('[@Detection] charAfterQuery:', { char: charAfterQuery, spacePosition, currentCursor })

        // Only hide if:
        // 1. Query is not empty (has actual text)
        // 2. There's a space after the query
        // 3. Cursor is PAST the space (user moved beyond it)
        // This prevents hiding when user is still typing (cursor before/at the space)
        if (charAfterQuery === ' ' && query.length > 0 && currentCursor > spacePosition) {
          // Reference is complete (e.g., "@BUG.md "), and cursor has moved past it
          debugLog('[@Detection] Reference complete (cursor past space), hiding file list')
          setIsFileListActive(false)
          setFilteredFiles([])
          setAtPosition(-1)
          return
        }

        // User is actively typing a query, show file list
        debugLog('[@Detection] Showing file list for query:', { query })
        try {
          const { files } = scanProjectFiles(FILE_SCAN_ROOT)
          const matches = fuzzyMatchFiles(query, files)

          setFilteredFiles(matches)
          setAtPosition(atBeforeCursor)
          setIsFileListActive(true)
          setSelectedFileIndex(0) // Reset selection when files change
        } catch (error) {
          debugLog('[@Detection] Failed to scan files:', error)
          setFilteredFiles([])
          setIsFileListActive(false)
        }
      } else {
        // Cursor is outside the @ reference, hide file list
        debugLog('[@Detection] Cursor outside reference, hiding file list')
        setIsFileListActive(false)
        setFilteredFiles([])
        setAtPosition(-1)
      }
    } else {
      // No @ found before cursor, hide file list
      debugLog('[@Detection] No @ found before cursor')
      setIsFileListActive(false)
      setFilteredFiles([])
      setAtPosition(-1)
    }
  }, [prompt, currentCursor])

  // Handle keyboard navigation - runs BEFORE other handlers
  // This is critical: we need to intercept ESC for progressive behavior
  useInput((input, key) => {
    // Handle ESC with progressive behavior:
    // 1. If file list is active, dismiss it
    // 2. If text is present, clear it
    // 3. If no text, allow PopupWrapper to close the popup
    if (key.escape) {
      if (isFileListActive) {
        // Dismiss file list
        debugLog('[ESC] Dismissing file list');
        setIsFileListActive(false);
        setFilteredFiles([]);
        setAtPosition(-1);
        return; // Prevent further handling
      } else if (prompt.length > 0) {
        // Clear the text input
        debugLog('[ESC] Clearing text input');
        setPrompt('');
        return; // Prevent further handling (don't close popup)
      }
      // If no file list and no text, let PopupWrapper close the popup
      // (don't return, let the event propagate)
    }

    // Only handle other keys when file list is active
    if (!isFileListActive) {
      return; // Let CleanTextInput handle keys
    }

    // Arrow up - move selection up
    if (key.upArrow) {
      setSelectedFileIndex(prev => Math.max(0, prev - 1));
      return;
    }

    // Arrow down - move selection down
    if (key.downArrow) {
      setSelectedFileIndex(prev => Math.min(filteredFiles.length - 1, prev + 1));
      return;
    }

    // Tab or Enter - select file and insert it
    if (key.tab || key.return) {
      if (filteredFiles.length > 0 && selectedFileIndex < filteredFiles.length) {
        const selectedFile = filteredFiles[selectedFileIndex];

        // Replace the query after @ with the selected file path (keep the @)
        const beforeAt = prompt.slice(0, atPosition);
        const afterAt = prompt.slice(atPosition);
        const afterAtMatch = afterAt.match(/^@[^\s]*/);
        const queryLength = afterAtMatch ? afterAtMatch[0].length : 1;
        const afterQuery = prompt.slice(atPosition + queryLength);

        // Insert @filepath (with space after if there isn't one)
        const fileReference = '@' + selectedFile;
        const newPrompt = beforeAt + fileReference + (afterQuery.startsWith(' ') ? '' : ' ') + afterQuery;
        setPrompt(newPrompt);

        // Set cursor position to end of the inserted file reference
        const newCursorPos = beforeAt.length + fileReference.length;
        setCursorPosition(newCursorPos);

        // Reset file list
        setIsFileListActive(false);
        setFilteredFiles([]);
        setAtPosition(-1);
      }
      return;
    }
  });

  const handleSubmit = (value?: string) => {
    // Don't submit if file list is active (Enter should select file, not submit)
    if (isFileListActive) {
      return;
    }

    writeSuccessAndExit(resultFile, value || prompt, exit)
  }

  const shouldAllowCancel = () => {
    // Block cancel (ESC key) if:
    // 1. File list is currently active, OR
    // 2. There's text in the prompt
    // This runs BEFORE my useInput handler, so we check the current state
    debugLog('[shouldAllowCancel]', { isFileListActive, hasPrompt: prompt.length > 0 });

    if (isFileListActive) {
      debugLog('[shouldAllowCancel] Blocking cancel - file list is active');
      return false;
    }

    if (prompt.length > 0) {
      debugLog('[shouldAllowCancel] Blocking cancel - prompt has text');
      return false;
    }

    // Only allow cancel if no file list and no text
    debugLog('[shouldAllowCancel] Allowing cancel');
    return true;
  }

  return (
    <PopupWrapper
      resultFile={resultFile}
      allowEscapeToCancel={true}
      shouldAllowCancel={shouldAllowCancel}
    >
      <PopupContainer footer={PopupFooters.input()}>
        {/* Project context */}
        <Box marginBottom={0}>
          <Text dimColor>Project: </Text>
          <Text bold color="cyan">{PROJECT_NAME}</Text>
          <Text dimColor>  ({FILE_SCAN_ROOT})</Text>
        </Box>

        {/* Instructions */}
        <Box marginBottom={1}>
          <Text dimColor>Enter a prompt for your AI agent.</Text>
        </Box>

        {/* Input area with themed border */}
        <Box
          width="100%"
          borderStyle={POPUP_CONFIG.inputBorderStyle}
          borderColor={POPUP_CONFIG.inputBorderColor}
          paddingX={POPUP_CONFIG.inputPadding.x}
          paddingY={POPUP_CONFIG.inputPadding.y}
        >
          <CleanTextInput
            value={prompt}
            onChange={setPrompt}
            onSubmit={handleSubmit}
            placeholder="e.g., Add user authentication with JWT"
            maxWidth={76}
            maxVisibleLines={10}
            cursorPosition={cursorPosition}
            disableUpDownArrows={isFileListActive}
            disableEscape={isFileListActive}
            onCursorChange={setCurrentCursor}
            ignoreFocus={true}
          />
        </Box>

        {/* File list (shown when @ is detected) */}
        {isFileListActive && (
          <FileList
            files={filteredFiles}
            selectedIndex={selectedFileIndex}
            maxVisible={10}
          />
        )}
      </PopupContainer>
    </PopupWrapper>
  )
}

// Entry point
function main() {
  const resultFile = process.argv[2]

  if (!resultFile) {
    console.error("Error: Result file path required")
    process.exit(1)
  }

  render(<NewPanePopupApp resultFile={resultFile} />)
}

main()
