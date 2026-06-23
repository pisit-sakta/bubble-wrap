import type { Settings, Message, WebSource, Attachment } from './types';

// The only media types Anthropic's vision API accepts. Attachments are normalized to
// one of these at attach time (see attach.ts); this set guards both ends.
export const CLAUDE_NATIVE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Anthropic accepts native PDF documents up to ~32MB / 100 pages per request. We leave
// headroom and fall back to extracted text for anything bigger (or missing a dataUrl).
const PDF_NATIVE_MAX_BYTES = 30 * 1024 * 1024;
function pdfAsDocument(a: Attachment): boolean {
  if (a.kind !== 'pdf' || !a.dataUrl) return false;
  const b64 = a.dataUrl.slice(a.dataUrl.indexOf(',') + 1);
  return b64.length * 0.75 <= PDF_NATIVE_MAX_BYTES;
}

// OpenAI Chat Completions request body
interface ContentTextPart  { type: 'text';      text: string; }
interface ContentImagePart { type: 'image_url'; image_url: { url: string }; }
type ContentPart = ContentTextPart | ContentImagePart;

interface RequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}


export interface StreamCallbacks {
  onText: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onSearch?: (query?: string) => void;
  onDone: (full: { text: string; thinking?: string; sources?: WebSource[]; searched?: boolean; queries?: string[] }) => void;
  onError: (error: Error) => void;
}

// Collect web-search results from whatever shape the proxy returns (Anthropic
// native blocks, or OpenAI-style url_citation annotations). De-duped by URL.
function collectSources(into: WebSource[], seen: Set<string>, raw: any) {
  const add = (url?: string, title?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    into.push({ url, title });
  };
  if (!raw || typeof raw !== 'object') return;
  // Anthropic: web_search_tool_result block → content: [{type:'web_search_result', url, title}]
  if (raw.type === 'web_search_tool_result' && Array.isArray(raw.content)) {
    for (const r of raw.content) add(r?.url, r?.title);
  }
  // Anthropic citations on text blocks
  if (raw.type === 'citations_delta' && raw.citation) add(raw.citation.url, raw.citation.title);
  if (Array.isArray(raw.citations)) for (const c of raw.citations) add(c?.url, c?.title);
  // OpenAI-translated annotations
  if (Array.isArray(raw.annotations)) {
    for (const a of raw.annotations) add(a?.url_citation?.url || a?.url, a?.url_citation?.title || a?.title);
  }
}

// Build the messages array from our internal Message[] + attachments.
// Images become OpenAI vision parts. Text/PDF attachments are inlined as text blocks.
function buildRequestMessages(history: Message[], systemPrompt: string): RequestMessage[] {
  const out: RequestMessage[] = [];
  if (systemPrompt && systemPrompt.trim()) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const m of history) {
    if (m.role === 'system') continue; // system handled above
    const parts: ContentPart[] = [];
    let textBody = m.content || '';
    const fileAttachments = (m.attachments || []).filter(a => a.kind !== 'image');
    if (fileAttachments.length) {
      const filesBlock = fileAttachments
        .map(a => `<attached_file name="${a.name}" type="${a.mime}">\n${a.text || ''}\n</attached_file>`)
        .join('\n\n');
      textBody = filesBlock + (textBody ? '\n\n' + textBody : '');
    }
    if (textBody) parts.push({ type: 'text', text: textBody });
    for (const a of m.attachments || []) {
      if (a.kind === 'image' && a.dataUrl) {
        parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
      }
    }
    out.push({
      role: m.role,
      content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts.length ? parts : '',
    });
  }
  return out;
}

