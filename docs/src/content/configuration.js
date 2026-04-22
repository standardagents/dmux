export const meta = { title: 'Configuration' };

export function render() {
  return `
    <h1>Configuration</h1>
    <p class="lead">dmux uses a layered configuration system with global, team, and project-level settings. Project settings override global settings, and global settings override optional team defaults committed in the repo.</p>

    <h2>Configuration Files</h2>
    <table>
      <thead>
        <tr><th>File</th><th>Scope</th><th>Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td><code>~/.dmux.global.json</code></td><td>Global</td><td>Default settings for all projects</td></tr>
        <tr><td><code>.dmux.defaults.json</code></td><td>Team</td><td>Repo-committed defaults shared across the project</td></tr>
        <tr><td><code>.dmux/settings.json</code></td><td>Project</td><td>Project-specific overrides</td></tr>
        <tr><td><code>.dmux/dmux.config.json</code></td><td>Project</td><td>Pane tracking (managed by dmux)</td></tr>
      </tbody>
    </table>

    <h2>Available Settings</h2>

    <h3><code>enableAutopilotByDefault</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>boolean</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>true</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Automatically accept options when no risk is detected for new panes. When enabled, agents will run with less user intervention.</td></tr>
      </tbody>
    </table>

    <h3><code>permissionMode</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>'' | 'plan' | 'acceptEdits' | 'bypassPermissions'</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>'bypassPermissions'</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Controls the permission flags dmux passes to launched agents. Use empty string to defer to each agent's own defaults.</td></tr>
      </tbody>
    </table>

    <h3><code>defaultAgent</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>AgentName | ''</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>''</code> (ask each time)</td></tr>
        <tr><td><strong>Description</strong></td><td>Skip the agent selection dialog and always use this agent for new panes. Set it to any supported agent ID such as <code>claude</code>, <code>codex</code>, or <code>gemini</code>. Use an empty string to be prompted each time.</td></tr>
      </tbody>
    </table>

    <h3><code>enabledAgents</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>AgentName[]</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>default-enabled registry entries</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Controls which agents appear in the new-pane selection popup. Use the settings UI to enable or disable agents per scope.</td></tr>
      </tbody>
    </table>

    <h3><code>enabledNotificationSounds</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>NotificationSoundId[]</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>['default-system-sound']</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Select which macOS helper sounds dmux randomizes between for background attention notifications. If the list is empty or invalid, dmux falls back to the default system sound.</td></tr>
      </tbody>
    </table>

    <h3><code>useTmuxHooks</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>boolean</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>false</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Use tmux hooks for event-driven pane updates instead of polling. Lower CPU usage but requires tmux hook support.</td></tr>
      </tbody>
    </table>

    <h3><code>baseBranch</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>string</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>''</code> (current HEAD)</td></tr>
        <tr><td><strong>Description</strong></td><td>Branch to create new worktrees from. Leave empty to use the current HEAD. The branch must exist in the repository.</td></tr>
      </tbody>
    </table>

    <h3><code>branchPrefix</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>string</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>''</code> (no prefix)</td></tr>
        <tr><td><strong>Description</strong></td><td>Prefix for new branch names. For example, setting this to <code>feat/</code> will create branches like <code>feat/fix-auth</code>. The worktree directory name stays flat (just the slug).</td></tr>
      </tbody>
    </table>

    <h3><code>promptForGitOptionsOnCreate</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>boolean</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>false</code></td></tr>
        <tr><td><strong>Description</strong></td><td>When enabled, the new-pane popup asks for optional create-time overrides for base branch and branch/worktree name. Base branch override must match an existing local branch (suggested in most-recently-committed order). These per-pane overrides take precedence over <code>baseBranch</code> and <code>branchPrefix</code>.</td></tr>
      </tbody>
    </table>

    <h3><code>minPaneWidth</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>number</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>50</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Minimum content-pane width in characters. Used during layout fitting to prevent panes from becoming too narrow. Range: 40–300. This is a global-only setting (project overrides are ignored).</td></tr>
      </tbody>
    </table>

    <h3><code>maxPaneWidth</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>number</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>80</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Maximum content-pane width in characters. Controls when wrapping or spacer logic kicks in. Range: 40–300. This is a global-only setting (project overrides are ignored).</td></tr>
      </tbody>
    </table>

    <h2>Accessing Settings</h2>

    <h3>TUI</h3>
    <p>Press <kbd>s</kbd> to open the settings dialog. You can switch between global and project scope, toggle each setting, choose enabled agents, and configure macOS attention notification sounds.</p>

    <h3>Manual Editing</h3>
    <p>You can edit the JSON files directly:</p>
    <pre><code data-lang="json">{
  "enableAutopilotByDefault": true,
  "permissionMode": "bypassPermissions",
  "defaultAgent": "claude",
  "enabledAgents": ["claude", "codex", "gemini"],
  "enabledNotificationSounds": ["default-system-sound", "harp"],
  "useTmuxHooks": false,
  "baseBranch": "develop",
  "branchPrefix": "feat/",
  "promptForGitOptionsOnCreate": true,
  "minPaneWidth": 50,
  "maxPaneWidth": 80
}</code></pre>
    <p><code>.dmux.defaults.json</code> lives at the repo root and is intended for safe, team-wide defaults that you want in version control. Personal overrides still belong in <code>.dmux/settings.json</code> or <code>~/.dmux.global.json</code>.</p>

    <h2>macOS Attention Notifications</h2>
    <p>On macOS, dmux ships with a native helper that can send attention notifications for background panes. This is progressive enhancement only: dmux continues working on Linux and Windows without it.</p>
    <ul>
      <li>Notifications are only sent for panes that are not currently fully focused</li>
      <li><code>enabledNotificationSounds</code> controls which helper sounds are eligible for random selection</li>
      <li>The sidebar and pane borders still show attention state even when native notifications are unavailable</li>
    </ul>

    <h2>Setting Precedence</h2>
    <p>When the same key is defined in multiple places, dmux resolves it in this order:</p>
    <ol>
      <li>Project settings (<code>.dmux/settings.json</code>) — highest priority</li>
      <li>Global settings (<code>~/.dmux.global.json</code>) — fallback</li>
      <li>Team defaults (<code>.dmux.defaults.json</code>) — shared repo baseline</li>
      <li>Built-in defaults — if neither file defines the setting</li>
    </ol>

    <h2>OpenRouter Configuration</h2>
    <p>dmux uses <a href="https://openrouter.ai" target="_blank" rel="noopener">OpenRouter</a> for AI-powered features like smart branch naming and commit message generation.</p>

    <h3>Setting Up</h3>
    <ol>
      <li>Create an account at <a href="https://openrouter.ai" target="_blank" rel="noopener">openrouter.ai</a></li>
      <li>Generate an API key from the <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">keys page</a></li>
      <li>Set the environment variable:
        <pre><code data-lang="bash">export OPENROUTER_API_KEY="sk-or-v1-..."</code></pre>
      </li>
      <li>Add it to your shell profile for persistence:
        <pre><code data-lang="bash"># Add to ~/.zshrc or ~/.bashrc
echo 'export OPENROUTER_API_KEY="sk-or-v1-..."' >> ~/.zshrc</code></pre>
      </li>
    </ol>

    <h3>How It's Used</h3>
    <table>
      <thead>
        <tr><th>Feature</th><th>Model</th><th>Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td>Slug generation</td><td>gpt-4o-mini</td><td>Convert prompts to short branch names</td></tr>
        <tr><td>Commit messages</td><td>gpt-4o-mini</td><td>Generate conventional commit messages from diffs</td></tr>
        <tr><td>Pane status</td><td>grok-4-fast (free)</td><td>Detect agent state from terminal output</td></tr>
      </tbody>
    </table>

    <h3>Without OpenRouter</h3>
    <p>If <code>OPENROUTER_API_KEY</code> is not set, dmux still works but with reduced functionality:</p>
    <ul>
      <li>Branch names fall back to <code>dmux-{timestamp}</code></li>
      <li>Commit messages fall back to <code>dmux: auto-commit changes</code></li>
      <li>Pane status detection uses heuristics instead of LLM analysis</li>
    </ul>

    <div class="callout callout-tip">
      <div class="callout-title">Tip</div>
      OpenRouter provides free credits for new accounts, and the models dmux uses (gpt-4o-mini, grok-4-fast) are very inexpensive. Even heavy usage costs only pennies per day.
    </div>

    <h2>Environment Variables</h2>
    <table>
      <thead>
        <tr><th>Variable</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr><td><code>OPENROUTER_API_KEY</code></td><td>API key for OpenRouter AI features</td></tr>
        <tr><td><code>DMUX_SESSION</code></td><td>Override the tmux session name</td></tr>
      </tbody>
    </table>
  `;
}
