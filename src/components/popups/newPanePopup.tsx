#!/usr/bin/env node

/**
 * Standalone popup used by dmux when creating a new pane.
 *
 * Behavior:
 * - Captures the initial agent prompt (with @file autocomplete support).
 * - Optionally captures per-pane git overrides (base branch + branch/worktree name)
 *   when enabled by settings/caller.
 * - Writes a structured popup result payload to the provided result file.
 */

import React, { useState, useEffect, useRef } from "react"
import { render, Box, Text, useApp, useInput } from "ink"
import {
  PopupContainer,
  PopupWrapper,
  writeSuccessAndExit,
  FileList,
} from "./shared/index.js"
import { PopupFooters, POPUP_CONFIG } from "./config.js"
import CleanTextInput from "../inputs/CleanTextInput.js"
import InlineCursorInput from "../inputs/InlineCursorInput.js"
import { scanProjectFiles, fuzzyMatchFiles } from "../../utils/fileScanner.js"
import {
  BASE_BRANCH_ERROR_MESSAGE,
  clampSelectedIndex,
  filterBranches,
  getVisibleBranchWindow,
  isValidBaseBranchOverride,
  loadLocalBranchNames,
  resolveBaseBranchEnter,
} from "./newPaneGitOptions.js"
import {
  getNextNewPaneField,
  getPreviousNewPaneField,
  type NewPaneField,
} from "./newPaneFieldNavigation.js"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"

const PROJECT_PATH_ARG = process.argv[3]
const ENABLE_GIT_OPTIONS_ARG = process.argv[4] === '1'
const FILE_SCAN_ROOT = PROJECT_PATH_ARG || process.cwd()
const PROJECT_NAME = path.basename(FILE_SCAN_ROOT)
const ESC_CLEAR_CONFIRMATION_MS = 500

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

