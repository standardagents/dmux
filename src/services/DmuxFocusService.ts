import { createHash, randomUUID } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { LogService } from './LogService.js';
import { TmuxService } from './TmuxService.js';
import { SettingsManager } from '../utils/settingsManager.js';
import {
  buildFocusToken,
  buildFocusWindowTitle,
  buildTerminalTitleSequence,
  mapTerminalProgramToBundleId,
  parseTmuxSocketPath,
  supportsNativeDmuxHelper,
  type DmuxHelperFocusStateMessage,
  type DmuxHelperNotifyMessage,
  type DmuxHelperSubscribeMessage,
} from '../utils/focusDetection.js';
import {
  getBundledNotificationSoundDefinitions,
  pickNotificationSound,
} from '../utils/notificationSounds.js';
import { resolvePackagePath } from '../utils/runtimePaths.js';

const HELPER_RECONNECT_DELAY_MS = 1000;
const HELPER_SOCKET_WAIT_TIMEOUT_MS = 5000;
const FOCUS_SYNC_INTERVAL_MS = 350;
const ATTENTION_FLASH_STEP_MS = 250;
const ATTENTION_FLASH_SEQUENCE_LENGTH = 12;
const ATTENTION_FLASH_FALLBACK_BG = 'colour237';

interface DmuxFocusServiceOptions {
  projectName: string;
  projectRoot?: string;
}

export interface DmuxFocusChangedEvent {
  fullyFocusedPaneId: string | null;
  helperFocused: boolean;
}

export interface DmuxAttentionNotificationRequest {
  title: string;
  subtitle?: string;
  body: string;
  tmuxPaneId: string;
}

export type PaneAttentionSurface = 'fully-focused' | 'same-window' | 'background';

function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test'
    || process.env.VITEST === 'true'
    || typeof process.env.VITEST !== 'undefined';
}

function getHelperRuntimePaths(): {
  sourcePath: string;
  infoPlistSourcePath: string;
  iconSourcePath: string;
  soundSourceDir: string;
  packagedAppPath: string;
  packagedExecutablePath: string;
  appPath: string;
  executablePath: string;
  resourcesPath: string;
  infoPlistPath: string;
  bundleIconPngPath: string;
  bundleIconIcnsPath: string;
  versionPath: string;
  socketPath: string;
} {
  const helperBaseDir = path.join(os.homedir(), '.dmux', 'native-helper');
  const packagedAppPath = resolvePackagePath('native', 'macos', 'prebuilt', 'dmux-helper.app');
  const packagedContentsPath = path.join(packagedAppPath, 'Contents');
  const appPath = path.join(helperBaseDir, 'dmux-helper.app');
  const contentsPath = path.join(appPath, 'Contents');
  const resourcesPath = path.join(contentsPath, 'Resources');
  return {
    sourcePath: resolvePackagePath('native', 'macos', 'dmux-helper.swift'),
    infoPlistSourcePath: resolvePackagePath('native', 'macos', 'dmux-helper-Info.plist'),
    iconSourcePath: resolvePackagePath('native', 'macos', 'dmux-helper-icon.png'),
    soundSourceDir: resolvePackagePath('native', 'macos', 'sounds'),
    packagedAppPath,
    packagedExecutablePath: path.join(packagedContentsPath, 'MacOS', 'dmux-helper'),
    appPath,
    executablePath: path.join(contentsPath, 'MacOS', 'dmux-helper'),
    resourcesPath,
    infoPlistPath: path.join(contentsPath, 'Info.plist'),
    bundleIconPngPath: path.join(resourcesPath, 'dmux-helper.png'),
    bundleIconIcnsPath: path.join(resourcesPath, 'dmux-helper.icns'),
    versionPath: path.join(helperBaseDir, 'version.txt'),
    socketPath: path.join(helperBaseDir, 'run', 'dmux-helper.sock'),
  };
}

interface HelperBinaryStatus {
  ready: boolean;
  rebuilt: boolean;
}

interface HelperBundleSnapshot {
  filePaths: string[];
  versionParts: Array<string | Buffer>;
}

const HELPER_BUNDLE_BUILD_VERSION = '1';
const LSREGISTER_PATH = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
const LEGACY_NOTIFIER_BASE_DIR = path.join(os.homedir(), '.dmux', 'macos-notifier');
const LEGACY_NOTIFIER_APP_PATH = path.join(LEGACY_NOTIFIER_BASE_DIR, 'dmux-notifier.app');

