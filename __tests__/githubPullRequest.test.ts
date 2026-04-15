import { describe, expect, it } from 'vitest';
import {
  buildMissingGitHubCliMessage,
  getGitHubCliInstallCommand,
} from '../src/utils/githubPullRequest.js';

describe('githubPullRequest install hints', () => {
  it('prefers Homebrew on macOS', () => {
    const installCommand = getGitHubCliInstallCommand(
      'darwin',
      (command) => command === 'brew'
    );

    expect(installCommand).toBe('brew install gh');
  });

  it('prefers WinGet on Windows', () => {
    const installCommand = getGitHubCliInstallCommand(
      'win32',
      (command) => command === 'winget'
    );

    expect(installCommand).toBe('winget install --id GitHub.cli');
  });

  it('uses the official apt one-liner on Debian-like systems', () => {
    const installCommand = getGitHubCliInstallCommand(
      'linux',
      (command) => command === 'apt' || command === 'sh'
    );

    expect(installCommand).toContain('sudo apt install gh -y');
    expect(installCommand).toContain('https://cli.github.com/packages stable main');
  });

  it('falls back to the installation page when no known package manager is present', () => {
    const message = buildMissingGitHubCliMessage(
      'linux',
      () => false
    );

    expect(message).toContain('https://github.com/cli/cli#installation');
  });

  it('includes an install command in the missing gh message when one can be determined', () => {
    const message = buildMissingGitHubCliMessage(
      'darwin',
      (command) => command === 'brew'
    );

    expect(message).toContain('Install it first with:');
    expect(message).toContain('brew install gh');
  });
});
