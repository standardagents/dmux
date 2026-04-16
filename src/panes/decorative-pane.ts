#!/usr/bin/env node

// Decorative pane renderer - displays ASCII art with animated falling binary characters
// This runs continuously without showing a command prompt

import { ASCII_ART as ASCII_ART_EXPORTS } from "../utils/asciiArt.js"
import { DECORATIVE_THEME, syncDmuxThemeFromSettings } from "../theme/colors.js"

// Parse the ASCII art string into an array of lines
const ASCII_ART = ASCII_ART_EXPORTS.dmuxWelcome.trim().split("\n")

const FILL_CHAR = "·"
syncDmuxThemeFromSettings(process.cwd())
const DIM_GRAY = DECORATIVE_THEME.fill
const RESET = DECORATIVE_THEME.reset

// Static drop settings
const TAIL_LENGTH = 8 // Length of the fading tail
const NUM_STATIC_DROPS = 150 // Number of drops to render in static view

const SHADES = DECORATIVE_THEME.tail

interface GridCell {
  char: string
  color: string
}

// Static drop - represents a frozen position of a falling column
interface StaticDrop {
  column: number
  y: number
  chars: string[]
}

/**
 * Generate random static drops that look like a paused animation
 */
function generateStaticDrops(width: number, height: number): StaticDrop[] {
  const drops: StaticDrop[] = []

  for (let i = 0; i < NUM_STATIC_DROPS; i++) {
    // Random column
    const column = Math.floor(Math.random() * width)

    // Random position in the screen (can be anywhere including partially visible)
    const y = Math.floor(Math.random() * (height + TAIL_LENGTH))

    // Random binary characters
    const chars = Array.from({ length: TAIL_LENGTH }, () =>
      Math.random() > 0.5 ? "1" : "0"
    )

    drops.push({ column, y, chars })
  }

  return drops
}

/**
 * Render static drops to a grid
 */
function renderStaticDrops(
  drops: StaticDrop[],
  grid: (GridCell | null)[][],
  height: number
): void {
  for (const drop of drops) {
    for (let i = 0; i < drop.chars.length; i++) {
      const row = Math.floor(drop.y - i)
      if (
        row >= 0 &&
        row < height &&
        drop.column >= 0 &&
        drop.column < grid[row].length
      ) {
        const shadeIndex = Math.min(i, SHADES.length - 1)
        grid[row][drop.column] = {
          char: drop.chars[i],
          color: SHADES[shadeIndex],
        }
      }
    }
  }
}

function render(width: number, height: number): void {
  // Generate random static drops for this render
  const drops = generateStaticDrops(width, height)

  // Create a grid for the background layer (falling characters)
  const backgroundGrid: (GridCell | null)[][] = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => null)
  )

  // Render all drops to the background grid
  renderStaticDrops(drops, backgroundGrid, height)

  const artHeight = ASCII_ART.length
  const artWidth = Math.max(...ASCII_ART.map((line) => line.length))

  // Calculate vertical centering for ASCII art
  const topPadding = Math.floor((height - artHeight) / 2)

  const lines: string[] = []

  // Build each line by combining background and foreground
  for (let row = 0; row < height; row++) {
    const isArtRow = row >= topPadding && row < topPadding + artHeight
    const artLine = isArtRow ? ASCII_ART[row - topPadding] : null

    let line = ""

    for (let col = 0; col < width; col++) {
      if (isArtRow && artLine) {
        const trimmedArt = artLine.trimEnd()
        const leftPadding = Math.max(
          0,
          Math.floor((width - trimmedArt.length) / 2)
        )
        const artCol = col - leftPadding

        // If we're in the art region and the art has a character here
        if (artCol >= 0 && artCol < trimmedArt.length) {
          const artChar = trimmedArt[artCol]
          // ASCII art takes precedence - render in orange
          line += DECORATIVE_THEME.primary + artChar + RESET
        } else {
          // Outside art region - show background or fill char
          const bg = backgroundGrid[row][col]
          if (bg) {
            line += bg.color + bg.char + RESET
          } else {
            line += DIM_GRAY + FILL_CHAR + RESET
          }
        }
      } else {
        // Not an art row - show background or fill char
        const bg = backgroundGrid[row][col]
        if (bg) {
          line += bg.color + bg.char + RESET
        } else {
          line += DIM_GRAY + FILL_CHAR + RESET
        }
      }
    }

    lines.push(line)
  }

  // Clear screen and render
  process.stdout.write("\x1b[2J\x1b[H") // Clear screen and home cursor
  process.stdout.write(lines.join("\n"))
}

// Initial render
const initialWidth = process.stdout.columns || 80
const initialHeight = process.stdout.rows || 24
render(initialWidth, initialHeight)

// Re-render only on terminal resize (static, no animation)
process.stdout.on("resize", () => {
  const width = process.stdout.columns || 80
  const height = process.stdout.rows || 24
  render(width, height)
})

// Keep the process running
process.stdin.resume()

// Handle Ctrl+C gracefully (though this pane will be killed by tmux)
process.on("SIGINT", () => {
  process.exit(0)
})

process.on("SIGTERM", () => {
  process.exit(0)
})