export const NewPanePopupApp: React.FC<{ resultFile: string }> = ({ resultFile }) => {
  const [prompt, setPrompt] = useState("")
  const [mode, setMode] = useState<'prompt' | 'gitOptions'>('prompt')
  const [baseBranch, setBaseBranch] = useState("")
  const [branchName, setBranchName] = useState("")
  const [activeGitField, setActiveGitField] = useState<'baseBranch' | 'branchName'>('baseBranch')
  const [availableBranches, setAvailableBranches] = useState<string[]>([])
  const [filteredBranches, setFilteredBranches] = useState<string[]>([])
  const [selectedBranchIndex, setSelectedBranchIndex] = useState(0)
  const [gitOptionsError, setGitOptionsError] = useState<string | null>(null)
  const [pendingClearEsc, setPendingClearEsc] = useState(false)
  const { exit } = useApp()
  const clearEscTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // File autocomplete state
  const [isFileListActive, setIsFileListActive] = useState(false)
  const [filteredFiles, setFilteredFiles] = useState<string[]>([])
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [atPosition, setAtPosition] = useState(-1) // Position of @ in text
  const [cursorPosition, setCursorPosition] = useState<number | undefined>(undefined)
  const [currentCursor, setCurrentCursor] = useState(0) // Track cursor position from CleanTextInput

  const getCurrentField = (): NewPaneField =>
    mode === 'prompt' ? 'prompt' : activeGitField

  const setCurrentField = (field: NewPaneField) => {
    if (field === 'prompt') {
      setMode('prompt')
      return
    }

    setMode('gitOptions')
    setActiveGitField(field)
  }

  const writeSuccessResult = () => {
    const trimmedBaseBranch = baseBranch.trim()
    if (!isValidBaseBranchOverride(trimmedBaseBranch, availableBranches)) {
      setGitOptionsError(BASE_BRANCH_ERROR_MESSAGE)
      return
    }

    const payload: { prompt: string; baseBranch?: string; branchName?: string } = {
      prompt,
    }

    const trimmedBranchName = branchName.trim()

    if (trimmedBaseBranch) payload.baseBranch = trimmedBaseBranch
    if (trimmedBranchName) payload.branchName = trimmedBranchName

    writeSuccessAndExit(resultFile, payload, exit)
  }

  useEffect(() => {
    if (!ENABLE_GIT_OPTIONS_ARG) {
      return
    }

    const branches = loadLocalBranchNames(FILE_SCAN_ROOT)
    setAvailableBranches(branches)
  }, [])

  useEffect(() => {
    if (mode !== 'gitOptions' || activeGitField !== 'baseBranch') {
      setFilteredBranches([])
      setSelectedBranchIndex(0)
      return
    }

    const matches = filterBranches(availableBranches, baseBranch)

    setFilteredBranches(matches)
    setSelectedBranchIndex((prev) => clampSelectedIndex(prev, matches.length))
  }, [mode, activeGitField, baseBranch, availableBranches])

  useEffect(() => {
    if (gitOptionsError) {
      setGitOptionsError(null)
    }
  }, [baseBranch, branchName])

  const resetPendingClearEsc = () => {
    if (clearEscTimeoutRef.current) {
      clearTimeout(clearEscTimeoutRef.current)
      clearEscTimeoutRef.current = null
    }
    setPendingClearEsc(false)
  }

  const armPendingClearEsc = () => {
    if (clearEscTimeoutRef.current) {
      clearTimeout(clearEscTimeoutRef.current)
    }

    setPendingClearEsc(true)
    clearEscTimeoutRef.current = setTimeout(() => {
      clearEscTimeoutRef.current = null
      setPendingClearEsc(false)
    }, ESC_CLEAR_CONFIRMATION_MS)
  }

  const updatePrompt = (nextPrompt: string) => {
    if (pendingClearEsc) {
      resetPendingClearEsc()
    }
    setPrompt(nextPrompt)
  }

  // Reset cursor position override after it's been applied
  useEffect(() => {
    if (cursorPosition !== undefined) {
      // Clear the override on next render to allow normal cursor movement
      const timer = setTimeout(() => setCursorPosition(undefined), 0);
      return () => clearTimeout(timer);
    }
  }, [cursorPosition]);

  useEffect(() => {
    return () => {
      if (clearEscTimeoutRef.current) {
        clearTimeout(clearEscTimeoutRef.current)
      }
    }
  }, [])

  // Detect @ and scan files (cursor-aware)
  useEffect(() => {
    if (mode !== 'prompt') {
      setIsFileListActive(false)
      setFilteredFiles([])
      setAtPosition(-1)
      return
    }

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
  }, [prompt, currentCursor, mode])

  // Handle keyboard navigation - runs BEFORE other handlers
  // This is critical: we need to intercept ESC for progressive behavior
  useInput((input, key) => {
    // Some terminals send BackTab as the raw escape sequence "\u001b[Z"
    // instead of setting key.shift+key.tab. Support both forms so
    // Shift+Tab reliably cycles fields in tmux popups.
    const isBackTab = input === '\u001b[Z' || (key.tab && key.shift)
    const isForwardTab = key.tab && !key.shift

    // Git-options mode has a different interaction model from the prompt editor:
    // - We cycle across prompt/base/branch with Tab and Shift+Tab
    // - Enter advances field -> submit (on second field)
    // - ESC backs out progressively (clear field -> switch field -> return to prompt)
    // This keeps behavior predictable and mirrors the "progressive ESC" style
    // used below in prompt mode.
    if (mode === 'gitOptions') {
      // ESC in git-options mode is intentionally layered:
      // 1) clear current field if it has text
      // 2) otherwise jump to the other field if that one has text
      // 3) otherwise return to prompt mode
      if (key.escape) {
        setGitOptionsError(null)
        if (activeGitField === 'baseBranch') {
          if (baseBranch.length > 0) {
            setBaseBranch('')
          } else if (branchName.length > 0) {
            setActiveGitField('branchName')
          } else {
            setMode('prompt')
          }
        } else {
          if (branchName.length > 0) {
            setBranchName('')
          } else if (baseBranch.length > 0) {
            setActiveGitField('baseBranch')
          } else {
            setMode('prompt')
          }
        }
        return
      }

      // Up navigates the branch list while base field is active.
      // Otherwise it focuses the base-branch field.
      if (key.upArrow) {
        if (activeGitField === 'baseBranch' && filteredBranches.length > 0) {
          setSelectedBranchIndex((prev) => Math.max(0, prev - 1))
          return
        }

        setActiveGitField('baseBranch')
        return
      }

      // Down navigates the branch list while base field is active.
      // If no list is active, it moves focus to branch-name field.
      if (key.downArrow) {
        if (activeGitField === 'baseBranch' && filteredBranches.length > 0) {
          setSelectedBranchIndex((prev) => Math.min(filteredBranches.length - 1, prev + 1))
          return
        }

        setActiveGitField('branchName')
        return
      }

      // Tab and Shift+Tab cycle across prompt/base/branch fields.
      if (isForwardTab || isBackTab) {
        const nextField = isForwardTab
          ? getNextNewPaneField(getCurrentField())
          : getPreviousNewPaneField(getCurrentField())
        setCurrentField(nextField)
        return
      }

      // Enter is a two-step action:
      // - on base field: accept highlighted/exact branch, then move to branch field
      // - on branch field: submit both overrides + prompt payload
      if (key.return) {
        if (activeGitField === 'baseBranch') {
          const resolution = resolveBaseBranchEnter({
            baseBranch,
            availableBranches,
            filteredBranches,
            selectedIndex: selectedBranchIndex,
          })

          if (!resolution.accepted) {
            setGitOptionsError(resolution.error || BASE_BRANCH_ERROR_MESSAGE)
            return
          }

          setBaseBranch(resolution.nextValue)
          setActiveGitField('branchName')
        } else {
          writeSuccessResult()
        }
        return
      }

      return
    }

    // Handle ESC with progressive behavior:
    // 1. If file list is active, dismiss it
    // 2. If text is present, arm a clear, then clear on a second ESC
    // 3. If no text, allow PopupWrapper to close the popup

    // With git options enabled, Tab/Shift+Tab also cycle into git fields
    // from the prompt editor when file autocomplete is not active.
    if (ENABLE_GIT_OPTIONS_ARG && !isFileListActive && (isForwardTab || isBackTab)) {
      const nextField = isForwardTab
        ? getNextNewPaneField(getCurrentField())
        : getPreviousNewPaneField(getCurrentField())
      setCurrentField(nextField)
      return
    }

    if (key.escape) {
      if (isFileListActive) {
        // Dismiss file list
        debugLog('[ESC] Dismissing file list');
        setIsFileListActive(false);
        setFilteredFiles([]);
        setAtPosition(-1);
        resetPendingClearEsc();
        return; // Prevent further handling
      } else if (prompt.length > 0) {
        if (pendingClearEsc) {
          debugLog('[ESC] Clearing text input after confirmation');
          updatePrompt('');
          return; // Prevent further handling (don't close popup)
        }

        debugLog('[ESC] Waiting for second ESC before clearing text input');
        armPendingClearEsc();
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
        updatePrompt(newPrompt);

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

    const nextPrompt = value || prompt
    updatePrompt(nextPrompt)

    if (ENABLE_GIT_OPTIONS_ARG) {
      setMode('gitOptions')
      setActiveGitField('baseBranch')
      return
    }

    writeSuccessAndExit(resultFile, { prompt: nextPrompt }, exit)
  }

  const shouldAllowCancel = () => {
    if (mode !== 'prompt') {
      return false
    }

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

  const branchWindow = getVisibleBranchWindow(filteredBranches, selectedBranchIndex)
  const hasHiddenAbove = branchWindow.startIndex > 0
  const hiddenAboveCount = branchWindow.startIndex
  const hiddenBelowCount = Math.max(0, filteredBranches.length - (branchWindow.startIndex + branchWindow.visibleBranches.length))
  const isBaseBranchInvalidLive =
    baseBranch.trim().length > 0 && !isValidBaseBranchOverride(baseBranch.trim(), availableBranches)
  const baseBranchBorderColor = isBaseBranchInvalidLive ? POPUP_CONFIG.errorColor : 'gray'

  return (
    <PopupWrapper
      resultFile={resultFile}
      allowEscapeToCancel={true}
      shouldAllowCancel={shouldAllowCancel}
    >
      <PopupContainer
        footer={mode === 'prompt'
          ? PopupFooters.input()
          : '↑↓ branch list • Tab/Shift+Tab cycle fields • Enter select/create • ESC progressive back'}
      >
        {mode === 'prompt' && (
          <>
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

            {pendingClearEsc && (
              <Box marginBottom={1}>
                <Text color={POPUP_CONFIG.titleColor}>Press Esc again to clear the prompt.</Text>
              </Box>
            )}

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
                onChange={updatePrompt}
                onSubmit={handleSubmit}
                placeholder="e.g., Add user authentication with JWT"
                maxWidth={76}
                maxVisibleLines={10}
                cursorPosition={cursorPosition}
                disableUpDownArrows={isFileListActive}
                disableEscape={true}
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
          </>
        )}

        {mode === 'gitOptions' && (
          <>
            <Box marginBottom={1}>
              <Text dimColor>Optional Git overrides for this pane.</Text>
            </Box>

            {gitOptionsError && (
              <Box marginBottom={1}>
                <Text color="red">{gitOptionsError}</Text>
              </Box>
            )}

            <Box marginBottom={1}>
              <Text dimColor>Prompt: </Text>
              <Text>{prompt.trim() || '(empty prompt)'}</Text>
            </Box>

            <Box marginBottom={0}>
              <Text color={activeGitField === 'baseBranch' ? POPUP_CONFIG.titleColor : 'white'}>
                {activeGitField === 'baseBranch' ? '▶ ' : '  '}Base branch override (optional)
              </Text>
            </Box>
            <Box
              width="100%"
              borderStyle={POPUP_CONFIG.inputBorderStyle}
              borderColor={baseBranchBorderColor}
              paddingX={POPUP_CONFIG.inputPadding.x}
              paddingY={POPUP_CONFIG.inputPadding.y}
              marginBottom={0}
              flexDirection="column"
            >
              <InlineCursorInput
                value={baseBranch}
                onChange={setBaseBranch}
                focus={activeGitField === 'baseBranch'}
                placeholder="e.g., develop"
              />

              {activeGitField === 'baseBranch' && filteredBranches.length > 0 && (
                <>
                  <Box marginBottom={0}>
                    <Text dimColor>
                      Existing branches ({filteredBranches.length}) - Use ↑↓ to navigate, Enter to pick
                    </Text>
                  </Box>

                  {hasHiddenAbove && (
                    <Box justifyContent="center">
                      <Text dimColor>↑ {hiddenAboveCount} more above</Text>
                    </Box>
                  )}

                  {branchWindow.visibleBranches.map((branch, index) => {
                    const actualIndex = branchWindow.startIndex + index
                    const isSelected = actualIndex === selectedBranchIndex
                    return (
                      <Box key={branch}>
                        <Text
                          color={isSelected ? 'black' : undefined}
                          backgroundColor={isSelected ? 'cyan' : undefined}
                          bold={isSelected}
                        >
                          {isSelected ? '▶ ' : '  '}{branch}
                        </Text>
                      </Box>
                    )
                  })}

                  {hiddenBelowCount > 0 && (
                    <Box justifyContent="center">
                      <Text dimColor>↓ {hiddenBelowCount} more below</Text>
                    </Box>
                  )}
                </>
              )}
            </Box>

            <Box marginBottom={0}>
              <Text color={activeGitField === 'branchName' ? POPUP_CONFIG.titleColor : 'white'}>
                {activeGitField === 'branchName' ? '▶ ' : '  '}Branch/worktree name override (optional)
              </Text>
            </Box>
            <Box
              width="100%"
              borderStyle={POPUP_CONFIG.inputBorderStyle}
              borderColor={activeGitField === 'branchName' ? POPUP_CONFIG.inputBorderColor : 'gray'}
              paddingX={POPUP_CONFIG.inputPadding.x}
              paddingY={POPUP_CONFIG.inputPadding.y}
            >
              <InlineCursorInput
                value={branchName}
                onChange={setBranchName}
                focus={activeGitField === 'branchName'}
                placeholder="e.g., feat/LIN-123-fix-auth"
              />
            </Box>
          </>
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

const entryPointHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (import.meta.url === entryPointHref) {
  main()
}
