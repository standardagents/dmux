import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const hooksDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/hooks'
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

// Only OS signals matter. process.on('pane-split-detected') and friends are
// custom events with no default disposition, so they stay legal here.
const OS_SIGNAL = /process\.on\(\s*['"`](SIG[A-Z0-9]+)['"`]/g;

/**
 * Registering an OS signal listener inside a React effect is a trap: the effect
 * cleanup calls process.off, and once the last listener for a signal is removed
 * Node restores the default disposition — which for SIGUSR1/SIGHUP/SIGTERM means
 * terminate. A signal arriving between cleanup and re-registration then kills
 * dmux. Signal handlers belong at process scope, next to the ones in index.ts.
 */
describe('src/hooks must not register OS signal handlers', () => {
  it('has no process.on("SIG…") inside any hook', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(hooksDir)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(OS_SIGNAL)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(hooksDir, file)}:${line} registers ${match[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
