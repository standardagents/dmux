import { describe, expect, it } from "vitest"
import {
  getPaneMenuActions,
  PaneAction,
  TOGGLE_PANE_VISIBILITY_ACTION,
} from "../src/actions/types.js"
import type { DmuxPane } from "../src/types.js"

function pane(id: string, overrides: Partial<DmuxPane> = {}): DmuxPane {
  const projectRoot = overrides.projectRoot || "/repo-a"
  const slug = overrides.slug || `pane-${id}`

  return {
    id,
    slug,
    prompt: `prompt-${id}`,
    paneId: `%${id}`,
    projectRoot,
    worktreePath: `${projectRoot}/.dmux/worktrees/${slug}`,
    ...overrides,
  }
}

describe("pane menu actions", () => {
  it("includes visibility actions and shortcuts for a visible pane", () => {
    const selectedPane = pane("1")
    const sameProjectPane = pane("2", { hidden: true })
    const otherProjectPane = pane("3", { projectRoot: "/repo-b" })

    const actions = getPaneMenuActions(
      selectedPane,
      [selectedPane, sameProjectPane, otherProjectPane],
      {},
      false,
      "/repo-a"
    )

    expect(actions[0].id).toBe(PaneAction.VIEW)
    expect(actions[1]).toMatchObject({
      id: TOGGLE_PANE_VISIBILITY_ACTION,
      label: "Hide Pane",
      shortcut: "h",
    })
    expect(actions[2]).toMatchObject({
      id: "hide-others",
      label: "Hide All Other Panes",
      shortcut: "H",
    })
    expect(actions[3]).toMatchObject({
      id: "focus-project",
      label: "Show Only This Project",
      shortcut: "P",
    })
    expect(actions.find((action) => action.id === PaneAction.CLOSE)).toMatchObject({
      shortcut: "x",
    })
    expect(actions.find((action) => action.id === PaneAction.CREATE_PR)).toMatchObject({
      shortcut: "p",
      label: "Create GitHub PR",
    })
    expect(actions[actions.length - 1].id).toBe(PaneAction.ATTACH_AGENT)
  })

  it("switches visibility labels when the pane and others are hidden", () => {
    const selectedPane = pane("1", { hidden: true })
    const sameProjectPane = pane("2", { hidden: true })

    const actions = getPaneMenuActions(
      selectedPane,
      [selectedPane, sameProjectPane],
      {},
      false,
      "/repo-a"
    )

    expect(actions.find((action) => action.id === TOGGLE_PANE_VISIBILITY_ACTION)).toMatchObject({
      label: "Show Pane",
      shortcut: "h",
    })
    expect(actions.find((action) => action.id === "show-others")).toMatchObject({
      label: "Show All Other Panes",
      shortcut: "H",
    })
  })

  it("shows the show-all project option when the selected project is already focused", () => {
    const selectedPane = pane("1")
    const sameProjectPane = pane("2")
    const otherProjectPane = pane("3", {
      hidden: true,
      projectRoot: "/repo-b",
    })

    const actions = getPaneMenuActions(
      selectedPane,
      [selectedPane, sameProjectPane, otherProjectPane],
      {},
      false,
      "/repo-a"
    )

    expect(actions.find((action) => action.id === "show-all")).toMatchObject({
      label: "Show All Panes",
      shortcut: "P",
    })
  })
})
