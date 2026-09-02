import fs from "fs";
import path from "path";

const DEBUG_LOG_FILE = process.env.DMUX_DEBUG_LOG || "/tmp/dmux-debug.log";

/**
 * Append a structured debug line to the dmux debug log file.
 * Used for troubleshooting popup / input issues in non-interactive settings.
 */
export function debugLog(label: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${label}] ${data !== undefined ? JSON.stringify(data) : ""}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG_FILE, line);
  } catch {
    // Ignore logging failures so we never break the app for a debug line.
  }
}

/**
 * Ensure the debug log directory exists.
 */
export function ensureDebugLogPath(): void {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true });
  } catch {
    // Ignore
  }
}