// Native Anthropic Messages format. Required for the web_search server tool —
// the OpenAI /chat/completions shim silently drops it, but /v1/messages forwards it.
function buildAnthropicMessages(history: Message[], systemPrompt: string): { system?: string; messages: any[] } {
  const messages: any[] = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    const parts: any[] = [];
    const skippedImages: string[] = [];
    for (const a of m.attachments || []) {
      if (a.kind === 'image' && a.dataUrl) {
        const mt = a.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
        // Newly-attached images are already normalized to a supported type, but a
        // message saved before that fix could still carry e.g. image/heic — drop it
        // (with a note) instead of letting the whole request 400.
        if (mt && CLAUDE_NATIVE_IMAGE.has(mt[1])) {
          parts.push({ type: 'image', source: { type: 'base64', media_type: mt[1], data: mt[2] } });
        } else if (mt) {
          skippedImages.push(`${a.name || 'image'} (${mt[1]})`);
        }
      }
    }
    // Native PDF documents — Claude reads these with vision (layout, scans, figures),
    // not just scraped text. Anything missing a dataUrl (old message) or too large
    // for one request falls through to the text block below.
    const pdfDocs = (m.attachments || []).filter(pdfAsDocument);
    for (const a of pdfDocs) {
      const mt = a.dataUrl!.match(/^data:([^;]+);base64,(.*)$/);
      if (mt) parts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: mt[2] } });
    }
    const sentAsDoc = new Set(pdfDocs.map(a => a.id));
    let textBody = m.content || '';
    if (skippedImages.length) {
      textBody = `[unsupported image format, not sent: ${skippedImages.join(', ')}]` + (textBody ? '\n\n' + textBody : '');
    }
    const fileAttachments = (m.attachments || []).filter(a => a.kind !== 'image' && !sentAsDoc.has(a.id));
    if (fileAttachments.length) {
      const filesBlock = fileAttachments
        .map(a => `<attached_file name="${a.name}" type="${a.mime}">\n${a.text || ''}\n</attached_file>`)
        .join('\n\n');
      textBody = filesBlock + (textBody ? '\n\n' + textBody : '');
    }
    if (textBody) parts.push({ type: 'text', text: textBody });
    if (!parts.length) parts.push({ type: 'text', text: '…' });
    messages.push({ role: m.role, content: parts });
  }
  return { system: systemPrompt && systemPrompt.trim() ? systemPrompt : undefined, messages };
}

