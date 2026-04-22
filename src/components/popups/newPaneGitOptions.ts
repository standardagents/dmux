import { execSync } from 'child_process';

export const MAX_VISIBLE_BRANCHES = 10;
export const BASE_BRANCH_ERROR_MESSAGE = 'Base branch must match an existing local branch (choose from the list).';

export interface BaseBranchEnterResolution {
  accepted: boolean;
  nextValue: string;
  error?: string;
}

export function loadLocalBranchNames(repoRoot: string): string[] {
  try {
    const raw = execSync(
      "git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads",
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      }
    );

    return parseBranchList(raw);
  } catch {
    return [];
  }
}

export function parseBranchList(raw: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const line of raw.split('\n')) {
    const branch = line.trim();
    if (!branch || seen.has(branch)) {
      continue;
    }
    seen.add(branch);
    ordered.push(branch);
  }

  return ordered;
}

export function filterBranches(branches: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return branches;
  }

  return branches.filter((branch) => branch.toLowerCase().includes(normalizedQuery));
}

export function clampSelectedIndex(selectedIndex: number, totalItems: number): number {
  if (totalItems <= 0) return 0;
  if (selectedIndex < 0) return 0;
  if (selectedIndex >= totalItems) return totalItems - 1;
  return selectedIndex;
}

export function getVisibleBranchWindow(
  branches: string[],
  selectedIndex: number,
  maxVisible: number = MAX_VISIBLE_BRANCHES
): { startIndex: number; visibleBranches: string[] } {
  if (branches.length <= maxVisible) {
    return { startIndex: 0, visibleBranches: branches };
  }

  const clampedIndex = clampSelectedIndex(selectedIndex, branches.length);
  let startIndex = Math.max(0, clampedIndex - Math.floor(maxVisible / 2));
  const maxStart = Math.max(0, branches.length - maxVisible);
  startIndex = Math.min(startIndex, maxStart);

  return {
    startIndex,
    visibleBranches: branches.slice(startIndex, startIndex + maxVisible),
  };
}

export function isValidBaseBranchOverride(value: string, availableBranches: string[]): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return availableBranches.includes(trimmed);
}

export function resolveBaseBranchEnter(input: {
  baseBranch: string;
  availableBranches: string[];
  filteredBranches: string[];
  selectedIndex: number;
}): BaseBranchEnterResolution {
  if (input.filteredBranches.length > 0 && input.selectedIndex < input.filteredBranches.length) {
    return {
      accepted: true,
      nextValue: input.filteredBranches[input.selectedIndex],
    };
  }

  const trimmed = input.baseBranch.trim();
  if (!trimmed) {
    return {
      accepted: true,
      nextValue: '',
    };
  }

  if (input.availableBranches.includes(trimmed)) {
    return {
      accepted: true,
      nextValue: trimmed,
    };
  }

  return {
    accepted: false,
    nextValue: trimmed,
    error: BASE_BRANCH_ERROR_MESSAGE,
  };
}
