import { store, newId } from './state';
import { streamChat, fetchSettingsFromST } from './api';
import { fileToAttachment, formatBytes } from './attach';
import { renderMarkdown, renderMarkdownStreaming } from './markdown';
import { CLAUDE_MODELS } from './defaults';
import { applyTheme, type ThemePref } from './theme';
import { onStatus, getStatus, syncNowManual, startSync, scheduleSync, type SyncStatus } from './sync';
import type { Attachment, Conversation, Message, Settings } from './types';

// ─── Helpers ───
const $ = <T extends Element>(s: string, root: ParentNode = document) => root.querySelector(s) as T | null;
const escHtml = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

let pendingAttachments: Attachment[] = [];
let abortCtrl: AbortController | null = null;

let toastTimer: number | null = null;
function toast(msg: string, kind: 'info' | 'error' = 'info') {
  let el = $('.toast') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
    el.addEventListener('click', () => el!.classList.remove('show'));
  }
  el.textContent = msg;
  const long = msg.length > 80;
  el.className = 'toast' + (kind === 'error' ? ' error' : '') + (long ? ' long' : '') + ' show';
  if (toastTimer) clearTimeout(toastTimer);
  // Errors stay until tapped or until 12s; info auto-dismisses fast
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 12000 : 2800);
}

function buzz(ms = 8) {
  if ('vibrate' in navigator) {
    try { (navigator as any).vibrate(ms); } catch {}
  }
}

