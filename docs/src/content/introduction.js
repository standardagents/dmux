export const meta = { title: 'Introduction' };

export function render() {
  return `
    <h1>What is dmux?</h1>
    <p class="lead">dmux runs multiple coding agents and shell panes in parallel using tmux and git worktrees. It automates the worktree lifecycle, supports multiple projects in one session, includes a built-in read-only file browser for each worktree, and can raise native macOS notifications when background panes need attention. If you provide an OpenRouter key, it will also generate branch names, commit messages, and other quality-of-life automation for you.</p>
    <p>Use <kbd>f</kbd> to browse files inside a pane's worktree, <kbd>h</kbd> and <kbd>H</kbd> to hide panes without stopping them, and <kbd>P</kbd> to focus a single project's panes inside a shared session.</p>

    <div class="agent-cloud">
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/claude.svg" alt="Claude Code" class="agent-cloud-logo" />
        <span>Claude Code</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/opencode.svg" alt="OpenCode" class="agent-cloud-logo" />
        <span>OpenCode</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/codex.svg" alt="Codex" class="agent-cloud-logo" />
        <span>Codex</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/grok.svg" alt="Grok Build" class="agent-cloud-logo" />
        <span>Grok</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/cline.svg" alt="Cline" class="agent-cloud-logo" />
        <span>Cline</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/gemini.svg" alt="Gemini CLI" class="agent-cloud-logo" />
        <span>Gemini</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/qwen.svg" alt="Qwen CLI" class="agent-cloud-logo" />
        <span>Qwen</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/amp.svg" alt="Amp" class="agent-cloud-logo" />
        <span>Amp</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/pi.svg" alt="pi CLI" class="agent-cloud-logo" />
        <span>pi</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/cursor.svg" alt="Cursor" class="agent-cloud-logo" />
        <span>Cursor</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/copilot.svg" alt="GitHub Copilot" class="agent-cloud-logo" />
        <span>Copilot</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/crush.svg" alt="Crush" class="agent-cloud-logo" />
        <span>Crush</span>
      </a>
      <a href="#/agents" class="agent-cloud-item">
        <img src="/agents/antigravity.svg" alt="Antigravity CLI" class="agent-cloud-logo" />
        <span>Antigravity</span>
      </a>
    </div>

    <div class="video-wrap">
      <video class="dmux-video" id="dmux-video" autoplay loop muted playsinline>
        <source src="/dmux.mp4" type="video/mp4" />
      </video>
      <button class="video-fullscreen" onclick="document.getElementById('dmux-video').requestFullscreen()" title="Fullscreen">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>

    <div class="sa-banner">
      <div class="sa-banner-inner">
        <div class="sa-banner-content">
          <div class="sa-banner-header">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 981.45 150" fill="currentColor" class="sa-logo"><path d="M44.06,0v44.08H0v105.92h105.93v-44.07h44.07V0H44.06ZM19.09,130.91c-16.47-16.47-5.29-54.45,24.96-85.18v60.2h60.23c-30.73,30.27-68.71,41.47-85.2,24.98ZM105.93,104.29v-60.21h-60.21C76.46,13.8,114.42,2.6,130.91,19.09c16.51,16.49,5.31,54.47-24.98,85.2Z"/><g><path d="M203.01,112.34c-8.14,0-16.05-1.81-17.52-2.03-.79.68-1.36,2.03-1.47,2.26h-3.84c-.45-3.84-1.58-14.58-2.26-18.98l3.5-.68,3.73,5.31c3.62,5.2,10.17,7.46,18.87,7.46,10.85,0,16.84-4.18,16.84-13.56,0-10.51-10.51-14.01-19.1-16.72-11.87-3.73-22.6-7.46-22.6-22.94,0-9.38,8.14-20.23,23.28-20.23,3.84,0,6.67.56,9.04,1.13s4.29,1.36,6.44,1.58c.34,0,2.15-1.58,2.37-1.69h2.6l2.94,16.95-4.29.45-2.71-4.97c-2.15-3.96-7.91-7.57-16.5-7.57s-14.24,4.07-14.24,12.54c0,8.93,8.7,11.64,18.08,14.8,11.98,4.07,24.3,8.81,24.3,24.63,0,12.32-11.75,22.26-27.46,22.26Z"/><path d="M276.01,63.52h-19.55v34.02c0,3.28.45,4.52,1.24,5.42,1.24,1.36,3.16,2.37,5.31,2.37,4.97,0,8.93-2.03,12.09-3.73v4.75c-2.83,2.26-10.51,6.21-14.92,6.21-7.46,0-13.9-3.73-13.9-10.06,0-2.71.45-10.06.45-20.91v-17.18l-6.44-1.58v-2.03c3.28-2.83,9.38-8.7,14.01-13.56h2.71s-.45,7.57-.57,10.28h20.68l-1.13,5.99Z"/><path d="M323.35,112.56c-3.16,0-7.01-.79-8.25-4.75-5.2,2.15-11.53,4.52-17.4,4.52-8.93,0-14.24-4.97-14.24-13.11,0-6.55,2.26-10.62,10.96-12.88,5.54-1.47,12.09-2.37,20.12-3.5v-7.8c0-1.24,0-2.6-.34-4.75-.79-5.2-6.44-7.68-10.85-7.68-2.37,0-4.63.68-6.67,2.03-1.69,1.13-2.26,2.37-2.26,4.18l-8.36,2.03c-.23-.57-.34-1.13-.34-1.81,0-2.15,1.69-4.29,3.62-5.76,2.26-1.81,4.52-3.28,7.34-4.52,3.39-1.58,7.91-3.16,12.32-3.16,3.96,0,7.23,1.02,9.72,2.6,2.6,1.69,4.29,4.18,4.86,7.57.34,1.92.34,4.18.34,7.35v26.56c0,4.52,2.37,6.33,5.31,6.33s4.97-1.24,6.89-2.71l.9,3.5c-4.41,3.05-8.93,5.76-13.67,5.76ZM314.54,87.25c-7.01.79-11.41,1.58-16.61,2.94-4.52,1.13-5.65,3.05-5.65,6.67,0,5.2,3.5,9.72,9.49,9.72,4.18,0,8.48-1.47,12.77-3.05v-16.27Z"/><path d="M376.35,110.76v-2.94l2.37-.79c2.49-.79,2.94-2.71,2.94-5.08v-24.18c0-5.2-.45-9.04-2.94-11.3-1.7-1.58-4.18-2.37-7.01-2.37-3.28,0-5.99.79-8.7,1.81-2.49.9-4.75,2.03-6.1,2.83v33.45c0,3.5.68,3.73,3.73,4.29l5.31.9v3.39h-23.96v-2.94l2.49-.79c2.49-.79,2.71-2.37,2.71-5.08v-30.51c0-3.5-.45-4.75-2.15-5.99l-2.6-1.92v-1.92l12.66-6.67,1.81.68v8.93c2.83-2.03,12.54-8.59,19.32-8.59,8.48,0,15.14,5.65,15.14,14.35v31.87c0,3.5.79,3.84,3.73,4.29l5.54.9v3.39h-24.3Z"/><path d="M447.65,113.92l-1.13-.9-.68-6.89c-4.52,2.6-10.85,6.33-17.74,6.33-13.33,0-21.58-10.74-21.58-26.22s11.75-29.16,29.27-29.16c3.39,0,8.02.79,10.06,1.36v-13.56c0-4.29-.9-5.65-2.83-6.78l-2.6-1.47v-1.81l13.67-7.8,2.26.79s-.79,8.81-.79,12.77v62.38c0,2.49,1.02,4.07,3.5,4.07.34,0,.68,0,1.13-.11l4.41-.68v4.18l-16.95,3.5ZM445.84,66.91c-4.07-2.15-7.91-3.62-13.56-3.62-9.83,0-16.16,3.62-16.16,17.63s5.31,24.41,17.06,24.41c4.41,0,9.27-1.24,12.66-2.49v-35.94Z"/><path d="M512.51,112.56c-3.16,0-7.01-.79-8.25-4.75-5.2,2.15-11.53,4.52-17.4,4.52-8.93,0-14.24-4.97-14.24-13.11,0-6.55,2.26-10.62,10.96-12.88,5.54-1.47,12.09-2.37,20.12-3.5v-7.8c0-1.24,0-2.6-.34-4.75-.79-5.2-6.44-7.68-10.85-7.68-2.37,0-4.63.68-6.67,2.03-1.69,1.13-2.26,2.37-2.26,4.18l-8.36,2.03c-.23-.57-.34-1.13-.34-1.81,0-2.15,1.69-4.29,3.62-5.76,2.26-1.81,4.52-3.28,7.34-4.52,3.39-1.58,7.91-3.16,12.32-3.16,3.96,0,7.23,1.02,9.72,2.6,2.6,1.69,4.29,4.18,4.86,7.57.34,1.92.34,4.18.34,7.35v26.56c0,4.52,2.37,6.33,5.31,6.33s4.97-1.24,6.89-2.71l.9,3.5c-4.41,3.05-8.93,5.76-13.67,5.76ZM503.7,87.25c-7.01.79-11.41,1.58-16.61,2.94-4.52,1.13-5.65,3.05-5.65,6.67,0,5.2,3.5,9.72,9.49,9.72,4.18,0,8.48-1.47,12.77-3.05v-16.27Z"/><path d="M564.49,68.94h-.23c-1.47-.79-3.73-1.92-3.73-1.92-2.03-1.02-3.62-1.58-5.08-1.58-1.7,0-3.39.79-5.42,2.37l-3.96,3.05v31.3c0,3.05,1.58,3.5,3.73,3.84l8.14,1.36v3.39h-26.78v-2.94l2.49-.68c2.49-.68,2.71-2.6,2.71-5.2v-29.04c0-3.62-.11-5.31-2.03-7.01l-2.71-2.37v-1.92l12.66-6.67,1.81.68v10.17c1.7-1.7,9.27-7.68,9.27-7.68,2.71-2.26,4.29-3.16,5.54-3.16,1.36,0,2.26,1.13,3.84,3.73l2.03,3.5c-.57,2.03-1.58,5.09-2.26,6.78Z"/><path d="M611.95,113.92l-1.13-.9-.68-6.89c-4.52,2.6-10.85,6.33-17.74,6.33-13.33,0-21.58-10.74-21.58-26.22s11.75-29.16,29.27-29.16c3.39,0,8.02.79,10.06,1.36v-13.56c0-4.29-.9-5.65-2.83-6.78l-2.6-1.47v-1.81l13.67-7.8,2.26.79s-.79,8.81-.79,12.77v62.38c0,2.49,1.02,4.07,3.5,4.07.34,0,.68,0,1.13-.11l4.41-.68v4.18l-16.95,3.5ZM610.14,66.91c-4.07-2.15-7.91-3.62-13.56-3.62-9.83,0-16.16,3.62-16.16,17.63s5.31,24.41,17.06,24.41c4.41,0,9.27-1.24,12.66-2.49v-35.94Z"/><path d="M688.79,110.76v-3.28c2.71-.23,3.96-1.13,3.96-3.39,0-1.02-.23-2.26-.79-3.84l-5.42-14.58h-29.38l-4.41,11.3c-.79,1.92-1.02,3.5-1.02,4.75,0,2.83,1.7,4.41,6.67,5.99v3.05h-20.57v-3.05c3.96-1.02,7.01-7.91,8.36-11.19l18.08-43.06c3.28-7.68,5.31-13.22,8.36-20.45h4.63c1.02,3.62,4.63,12.66,6.44,17.18l19.78,49.95c1.24,3.28,3.96,6.67,7.91,7.35v3.28h-22.6ZM672.06,48.6l-12.77,31.3h25.09l-12.32-31.3Z"/><path d="M759.86,62.84c2.37,3.05,3.73,7.01,3.73,11.53,0,9.27-6.67,18.31-18.87,21.7-1.02.23-3.28.68-6.44,1.58-1.36.34-2.71.79-3.84,1.24-1.47.68-2.37,1.58-2.37,2.6,0,1.58,1.7,2.49,3.5,3.05,1.36.34,2.71.57,6.89.57h11.98c10.28,0,15.71,3.5,15.71,10.74,0,10.85-14.13,20.45-32.32,20.45-14.01,0-20-4.07-20-10.85,0-4.86,5.2-9.72,13.22-12.54-3.62-.79-8.7-3.5-8.7-7.68,0-4.75,6.33-7.35,11.08-9.38-8.02-1.58-13.56-9.61-13.56-17.18,0-12.77,10.85-23.51,23.51-23.51,3.39,0,6.78.9,9.72,2.37h18.53v5.31h-11.75ZM753.42,113.35h-11.75c-7.23,0-14.69,4.07-14.69,8.93,0,5.76,7.01,7.68,14.8,7.68,9.83,0,21.02-2.71,21.02-11.3,0-3.39-3.39-5.31-9.38-5.31ZM739.64,61.48c-6.78,0-11.53,4.18-11.53,11.19,0,8.25,5.65,18.42,14.8,18.42,8.02,0,11.98-6.22,11.98-13,0-8.7-5.99-16.61-15.26-16.61Z"/><path d="M799.08,112.56c-13.9,0-22.38-10.28-22.38-26.44,0-14.13,8.36-30.17,24.97-30.17,10.51,0,18.08,8.14,21.02,16.39l1.47.68v3.05l-38.2,9.04c1.02,10.62,7.23,21.02,19.55,21.02,4.63,0,11.41-2.37,17.18-6.55l1.58,4.29c-7.57,6.78-18.08,8.7-25.2,8.7ZM799.64,60.69c-7.35,0-13.9,8.02-13.9,20.23l26.78-7.01c-1.81-7.12-6.44-13.22-12.88-13.22Z"/><path d="M866.42,110.76v-2.94l2.37-.79c2.49-.79,2.94-2.71,2.94-5.08v-24.18c0-5.2-.45-9.04-2.94-11.3-1.7-1.58-4.18-2.37-7.01-2.37-3.28,0-5.99.79-8.7,1.81-2.49.9-4.75,2.03-6.1,2.83v33.45c0,3.5.68,3.73,3.73,4.29l5.31.9v3.39h-23.96v-2.94l2.49-.79c2.49-.79,2.71-2.37,2.71-5.08v-30.51c0-3.5-.45-4.75-2.15-5.99l-2.6-1.92v-1.92l12.66-6.67,1.81.68v8.93c2.83-2.03,12.54-8.59,19.32-8.59,8.48,0,15.14,5.65,15.14,14.35v31.87c0,3.5.79,3.84,3.73,4.29l5.54.9v3.39h-24.3Z"/><path d="M931.96,63.52h-19.55v34.02c0,3.28.45,4.52,1.24,5.42,1.24,1.36,3.16,2.37,5.31,2.37,4.97,0,8.93-2.03,12.09-3.73v4.75c-2.83,2.26-10.51,6.21-14.92,6.21-7.46,0-13.9-3.73-13.9-10.06,0-2.71.45-10.06.45-20.91v-17.18l-6.44-1.58v-2.03c3.28-2.83,9.38-8.7,14.01-13.56h2.71s-.45,7.57-.57,10.28h20.68l-1.13,5.99Z"/><path d="M957.38,112c-4.07,0-8.14-.68-12.09-1.24h-4.97l-.57-14.92,3.84-.45,1.36,4.52c1.7,5.76,6.55,7.01,11.87,7.01,4.97,0,12.88-1.24,12.88-7.57,0-4.29-3.28-6.67-7.68-8.7-3.5-1.58-7.01-2.83-10.62-4.52-5.88-2.83-10.85-6.78-10.85-14.8s7.91-15.37,20.91-15.37c3.5,0,6.89.56,10.28,1.36l3.05,12.66-4.18,1.24c-2.03-5.2-4.86-9.49-12.32-9.49-4.29,0-10.51,2.15-10.51,7.35,0,4.29,3.62,6.44,8.36,8.47,3.28,1.36,6.67,2.49,10.51,4.41,5.76,2.83,10.62,6.78,10.62,14.46,0,10.51-10.28,15.6-19.89,15.6Z"/></g></svg>
            <span class="sa-badge">Early Access</span>
          </div>
          <p class="sa-description">From the team behind <a href="https://formkit.com" target="_blank" rel="noopener">FormKit</a>, <a href="https://tempo.formkit.com" target="_blank" rel="noopener">Tempo</a>, dmux, <a href="https://auto-animate.formkit.com" target="_blank" rel="noopener">AutoAnimate</a>, and <a href="https://drag-and-drop.formkit.com" target="_blank" rel="noopener">Drag and Drop</a> &mdash; Standard Agents is an open standard for creating domain-specific agents you can distribute and compose together to form safe, efficient, and effective agents. Join the early access waitlist below.</p>
          <div id="sa-form-wrapper">
            <form class="sa-form" id="sa-early-access-form">
              <input type="text" placeholder="Name" required class="sa-input" id="sa-name-input" />
              <input type="email" placeholder="Email" required class="sa-input" id="sa-email-input" />
              <button type="submit" class="sa-submit" id="sa-submit-btn">
                <span class="sa-submit-label">Request Early Access</span>
                <span class="sa-submit-spinner" style="display:none"><svg class="sa-spinner" viewBox="0 0 20 20" width="16" height="16" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="2.5" opacity="0.25"/><path d="M10 2a8 8 0 0 1 8 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></span>
              </button>
            </form>
            <p class="sa-error" id="sa-error-msg" style="display:none"></p>
          </div>
          <div class="sa-success" id="sa-success-msg" style="display:none">
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none"><circle cx="10" cy="10" r="9" stroke="#22c55e" stroke-width="1.5"/><path d="M6 10.5l2.5 2.5 5.5-5.5" stroke="#22c55e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>You're on the list! We'll be in touch.</span>
          </div>
        </div>
      </div>
    </div>
  `;
}