export function supportsRuntimeHelperSourceBuild(
  packageRoot: string = resolvePackagePath(),
): boolean {
  return existsSync(path.join(packageRoot, 'src', 'services', 'DmuxFocusService.ts'));
}

function readTmuxGlobalEnvironment(name: string): string | undefined {
  if (!process.env.TMUX) {
    return undefined;
  }

  const result = spawnSync('tmux', ['show-environment', '-g', name], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    return undefined;
  }

  const line = result.stdout.trim();
  if (!line || line === `-${name}`) {
    return undefined;
  }

  const prefix = `${name}=`;
  if (!line.startsWith(prefix)) {
    return undefined;
  }

  return line.slice(prefix.length);
}

function resolveTerminalProgram(): string | undefined {
  const terminalProgram = process.env.TERM_PROGRAM?.trim();
  if (terminalProgram && terminalProgram.toLowerCase() !== 'tmux') {
    return terminalProgram;
  }

  return readTmuxGlobalEnvironment('TERM_PROGRAM') ?? terminalProgram;
}

function resolveTmuxSocketPath(): string | undefined {
  const parsedFromEnv = parseTmuxSocketPath(process.env.TMUX);
  if (parsedFromEnv) {
    return parsedFromEnv;
  }

  if (!process.env.TMUX) {
    return undefined;
  }

  const result = spawnSync('tmux', ['display-message', '-p', '#{socket_path}'], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    return undefined;
  }

  const socketPath = result.stdout.trim();
  return socketPath || undefined;
}

function buildHelperVersionHash(parts: Array<string | Buffer>): string {
  const hash = createHash('sha1');
  hash.update(HELPER_BUNDLE_BUILD_VERSION);
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest('hex');
}

async function snapshotHelperBundle(bundlePath: string): Promise<HelperBundleSnapshot> {
  const filePaths: string[] = [];

  const walk = async (currentPath: string, relativePrefix = ''): Promise<void> => {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
        continue;
      }

      if (entry.isFile()) {
        filePaths.push(relativePath);
      }
    }
  };

  await walk(bundlePath);
  const versionParts: Array<string | Buffer> = [];
  for (const filePath of filePaths) {
    versionParts.push(filePath);
    versionParts.push(await fs.readFile(path.join(bundlePath, filePath)));
  }

  return { filePaths, versionParts };
}

function helperBundleNeedsSync(
  runtimeBundlePath: string,
  snapshot: HelperBundleSnapshot,
  currentVersion: string
): boolean {
  if (currentVersion.trim() !== buildHelperVersionHash(snapshot.versionParts)) {
    return true;
  }

  return snapshot.filePaths.some((relativePath) => !existsSync(path.join(runtimeBundlePath, relativePath)));
}

async function removeLegacyMacosNotifierArtifacts(): Promise<void> {
  if (!supportsNativeDmuxHelper() || !existsSync(LEGACY_NOTIFIER_BASE_DIR)) {
    return;
  }

  if (existsSync(LEGACY_NOTIFIER_APP_PATH) && existsSync(LSREGISTER_PATH)) {
    spawnSync(LSREGISTER_PATH, ['-u', LEGACY_NOTIFIER_APP_PATH], {
      stdio: 'ignore',
    });
  }

  await fs.rm(LEGACY_NOTIFIER_BASE_DIR, { recursive: true, force: true });
}

async function removeHelperRuntimeArtifacts(
  paths: ReturnType<typeof getHelperRuntimePaths>
): Promise<void> {
  await Promise.all([
    fs.rm(paths.appPath, { recursive: true, force: true }),
    fs.rm(paths.versionPath, { force: true }),
  ]);
}