// ─── Top-level render ───
export function mount(root: HTMLElement) {
  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <button class="icon-btn" id="btn-menu" aria-label="Conversations">☰</button>
        <button class="title" id="btn-model" aria-label="Model & compaction">
          <div class="name">Bubble</div>
          <div class="model" id="model-label"></div>
        </button>
        <button class="icon-btn" id="btn-settings" aria-label="Settings">⚙</button>
      </header>

      <div class="popover hidden" id="model-popover">
        <div class="popover-section">
          <div class="popover-label">Active model — tap to swap</div>
          <div class="model-toggle" id="model-toggle"></div>
        </div>
        <div class="popover-section">
          <div class="popover-label">This conversation</div>
          <div class="token-row" id="token-row"></div>
        </div>
        <div class="popover-section">
          <button class="popover-btn" id="btn-compact-now">📦 Compact conversation</button>
          <div class="popover-hint">Summarizes via <span id="compact-model-name"></span> and replaces history. You can also type <code>/compact</code>.</div>
        </div>
        <div class="popover-section">
          <div class="popover-label">Export this conversation</div>
          <div class="export-row">
            <button class="popover-btn ghost" id="btn-export-md">⬇ Markdown</button>
            <button class="popover-btn ghost" id="btn-export-json">⬇ JSON</button>
          </div>
        </div>
        <div class="popover-section">
          <div class="popover-label">Web search</div>
          <button class="ws-row" id="btn-ws-toggle" type="button">
            <span class="ws-txt">🔍 Let Claude search the web</span>
            <span class="toggle" id="ws-toggle-el"></span>
          </button>
          <div class="popover-hint">Claude decides when to search — ask something current, or say “search the web for…”. Requires proxy support.</div>
        </div>
      </div>

      <main class="chat-scroll" id="chat"></main>

      <footer class="composer">
        <div class="prompt-chips" id="prompt-chips"></div>
        <div class="attachments" id="attachments"></div>
        <div class="row">
          <button class="icon-btn" id="btn-attach" aria-label="Attach">+</button>
          <input type="file" id="file-input" multiple accept="image/*,.png,.jpg,.jpeg,.jfif,.webp,.gif,.bmp,.svg,.avif,.heic,.heif,.tif,.tiff,.ico,.pdf,.md,.markdown,.txt,.json,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.toml,.sh,.log,text/*" hidden />
          <textarea id="composer-input" rows="1" placeholder="Message..." autocapitalize="sentences"></textarea>
          <button class="icon-btn send-btn" id="btn-send" aria-label="Send">↑</button>
        </div>
      </footer>
    </div>

    <div class="scrim" id="scrim"></div>

    <aside class="drawer" id="drawer">
      <div class="head">
        <button class="new-btn" id="btn-new">＋ &nbsp;New chat</button>
        <button class="icon-btn" id="btn-close-drawer" aria-label="Close">✕</button>
      </div>
      <div class="conv-list" id="conv-list"></div>
    </aside>

    <section class="sheet" id="sheet">
      <div class="head">
        <button class="icon-btn" id="btn-close-sheet" aria-label="Close">✕</button>
        <h2>Settings</h2>
        <button class="btn-secondary" id="btn-resync">Sync from ST</button>
      </div>
      <div class="sheet-body" id="sheet-body"></div>
    </section>
  `;

  // bindings
  $<HTMLButtonElement>('#btn-menu')!.addEventListener('click', () => toggleDrawer(true));
  $<HTMLButtonElement>('#btn-model')!.addEventListener('click', () => toggleModelPopover());
  $<HTMLButtonElement>('#btn-compact-now')!.addEventListener('click', async () => { toggleModelPopover(false); await runCompact(); });
  $<HTMLButtonElement>('#btn-export-md')!.addEventListener('click', () => { toggleModelPopover(false); exportCurrentMarkdown(); });
  $<HTMLButtonElement>('#btn-export-json')!.addEventListener('click', () => { toggleModelPopover(false); exportCurrentJSON(); });
  $<HTMLButtonElement>('#btn-ws-toggle')!.addEventListener('click', async () => {
    const next = !store.settings.enable_web_search;
    await store.updateSettings({ enable_web_search: next });
    $<HTMLSpanElement>('#ws-toggle-el')?.classList.toggle('on', next);
    toast(next ? 'Web search on — ask something current' : 'Web search off');
    buzz();
  });
  document.addEventListener('click', (e) => {
    const pop = $<HTMLDivElement>('#model-popover');
    const trigger = $<HTMLButtonElement>('#btn-model');
    if (!pop || !trigger) return;
    if (pop.classList.contains('hidden')) return;
    const t = e.target as Node;
    if (!pop.contains(t) && !trigger.contains(t)) toggleModelPopover(false);
  });
  $<HTMLButtonElement>('#btn-close-drawer')!.addEventListener('click', () => toggleDrawer(false));
  $<HTMLButtonElement>('#btn-settings')!.addEventListener('click', () => { renderSettingsSheet(); toggleSheet(true); });
  $<HTMLButtonElement>('#btn-close-sheet')!.addEventListener('click', () => toggleSheet(false));
  $<HTMLButtonElement>('#scrim')!.addEventListener('click', () => { toggleDrawer(false); toggleSheet(false); });
  $<HTMLButtonElement>('#btn-new')!.addEventListener('click', async () => {
    await store.newConversation();
    toggleDrawer(false);
    renderChat();
    focusComposer();
  });
  $<HTMLButtonElement>('#btn-attach')!.addEventListener('click', () => $<HTMLInputElement>('#file-input')!.click());
  $<HTMLInputElement>('#file-input')!.addEventListener('change', onFilesPicked);
  $<HTMLButtonElement>('#btn-send')!.addEventListener('click', onSendOrCancel);
  $<HTMLButtonElement>('#btn-resync')!.addEventListener('click', resyncFromST);

  // Track whether the user is pinned to the bottom; only auto-scroll if so.
  const chatRoot = $<HTMLDivElement>('#chat')!;
  chatRoot.addEventListener('scroll', () => {
    stickToBottom = chatRoot.scrollHeight - chatRoot.scrollTop - chatRoot.clientHeight < 90;
  }, { passive: true });

  const ta = $<HTMLTextAreaElement>('#composer-input')!;
  ta.addEventListener('input', () => { autoGrow(ta); updateSendBtn(); });
  ta.addEventListener('keydown', (e) => {
    // Enter (no shift): send. Mobile: Enter = newline (default), so only desktop should send.
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      onSendOrCancel();
    }
  });

  // Subscribe to store updates
  store.subscribe(() => {
    renderModelLabel();
    renderConvList();
    renderChat();
    renderPromptChips();
    updateSendBtn();
  });

  // Initial render
  renderModelLabel();
  renderConvList();
  renderChat();
  renderPromptChips();
  updateSendBtn();

  // Welcome / bootstrap nudge
  if (!store.settings.proxy_password) {
    setTimeout(() => toast('Open Settings → fill in proxy URL & password', 'info'), 800);
  }
}

function isMobile() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

function autoGrow(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

function focusComposer() {
  const ta = $<HTMLTextAreaElement>('#composer-input');
  ta?.focus();
}

function updateSendBtn() {
  const btn = $<HTMLButtonElement>('#btn-send')!;
  const ta = $<HTMLTextAreaElement>('#composer-input')!;
  const hasContent = ta.value.trim().length > 0 || pendingAttachments.length > 0;
  if (store.streaming) {
    btn.classList.add('streaming', 'active');
    btn.textContent = '■';
    btn.setAttribute('aria-label', 'Stop');
    return;
  }
  btn.textContent = '↑';
  btn.setAttribute('aria-label', 'Send');
  btn.classList.remove('streaming');
  btn.classList.toggle('active', hasContent);
}

function renderModelLabel() {
  const el = $<HTMLDivElement>('#model-label');
  if (!el) return;
  const m = store.settings.claude_model;
  const tok = formatTokens(totalConversationTokens());
  el.textContent = `${m} · ${tok}`;
}

// ─── Token counter (chars/4 heuristic) ───
function approxTokens(text: string | undefined): number {
  return Math.ceil((text || '').length / 4);
}
function totalConversationTokens(): number {
  if (!store.current) return 0;
  let total = approxTokens(effectiveSystemPrompt());
  total += approxTokens(store.current.compactionSummary);
  for (const m of store.current.messages) {
    total += approxTokens(m.content);
    total += approxTokens(m.thinking);
    if (m.attachments) {
      for (const a of m.attachments) total += approxTokens(a.text);
    }
  }
  return total;
}
function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// ─── Prompt chips (1 system + 2 userstyle, toggleable inline) ───
function renderPromptChips() {
  const root = $<HTMLDivElement>('#prompt-chips');
  if (!root) return;
  const s = store.settings;
  const chips = [
    { key: 'system_prompt' as const, name: 'System', body: s.system_prompt, on: s.system_prompt_enabled, enabledKey: 'system_prompt_enabled' as const },
    { key: 'userstyle1' as const, name: s.userstyle1_name || 'Style 1', body: s.userstyle1, on: s.userstyle1_enabled, enabledKey: 'userstyle1_enabled' as const },
    { key: 'userstyle2' as const, name: s.userstyle2_name || 'Style 2', body: s.userstyle2, on: s.userstyle2_enabled, enabledKey: 'userstyle2_enabled' as const },
  ];
  root.innerHTML = chips.map(c => {
    const empty = !c.body || !c.body.trim();
    return `<button class="chip ${c.on ? 'on' : ''} ${empty ? 'empty' : ''}" data-toggle-prompt="${c.enabledKey}" title="${c.on ? 'On — tap to disable' : 'Off — tap to enable'}">${escHtml(c.name)}</button>`;
  }).join('');
  root.querySelectorAll<HTMLButtonElement>('[data-toggle-prompt]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.togglePrompt!;
      const next = !((store.settings as any)[key]);
      await store.updateSettings({ [key]: next } as any);
      buzz();
    });
  });
}

// ─── Effective system prompt ───
function effectiveSystemPrompt(): string {
  const s = store.settings;
  const parts: string[] = [];
  if (store.current?.compactionSummary) {
    parts.push(`<previous_conversation_summary>\n${store.current.compactionSummary}\n</previous_conversation_summary>`);
  }
  if (s.system_prompt_enabled && s.system_prompt?.trim()) parts.push(s.system_prompt.trim());
  if (s.userstyle1_enabled && s.userstyle1?.trim()) parts.push(s.userstyle1.trim());
  if (s.userstyle2_enabled && s.userstyle2?.trim()) parts.push(s.userstyle2.trim());
  return parts.join('\n\n');
}

// ─── Model popover ───
function toggleModelPopover(force?: boolean) {
  const pop = $<HTMLDivElement>('#model-popover');
  if (!pop) return;
  const open = force === undefined ? pop.classList.contains('hidden') : force;
  if (open) {
    renderModelPopover();
    pop.classList.remove('hidden');
  } else {
    pop.classList.add('hidden');
  }
}

function renderModelPopover() {
  const s = store.settings;
  const toggle = $<HTMLDivElement>('#model-toggle');
  if (toggle) {
    const a = s.claude_model;
    const b = s.claude_alt_model || s.claude_model;
    toggle.innerHTML = `
      <button class="seg ${'on'}" data-pick="primary">${escHtml(a)}</button>
      <button class="seg" data-pick="alt">${escHtml(b)}</button>
    `;
    toggle.querySelector<HTMLButtonElement>('[data-pick="alt"]')?.addEventListener('click', async () => {
      // Swap primary <-> alt
      await store.updateSettings({ claude_model: b, claude_alt_model: a });
      renderModelPopover();
      buzz();
    });
  }
  const tokens = totalConversationTokens();
  const tokRow = $<HTMLDivElement>('#token-row');
  if (tokRow) {
    tokRow.innerHTML = `
      <div class="tok-num">${formatTokens(tokens)}</div>
      <div class="tok-sub">approx tokens · using chars÷4</div>
    `;
  }
  const cmName = $<HTMLSpanElement>('#compact-model-name');
  if (cmName) cmName.textContent = s.compact_model;
  $<HTMLSpanElement>('#ws-toggle-el')?.classList.toggle('on', !!s.enable_web_search);
}

// ─── /compact: summarize current conversation, replace messages ───
let compacting = false;
async function runCompact() {
  if (compacting) return;
  if (!store.current || !store.current.messages.length) {
    toast('Nothing to compact yet', 'info');
    return;
  }
  if (store.streaming) { toast('Wait for the current response to finish', 'error'); return; }

  const s = store.settings;
  if (!s.reverse_proxy || !s.proxy_password) {
    toast('Set the proxy URL + password in Settings first', 'error');
    return;
  }
  if (!s.compact_model) { toast('No compact model set', 'error'); return; }

  compacting = true;
  const beforeTokens = totalConversationTokens();
  toast('Compacting…');

  // Render the conversation as a single block of text inside a user message.
  // This avoids "conversation must end with user" 400 errors from Claude.
  const blocks: string[] = [];
  if (store.current!.compactionSummary) {
    blocks.push(`# Previous summary\n${store.current!.compactionSummary}`);
  }
  for (const m of store.current!.messages) {
    if (m.role === 'system') continue;
    blocks.push(`## ${m.role}\n${m.content || ''}`);
  }
  const conversationText = blocks.join('\n\n');

  const compactPrompt = `Summarize the following conversation concisely but information-densely. Preserve:
- The user's goals, intent, and any open questions
- Key decisions or conclusions
- Important facts, code snippets, or exact values shared
- State of ongoing tasks
- Notable preferences or style requirements

Output ONLY the summary as plain prose. Do NOT greet, do NOT comment, do NOT respond conversationally — your output replaces the conversation history.

<conversation>
${conversationText}
</conversation>`;

  const { streamChat } = await import('./api');
  let summary = '';
  try {
    await new Promise<void>((resolve, reject) => {
      streamChat(
        { ...store.settings, claude_model: s.compact_model, stream_openai: false, openai_max_tokens: 8000 },
        [{ id: 'compact-input', role: 'user', content: compactPrompt, createdAt: Date.now() }],
        '',
        {
          onText: (delta) => { summary += delta; },
          onDone: ({ text }) => { if (!summary && text) summary = text; resolve(); },
          onError: (e) => reject(e),
        },
      );
    });
  } catch (e) {
    compacting = false;
    const err = (e as Error).message || String(e);
    console.error('Compact failed:', e);
    // Surface a hint when the model name looks like the culprit
    const hint = /model|404|invalid_request_error/i.test(err)
      ? `\n\nHint: your proxy may not recognize "${s.compact_model}". Try setting a different "Compact model" in Settings → Advanced (or sync from SillyTavern).`
      : '';
    toast(`Compact failed (tap to dismiss):\n${err}${hint}`, 'error');
    return;
  }

  if (!summary || !summary.trim()) {
    compacting = false;
    toast('Compact returned empty result', 'error');
    return;
  }

  // Persist into the conversation: clear messages, store summary
  const c = store.current!;
  // If there was already a previous summary, fold it in
  const merged = c.compactionSummary
    ? `${c.compactionSummary.trim()}\n\n---\n\n${summary.trim()}`
    : summary.trim();
  c.compactionSummary = merged;
  c.compactedAt = Date.now();
  c.compactedTokenCount = beforeTokens;
  c.messages = [];
  // Drop DOM cache for messages
  for (const [, el] of msgNodes) el.remove();
  msgNodes.clear();
  await store.saveCurrent();
  compacting = false;
  toast(`Compacted ✓ ${formatTokens(beforeTokens)} → ${formatTokens(approxTokens(summary))}`);
  buzz(20);
}

