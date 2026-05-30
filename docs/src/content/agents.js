export const meta = { title: 'Agents' };

export function render() {
  return `
    <h1>Agents</h1>
    <p class="lead">dmux supports 13 AI coding agents. Each agent is automatically detected if its CLI is installed and available in your PATH.</p>

    <h2>Agent Detection</h2>
    <p>dmux automatically detects installed agents by searching:</p>
    <ol>
      <li>Your shell's command path (<code>command -v</code>)</li>
      <li>Common installation directories:
        <ul>
          <li><code>~/.claude/local/claude</code></li>
          <li><code>~/.local/bin/</code></li>
          <li><code>/usr/local/bin/</code></li>
          <li><code>/opt/homebrew/bin/</code></li>
        </ul>
      </li>
    </ol>
    <p>When creating panes from the TUI, dmux opens the agent chooser so you can choose one or more runs per agent. If <code>defaultAgent</code> is set in <a href="#/configuration">configuration</a>, that agent is preselected at <code>1x</code>; otherwise the first available agent is preselected.</p>

    <h2>Enabling Agents</h2>
    <p>Claude Code, OpenCode, Codex, and Grok Build are enabled by default. To use other agents, open settings by pressing <kbd>s</kbd> and toggle on the agents you want available in the agent selector.</p>

    <h2>Default Agent</h2>
    <p>To preselect your usual agent in the chooser, set a default agent:</p>
    <ul>
      <li><strong>TUI:</strong> Press <kbd>s</kbd> → set "Default Agent"</li>
      <li><strong>Config:</strong> Add <code>"defaultAgent": "claude"</code> to your settings JSON</li>
      <li><strong>API:</strong> <code>PATCH /api/settings</code> with <code>{"defaultAgent": "claude"}</code></li>
    </ul>

    <h2>Permission Modes</h2>
    <p>The <code>permissionMode</code> setting controls what flags dmux passes to each agent:</p>
    <table>
      <thead>
        <tr><th>permissionMode</th><th>Claude Code</th><th>Codex</th><th>Grok Build</th><th>opencode</th></tr>
      </thead>
      <tbody>
        <tr><td><code>''</code> (empty)</td><td>No flags</td><td>No flags</td><td>No flags</td><td>No flags</td></tr>
        <tr><td><code>plan</code></td><td><code>--permission-mode plan</code></td><td>No flags</td><td><code>--permission-mode plan</code></td><td>No flags</td></tr>
        <tr><td><code>acceptEdits</code></td><td><code>--permission-mode acceptEdits</code></td><td><code>--full-auto</code></td><td><code>--permission-mode acceptEdits</code></td><td>No flags</td></tr>
        <tr><td><code>bypassPermissions</code></td><td><code>--dangerously-skip-permissions</code></td><td><code>--dangerously-bypass-approvals-and-sandbox</code></td><td><code>--always-approve</code></td><td>No flags</td></tr>
      </tbody>
    </table>

    <h2>Autopilot Mode</h2>
    <p>When <code>enableAutopilotByDefault</code> is enabled in <a href="#/configuration">settings</a>, dmux will automatically accept agent option dialogs when no risk is detected. This reduces manual intervention while agents work.</p>
    <p>This setting controls dialog handling and is separate from <code>permissionMode</code>.</p>

    <h2>Goal Mode</h2>
    <p>When <code>enableGoalModeByDefault</code> is enabled, new panes start supported agents with a <code>/goal</code> command built from the initial prompt. The new-pane prompt popup also includes a per-pane checkbox so you can turn goal mode on or off for that launch.</p>
    <p>dmux currently enables native goal launch behavior for Claude Code and Codex. Codex launches with the experimental <code>--enable goals</code> flag when goal mode is selected. Other agents receive the normal initial prompt unless they add compatible goal-mode support later.</p>

    <h2>Grok Build Notes</h2>
    <p>Grok Build is detected as <code>grok</code>. dmux starts the interactive TUI and pastes the initial prompt into it so the pane remains usable after the first response. Reopened Grok panes use <code>grok --continue</code> from the worktree directory.</p>
    <p>dmux also installs lightweight Grok project hooks in <code>.grok/hooks/</code> for stop and notification events. Grok requires project hook trust before project hooks execute; open Grok's hooks UI with <code>/hooks</code> or run <code>/hooks-trust</code> inside the Grok session if needed.</p>

    <div class="callout callout-warning">
      <div class="callout-title">Caution</div>
      With the default <code>permissionMode</code> (<code>bypassPermissions</code>), Claude, Codex, and Grok run with full-permission flags. Combined with autopilot, this provides highly autonomous behavior. Use only in isolated/trusted environments.
    </div>

    <h2>Agent Status Detection</h2>
    <p>dmux monitors each agent pane to determine its current state. This is used to show status indicators in the sidebar.</p>
    <p>The detection works by:</p>
    <ol>
      <li><strong>Activity tracking</strong> — if the terminal content is changing, the agent is considered "working"</li>
      <li><strong>LLM analysis</strong> — when activity stops, dmux uses lightweight OpenRouter models, with a free JSON-capable fallback, to analyze the terminal content and determine if the agent is waiting for input, showing a dialog, or idle</li>
      <li><strong>User typing detection</strong> — if the user is typing, dmux avoids false positives</li>
    </ol>
    <p>Each pane has its own worker thread that polls every second without blocking the main UI.</p>
  `;
}