function shiftHexColor(hex: string, delta: number): string | null {
  const match = hex.trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!match) {
    return null;
  }

  const value = match[1];
  const channels = [0, 2, 4].map((offset) =>
    Math.max(0, Math.min(255, Number.parseInt(value.slice(offset, offset + 2), 16) + delta))
  );

  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function buildAttentionFlashWindowStyle(baseStyle: string): string {
  const normalized = baseStyle.trim();
  const bgPattern = /(^|,)\s*bg=([^,\s]+)/;
  const match = normalized.match(bgPattern);

  let nextBackground = ATTENTION_FLASH_FALLBACK_BG;
  if (match?.[2]) {
    const currentBackground = match[2].trim();
    const colourMatch = currentBackground.match(/^colour(\d{1,3})$/i);
    if (colourMatch) {
      const currentValue = Number.parseInt(colourMatch[1], 10);
      const nextValue = currentValue >= 248
        ? Math.max(0, currentValue - 1)
        : Math.min(255, currentValue + 1);
      nextBackground = `colour${nextValue}`;
    } else if (currentBackground === 'default') {
      nextBackground = ATTENTION_FLASH_FALLBACK_BG;
    } else {
      nextBackground = shiftHexColor(currentBackground, 14) ?? ATTENTION_FLASH_FALLBACK_BG;
    }
  }

  if (!match) {
    return normalized ? `${normalized},bg=${nextBackground}` : `bg=${nextBackground}`;
  }

  return normalized.replace(bgPattern, (_full, prefix) => `${prefix}bg=${nextBackground}`);
}