// ─── Drawer ───
function toggleDrawer(open: boolean) {
  const d = $('#drawer')!;
  const s = $('#scrim')!;
  d.classList.toggle('open', open);
  s.classList.toggle('open', open);
}

function renderConvList() {
  const list = $<HTMLDivElement>('#conv-list');
  if (!list) return;
  if (!store.conversations.length) {
    list.innerHTML = `<div style="padding:14px;color:var(--text-faint);font-size:13px;text-align:center;">No conversations yet.</div>`;
    return;
  }
  list.innerHTML = store.conversations.map(c => `
    <div class="conv-item ${store.current?.id === c.id ? 'active' : ''}" data-id="${c.id}">
      <div class="row">
        <div class="name">${escHtml(c.title || 'Untitled')}</div>
        <button class="delete" data-del="${c.id}" aria-label="Delete">✕</button>
      </div>
      <div class="preview">${escHtml(lastMessagePreview(c.messages))}</div>
    </div>
  `).join('');
  list.querySelectorAll<HTMLDivElement>('.conv-item').forEach(it => {
    it.addEventListener('click', async (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.dataset.del) {
        e.stopPropagation();
        if (confirm('Delete this conversation?')) await store.deleteCurrentConversation(tgt.dataset.del);
        return;
      }
      const id = it.dataset.id!;
      await store.selectConversation(id);
      toggleDrawer(false);
    });
  });
}

function lastMessagePreview(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].content) return msgs[i].content.slice(0, 80);
  }
  return '';
}

// ─── Chat view (incremental DOM, perf-aware) ───

const msgNodes = new Map<string, HTMLElement>();
let streamingMsgId: string | null = null;

function ensureChatRoot(): HTMLDivElement | null {
  return $<HTMLDivElement>('#chat');
}

function renderEmptyState(root: HTMLDivElement) {
  root.innerHTML = `
    <div class="chat-empty">
      <div>
        <div class="logo">🫧</div>
        <div class="title">Start a conversation</div>
        <div class="sub">Anything goes — code, debugging, prose, weird hypotheticals</div>
      </div>
    </div>`;
  msgNodes.clear();
}

function renderChat() {
  const root = ensureChatRoot();
  if (!root) return;
  const c = store.current;
  if (!c || (!c.messages.length && !c.compactionSummary)) { renderEmptyState(root); return; }

  // Reconcile DOM with messages list: keep nodes for messages that still exist,
  // create/delete only what's necessary, no big rebuild.
  if (root.querySelector('.chat-empty')) root.innerHTML = '';

  // Render compaction card if present
  renderCompactionCard(root, c);

  const wantedSet = new Set(c.messages.map(m => m.id));
  for (const [id, el] of msgNodes) {
    if (!wantedSet.has(id)) { el.remove(); msgNodes.delete(id); }
  }

  // Account for the compaction card sitting at the top of #chat (if present).
  const offset = root.querySelector('.compaction-card') ? 1 : 0;
  for (let i = 0; i < c.messages.length; i++) {
    const m = c.messages[i];
    let el = msgNodes.get(m.id);
    if (!el) {
      el = createMessageEl(m);
      msgNodes.set(m.id, el);
    } else {
      updateMessageEl(el, m);
    }
    const existing = root.children[i + offset];
    if (existing !== el) root.insertBefore(el, existing || null);
  }

  // (Removal of stray nodes handled implicitly by msgNodes pruning above.)

  scrollToBottomSoon();
}

function renderCompactionCard(root: HTMLElement, c: { compactionSummary?: string; compactedAt?: number; compactedTokenCount?: number; }) {
  let card = root.querySelector<HTMLDivElement>('.compaction-card');
  if (!c.compactionSummary) { card?.remove(); return; }
  if (!card) {
    card = document.createElement('div');
    card.className = 'compaction-card';
    root.prepend(card);
  } else if (root.firstChild !== card) {
    root.prepend(card);
  }
  const when = c.compactedAt ? new Date(c.compactedAt).toLocaleString() : '';
  const before = c.compactedTokenCount ?? 0;
  const after = approxTokens(c.compactionSummary);
  card.innerHTML = `
    <div class="head">
      <span class="ico">📦</span>
      <div class="meta">
        <div class="t">Compacted ${when}</div>
        <div class="s">${formatTokens(before)} → ${formatTokens(after)} (~${Math.round((1 - after / Math.max(before, 1)) * 100)}% smaller)</div>
      </div>
      <button class="expand" aria-label="View summary">▾</button>
    </div>
    <div class="body hidden">
      <pre>${escHtml(c.compactionSummary)}</pre>
      <div class="actions">
        <button class="btn-secondary" data-act="recompact">Compact again</button>
        <button class="btn-secondary" data-act="clear-compaction">Clear summary</button>
      </div>
    </div>
  `;
  const exp = card.querySelector<HTMLButtonElement>('.expand');
  const body = card.querySelector<HTMLDivElement>('.body');
  exp?.addEventListener('click', () => {
    body?.classList.toggle('hidden');
    if (exp) exp.textContent = body?.classList.contains('hidden') ? '▾' : '▴';
  });
  card.querySelector<HTMLButtonElement>('[data-act="recompact"]')?.addEventListener('click', () => runCompact());
  card.querySelector<HTMLButtonElement>('[data-act="clear-compaction"]')?.addEventListener('click', async () => {
    if (!confirm('Remove the conversation summary? Messages stay, but the summary context is dropped.')) return;
    if (store.current) {
      store.current.compactionSummary = undefined;
      store.current.compactedAt = undefined;
      store.current.compactedTokenCount = undefined;
      await store.saveCurrent();
    }
  });
}

let scrollPending = false;
let stickToBottom = true;
function scrollToBottomSoon(forceStick = false) {
  if (forceStick) stickToBottom = true;
  if (!stickToBottom) return;
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    const root = ensureChatRoot();
    if (root) root.scrollTop = root.scrollHeight;
  });
}

// Scroll a specific message to the top of the chat viewport (with a little breathing
// room), so a new/regenerating turn sits up top and the reply streams in below it.
function scrollMsgToTop(id: string) {
  requestAnimationFrame(() => {
    const root = ensureChatRoot();
    const el = msgNodes.get(id);
    if (root && el) root.scrollTop = Math.max(0, el.offsetTop - 12);
  });
}

function createMessageEl(m: Message): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.dataset.id = m.id;
  el.innerHTML = messageInnerHtml(m, false);
  bindMessageHandlers(el);
  return el;
}

function updateMessageEl(el: HTMLElement, m: Message) {
  if (m.id === streamingMsgId) {
    updateStreamingBody(el, m);
    return;
  }
  // Skip re-render when the message hasn't actually changed
  const sig = msgSig(m);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.classList.remove('streaming');
  el.innerHTML = messageInnerHtml(m, false);
  bindMessageHandlers(el);
}

function msgSig(m: Message): string {
  return [
    m.content?.length || 0,
    m.thinking?.length || 0,
    m.error || '',
    m.activeVariant ?? -1,
    m.variants?.length || 0,
    m.attachments?.length || 0,
    m.webSources?.length || 0,
    m.webSearchQueries?.length || 0,
    m.offerDismissed ? 1 : 0,
    store.settings.chat_mode,   // doc-offer bar visibility depends on the mode → bust cache on toggle
  ].join('|');
}

let lastMdRender = 0;
function updateStreamingBody(el: HTMLElement, m: Message, force = false) {
  // Ignore stale calls for a message that has already finished streaming.
  if (m.id !== streamingMsgId) return;
  // Initial scaffold if missing
  if (!el.querySelector('.bubble')) {
    el.innerHTML = messageInnerHtml(m, true);
    bindMessageHandlers(el);
  }
  let body = el.querySelector<HTMLDivElement>('.stream-body');
  if (!body) {
    el.innerHTML = messageInnerHtml(m, true);
    bindMessageHandlers(el);
    body = el.querySelector('.stream-body');
  }
  el.classList.add('streaming');

  // Thinking block: ensure exists when needed, update text
  if (m.thinking) {
    let think = el.querySelector<HTMLDivElement>('.thinking');
    if (!think) {
      const bubble = el.querySelector('.bubble');
      if (bubble) {
        const wrap = document.createElement('div');
        wrap.innerHTML = `<div class="thinking-toggle">▾ Thoughts</div><div class="thinking"></div>`;
        bubble.prepend(wrap.children[1]);
        bubble.prepend(wrap.children[0]);
      }
      think = el.querySelector<HTMLDivElement>('.thinking');
    }
    if (think) think.textContent = m.thinking;
  }

  if (!body) return;

  // Before the first token: show animated typing dots.
  if (!m.content) {
    if (!body.querySelector('.typing')) {
      body.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
    }
    return;
  }

  // Throttle the (cheap, highlight-free) markdown re-parse to ~30fps for long
  // messages so we never thrash layout. Short messages render every frame.
  const now = performance.now();
  if (!force && m.content.length > 400 && now - lastMdRender < 33) return;
  lastMdRender = now;

  body.innerHTML = renderMarkdownStreaming(m.content);
  appendStreamCaret(body);
}