export async function streamChat(
  settings: Settings,
  messages: Message[],
  systemPrompt: string,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal,
): Promise<void> {
  // Web search AND extended thinking only work via the native Anthropic endpoint.
  const thinkingOn = !!settings.thinking_effort && settings.thinking_effort !== 'off';
  // A native PDF document block only forwards through /v1/messages, so a PDF attachment
  // forces the native path (the OpenAI /chat/completions shim can't carry documents).
  const hasPdfDoc = messages.some(m => (m.attachments || []).some(pdfAsDocument));
  const useNative = !!(settings.chat_completion_source === 'claude' && (settings.enable_web_search || thinkingOn || hasPdfDoc));
  const base = settings.reverse_proxy.replace(/\/$/, '');
  const url = base + (useNative ? '/messages' : '/chat/completions');
  const model =
    settings.chat_completion_source === 'custom' && settings.custom_model
      ? settings.custom_model
      : settings.claude_model;

  let body: any;
  if (useNative) {
    const { system, messages: amsgs } = buildAnthropicMessages(messages, systemPrompt);
    body = {
      model,
      max_tokens: settings.openai_max_tokens || 8192,
      messages: amsgs,
      stream: !!settings.stream_openai,
    };
    if (system) body.system = system;
    if (settings.enable_web_search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    if (thinkingOn) {
      // Adaptive thinking + effort; summarized so the reasoning is visible (else it's empty).
      body.thinking = { type: 'adaptive', display: 'summarized' };
      body.output_config = { effort: settings.thinking_effort };
    }
    // Sampling params are intentionally omitted — newer models (Opus 4.8 / Fable 5) reject them.
  } else {
    body = {
      model,
      messages: buildRequestMessages(messages, systemPrompt),
      stream: !!settings.stream_openai,
    };
    if (settings.temp_openai !== undefined) body.temperature = settings.temp_openai;
    if (settings.top_p_openai !== undefined && settings.top_p_openai !== 1) body.top_p = settings.top_p_openai;
    if (settings.top_k_openai && settings.top_k_openai > 0) body.top_k = settings.top_k_openai;
    if (settings.openai_max_tokens) body.max_tokens = settings.openai_max_tokens;
    if (settings.freq_pen_openai) body.frequency_penalty = settings.freq_pen_openai;
    if (settings.pres_pen_openai) body.presence_penalty = settings.pres_pen_openai;
    if (settings.seed !== undefined && settings.seed !== -1) body.seed = settings.seed;
    if (settings.n && settings.n > 1) body.n = settings.n;
  }

  let fullText = '';
  let fullThinking = '';
  const sources: WebSource[] = [];
  const seenUrls = new Set<string>();
  let searched = false;
  const queries: string[] = [];
  // Track the in-flight server_tool_use block so we can reassemble its streamed
  // query JSON (Claude writes its OWN search query — not the user's prompt).
  let stuIndex = -1;
  let stuJson = '';

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.proxy_password}`,
        // NB: no `anthropic-version` header — proxies often omit it from their CORS
        // allow-list, which blocks the browser POST. The proxy defaults the version.
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 400)}`);
    }

    if (!body.stream) {
      const json: any = await resp.json();
      let text: any = json?.choices?.[0]?.message?.content ?? '';
      // Native Anthropic: content is an array of blocks (server_tool_use, text, …).
      // Join EVERY text block — block 0 is often a tool block, so content[0].text is wrong.
      if ((!text || typeof text !== 'string') && Array.isArray(json?.content)) {
        text = json.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
      }
      const thinking = json?.choices?.[0]?.message?.reasoning_content ?? undefined;
      fullText = typeof text === 'string' ? text : Array.isArray(text) ? text.map((p: any) => p.text || '').join('') : '';
      if (thinking) fullThinking = thinking;
      // Scan for web-search results / citations in either response shape.
      if (Array.isArray(json?.content)) {
        for (const block of json.content) {
          if (block?.type === 'server_tool_use' || block?.type === 'web_search_tool_result') searched = true;
          if (block?.type === 'server_tool_use' && typeof block.input?.query === 'string') queries.push(block.input.query);
          collectSources(sources, seenUrls, block);
        }
      }
      collectSources(sources, seenUrls, json?.choices?.[0]?.message);
      if (fullText) callbacks.onText(fullText);
      if (fullThinking && callbacks.onThinking) callbacks.onThinking(fullThinking);
      callbacks.onDone({ text: fullText, thinking: fullThinking || undefined, sources: sources.length ? sources : undefined, searched, queries: queries.length ? queries : undefined });
      return;
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const evt: any = JSON.parse(data);
          // OpenAI Chat Completions delta
          const delta = evt?.choices?.[0]?.delta;
          if (delta) {
            if (typeof delta.content === 'string' && delta.content) {
              fullText += delta.content;
              callbacks.onText(delta.content);
            } else if (Array.isArray(delta.content)) {
              for (const part of delta.content) {
                if (part?.type === 'text' && typeof part.text === 'string') {
                  fullText += part.text;
                  callbacks.onText(part.text);
                }
              }
            }
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
              fullThinking += delta.reasoning_content;
              callbacks.onThinking?.(delta.reasoning_content);
            }
            if (typeof delta.thinking === 'string' && delta.thinking) {
              fullThinking += delta.thinking;
              callbacks.onThinking?.(delta.thinking);
            }
            // OpenAI-translated web-search citations
            if (Array.isArray(delta.annotations) && delta.annotations.length) {
              if (!searched) { searched = true; callbacks.onSearch?.(); }
              collectSources(sources, seenUrls, delta);
            }
          }
          // Anthropic-style fallback (some proxies pass through native events)
          if (evt?.type === 'content_block_delta' && evt?.delta) {
            if (evt.delta.type === 'text_delta' && evt.delta.text) {
              fullText += evt.delta.text;
              callbacks.onText(evt.delta.text);
            } else if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
              fullThinking += evt.delta.thinking;
              callbacks.onThinking?.(evt.delta.thinking);
            } else if (evt.delta.type === 'citations_delta') {
              collectSources(sources, seenUrls, evt.delta);
            } else if (evt.delta.type === 'input_json_delta' && evt.index === stuIndex) {
              stuJson += evt.delta.partial_json || '';
            }
          }
          // Anthropic server-tool blocks (web search)
          if (evt?.type === 'content_block_start' && evt?.content_block) {
            const cb = evt.content_block;
            if (cb.type === 'server_tool_use' && /search/i.test(cb.name || '')) {
              searched = true;
              stuIndex = evt.index;
              stuJson = '';
              if (typeof cb.input?.query === 'string') { queries.push(cb.input.query); callbacks.onSearch?.(cb.input.query); }
              else callbacks.onSearch?.();
            }
            if (cb.type === 'web_search_tool_result') {
              searched = true;
              collectSources(sources, seenUrls, cb);
            }
          }
          // Server_tool_use block finished — its query JSON is now complete.
          if (evt?.type === 'content_block_stop' && evt.index === stuIndex) {
            stuIndex = -1;
            try {
              const q = JSON.parse(stuJson);
              if (q && typeof q.query === 'string') { queries.push(q.query); callbacks.onSearch?.(q.query); }
            } catch { /* partial/garbled json — skip */ }
          }
        } catch {
          /* skip bad chunk */
        }
      }
    }

    callbacks.onDone({ text: fullText, thinking: fullThinking || undefined, sources: sources.length ? sources : undefined, searched, queries: queries.length ? queries : undefined });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      callbacks.onDone({ text: fullText, thinking: fullThinking || undefined, sources: sources.length ? sources : undefined, searched, queries: queries.length ? queries : undefined });
      return;
    }
    callbacks.onError(e as Error);
  }
}