function runBuildTool(executable: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(executable, args, {
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  return {
    ok: result.status === 0,
    output: (result.stderr || result.stdout || '').trim(),
  };
}

async function buildHelperBundleIcon(iconSourcePath: string, iconIcnsPath: string): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmux-helper-icon-'));
  const iconsetDir = path.join(tempDir, 'dmux-helper.iconset');

  try {
    await fs.mkdir(iconsetDir, { recursive: true });
    const sizes = [16, 32, 128, 256, 512];

    for (const size of sizes) {
      const oneX = path.join(iconsetDir, `icon_${size}x${size}.png`);
      const twoX = path.join(iconsetDir, `icon_${size}x${size}@2x.png`);

      let result = runBuildTool('/usr/bin/sips', [
        '-z',
        String(size),
        String(size),
        iconSourcePath,
        '--out',
        oneX,
      ]);
      if (!result.ok) {
        throw new Error(result.output || 'sips failed building helper icon');
      }

      result = runBuildTool('/usr/bin/sips', [
        '-z',
        String(size * 2),
        String(size * 2),
        iconSourcePath,
        '--out',
        twoX,
      ]);
      if (!result.ok) {
        throw new Error(result.output || 'sips failed building helper icon');
      }
    }

    const iconutilResult = runBuildTool('/usr/bin/iconutil', [
      '-c',
      'icns',
      iconsetDir,
      '-o',
      iconIcnsPath,
    ]);
    if (!iconutilResult.ok) {
      throw new Error(iconutilResult.output || 'iconutil failed building helper icon');
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function ensureHelperBundle(
  paths: ReturnType<typeof getHelperRuntimePaths>
): Promise<HelperBinaryStatus> {
  if (existsSync(paths.packagedAppPath) && existsSync(paths.packagedExecutablePath)) {
    const [packagedSnapshot, currentVersion] = await Promise.all([
      snapshotHelperBundle(paths.packagedAppPath),
      existsSync(paths.versionPath)
        ? fs.readFile(paths.versionPath, 'utf-8').catch(() => '')
        : Promise.resolve(''),
    ]);

    const expectedVersion = buildHelperVersionHash(packagedSnapshot.versionParts);
    const needsSync = !existsSync(paths.executablePath)
      || !existsSync(paths.infoPlistPath)
      || helperBundleNeedsSync(paths.appPath, packagedSnapshot, currentVersion);

    if (!needsSync) {
      return { ready: true, rebuilt: false };
    }

    await fs.rm(paths.appPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(paths.appPath), { recursive: true });
    await fs.cp(paths.packagedAppPath, paths.appPath, { recursive: true });
    await fs.chmod(paths.executablePath, 0o755).catch(() => undefined);
    await fs.writeFile(paths.versionPath, expectedVersion, 'utf-8');

    return {
      ready: true,
      rebuilt: true,
    };
  }

  if (!existsSync(paths.sourcePath) || !existsSync(paths.infoPlistSourcePath)) {
    return { ready: false, rebuilt: false };
  }

  const hasRuntimeBundle = existsSync(paths.executablePath) && existsSync(paths.infoPlistPath);
  if (!supportsRuntimeHelperSourceBuild()) {
    if (hasRuntimeBundle) {
      return { ready: true, rebuilt: false };
    }

    await removeHelperRuntimeArtifacts(paths).catch(() => undefined);
    return { ready: false, rebuilt: false };
  }

  const bundledSoundAssets = getBundledNotificationSoundDefinitions().map((definition) => ({
    resourceFileName: definition.resourceFileName as string,
    sourcePath: path.join(paths.soundSourceDir, definition.resourceFileName as string),
  }));

  const [sourceTemplate, infoPlistTemplate, iconBuffer, soundAssets, currentVersion] = await Promise.all([
    fs.readFile(paths.sourcePath, 'utf-8'),
    fs.readFile(paths.infoPlistSourcePath, 'utf-8'),
    existsSync(paths.iconSourcePath)
      ? fs.readFile(paths.iconSourcePath)
      : Promise.resolve<Buffer | null>(null),
    Promise.all(
      bundledSoundAssets
        .filter((asset) => existsSync(asset.sourcePath))
        .map(async (asset) => ({
          ...asset,
          buffer: await fs.readFile(asset.sourcePath),
        }))
    ),
    existsSync(paths.versionPath)
      ? fs.readFile(paths.versionPath, 'utf-8').catch(() => '')
      : Promise.resolve(''),
  ]);

  const expectedVersion = buildHelperVersionHash([
    sourceTemplate,
    infoPlistTemplate,
    iconBuffer ?? 'no-icon',
    ...soundAssets.flatMap((asset) => [asset.resourceFileName, asset.buffer]),
  ]);

  const needsBuild = !existsSync(paths.executablePath)
    || !existsSync(paths.infoPlistPath)
    || (iconBuffer !== null && !existsSync(paths.bundleIconPngPath))
    || soundAssets.some((asset) => !existsSync(path.join(paths.resourcesPath, asset.resourceFileName)))
    || currentVersion.trim() !== expectedVersion;

  if (!needsBuild) {
    return { ready: true, rebuilt: false };
  }

  const helperBaseDir = path.dirname(paths.appPath);
  await fs.mkdir(helperBaseDir, { recursive: true });

  const tempRoot = await fs.mkdtemp(path.join(helperBaseDir, 'build-'));
  const tempAppPath = path.join(tempRoot, 'dmux-helper.app');
  const tempContentsPath = path.join(tempAppPath, 'Contents');
  const tempResourcesPath = path.join(tempContentsPath, 'Resources');
  const tempExecutablePath = path.join(tempContentsPath, 'MacOS', 'dmux-helper');
  const tempInfoPlistPath = path.join(tempContentsPath, 'Info.plist');
  const tempBundleIconPngPath = path.join(tempResourcesPath, 'dmux-helper.png');
  const tempBundleIconIcnsPath = path.join(tempResourcesPath, 'dmux-helper.icns');

  try {
    await fs.mkdir(path.dirname(tempExecutablePath), { recursive: true });
    await fs.mkdir(tempResourcesPath, { recursive: true });
    await fs.writeFile(tempInfoPlistPath, infoPlistTemplate, 'utf-8');

    if (iconBuffer !== null) {
      await fs.writeFile(tempBundleIconPngPath, iconBuffer);
      try {
        await buildHelperBundleIcon(tempBundleIconPngPath, tempBundleIconIcnsPath);
      } catch {
        // The helper can still set the bundled PNG as its runtime icon.
      }
    }

    await Promise.all(
      soundAssets.map(async (asset) => {
        await fs.writeFile(path.join(tempResourcesPath, asset.resourceFileName), asset.buffer);
      })
    );

    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn('swiftc', [
        '-O',
        paths.sourcePath,
        '-o',
        tempExecutablePath,
        '-framework',
        'AppKit',
        '-framework',
        'ApplicationServices',
      ], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.on('close', (code) => { resolve({ status: code, stderr }); });
      child.on('error', () => { resolve({ status: 1, stderr }); });
    });

    if (result.status !== 0) {
      if (!hasRuntimeBundle) {
        await removeHelperRuntimeArtifacts(paths).catch(() => undefined);
      }
      return { ready: false, rebuilt: false };
    }

    await fs.chmod(tempExecutablePath, 0o755).catch(() => undefined);
    await fs.rm(paths.appPath, { recursive: true, force: true });
    await fs.rename(tempAppPath, paths.appPath);
    await fs.writeFile(paths.versionPath, expectedVersion, 'utf-8');

    return {
      ready: true,
      rebuilt: true,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function parseHelperSocketOwnerProcessIds(
  lsofOutput: string,
  socketPath: string,
  currentProcessId: number = process.pid,
): number[] {
  return lsofOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith(socketPath))
    .map((line) => {
      const match = line.match(/^\S+\s+(\d+)\s+/);
      return match ? Number.parseInt(match[1], 10) : Number.NaN;
    })
    .filter((value, index, values) => (
      Number.isFinite(value)
      && value > 0
      && value !== currentProcessId
      && values.indexOf(value) === index
    ));
}

function findHelperSocketOwnerProcessIds(socketPath: string): number[] {
  const result = spawnSync('lsof', ['-nP', '-U', socketPath], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    return [];
  }

  // Only kill the helper process that owns the socket path itself.
  // Connected clients show up as peer links (`->...`) and must be left alone.
  return parseHelperSocketOwnerProcessIds(result.stdout, socketPath);
}

async function stopRunningHelper(socketPath: string): Promise<boolean> {
  const pids = findHelperSocketOwnerProcessIds(socketPath);
  if (pids.length === 0) {
    return true;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore races where the helper exits between lookup and signal delivery.
    }
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const activePids = findHelperSocketOwnerProcessIds(socketPath);
    if (activePids.length === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await fs.rm(socketPath, { force: true }).catch(() => undefined);
  return findHelperSocketOwnerProcessIds(socketPath).length === 0;
}

async function waitForHelperSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const connected = await new Promise<boolean>((resolve) => {
        const probe = createConnection(socketPath);
        let settled = false;

        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          probe.destroy();
          resolve(value);
        };

        probe.once('connect', () => finish(true));
        probe.once('error', () => finish(false));
      });

      if (connected) {
        return true;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return false;
}

async function ensureHelperRunning(
  logger: LogService
): Promise<string | null> {
  await removeLegacyMacosNotifierArtifacts().catch(() => undefined);
  const helperPaths = getHelperRuntimePaths();
  const { executablePath, socketPath } = helperPaths;
  const binaryStatus = await ensureHelperBundle(helperPaths);

  if (!binaryStatus.ready) {
    logger.warn('dmux helper app bundle is unavailable on this system', 'focus-helper');
    return null;
  }

  const alreadyRunning = await waitForHelperSocket(socketPath, 250);
  if (alreadyRunning && !binaryStatus.rebuilt) {
    return socketPath;
  }

  if (alreadyRunning && binaryStatus.rebuilt) {
    const stopped = await stopRunningHelper(socketPath);
    if (!stopped) {
      logger.warn('Failed to restart dmux helper after rebuilding it', 'focus-helper');
      return socketPath;
    }
  }

  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  const child = spawn(executablePath, ['--socket', socketPath, '--poll-ms', '250'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const started = await waitForHelperSocket(socketPath, HELPER_SOCKET_WAIT_TIMEOUT_MS);
  if (!started) {
    logger.warn('Timed out waiting for dmux helper to start', 'focus-helper');
    return null;
  }

  return socketPath;
}

export class DmuxFocusService extends EventEmitter {
  private readonly logger = LogService.getInstance();
  private readonly tmuxService = TmuxService.getInstance();
  private readonly instanceId = randomUUID();
  private readonly token = buildFocusToken(this.instanceId);
  private readonly terminalProgram = supportsNativeDmuxHelper()
    ? resolveTerminalProgram()
    : undefined;
  private readonly bundleId = mapTerminalProgramToBundleId(this.terminalProgram);
  private readonly tmuxSocketPath = supportsNativeDmuxHelper()
    ? resolveTmuxSocketPath()
    : undefined;
  private readonly terminalTitle: string;
  private readonly baseTitle: string;
  private helperSocketPath: string | null = null;
  private helperSocket: Socket | null = null;
  private helperFocused = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private lineBuffer = '';
  private active = false;
  private titleApplied = false;
  private fullyFocusedPaneId: string | null = null; // tmux pane id
  private readonly flashingTmuxPaneIds = new Set<string>();

  constructor(private readonly options: DmuxFocusServiceOptions) {
    super();
    this.baseTitle = `dmux ${options.projectName}`;
    this.terminalTitle = buildFocusWindowTitle(options.projectName, this.token);
  }

  private resolveAttentionNotificationSoundName(): string | undefined {
    const settingsManager = new SettingsManager(this.options.projectRoot ?? process.cwd());
    const selectedSound = pickNotificationSound(
      settingsManager.getSettings().enabledNotificationSounds
    );
    return selectedSound.resourceFileName;
  }

  async start(): Promise<void> {
    if (!supportsNativeDmuxHelper() || !process.env.TMUX || isTestEnvironment()) {
      return;
    }

    this.active = true;
    const helperSocketPath = await ensureHelperRunning(this.logger);
    if (!helperSocketPath) {
      return;
    }

    this.helperSocketPath = helperSocketPath;
    this.writeTerminalTitle(this.terminalTitle);
    this.titleApplied = true;

    this.syncInterval = setInterval(() => {
      void this.syncFocusedPaneState();
    }, FOCUS_SYNC_INTERVAL_MS);

    this.connectToHelper();
  }

  stop(): void {
    this.active = false;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.helperSocket) {
      this.helperSocket.destroy();
      this.helperSocket = null;
    }

    this.helperFocused = false;
    this.setFullyFocusedPaneId(null);

    if (this.titleApplied) {
      this.writeTerminalTitle(this.baseTitle);
      this.titleApplied = false;
    }
  }

  private connectToHelper(): void {
    if (!this.active || !this.helperSocketPath) {
      return;
    }

    this.lineBuffer = '';
    const socket = createConnection(this.helperSocketPath);
    this.helperSocket = socket;

    socket.on('connect', () => {
      const subscribeMessage: DmuxHelperSubscribeMessage = {
        type: 'subscribe',
        instanceId: this.instanceId,
        titleToken: this.token,
        bundleId: this.bundleId,
        terminalProgram: this.terminalProgram,
      };
      socket.write(`${JSON.stringify(subscribeMessage)}\n`);
    });

    socket.on('data', (chunk) => {
      this.lineBuffer += chunk.toString('utf-8');

      let newlineIndex = this.lineBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = this.lineBuffer.slice(0, newlineIndex).trim();
        this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
        if (line) {
          this.handleHelperMessage(line);
        }
        newlineIndex = this.lineBuffer.indexOf('\n');
      }
    });

    socket.on('error', () => {
      this.handleHelperDisconnect();
    });

    socket.on('close', () => {
      this.handleHelperDisconnect();
    });
  }

  private handleHelperMessage(line: string): void {
    try {
      const message = JSON.parse(line) as DmuxHelperFocusStateMessage;
      if (message.type !== 'focus-state' || message.instanceId !== this.instanceId) {
        return;
      }

      this.helperFocused = message.fullyFocused;
      void this.syncFocusedPaneState();
    } catch {
      // Ignore malformed helper output and keep current state.
    }
  }

  private handleHelperDisconnect(): void {
    if (this.helperSocket) {
      this.helperSocket.destroy();
      this.helperSocket = null;
    }

    this.helperFocused = false;
    this.setFullyFocusedPaneId(null);

    if (!this.active || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToHelper();
    }, HELPER_RECONNECT_DELAY_MS);
  }

  getFullyFocusedPaneId(): string | null {
    return this.fullyFocusedPaneId;
  }

  isPaneFullyFocused(tmuxPaneId: string): boolean {
    return this.fullyFocusedPaneId === tmuxPaneId;
  }

  setPaneAttentionIndicator(tmuxPaneId: string, enabled: boolean): void {
    if (enabled) {
      this.tmuxService.setPaneOptionSync(tmuxPaneId, '@dmux_attention', '1');
      return;
    }

    this.tmuxService.unsetPaneOptionSync(tmuxPaneId, '@dmux_attention');
  }

  async getPaneAttentionSurface(tmuxPaneId: string): Promise<PaneAttentionSurface> {
    if (!this.active || !this.helperFocused) {
      return 'background';
    }

    try {
      const [currentPaneId, currentWindowId, paneWindowId] = await Promise.all([
        this.tmuxService.getCurrentPaneId(),
        this.tmuxService.getCurrentWindowId(),
        this.tmuxService.getPaneWindowId(tmuxPaneId),
      ]);

      if (currentPaneId === tmuxPaneId) {
        return 'fully-focused';
      }

      if (currentWindowId && paneWindowId && currentWindowId === paneWindowId) {
        return 'same-window';
      }
    } catch {
      return 'background';
    }

    return 'background';
  }

  async flashPaneAttention(tmuxPaneId: string): Promise<void> {
    if (this.flashingTmuxPaneIds.has(tmuxPaneId)) {
      return;
    }

    this.flashingTmuxPaneIds.add(tmuxPaneId);

    const existingPaneStyle = this.tmuxService.getPaneOptionSync(tmuxPaneId, 'window-style');
    const baseStyle = existingPaneStyle || this.tmuxService.getGlobalOptionSync('window-style');
    const flashStyle = buildAttentionFlashWindowStyle(baseStyle);

    const restorePaneStyle = () => {
      if (existingPaneStyle) {
        this.tmuxService.setPaneOptionSync(tmuxPaneId, 'window-style', existingPaneStyle);
      } else {
        this.tmuxService.unsetPaneOptionSync(tmuxPaneId, 'window-style');
      }
    };

    for (let step = 0; step < ATTENTION_FLASH_SEQUENCE_LENGTH; step += 1) {
      setTimeout(() => {
        if (!this.active) {
          restorePaneStyle();
          this.flashingTmuxPaneIds.delete(tmuxPaneId);
          return;
        }

        if (step % 2 === 0) {
          this.tmuxService.setPaneOptionSync(tmuxPaneId, 'window-style', flashStyle);
        } else {
          restorePaneStyle();
        }

        if (step === ATTENTION_FLASH_SEQUENCE_LENGTH - 1) {
          restorePaneStyle();
          this.flashingTmuxPaneIds.delete(tmuxPaneId);
        }
      }, step * ATTENTION_FLASH_STEP_MS);
    }
  }

  async sendAttentionNotification(
    request: DmuxAttentionNotificationRequest
  ): Promise<boolean> {
    if (!supportsNativeDmuxHelper() || isTestEnvironment()) {
      return false;
    }

    const socketPath = await this.ensureHelperSocketPath();
    if (!socketPath) {
      return false;
    }

    const payload: DmuxHelperNotifyMessage = {
      type: 'notify',
      title: request.title,
      subtitle: request.subtitle,
      body: request.body,
      soundName: this.resolveAttentionNotificationSoundName(),
      titleToken: this.token,
      bundleId: this.bundleId,
      tmuxPaneId: request.tmuxPaneId,
      tmuxSocketPath: this.tmuxSocketPath,
    };

    return new Promise<boolean>((resolve) => {
      const socket = createConnection(socketPath);
      let settled = false;

      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.once('connect', () => {
        socket.write(`${JSON.stringify(payload)}\n`, (error) => {
          finish(!error);
        });
      });

      socket.once('error', () => {
        finish(false);
      });
    });
  }

  private async ensureHelperSocketPath(): Promise<string | null> {
    if (this.helperSocketPath) {
      const helperReady = await waitForHelperSocket(this.helperSocketPath, 100);
      if (helperReady) {
        return this.helperSocketPath;
      }
    }

    const helperSocketPath = await ensureHelperRunning(this.logger);
    if (!helperSocketPath) {
      return null;
    }

    this.helperSocketPath = helperSocketPath;
    return helperSocketPath;
  }

  private async syncFocusedPaneState(): Promise<void> {
    if (!this.active || !this.helperFocused) {
      this.setFullyFocusedPaneId(null);
      return;
    }

    try {
      const currentPaneId = await this.tmuxService.getCurrentPaneId();
      if (!currentPaneId) {
        this.setFullyFocusedPaneId(null);
        return;
      }

      this.setFullyFocusedPaneId(currentPaneId);
    } catch {
      this.setFullyFocusedPaneId(null);
    }
  }

  private setFullyFocusedPaneId(paneId: string | null): void {
    if (this.fullyFocusedPaneId === paneId) {
      return;
    }

    this.fullyFocusedPaneId = paneId;
    this.emit('focus-changed', {
      fullyFocusedPaneId: paneId,
      helperFocused: this.helperFocused,
    } satisfies DmuxFocusChangedEvent);
  }

  private writeTerminalTitle(title: string): void {
    process.stdout.write(
      buildTerminalTitleSequence(title, Boolean(process.env.TMUX))
    );
  }
}