// Tuck a blinking caret after the last piece of text, like claude.ai.
function appendStreamCaret(body: HTMLElement) {
  const caret = document.createElement('span');
  caret.className = 'stream-caret';
  const last = body.lastElementChild;
  const inlineHosts = ['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'BLOCKQUOTE'];
  if (last && inlineHosts.includes(last.tagName)) last.appendChild(caret);
  else body.appendChild(caret);
}

function messageInnerHtml(m: Message, isStreaming: boolean): string {
  const imageHtml = (m.attachments || []).filter(a => a.kind === 'image' && a.dataUrl)
    .map(a => `<img src="${a.dataUrl}" alt="${escHtml(a.name)}" />`).join('');
  const fileHtml = (m.attachments || []).filter(a => a.kind !== 'image')
    .map(a => `<div class="file-chip"><span>📎</span><span class="name">${escHtml(a.name)}</span><span class="size">${formatBytes(a.size)}</span></div>`).join('');

  const thinkingHtml = m.thinking
    ? `<div class="thinking-toggle">▾ Thoughts</div><div class="thinking">${escHtml(m.thinking)}</div>`
    : '';

  const bodyHtml = isStreaming
    ? `<div class="stream-body">${m.content ? renderMarkdownStreaming(m.content) : ''}</div>`
    : (m.role === 'assistant'
        ? renderMarkdown(m.content || '')
        : `<div style="white-space:pre-wrap;">${escHtml(m.content || '')}</div>`);

  const errHtml = m.error
    ? `<div style="color:var(--danger);font-size:12px;padding:6px 0;">⚠ ${escHtml(m.error)}</div>`
    : '';

  const navigator = renderVariantNavigator(m);

  const saveMenu = m.role === 'assistant'
    ? `<span class="save-wrap">
        <button data-action="save-toggle" data-mid="${m.id}">Save ▾</button>
        <span class="save-menu hidden">
          <button data-action="save-pdf" data-mid="${m.id}">PDF</button>
          <button data-action="save-docx" data-mid="${m.id}">DOCX</button>
          <button data-action="save-html" data-mid="${m.id}">HTML</button>
          <button data-action="save-xlsx" data-mid="${m.id}">XLSX</button>
        </span>
      </span>`
    : '';

  const meta = `
    <div class="meta">
      ${m.role !== 'system' ? `<button data-action="edit" data-mid="${m.id}">Edit</button>` : ''}
      <button data-action="copy" data-mid="${m.id}">Copy</button>
      <button data-action="delete" data-mid="${m.id}">Delete</button>
      ${m.role === 'assistant' ? `<button data-action="regen" data-mid="${m.id}">Regenerate</button>` : ''}
      ${saveMenu}
    </div>
  `;

  const hasSearch = !isStreaming && ((m.webSources && m.webSources.length) || (m.webSearchQueries && m.webSearchQueries.length));
  const queryPills = (m.webSearchQueries && m.webSearchQueries.length)
    ? `<div class="search-queries">${m.webSearchQueries.map(q => `<span class="sq">🔍 ${escHtml(q)}</span>`).join('')}</div>`
    : '';
  const sourceCards = (m.webSources && m.webSources.length)
    ? `<div class="sources-head">Sources</div>${m.webSources.map(s => {
        const safe = /^https?:\/\//i.test(s.url);  // only allow real web links
        const inner = `<span class="t">${escHtml(s.title || s.url)}</span><span class="u">${escHtml(hostOf(s.url))}</span>`;
        return safe
          ? `<a class="source" href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
          : `<div class="source">${inner}</div>`;
      }).join('')}`
    : '';
  const sourcesHtml = hasSearch ? `<div class="sources">${queryPills}${sourceCards}</div>` : '';

  // The proactive "save as document" bar only shows in Work mode — in Casual it'd
  // ambush every table/ASCII-art reply with a vibe-killing "WANNA DOWNLOAD??".
  const offerHtml = (store.settings.chat_mode === 'work' && !isStreaming && m.role === 'assistant' && !m.offerDismissed) ? docOfferHtml(m) : '';

  return `
    ${imageHtml ? `<div class="images">${imageHtml}</div>` : ''}
    ${fileHtml ? `<div class="files">${fileHtml}</div>` : ''}
    ${(m.content || m.thinking || m.error || isStreaming) ? `<div class="bubble">${thinkingHtml}${bodyHtml}${errHtml}</div>` : ''}
    ${sourcesHtml}
    ${offerHtml}
    ${navigator}
    ${meta}
  `;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// Heuristic: if a finished reply looks like a document or contains a table,
// surface a one-tap "save it" offer using the same generators as the Save menu.
function docOfferHtml(m: Message): string {
  const md = m.content || '';
  if (!md.trim()) return '';
  const hasTable = /^\s*\|.*\|.*\r?\n\s*\|[\s:|-]+\|/m.test(md);
  const docLike = /^#{1,3}\s/m.test(md) && md.length > 600;
  if (!hasTable && !docLike) return '';
  const btns: string[] = [];
  if (docLike) btns.push(
    `<button data-action="save-pdf" data-mid="${m.id}">📄 PDF</button>`,
    `<button data-action="save-docx" data-mid="${m.id}">DOCX</button>`,
  );
  if (hasTable) btns.push(`<button data-action="save-xlsx" data-mid="${m.id}">📊 Excel</button>`);
  const label = hasTable && !docLike ? 'Looks like a table' : 'Looks like a document';
  return `<div class="doc-offer"><span class="lbl">✨ ${label} — save it:</span><span class="acts">${btns.join('')}</span><button class="dismiss" data-action="dismiss-offer" data-mid="${m.id}" aria-label="Dismiss">✕</button></div>`;
}

function renderVariantNavigator(m: Message): string {
  if (!m.variants || m.variants.length < 2) return '';
  const idx = (m.activeVariant ?? 0) + 1;
  const tot = m.variants.length;
  return `<div class="variant-nav">
    <button data-action="prev-variant" data-mid="${m.id}" aria-label="Previous">‹</button>
    <span>${idx} / ${tot}</span>
    <button data-action="next-variant" data-mid="${m.id}" aria-label="Next">›</button>
  </div>`;
}

function bindMessageHandlers(el: HTMLElement) {
  el.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleMessageAction(btn.dataset.action!, btn.dataset.mid!);
    });
  });
  el.querySelectorAll<HTMLDivElement>('.thinking-toggle').forEach(t => {
    t.addEventListener('click', () => {
      const next = t.nextElementSibling as HTMLElement | null;
      if (next) next.classList.toggle('hidden');
    });
  });
  enhanceCodeBlocks(el);
}

// Give every fenced code block a header (language label + Copy), and an
// Artifacts-style live Preview for html/svg blocks rendered in a sandboxed
// iframe. Skipped while streaming (the code isn't complete yet).
function enhanceCodeBlocks(el: HTMLElement) {
  if (el.querySelector('.stream-body')) return; // mid-stream; wait for final render
  el.querySelectorAll<HTMLPreElement>('.bubble pre').forEach(pre => {
    if (pre.dataset.enhanced) return;
    const code = pre.querySelector('code');
    if (!code) return;
    pre.dataset.enhanced = '1';

    const lang = ([...code.classList].find(c => c.startsWith('language-')) || '').slice(9).toLowerCase();
    const previewable = /^(html|svg|xml)$/.test(lang);
    const isCsv = lang === 'csv';

    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `
      <span class="lang">${escHtml(lang || 'code')}</span>
      <div class="acts">
        ${previewable ? `<button class="ca-btn ca-prev" type="button">▶ Preview</button>` : ''}
        ${previewable ? `<button class="ca-btn ca-dl" type="button">⬇ file</button>` : ''}
        ${isCsv ? `<button class="ca-btn ca-xlsx" type="button">⬇ xlsx</button>` : ''}
        <button class="ca-btn ca-copy" type="button">Copy</button>
      </div>`;
    pre.replaceWith(wrap);
    wrap.appendChild(head);
    wrap.appendChild(pre);

    head.querySelector<HTMLButtonElement>('.ca-copy')!.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code.textContent || ''); toast('Code copied'); }
      catch { toast('Copy failed', 'error'); }
    });

    head.querySelector<HTMLButtonElement>('.ca-dl')?.addEventListener('click', async () => {
      const ext = lang === 'svg' ? 'svg' : 'html';
      const mime = lang === 'svg' ? 'image/svg+xml' : 'text/html';
      const { downloadBlob } = await import('./export-doc');
      downloadBlob(`artifact.${ext}`, new Blob([code.textContent || ''], { type: mime }));
      toast(`Downloaded .${ext} ✓`);
    });

    head.querySelector<HTMLButtonElement>('.ca-xlsx')?.addEventListener('click', async () => {
      try { const { csvToXlsx } = await import('./export-doc'); await csvToXlsx(code.textContent || '', 'table'); toast('Saved XLSX ✓'); }
      catch (e) { toast((e as Error).message || 'Export failed', 'error'); }
    });

    if (previewable) {
      let frame: HTMLIFrameElement | null = null;
      let showing = false;
      const btn = head.querySelector<HTMLButtonElement>('.ca-prev')!;
      btn.addEventListener('click', () => {
        if (!frame) {
          frame = document.createElement('iframe');
          frame.className = 'artifact-frame';
          // No allow-same-origin → the artifact can run scripts but can't touch the app.
          frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals');
          const src = code.textContent || '';
          frame.srcdoc = lang === 'svg' || lang === 'xml'
            ? `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${src}</body></html>`
            : src;
          wrap.appendChild(frame);
        }
        showing = !showing;
        wrap.classList.toggle('previewing', showing);
        btn.textContent = showing ? '◼ Code' : '▶ Preview';
      });
    }
  });
}

async function handleMessageAction(action: string, mid: string) {
  const c = store.current;
  if (!c) return;
  const msg = c.messages.find(m => m.id === mid);
  if (!msg) return;
  if (action === 'copy') {
    try { await navigator.clipboard.writeText(msg.content || ''); toast('Copied'); } catch { toast('Copy failed', 'error'); }
  } else if (action === 'delete') {
    c.messages = c.messages.filter(m => m.id !== mid);
    msgNodes.get(mid)?.remove();
    msgNodes.delete(mid);
    await store.saveCurrent();
  } else if (action === 'edit') {
    enterEditMode(msg);
  } else if (action === 'regen') {
    if (await store.forkForRegenerate(mid)) {
      // Re-mount the now-empty assistant message before streaming
      renderChat();
      await streamAndAppend(mid);
    }
  } else if (action === 'prev-variant') {
    if (!msg.variants || msg.variants.length < 2) return;
    const i = ((msg.activeVariant ?? 0) - 1 + msg.variants.length) % msg.variants.length;
    await store.switchVariant(mid, i);
    buzz();
  } else if (action === 'next-variant') {
    if (!msg.variants || msg.variants.length < 2) return;
    const i = ((msg.activeVariant ?? 0) + 1) % msg.variants.length;
    await store.switchVariant(mid, i);
    buzz();
  } else if (action === 'save-toggle') {
    msgNodes.get(mid)?.querySelector('.save-menu')?.classList.toggle('hidden');
  } else if (action === 'dismiss-offer') {
    msg.offerDismissed = true;
    await store.saveCurrent();
  } else if (action.startsWith('save-')) {
    await saveReplyAs(action.slice(5), msg);
    msgNodes.get(mid)?.querySelector('.save-menu')?.classList.add('hidden');
  }
}

async function saveReplyAs(fmt: string, msg: Message) {
  const md = msg.content || '';
  if (!md.trim()) { toast('Nothing to save in this reply', 'info'); return; }
  const title = store.current?.title || 'bubble-reply';
  try {
    const ex = await import('./export-doc');
    if (fmt === 'pdf') { ex.saveReplyAsPdf(md, title); }
    else if (fmt === 'html') { ex.saveReplyAsHtml(md, title); toast('Saved HTML ✓'); }
    else if (fmt === 'docx') { toast('Building DOCX…'); await ex.saveReplyAsDocx(md, title); toast('Saved DOCX ✓'); }
    else if (fmt === 'xlsx') { await ex.saveTablesAsXlsx(md, title); toast('Saved XLSX ✓'); }
    buzz(12);
  } catch (e) {
    toast((e as Error).message || 'Export failed', 'error');
  }
}

function enterEditMode(m: Message) {
  const el = msgNodes.get(m.id);
  if (!el) return;
  const bubble = el.querySelector('.bubble') as HTMLDivElement | null;
  if (!bubble) return;
  el.classList.add('editing');
  bubble.innerHTML = `
    <textarea class="edit-input">${escHtml(m.content || '')}</textarea>
    <div class="edit-actions">
      <button class="btn-secondary" data-edit-cancel>Cancel</button>
      <button class="btn-primary" data-edit-save>${m.role === 'user' ? 'Save & resend' : 'Save'}</button>
    </div>
  `;
  const ta = bubble.querySelector('textarea') as HTMLTextAreaElement;
  ta.focus();
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
  });
  bubble.querySelector('[data-edit-cancel]')?.addEventListener('click', () => {
    el.classList.remove('editing');
    delete el.dataset.sig; // edit replaced innerHTML without changing the sig; force a rebuild
    updateMessageEl(el, m);
  });
  bubble.querySelector('[data-edit-save]')?.addEventListener('click', async () => {
    const newContent = ta.value;
    el.classList.remove('editing');
    if (m.role === 'user') {
      await store.forkAtMessage(m.id, { content: newContent });
      renderChat();
      await streamAndAppend();
    } else {
      await store.forkAtMessage(m.id, { content: newContent });
      renderChat();
    }
  });
}

// ─── Send / cancel ───
async function onSendOrCancel() {
  if (store.streaming) {
    abortCtrl?.abort();
    return;
  }
  const ta = $<HTMLTextAreaElement>('#composer-input')!;
  const text = ta.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  // Slash commands
  if (text === '/compact' && pendingAttachments.length === 0) {
    ta.value = '';
    autoGrow(ta);
    await runCompact();
    return;
  }

  const userMsg: Message = {
    id: newId(),
    role: 'user',
    content: text,
    attachments: pendingAttachments.length ? pendingAttachments : undefined,
    createdAt: Date.now(),
  };
  ta.value = '';
  autoGrow(ta);
  pendingAttachments = [];
  renderAttachments();

  if (!store.current) await store.newConversation();
  await store.appendMessage(userMsg);
  buzz();
  await streamAndAppend();
}

async function streamAndAppend(reuseAssistantId?: string) {
  if (!store.current) return;
  const s = store.settings;
  if (!s.reverse_proxy || !s.proxy_password) {
    toast('Set the proxy URL + password in Settings first', 'error');
    return;
  }

  let asstId: string;
  if (reuseAssistantId) {
    asstId = reuseAssistantId;
  } else {
    asstId = newId();
    const asstMsg: Message = { id: asstId, role: 'assistant', content: '', createdAt: Date.now() };
    store.current.messages.push(asstMsg);
    await store.saveCurrent();
  }

  store.streaming = true;
  streamingMsgId = asstId;
  // Anchor the new turn at the TOP of the viewport (claude.ai-style) and DON'T follow
  // the streaming text down — that drag-the-screen feeling was the bottom-pinning below.
  stickToBottom = false;
  updateSendBtn();
  abortCtrl = new AbortController();

  const systemPrompt = store.current.systemPromptOverride ?? effectiveSystemPrompt();
  const idx = store.current.messages.findIndex(m => m.id === asstId);
  const historyForApi = idx === -1 ? store.current.messages : store.current.messages.slice(0, idx);

  // Mount the message node before streaming kicks in
  renderChat();

  // Scroll the just-sent user turn (or the regen target) to the top so the reply has
  // room to stream in below, instead of yanking the view to the bottom.
  const anchorId = idx > 0 && store.current.messages[idx - 1]?.role === 'user'
    ? store.current.messages[idx - 1].id
    : asstId;
  scrollMsgToTop(anchorId);

  let accText = '';
  let accThinking = '';

  // Throttled DOM updates: at most one per animation frame
  let dirty = false;
  let raf: number | null = null;
  const flush = () => {
    raf = null;
    if (!dirty) return;
    dirty = false;
    const el = msgNodes.get(asstId);
    const i = store.current!.messages.findIndex(x => x.id === asstId);
    if (i !== -1) {
      store.current!.messages[i].content = accText;
      store.current!.messages[i].thinking = accThinking || undefined;
      if (el) updateStreamingBody(el, store.current!.messages[i]);
    }
    scrollToBottomSoon();
  };
  const requestFlush = () => {
    dirty = true;
    if (raf == null) raf = requestAnimationFrame(flush);
  };

  await streamChat(
    s,
    historyForApi,
    systemPrompt,
    {
      onText: (delta) => { accText += delta; requestFlush(); },
      onThinking: (delta) => { accThinking += delta; requestFlush(); },
      onSearch: (query) => {
        const el = msgNodes.get(asstId);
        const bubble = el?.querySelector('.bubble');
        if (!bubble) return;
        let chip = bubble.querySelector('.search-chip') as HTMLDivElement | null;
        if (!chip) {
          chip = document.createElement('div');
          chip.className = 'search-chip';
          bubble.prepend(chip);
        }
        chip.textContent = query ? `🔍 Searching: ${query}` : '🔍 Searching the web…';
        scrollToBottomSoon();
      },
      onDone: async ({ sources, queries }) => {
        // Kill any pending streaming flush so it can't clobber the final render.
        if (raf != null) { cancelAnimationFrame(raf); raf = null; }
        dirty = false;
        // Final commit: swap streaming body for fully-rendered markdown.
        const el = msgNodes.get(asstId);
        const i = store.current!.messages.findIndex(x => x.id === asstId);
        if (i !== -1) {
          store.current!.messages[i].content = accText;
          store.current!.messages[i].thinking = accThinking || undefined;
          store.current!.messages[i].webSources = sources && sources.length ? sources : undefined;
          store.current!.messages[i].webSearchQueries = queries && queries.length ? queries : undefined;
        }
        store.streaming = false;
        streamingMsgId = null;
        abortCtrl = null;
        if (el && i !== -1) {
          el.classList.remove('streaming');
          el.innerHTML = messageInnerHtml(store.current!.messages[i], false);
          el.dataset.sig = msgSig(store.current!.messages[i]);
          bindMessageHandlers(el);
        }
        if (reuseAssistantId) {
          await store.finalizeRegenVariant(asstId);
        }
        updateSendBtn();
        await store.saveCurrent();
        // Push the finished reply NOW (not on the 1500ms debounce) so it lands before
        // the user backgrounds the app — otherwise the turn syncs reply-less.
        scheduleSync(0);
        buzz(4);
        scrollToBottomSoon();
      },
      onError: async (err) => {
        // Kill any pending streaming flush so it can't overwrite the error render.
        if (raf != null) { cancelAnimationFrame(raf); raf = null; }
        dirty = false;
        store.streaming = false;
        streamingMsgId = null;
        abortCtrl = null;
        const i = store.current!.messages.findIndex(x => x.id === asstId);
        if (i !== -1) {
          store.current!.messages[i].content = accText;
          store.current!.messages[i].error = err.message;
        }
        updateSendBtn();
        renderChat();
        await store.saveCurrent();
        toast('Error: ' + err.message, 'error');
      },
    },
    abortCtrl.signal,
  );
}

// ─── Attachments ───
async function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length) return;
  for (const f of files) {
    try {
      const att = await fileToAttachment(f);
      pendingAttachments.push(att);
    } catch (e) {
      toast(`Couldn't attach ${f.name}: ${(e as Error).message}`, 'error');
    }
  }
  renderAttachments();
  updateSendBtn();
}

