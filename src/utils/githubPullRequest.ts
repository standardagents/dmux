import { spawnSync } from 'child_process';

export interface GitHubPullRequestResult {
  url: string;
  created: boolean;
  remoteName: string;
}

interface CommandOptions {
  cwd: string;
  allowFailure?: boolean;
}

function commandExists(command: string): boolean {
  const result = process.platform === 'win32'
    ? spawnSync('where', [command], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawnSync('sh', ['-lc', `command -v "${command}" >/dev/null 2>&1`], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  return !result.error && result.status === 0;
}

export function getGitHubCliInstallCommand(
  platform: NodeJS.Platform = process.platform,
  hasCommand: (command: string) => boolean = commandExists
): string | null {
  if (platform === 'darwin') {
    if (hasCommand('brew')) return 'brew install gh';
    if (hasCommand('port')) return 'sudo port install gh';
    if (hasCommand('conda')) return 'conda install gh --channel conda-forge';
    return 'brew install gh';
  }

  if (platform === 'win32') {
    if (hasCommand('winget')) return 'winget install --id GitHub.cli';
    if (hasCommand('scoop')) return 'scoop install gh';
    if (hasCommand('choco')) return 'choco install gh';
    if (hasCommand('conda')) return 'conda install gh --channel conda-forge';
    return 'winget install --id GitHub.cli';
  }

  if (hasCommand('brew')) return 'brew install gh';

  if (hasCommand('apt-get') || hasCommand('apt')) {
    return '(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) && sudo mkdir -p -m 755 /etc/apt/keyrings && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && sudo mkdir -p -m 755 /etc/apt/sources.list.d && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && sudo apt update && sudo apt install gh -y';
  }

  if (hasCommand('dnf5')) {
    return 'sudo dnf install dnf5-plugins && sudo dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo && sudo dnf install gh --repo gh-cli';
  }

  if (hasCommand('dnf')) {
    return "sudo dnf install 'dnf-command(config-manager)' && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo dnf install gh --repo gh-cli";
  }

  if (hasCommand('yum')) {
    return 'type -p yum-config-manager >/dev/null || sudo yum install yum-utils && sudo yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo yum install gh';
  }

  if (hasCommand('zypper')) {
    return 'sudo zypper addrepo https://cli.github.com/packages/rpm/gh-cli.repo && sudo zypper ref && sudo zypper install gh';
  }

  if (hasCommand('pacman')) return 'sudo pacman -S github-cli';
  if (hasCommand('apk')) return 'apk add github-cli';
  if (hasCommand('pkg')) return 'pkg install gh';
  if (hasCommand('conda')) return 'conda install gh --channel conda-forge';

  return null;
}

export function buildMissingGitHubCliMessage(
  platform: NodeJS.Platform = process.platform,
  hasCommand: (command: string) => boolean = commandExists
): string {
  const installCommand = getGitHubCliInstallCommand(platform, hasCommand);

  if (!installCommand) {
    return 'GitHub CLI (gh) is required to create pull requests from dmux. Install it from https://github.com/cli/cli#installation and then try again.';
  }

  return `GitHub CLI (gh) is required to create pull requests from dmux. Install it first with:\n${installCommand}`;
}

function runCommandText(
  command: string,
  args: string[],
  options: CommandOptions
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    if (options.allowFailure) {
      return '';
    }
    throw result.error;
  }

  if (result.status !== 0) {
    if (options.allowFailure) {
      return '';
    }

    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(stderr || stdout || `${command} exited with status ${result.status}`);
  }

  return result.stdout.trim();
}

function runGit(
  repoPath: string,
  args: string[],
  options: Omit<CommandOptions, 'cwd'> = {}
): string {
  return runCommandText('git', args, { cwd: repoPath, ...options });
}

function runGh(
  repoPath: string,
  args: string[],
  options: Omit<CommandOptions, 'cwd'> = {}
): string {
  return runCommandText('gh', args, { cwd: repoPath, ...options });
}

function ensureGitHubCliAvailable(repoPath: string): void {
  try {
    runGh(repoPath, ['--version']);
  } catch {
    throw new Error(buildMissingGitHubCliMessage());
  }
}

function listGitRemotes(repoPath: string): string[] {
  const output = runGit(repoPath, ['remote'], { allowFailure: true });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getPreferredPushRemote(repoPath: string): string {
  const upstream = runGit(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { allowFailure: true }
  );

  if (upstream.includes('/')) {
    return upstream.split('/')[0];
  }

  const currentBranch = runGit(repoPath, ['branch', '--show-current'], {
    allowFailure: true,
  });

  if (currentBranch && currentBranch !== 'HEAD') {
    const configuredRemote = runGit(
      repoPath,
      ['config', `branch.${currentBranch}.remote`],
      { allowFailure: true }
    );

    if (configuredRemote) {
      return configuredRemote;
    }
  }

  const remotes = listGitRemotes(repoPath);
  if (remotes.length === 0) {
    throw new Error('No git remote is configured for this repository.');
  }

  return remotes.includes('origin') ? 'origin' : remotes[0];
}

export function findExistingPullRequestUrl(
  repoPath: string,
  sourceBranch: string
): string | null {
  const output = runGh(
    repoPath,
    ['pr', 'view', sourceBranch, '--json', 'url', '--jq', '.url'],
    { allowFailure: true }
  );

  const url = output.trim();
  return url || null;
}

function ensureRemoteBranchExists(
  repoPath: string,
  remoteName: string,
  branchName: string
): void {
  const output = runGit(repoPath, ['ls-remote', '--heads', remoteName, branchName]);

  if (!output.trim()) {
    throw new Error(
      `Remote branch ${remoteName}/${branchName} was not found. Push or create a PR for the parent branch first.`
    );
  }
}

export function createGitHubPullRequest(options: {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  remoteName?: string;
}): GitHubPullRequestResult {
  const {
    repoPath,
    sourceBranch,
    targetBranch,
    remoteName = getPreferredPushRemote(repoPath),
  } = options;

  ensureGitHubCliAvailable(repoPath);

  const existingUrl = findExistingPullRequestUrl(repoPath, sourceBranch);
  if (existingUrl) {
    return {
      url: existingUrl,
      created: false,
      remoteName,
    };
  }

  ensureRemoteBranchExists(repoPath, remoteName, targetBranch);

  runGit(repoPath, ['push', '--set-upstream', remoteName, sourceBranch]);

  try {
    runGh(repoPath, [
      'pr',
      'create',
      '--base',
      targetBranch,
      '--head',
      sourceBranch,
      '--fill',
    ]);
  } catch (error) {
    const existingAfterCreate = findExistingPullRequestUrl(repoPath, sourceBranch);
    if (existingAfterCreate) {
      return {
        url: existingAfterCreate,
        created: false,
        remoteName,
      };
    }

    throw error;
  }

  const createdUrl = findExistingPullRequestUrl(repoPath, sourceBranch);
  if (!createdUrl) {
    throw new Error('Pull request was created but the resulting URL could not be determined.');
  }

  return {
    url: createdUrl,
    created: true,
    remoteName,
  };
}
