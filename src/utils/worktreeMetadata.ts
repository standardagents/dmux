import fs from 'fs';
import path from 'path';
import type { MergeTargetReference } from '../types.js';
import {
  isAgentName,
  type AgentName,
  type PermissionMode,
} from './agentLaunch.js';
import { atomicWriteJsonSync } from './atomicWrite.js';
import { sanitizePaneDisplayName } from './paneTitle.js';
import { validateLinkedRepoPathsSetting } from './linkedRepoConfig.js';

export interface WorktreeMetadata {
  agent?: AgentName;
  permissionMode?: PermissionMode;
  goalMode?: boolean;
  displayName?: string;
  branchName?: string;
  mergeTargetChain?: MergeTargetReference[];
  linkedRepoPaths?: string[];
}

const METADATA_DIR = '.dmux';
const METADATA_FILE = 'worktree-metadata.json';
const PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  '',
  'plan',
  'acceptEdits',
  'bypassPermissions',
]);

function isMergeTargetReference(value: unknown): value is MergeTargetReference {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.branchName !== 'string' || candidate.branchName.length === 0) {
    return false;
  }
  if (candidate.displayName !== undefined && typeof candidate.displayName !== 'string') {
    return false;
  }
  if (candidate.slug !== undefined && typeof candidate.slug !== 'string') {
    return false;
  }
  if (
    candidate.worktreePath !== undefined
    && typeof candidate.worktreePath !== 'string'
  ) {
    return false;
  }

  return true;
}

function normalizeLinkedRepoPaths(linkedRepoPaths: unknown): string[] | undefined {
  if (!Array.isArray(linkedRepoPaths)) return undefined;

  const normalized = linkedRepoPaths
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);

  try {
    const validated = validateLinkedRepoPathsSetting(normalized.join('\n'));
    return validated;
  } catch {
    return undefined;
  }
}

function normalizeMergeTargetChain(
  mergeTargetChain: unknown
): MergeTargetReference[] | undefined {
  if (!Array.isArray(mergeTargetChain)) return undefined;

  const normalized = mergeTargetChain
    .filter(isMergeTargetReference)
    .map((entry) => ({
      displayName: entry.displayName,
      branchName: entry.branchName,
      slug: entry.slug,
      worktreePath: entry.worktreePath,
    }));

  return normalized.length > 0 ? normalized : undefined;
}

export function getWorktreeMetadataPath(worktreePath: string): string {
  return path.join(worktreePath, METADATA_DIR, METADATA_FILE);
}

export function readWorktreeMetadata(worktreePath: string): WorktreeMetadata | null {
  try {
    const metadataPath = getWorktreeMetadataPath(worktreePath);
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;

    const metadata: WorktreeMetadata = {};

    if (typeof parsed.agent === 'string' && isAgentName(parsed.agent)) {
      metadata.agent = parsed.agent;
    }

    if (
      typeof parsed.permissionMode === 'string'
      && PERMISSION_MODES.has(parsed.permissionMode as PermissionMode)
    ) {
      metadata.permissionMode = parsed.permissionMode as PermissionMode;
    }

    if (typeof parsed.goalMode === 'boolean') {
      metadata.goalMode = parsed.goalMode;
    }

    if (typeof parsed.displayName === 'string') {
      const displayName = sanitizePaneDisplayName(parsed.displayName);
      if (displayName.length > 0) {
        metadata.displayName = displayName;
      }
    }

    if (typeof parsed.branchName === 'string' && parsed.branchName.length > 0) {
      metadata.branchName = parsed.branchName;
    }

    const mergeTargetChain = normalizeMergeTargetChain(parsed.mergeTargetChain);
    if (mergeTargetChain) {
      metadata.mergeTargetChain = mergeTargetChain;
    }

    const linkedRepoPaths = normalizeLinkedRepoPaths(parsed.linkedRepoPaths);
    if (linkedRepoPaths) {
      metadata.linkedRepoPaths = linkedRepoPaths;
    }

    return metadata;
  } catch {
    return null;
  }
}

export function writeWorktreeMetadata(
  worktreePath: string,
  metadata: WorktreeMetadata
): void {
  const metadataPath = getWorktreeMetadataPath(worktreePath);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  atomicWriteJsonSync(metadataPath, {
    ...metadata,
    displayName: metadata.displayName
      ? sanitizePaneDisplayName(metadata.displayName)
      : undefined,
    linkedRepoPaths: metadata.linkedRepoPaths !== undefined
      ? validateLinkedRepoPathsSetting(metadata.linkedRepoPaths.join('\n'))
      : undefined,
  });
}