function renderAttachments() {
  const root = $<HTMLDivElement>('#attachments')!;
  root.innerHTML = pendingAttachments.map(a => {
    if (a.kind === 'image' && a.dataUrl) {
      return `<div class="att" data-id="${a.id}"><img src="${a.dataUrl}" alt=""><span class="x" data-x="${a.id}">✕</span></div>`;
    }
    const icon = a.kind === 'pdf' ? '📕' : '📄';
    return `<div class="att" data-id="${a.id}">${icon}<span class="lbl">${escHtml(a.name)}</span><span class="x" data-x="${a.id}">✕</span></div>`;
  }).join('');
  root.querySelectorAll<HTMLSpanElement>('[data-x]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.x!;
      pendingAttachments = pendingAttachments.filter(a => a.id !== id);
      renderAttachments();
      updateSendBtn();
    });
  });
}

// ─── Export / Import ───
function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function safeFilename(s: string): string {
  return (s || 'chat').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'chat';
}

// Pick a code fence longer than any backtick run inside the content, so fenced
// text that itself contains ``` can't terminate the fence early.
function fenceFor(s: string): string {
  let max = 2;
  for (const run of s.match(/`+/g) || []) max = Math.max(max, run.length);
  return '`'.repeat(max + 1);
}

function conversationToMarkdown(c: Conversation): string {
  const out: string[] = [];
  out.push(`# ${c.title || 'Untitled chat'}`, '');
  out.push(`*Exported ${new Date().toLocaleString()} · model \`${c.model || store.settings.claude_model}\`*`, '');
  if (c.compactionSummary) {
    out.push('> **Conversation summary (compacted):**');
    for (const ln of c.compactionSummary.split('\n')) out.push('> ' + ln);
    out.push('');
  }
  for (const m of c.messages) {
    if (m.role === 'system') continue;
    out.push(`### ${m.role === 'user' ? '🧑 You' : '🫧 Claude'}`);
    const atts = m.attachments || [];
    // Name in a code span (with backticks neutralised) so filenames with markdown chars stay intact.
    if (atts.length) out.push(atts.map(a => `📎 \`${(a.name || '').replace(/`/g, "'")}\` (${a.kind})`).join(' · '), '');
    if (m.thinking) {
      const f = fenceFor(m.thinking);
      out.push('<details><summary>Thoughts</summary>', '', f, m.thinking, f, '', '</details>', '');
    }
    out.push(m.content || '', '');
  }
  return out.join('\n');
}

