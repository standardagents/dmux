import { TmuxService } from "../services/TmuxService.js"
import { ASCII_ART_RENDER_DELAY } from "../constants/timing.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { resolveDistPath } from "./runtimePaths.js"
import { getActiveDmuxTheme } from "../theme/colors.js"

export interface RenderAsciiArtOptions {
  paneId: string
  art: string[]
  fillChar?: string
  centerVertically?: boolean
  centerHorizontally?: boolean
}

/**
 * Render ASCII art centered in a tmux pane with fill characters
 * Uses a persistent node script that re-renders on resize
 *
 * @param options - Rendering options
 * @param options.paneId - The tmux pane ID to render to
 * @param options.art - Array of strings representing each line of ASCII art (unused, uses default art)
 * @param options.fillChar - Character to fill empty space (unused, uses default)
 * @param options.centerVertically - Center art vertically (unused, always centered)
 * @param options.centerHorizontally - Center art horizontally (unused, always centered)
 */
export async function renderAsciiArt(
  options: RenderAsciiArtOptions
): Promise<void> {
  const { paneId } = options
  const tmuxService = TmuxService.getInstance()

  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  // Prefer package dist path first to keep runtime behavior aligned.
  const possiblePaths = [
    resolveDistPath("panes", "decorative-pane.js"),
    path.join(__dirname, "..", "panes", "decorative-pane.js"),
  ]

  let scriptPath = possiblePaths[0] // Default
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      scriptPath = p
      break
    }
  }

  // Verify the script exists
  if (!fs.existsSync(scriptPath)) {
    throw new Error(
      `Decorative pane script not found at ${scriptPath}. Tried: ${possiblePaths.join(
        ", "
      )}`
    )
  }

  // Kill any existing process in the pane
  try {
    await tmuxService.sendKeys(paneId, 'C-c')
  } catch {
    // Pane might not have a running process, that's okay
  }
  await new Promise((resolve) => setTimeout(resolve, ASCII_ART_RENDER_DELAY))

  // Run the decorative pane script with absolute path
  const absolutePath = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(scriptPath)
  await tmuxService.sendKeys(
    paneId,
    `'DMUX_THEME=${getActiveDmuxTheme()} node "${absolutePath}"' Enter`
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
}

/**
 * Predefined ASCII art designs
 */
export const ASCII_ART = {
  dmuxWelcome: `
╭─────────────────────────────────────────────────────────╮
│                                                         │
│           ███                                           │
│           ███                                           │
│       ███████  █████████████   ███  ███  ███  ███       │
│      ███  ███  ███  ███  ████  ███  ███  ███  ███       │
│      ███  ███  ███  ███  ████  ███  ███    █████        │
│      ███  ███  ███  ███  ████  ███  ███  ███  ███       │
│      ████████  ███  ███  ████  ████████  ███  ███       │
│                                                         │
│              AI developer agent multiplexer             │
│              Press [n] to create a new agent            │
│                                                         │
╰─────────────────────────────────────────────────────────╯
  `,
}
