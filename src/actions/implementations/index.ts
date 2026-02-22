/**
 * Action Implementations
 *
 * Exports all action implementations for use by adapters
 */

export { viewPane } from './viewAction.js';
export { closePane } from './closeAction.js';
export { mergePane } from './mergeAction.js';
export { renamePane } from './renameAction.js';
export { duplicatePane } from './duplicateAction.js';
export { copyPath } from './copyPathAction.js';
export { openInEditor } from './openInEditorAction.js';
export { toggleAutopilot } from './toggleAutopilotAction.js';

// attachAgent is handled directly via the 'a' keyboard shortcut in useInputHandling.
// This stub exists to document the action in the system.
export { attachAgentToWorktree as attachAgent } from '../../utils/attachAgent.js';