function exportCurrentMarkdown() {
  const c = store.current;
  if (!c || (!c.messages.length && !c.compactionSummary)) { toast('Nothing to export yet', 'info'); return; }
  downloadFile(`${safeFilename(c.title)}.md`, conversationToMarkdown(c), 'text/markdown');
  toast('Exported Markdown ✓');
}

function exportCurrentJSON() {
  const c = store.current;
  if (!c || (!c.messages.length && !c.compactionSummary)) { toast('Nothing to export yet', 'info'); return; }
  const payload = { type: 'bubble.chat', version: 1, exportedAt: Date.now(), conversation: c };
  downloadFile(`${safeFilename(c.title)}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast('Exported JSON ✓');
}

function exportAllJSON() {
  if (!store.conversations.length) { toast('No conversations to export', 'info'); return; }
  const payload = { type: 'bubble.backup', version: 1, exportedAt: Date.now(), conversations: store.conversations };
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`bubble-backup-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast(`Exported ${store.conversations.length} chats ✓`);
}

async function importJSONFile(file: File) {
  try {
    const data: any = JSON.parse(await file.text());
    let raws: any[] = [];
    if (data?.type === 'bubble.backup' && Array.isArray(data.conversations)) raws = data.conversations;
    else if (data?.type === 'bubble.chat' && data.conversation) raws = [data.conversation];
    else if (Array.isArray(data)) raws = data;
    else if (data?.id && Array.isArray(data.messages)) raws = [data];
    else { toast('Unrecognized file — expected a Bubble export', 'error'); return; }

    let added = 0;
    for (const raw of raws) {
      if (await store.importConversation(raw)) added++;
    }
    toast(added ? `Imported ${added} chat${added === 1 ? '' : 's'} ✓` : 'Nothing importable in that file', added ? 'info' : 'error');
    buzz(20);
  } catch (e) {
    toast('Import failed: ' + (e as Error).message, 'error');
  }
}

// ─── Sheet / settings ───
function toggleSheet(open: boolean) {
  $('#sheet')!.classList.toggle('open', open);
  $('#scrim')!.classList.toggle('open', open);
}

function field(label: string, desc: string | null, control: string) {
  return `<div class="field"><label>${escHtml(label)}</label>${desc ? `<div class="desc">${escHtml(desc)}</div>` : ''}${control}</div>`;
}
function rowField(label: string, desc: string | null, control: string) {
  return `<div class="field row"><div class="col"><label>${escHtml(label)}</label>${desc ? `<div class="desc">${escHtml(desc)}</div>` : ''}</div>${control}</div>`;
}
function sliderField(key: string, label: string, value: number, min: number, max: number, step: number) {
  return `<div class="slider-field"><div class="top"><label>${escHtml(label)}</label><span class="val" data-val-for="${key}">${value}</span></div><input type="range" data-bind="${key}" min="${min}" max="${max}" step="${step}" value="${value}" /></div>`;
}
function toggleControl(key: string, on: boolean) {
  return `<div class="toggle ${on ? 'on' : ''}" data-toggle="${key}"></div>`;
}
function selectControl(key: string, value: string, options: string[]) {
  return `<select data-bind="${key}">${options.map(o => `<option value="${escHtml(o)}" ${o === value ? 'selected' : ''}>${escHtml(o)}</option>`).join('')}</select>`;
}
function textInput(key: string, value: string, type = 'text', extraAttrs = '') {
  return `<input type="${type}" data-bind="${key}" value="${escHtml(String(value ?? ''))}" ${extraAttrs} />`;
}
// Mobile keyboards autocapitalize/autocorrect by default — fatal for URLs, emails
// and passwords. Stamp these off so the typed value is exactly what the user sees.
const NO_MANGLE = 'autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"';
function numberInput(key: string, value: number) {
  return `<input type="number" data-bind="${key}" value="${value}" />`;
}
function textAreaInput(key: string, value: string, rows = 4) {
  return `<textarea data-bind="${key}" rows="${rows}">${escHtml(String(value ?? ''))}</textarea>`;
}

function renderSettingsSheet() {
  const body = $<HTMLDivElement>('#sheet-body')!;
  const s = store.settings;
  body.innerHTML = `
    <div class="sect">
      <h3>Mode</h3>
      <div class="group">
        ${rowField('Chat mode', 'Casual keeps it chill — no auto "save as document" prompts. Work surfaces them when a reply looks like a doc or table. (The manual "Save ▾" button stays in both.)', `<div class="seg-control" id="mode-control">${
          (['casual', 'work'] as const).map(t =>
            `<button class="seg ${s.chat_mode === t ? 'on' : ''}" data-mode-pick="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`
          ).join('')
        }</div>`)}
      </div>
    </div>

    <div class="sect">
      <h3>Appearance</h3>
      <div class="group">
        ${rowField('Theme', 'Auto follows your system setting', `<div class="seg-control" id="theme-control">${
          (['auto', 'light', 'dark'] as const).map(t =>
            `<button class="seg ${s.theme === t ? 'on' : ''}" data-theme-pick="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`
          ).join('')
        }</div>`)}
      </div>
    </div>

    <div class="sect">
      <h3>Thinking</h3>
      <div class="group">
        ${field('Extended thinking', 'Off = fastest. Higher = more reasoning before answering (slower). Reasoning shows in a collapsible "Thoughts" block. Claude models only.', `<div class="seg-control wide" id="effort-control">${
          ([['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['max', 'Ultra']] as const).map(([v, l]) =>
            `<button class="seg ${s.thinking_effort === v ? 'on' : ''}" data-effort-pick="${v}">${l}</button>`
          ).join('')
        }</div>`)}
      </div>
    </div>

    <div class="sect">
      <h3>API Connections</h3>
      <div class="group">
        ${field('Chat Completion Source', null, selectControl('chat_completion_source', s.chat_completion_source, ['claude','openai','custom']))}
        ${field('Reverse Proxy URL', '/chat/completions appended automatically', textInput('reverse_proxy', s.reverse_proxy, 'url'))}
        ${field('Proxy Password', 'Sent as Bearer token', textInput('proxy_password', s.proxy_password, 'password'))}
        ${field('Claude Model (primary)', null, selectControl('claude_model', s.claude_model, CLAUDE_MODELS))}
        ${field('Claude Model (alt)', 'Quick-swap target in the topbar popover', selectControl('claude_alt_model', s.claude_alt_model, CLAUDE_MODELS))}
        ${field('Compact Model', 'Used by /compact (long context recommended)', selectControl('compact_model', s.compact_model, CLAUDE_MODELS))}
        ${field('Custom Model', 'Used when source = custom', textInput('custom_model', s.custom_model))}
        ${field('Custom URL', 'Used when source = custom', textInput('custom_url', s.custom_url, 'url'))}
      </div>
    </div>

    <div class="sect">
      <h3>Active Prompts</h3>
      <div class="group">
        ${rowField('System Prompt — On', 'Toggle inline above the composer too', toggleControl('system_prompt_enabled', s.system_prompt_enabled))}
        ${field('System Prompt body', null, textAreaInput('system_prompt', s.system_prompt, 6))}
        ${rowField('Userstyle 1 — On', null, toggleControl('userstyle1_enabled', s.userstyle1_enabled))}
        ${field('Userstyle 1 name', null, textInput('userstyle1_name', s.userstyle1_name))}
        ${field('Userstyle 1 body', null, textAreaInput('userstyle1', s.userstyle1, 5))}
        ${rowField('Userstyle 2 — On', null, toggleControl('userstyle2_enabled', s.userstyle2_enabled))}
        ${field('Userstyle 2 name', null, textInput('userstyle2_name', s.userstyle2_name))}
        ${field('Userstyle 2 body', null, textAreaInput('userstyle2', s.userstyle2, 5))}
      </div>
    </div>

    <div class="sect">
      <h3>SillyTavern Sync</h3>
      <div class="group">
        ${field('SillyTavern URL', null, textInput('st_url', s.st_url, 'url'))}
        ${field('Basic Auth User', null, textInput('st_basic_user', s.st_basic_user))}
        ${field('Basic Auth Password', null, textInput('st_basic_pass', s.st_basic_pass, 'password'))}
      </div>
    </div>

    <details class="sect adv">
      <summary><h3 style="display:inline;">Advanced</h3><span class="caret">▾</span></summary>

      <div class="sub">
        <h4>Sampling</h4>
        <div class="group">
          ${sliderField('temp_openai', 'Temperature', s.temp_openai, 0, 2, 0.01)}
          ${sliderField('top_p_openai', 'Top P', s.top_p_openai, 0, 1, 0.01)}
          ${sliderField('top_k_openai', 'Top K', s.top_k_openai, 0, 200, 1)}
          ${sliderField('freq_pen_openai', 'Frequency Penalty', s.freq_pen_openai, -2, 2, 0.01)}
          ${sliderField('pres_pen_openai', 'Presence Penalty', s.pres_pen_openai, -2, 2, 0.01)}
          ${sliderField('repetition_penalty_openai', 'Repetition Penalty', s.repetition_penalty_openai, 0.5, 2, 0.01)}
          ${sliderField('min_p_openai', 'Min P', s.min_p_openai, 0, 1, 0.001)}
          ${sliderField('top_a_openai', 'Top A', s.top_a_openai, 0, 1, 0.001)}
        </div>
      </div>

      <div class="sub">
        <h4>Limits</h4>
        <div class="group">
          ${rowField('Max Response Tokens', null, numberInput('openai_max_tokens', s.openai_max_tokens))}
          ${rowField('Max Context Tokens', null, numberInput('openai_max_context', s.openai_max_context))}
          ${rowField('Max Context Unlocked', null, toggleControl('max_context_unlocked', s.max_context_unlocked))}
          ${rowField('Seed', '-1 = random', numberInput('seed', s.seed))}
          ${rowField('n (completions)', null, numberInput('n', s.n))}
        </div>
      </div>

      <div class="sub">
        <h4>Behavior</h4>
        <div class="group">
          ${rowField('Streaming', null, toggleControl('stream_openai', s.stream_openai))}
          ${rowField('Reasoning Effort', null, selectControl('reasoning_effort', s.reasoning_effort, ['auto','low','medium','high']))}
          ${rowField('Show Thoughts', null, toggleControl('show_thoughts', s.show_thoughts))}
          ${rowField('Squash System Messages', null, toggleControl('squash_system_messages', s.squash_system_messages))}
          ${rowField('Use System Prompt', null, toggleControl('use_sysprompt', s.use_sysprompt))}
          ${rowField('Names Behavior', '0=none, 1=user only, 2=all', numberInput('names_behavior', s.names_behavior))}
          ${rowField('Verbosity', null, selectControl('verbosity', s.verbosity, ['auto','low','medium','high']))}
          ${rowField('Tool Reasoning Mode', null, selectControl('tool_reasoning_mode', s.tool_reasoning_mode, ['disabled','auto','always']))}
          ${rowField('Function Calling', null, toggleControl('function_calling', s.function_calling))}
          ${rowField('Web Search', null, toggleControl('enable_web_search', s.enable_web_search))}
          ${rowField('Bypass Status Check', null, toggleControl('bypass_status_check', s.bypass_status_check))}
          ${rowField('Show External Models', null, toggleControl('show_external_models', s.show_external_models))}
        </div>
      </div>

      <div class="sub">
        <h4>Other Prompts</h4>
        <div class="group">
          ${field('Assistant Prefill', null, textAreaInput('assistant_prefill', s.assistant_prefill, 3))}
          ${field('Assistant Impersonation', null, textAreaInput('assistant_impersonation', s.assistant_impersonation, 3))}
          ${rowField('Continue Prefill', null, toggleControl('continue_prefill', s.continue_prefill))}
          ${field('Continue Postfix', null, textInput('continue_postfix', s.continue_postfix))}
          ${field('Continue Nudge Prompt', null, textAreaInput('continue_nudge_prompt', s.continue_nudge_prompt, 2))}
          ${field('New Chat Prompt', null, textAreaInput('new_chat_prompt', s.new_chat_prompt, 2))}
          ${field('New Example Chat Prompt', null, textAreaInput('new_example_chat_prompt', s.new_example_chat_prompt, 2))}
          ${field('New Group Chat Prompt', null, textAreaInput('new_group_chat_prompt', s.new_group_chat_prompt, 2))}
          ${field('Impersonation Prompt', null, textAreaInput('impersonation_prompt', s.impersonation_prompt, 4))}
          ${field('Group Nudge Prompt', null, textAreaInput('group_nudge_prompt', s.group_nudge_prompt, 2))}
          ${field('Personality Format', null, textInput('personality_format', s.personality_format))}
          ${field('Scenario Format', null, textInput('scenario_format', s.scenario_format))}
          ${field('WI Format', null, textInput('wi_format', s.wi_format))}
          ${field('Send if Empty', null, textInput('send_if_empty', s.send_if_empty))}
        </div>
      </div>
    </details>

    <div class="sect">
      <h3>Sync across devices</h3>
      <div class="group">
        ${rowField('Enable sync', 'Mirror chats & settings to your PocketBase (proxy password stays on this device)', toggleControl('sync_enabled', s.sync_enabled))}
        ${field('PocketBase URL', 'e.g. https://bubble-pb.up.railway.app', textInput('sync_url', s.sync_url, 'url', NO_MANGLE))}
        ${field('Account email', null, textInput('sync_email', s.sync_email, 'email', NO_MANGLE))}
        ${field('Account password', 'Your PocketBase user login (device-local)', textInput('sync_password', s.sync_password, 'password', NO_MANGLE))}
        ${rowField('Status', null, '<button class="btn-secondary" id="set-sync-now">Connect &amp; sync now</button>')}
        <div class="field"><div class="desc" id="sync-status">—</div></div>
      </div>
    </div>

    <div class="sect">
      <h3>Data</h3>
      <div class="group">
        ${rowField('Export all chats', 'Download a JSON backup of every conversation', '<button class="btn-secondary" id="set-export-all">Export all</button>')}
        ${rowField('Import chats', 'Restore from a Bubble JSON backup or a single exported chat', '<button class="btn-secondary" id="set-import">Import…</button>')}
        ${rowField('Current chat → Markdown', 'Human-readable transcript of the open conversation', '<button class="btn-secondary" id="set-export-md">Markdown</button>')}
      </div>
      <input type="file" id="import-file-input" accept="application/json,.json" hidden />
    </div>

    <div class="sect" style="text-align:center;color:var(--text-faint);font-size:11px;padding:12px 0 0;">
      Bubble · settings stored locally in your browser
    </div>
  `;

  // Two-way bind
  body.querySelectorAll<HTMLElement>('[data-bind]').forEach(el => {
    const key = (el as any).dataset.bind as keyof Settings;
    el.addEventListener('input', () => persistFromControl(el, key));
    el.addEventListener('change', () => persistFromControl(el, key));
  });
  body.querySelectorAll<HTMLDivElement>('[data-toggle]').forEach(el => {
    const key = el.dataset.toggle as keyof Settings;
    el.addEventListener('click', async () => {
      const next = !el.classList.contains('on');
      el.classList.toggle('on', next);
      await store.updateSettings({ [key]: next } as any);
      buzz();
    });
  });

  // Theme segmented control
  body.querySelectorAll<HTMLButtonElement>('[data-theme-pick]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pick = btn.dataset.themePick as ThemePref;
      await store.updateSettings({ theme: pick });
      applyTheme(pick);
      body.querySelectorAll<HTMLButtonElement>('[data-theme-pick]').forEach(b => b.classList.toggle('on', b === btn));
      buzz();
    });
  });

  // Chat mode segmented control (Work shows the proactive doc-offer bar; Casual hides it)
  body.querySelectorAll<HTMLButtonElement>('[data-mode-pick]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pick = btn.dataset.modePick as Settings['chat_mode'];
      await store.updateSettings({ chat_mode: pick });  // emit() re-renders the chat → offer bars update
      body.querySelectorAll<HTMLButtonElement>('[data-mode-pick]').forEach(b => b.classList.toggle('on', b === btn));
      buzz();
    });
  });

  // Thinking effort segmented control
  body.querySelectorAll<HTMLButtonElement>('[data-effort-pick]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pick = btn.dataset.effortPick as Settings['thinking_effort'];
      await store.updateSettings({ thinking_effort: pick });
      body.querySelectorAll<HTMLButtonElement>('[data-effort-pick]').forEach(b => b.classList.toggle('on', b === btn));
      buzz();
    });
  });

  // Sync
  const fmtStatus = (st: SyncStatus): string => {
    const when = st.at ? new Date(st.at).toLocaleTimeString() : '';
    if (st.state === 'synced') return `✓ Synced ${when}`;
    if (st.state === 'connecting') return '… Connecting';
    if (st.state === 'error') return `⚠ ${st.detail || 'error'}`;
    return store.settings.sync_enabled ? 'Idle' : 'Off';
  };
  const renderStatus = (st: SyncStatus) => { const el = $<HTMLDivElement>('#sync-status'); if (el) el.textContent = fmtStatus(st); };
  renderStatus(getStatus());
  onStatus(renderStatus);
  $<HTMLButtonElement>('#set-sync-now')?.addEventListener('click', async () => {
    const el = $<HTMLDivElement>('#sync-status'); if (el) el.textContent = '… Connecting';
    try { await syncNowManual(); toast('Synced ✓'); } catch (e) { toast((e as Error).message, 'error'); }
  });
  $<HTMLDivElement>('[data-toggle="sync_enabled"]')?.addEventListener('click', () => {
    setTimeout(() => { if (store.settings.sync_enabled) startSync().catch(() => {}); else renderStatus(getStatus()); }, 60);
  });

  // Data: export / import
  $<HTMLButtonElement>('#set-export-all')?.addEventListener('click', exportAllJSON);
  $<HTMLButtonElement>('#set-export-md')?.addEventListener('click', exportCurrentMarkdown);
  const importInput = $<HTMLInputElement>('#import-file-input');
  $<HTMLButtonElement>('#set-import')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    importInput.value = '';
    if (f) await importJSONFile(f);
  });
}