// ── Bootstrap from SillyTavern: pull live settings + prompts ──
export async function fetchSettingsFromST(stUrl: string, basicUser: string, basicPass: string): Promise<Partial<Settings> | null> {
  const url = stUrl.replace(/\/$/, '') + '/api/settings/get';
  const auth = btoa(`${basicUser}:${basicPass}`);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
        'X-CSRF-Token': await fetchCsrfToken(stUrl, auth),
      },
      body: JSON.stringify({}),
      credentials: 'omit',
    });
    if (!resp.ok) throw new Error(`ST returned HTTP ${resp.status}`);
    const json: any = await resp.json();
    const stRaw = typeof json?.settings === 'string' ? json.settings : JSON.stringify(json.settings || json);
    const parsed = JSON.parse(stRaw);
    return mapStOaiToSettings(parsed?.oai_settings || parsed);
  } catch (e) {
    console.warn('Bootstrap fetch failed:', e);
    return null;
  }
}

async function fetchCsrfToken(stUrl: string, auth: string): Promise<string> {
  const r = await fetch(stUrl.replace(/\/$/, '') + '/csrf-token', {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) return '';
  const j: any = await r.json().catch(() => ({}));
  return j?.token || '';
}

function mapStOaiToSettings(oai: any): Partial<Settings> {
  if (!oai || typeof oai !== 'object') return {};
  const pick = (k: string) => (k in oai ? oai[k] : undefined);
  const out: Partial<Settings> = {};
  const directKeys: (keyof Settings)[] = [
    'chat_completion_source', 'reverse_proxy', 'proxy_password',
    'claude_model', 'custom_model', 'custom_url',
    'bypass_status_check', 'show_external_models',
    'temp_openai', 'top_p_openai', 'top_k_openai',
    'freq_pen_openai', 'pres_pen_openai', 'repetition_penalty_openai',
    'min_p_openai', 'top_a_openai',
    'openai_max_tokens', 'openai_max_context', 'max_context_unlocked',
    'seed', 'n',
    'stream_openai', 'reasoning_effort', 'show_thoughts',
    'squash_system_messages', 'use_sysprompt', 'names_behavior',
    'verbosity', 'tool_reasoning_mode',
    'function_calling', 'enable_web_search',
    'assistant_prefill', 'assistant_impersonation',
    'continue_prefill', 'continue_postfix', 'continue_nudge_prompt',
    'new_chat_prompt', 'new_example_chat_prompt', 'new_group_chat_prompt',
    'impersonation_prompt', 'group_nudge_prompt',
    'personality_format', 'scenario_format', 'wi_format', 'send_if_empty',
  ];
  for (const k of directKeys) {
    const v = pick(k as string);
    if (v !== undefined) (out as any)[k] = v;
  }
  // Try to extract a system prompt from the prompts list
  if (Array.isArray(oai.prompts)) {
    const main = oai.prompts.find((p: any) => p?.identifier === 'main' || p?.name === 'Main Prompt');
    if (main?.content) out.system_prompt = main.content;
  }
  return out;
}

// ── Attachment helpers (file → Attachment) ──
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export async function fileToText(file: File): Promise<string> {
  return await file.text();
}
