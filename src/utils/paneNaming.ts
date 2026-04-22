export interface ResolvePaneNamingInput {
  generatedSlug: string;
  slugSuffix?: string;
  branchPrefix?: string;
  baseBranchSetting?: string;
  baseBranchOverride?: string;
  branchNameOverride?: string;
}

export interface ResolvedPaneNaming {
  slug: string;
  branchName: string;
  baseBranch: string;
}

function normalizeSuffix(slugSuffix?: string): string {
  if (!slugSuffix) return '';
  return slugSuffix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function appendNormalizedSuffix(value: string, slugSuffix?: string): string {
  const suffix = normalizeSuffix(slugSuffix);
  if (!suffix) return value;
  if (value.toLowerCase().endsWith(`-${suffix}`)) return value;
  return `${value}-${suffix}`;
}

export function sanitizeWorktreeSlugFromBranch(branchName: string): string {
  const normalized = branchName
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+|\.+$/g, '');

  return normalized || 'pane';
}

export function resolvePaneNaming(input: ResolvePaneNamingInput): ResolvedPaneNaming {
  const generatedSlug = (input.generatedSlug || '').trim() || 'pane';
  const configuredBaseBranch = (input.baseBranchSetting || '').trim();
  const overrideBaseBranch = (input.baseBranchOverride || '').trim();
  const explicitBranchName = (input.branchNameOverride || '').trim();
  const branchPrefix = input.branchPrefix || '';

  const baseBranch = overrideBaseBranch || configuredBaseBranch;

  const baseBranchName = explicitBranchName || `${branchPrefix}${generatedSlug}`;
  const baseSlug = explicitBranchName
    ? sanitizeWorktreeSlugFromBranch(explicitBranchName)
    : generatedSlug;

  return {
    slug: appendNormalizedSuffix(baseSlug, input.slugSuffix),
    branchName: appendNormalizedSuffix(baseBranchName, input.slugSuffix),
    baseBranch,
  };
}
