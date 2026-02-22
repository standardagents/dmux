import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildExportLine,
  getShellConfigCandidates,
  persistEnvToShell,
  upsertEnvBlock,
} from '../src/utils/shellKeyPersist.js';

describe('shellKeyPersist', () => {
  describe('getShellConfigCandidates', () => {
    it('returns candidates for zsh', () => {
      const candidates = getShellConfigCandidates('/bin/zsh', '/tmp/home');
      expect(candidates).toEqual([
        '/tmp/home/.zshrc',
        '/tmp/home/.zprofile',
      ]);
    });

    it('returns candidates for bash', () => {
      const candidates = getShellConfigCandidates('/bin/bash', '/tmp/home');
      expect(candidates).toEqual([
        '/tmp/home/.bashrc',
        '/tmp/home/.bash_profile',
        '/tmp/home/.profile',
      ]);
    });

    it('returns candidates for fish', () => {
      const candidates = getShellConfigCandidates('/usr/bin/fish', '/tmp/home');
      expect(candidates).toEqual([
        '/tmp/home/.config/fish/config.fish',
      ]);
    });

    it('returns .profile for unknown shell', () => {
      const candidates = getShellConfigCandidates('/bin/unknown', '/tmp/home');
      expect(candidates).toEqual(['/tmp/home/.profile']);
    });
  });

  describe('buildExportLine', () => {
    it('builds POSIX export line', () => {
      const line = buildExportLine('OPENROUTER_API_KEY', 'sk-test-123', '/bin/zsh');
      expect(line).toBe("export OPENROUTER_API_KEY='sk-test-123'");
    });

    it('builds fish export line', () => {
      const line = buildExportLine('OPENROUTER_API_KEY', 'sk-test-123', '/usr/bin/fish');
      expect(line).toBe('set -gx OPENROUTER_API_KEY "sk-test-123"');
    });

    it('escapes single quotes in POSIX values', () => {
      const line = buildExportLine('MY_KEY', "it's a test", '/bin/bash');
      expect(line).toBe("export MY_KEY='it'\\''s a test'");
    });

    it('trims whitespace from value', () => {
      const line = buildExportLine('MY_KEY', '  sk-test  ', '/bin/zsh');
      expect(line).toBe("export MY_KEY='sk-test'");
    });
  });

  describe('upsertEnvBlock', () => {
    it('inserts block into empty content', () => {
      const exportLine = buildExportLine('OPENROUTER_API_KEY', 'sk-test-123', '/bin/zsh');
      const updated = upsertEnvBlock('', 'OPENROUTER_API_KEY', exportLine);

      expect(updated).toContain('# >>> dmux openrouter-api-key >>>');
      expect(updated).toContain("export OPENROUTER_API_KEY='sk-test-123'");
      expect(updated).toContain('# <<< dmux openrouter-api-key <<<');
      expect(updated.endsWith('\n')).toBe(true);
    });

    it('replaces existing managed block', () => {
      const initial = [
        '# >>> dmux openrouter-api-key >>>',
        "export OPENROUTER_API_KEY='old-key'",
        '# <<< dmux openrouter-api-key <<<',
        '',
      ].join('\n');

      const nextLine = buildExportLine('OPENROUTER_API_KEY', 'new-key', '/bin/zsh');
      const updated = upsertEnvBlock(initial, 'OPENROUTER_API_KEY', nextLine);

      expect(updated).not.toContain('old-key');
      expect(updated).toContain("export OPENROUTER_API_KEY='new-key'");
    });

    it('appends block to existing content', () => {
      const existing = '# my shell config\nexport PATH="/usr/bin"\n';
      const exportLine = buildExportLine('MY_KEY', 'val', '/bin/zsh');
      const updated = upsertEnvBlock(existing, 'MY_KEY', exportLine);

      expect(updated).toContain('# my shell config');
      expect(updated).toContain('# >>> dmux my-key >>>');
      expect(updated).toContain("export MY_KEY='val'");
    });

    it('handles content without trailing newline', () => {
      const existing = '# no trailing newline';
      const exportLine = buildExportLine('KEY', 'val', '/bin/zsh');
      const updated = upsertEnvBlock(existing, 'KEY', exportLine);

      expect(updated).toContain('# no trailing newline');
      expect(updated).toContain('# >>> dmux key >>>');
      expect(updated.endsWith('\n')).toBe(true);
    });
  });

  describe('persistEnvToShell', () => {
    it('persists key to shell config file', async () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'dmux-shellkey-'));

      try {
        const zshrcPath = join(homeDir, '.zshrc');
        writeFileSync(zshrcPath, '# existing config\n', 'utf-8');

        const result = await persistEnvToShell('OPENROUTER_API_KEY', 'sk-live-abc', {
          shellPath: '/bin/zsh',
          homeDir,
        });

        const content = readFileSync(result.shellConfigPath, 'utf-8');
        expect(result.shellConfigPath).toBe(zshrcPath);
        expect(content).toContain("export OPENROUTER_API_KEY='sk-live-abc'");
        expect(content).toContain('# existing config');
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it('creates shell config if it does not exist', async () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'dmux-shellkey-'));

      try {
        const result = await persistEnvToShell('MY_KEY', 'my-value', {
          shellPath: '/bin/zsh',
          homeDir,
        });

        const content = readFileSync(result.shellConfigPath, 'utf-8');
        expect(content).toContain("export MY_KEY='my-value'");
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });
});