async function persistFromControl(el: HTMLElement, key: keyof Settings) {
  const tagName = el.tagName;
  let val: any;
  if (tagName === 'INPUT') {
    const inp = el as HTMLInputElement;
    if (inp.type === 'number' || inp.type === 'range') val = inp.value === '' ? 0 : Number(inp.value);
    else val = inp.value;
  } else if (tagName === 'SELECT') {
    val = (el as HTMLSelectElement).value;
  } else if (tagName === 'TEXTAREA') {
    val = (el as HTMLTextAreaElement).value;
  }
  // sync slider value display
  if ((el as HTMLInputElement).type === 'range') {
    const v = $(`[data-val-for="${key}"]`);
    if (v) v.textContent = String(val);
  }
  await store.updateSettings({ [key]: val } as any);
}

async function resyncFromST() {
  const s = store.settings;
  if (!s.st_url || !s.st_basic_user || !s.st_basic_pass) {
    toast('Fill SillyTavern URL + basic auth in Settings first', 'error');
    return;
  }
  toast('Syncing from SillyTavern…');
  const fetched = await fetchSettingsFromST(s.st_url, s.st_basic_user, s.st_basic_pass);
  if (!fetched) {
    toast('Sync failed (check creds & URL)', 'error');
    return;
  }
  await store.updateSettings(fetched);
  renderSettingsSheet();
  toast('Synced ✓');
  buzz(20);
}
