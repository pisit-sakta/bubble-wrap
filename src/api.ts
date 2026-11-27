import type { Settings, Message, WebSource, Attachment } from './types';
import { CLAUDE_NATIVE_IMAGE, splitDataUrl, sniffBase64 } from './image';

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


// Why a reply ended, when it didn't simply finish. A reply that is declined, cut off at
// the length limit or paused arrives as an ordinary successful response — with no error
// — so unless this is read and shown, half a sentence looks like the whole answer.
export interface StopInfo {
  reason: 'refusal' | 'length' | 'paused';
  category?: string;      // refusals: which safety check declined (cyber, bio, reasoning_extraction, …)
  explanation?: string;   // refusals: the API's own one-line reason, when it gives one
  requestId?: string;     // what support asks for when a decline looks wrong
}

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onSearch?: (query?: string) => void;
  // Something the user should know about that isn't an error (e.g. images left out).
  onNotice?: (message: string) => void;
  onDone: (full: { text: string; thinking?: string; sources?: WebSource[]; searched?: boolean; queries?: string[]; stop?: StopInfo }) => void;
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

// ── Images in a request ──
// The API caps a request at 100 images on 200k-context models (600 on the rest).
const MAX_IMAGES = 100;
// Total base64 image payload one request may carry. Unknowable up front — 128 MB on the
// first-party API, 20 MB on Bedrock, anything at all on a self-hosted proxy — so it
// starts unlimited and is learned: a 413 halves it for the rest of the session.
let imageBudget = Infinity;
let budgetProxy = '';

interface ImagePlan {
  send: Map<Attachment, { mediaType: string; data: string }>;
  note: Map<Attachment, string>;   // what to tell Claude about an image that isn't going
  bytes: number;
  omitted: number;                 // left out for room (as opposed to unusable)
}

// Decide, once per request and for both wire formats, exactly which images go and with
// what media type. The type is sniffed from the bytes right here, so a stale or missing
// label on a stored attachment can never reach the API; anything that isn't a format
// Claude accepts becomes a text note instead of a rejected request. Newest messages get
// first claim on the room, so when a chat outgrows a request it is the oldest images
// that drop out.
function planImages(history: Message[], budget: number): ImagePlan {
  const plan: ImagePlan = { send: new Map(), note: new Map(), bytes: 0, omitted: 0 };
  let full = false;
  for (let i = history.length - 1; i >= 0; i--) {
    for (const a of history[i].attachments || []) {
      if (a.kind !== 'image') continue;
      const label = `"${a.name || 'image'}"`;
      const parts = a.unreadable ? null : splitDataUrl(a.dataUrl);
      const type = parts && sniffBase64(parts.b64);
      if (!parts || !type || !CLAUDE_NATIVE_IMAGE.has(type)) {
        plan.note.set(a, `[attached image ${label} could not be sent: ${type || parts?.mime || 'the file'} is not a readable JPEG, PNG, GIF or WebP]`);
      } else if (full || plan.send.size >= MAX_IMAGES || plan.bytes + parts.b64.length > budget) {
        full = true;
        plan.omitted++;
        plan.note.set(a, `[earlier image ${label} left out: this conversation holds more images than fit in one request]`);
      } else {
        plan.send.set(a, { mediaType: type, data: parts.b64 });
        plan.bytes += parts.b64.length;
      }
    }
  }
  return plan;
}

// A message's text as sent: notes for images that aren't going, then inlined files, then the text.
function textBodyOf(m: Message, plan: ImagePlan, files: Attachment[]): string {
  const notes = (m.attachments || []).map(a => plan.note.get(a)).filter(Boolean).join('\n');
  const filesBlock = files
    .map(a => a.kind === 'media'
      ? `[attached recording "${a.name}" is not included: audio and video are only sent in Gemini mode]`
      : `<attached_file name="${a.name}" type="${a.mime}">\n${a.text || ''}\n</attached_file>`)
    .join('\n\n');
  return [notes, filesBlock, m.content || ''].filter(Boolean).join('\n\n');
}

// Build the messages array from our internal Message[] + attachments.
// Images become OpenAI vision parts. Text/PDF attachments are inlined as text blocks.
function buildRequestMessages(history: Message[], systemPrompt: string, plan: ImagePlan): RequestMessage[] {
  const out: RequestMessage[] = [];
  if (systemPrompt && systemPrompt.trim()) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const m of history) {
    if (m.role === 'system') continue; // system handled above
    const parts: ContentPart[] = [];
    const textBody = textBodyOf(m, plan, (m.attachments || []).filter(a => a.kind !== 'image'));
    if (textBody) parts.push({ type: 'text', text: textBody });
    for (const a of m.attachments || []) {
      const img = plan.send.get(a);
      // Rebuilt from the sniffed type: the proxy derives media_type from this header.
      if (img) parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
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
function buildAnthropicMessages(history: Message[], systemPrompt: string, plan: ImagePlan): { system?: string; messages: any[] } {
  const messages: any[] = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    const parts: any[] = [];
    for (const a of m.attachments || []) {
      const img = plan.send.get(a);
      if (img) parts.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
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
    const textBody = textBodyOf(m, plan, (m.attachments || []).filter(a => a.kind !== 'image' && !sentAsDoc.has(a.id)));
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

  // The learned image budget belongs to one proxy; start over if it changed.
  if (budgetProxy !== base) { budgetProxy = base; imageBudget = Infinity; }
  let plan = planImages(messages, imageBudget);
  let body: any;
  if (useNative) {
    const { system, messages: amsgs } = buildAnthropicMessages(messages, systemPrompt, plan);
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
      messages: buildRequestMessages(messages, systemPrompt, plan),
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
  let stop: StopInfo | undefined;
  // Both wire formats, and whatever a proxy maps one onto the other: Anthropic says
  // refusal / max_tokens / pause_turn, OpenAI says content_filter / length.
  const noteStop = (reason: unknown, details?: any) => {
    if (reason === 'refusal' || reason === 'content_filter') {
      stop = { reason: 'refusal', category: details?.category || undefined, explanation: details?.explanation || undefined };
    } else if (reason === 'max_tokens' || reason === 'length') {
      stop = { reason: 'length' };
    } else if (reason === 'pause_turn') {
      stop = { reason: 'paused' };
    }
  };

  try {
    const post = () => fetch(url, {
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
    let resp = await post();
    // 413 = the request outgrew the proxy's or platform's body limit, and images are the
    // only bulk in it. Shed the oldest ones and go again rather than leave the chat
    // unable to send; a 413 is refused before any work is done, so retrying is free.
    for (let i = 0; resp.status === 413 && plan.bytes > 0 && i < 6; i++) {
      resp.body?.cancel().catch(() => {});
      imageBudget = Math.floor(plan.bytes / 2);
      plan = planImages(messages, imageBudget);
      body.messages = useNative
        ? buildAnthropicMessages(messages, systemPrompt, plan).messages
        : buildRequestMessages(messages, systemPrompt, plan);
      resp = await post();
    }
    if (plan.omitted) {
      callbacks.onNotice?.(`${plan.omitted} older image${plan.omitted === 1 ? '' : 's'} left out — this chat has more than fit in one request`);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 400)}`);
    }

    // Only readable when the proxy exposes it to the page; harmless when it doesn't.
    const requestId = resp.headers.get('request-id') || undefined;

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
      noteStop(json?.stop_reason ?? json?.choices?.[0]?.finish_reason, json?.stop_details);
      if (stop) stop.requestId = requestId;
      if (fullText) callbacks.onText(fullText);
      if (fullThinking && callbacks.onThinking) callbacks.onThinking(fullThinking);
      callbacks.onDone({ text: fullText, thinking: fullThinking || undefined, sources: sources.length ? sources : undefined, searched, queries: queries.length ? queries : undefined, stop });
      return;
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');
    const decoder = new TextDecoder();
    let buffer = '';
    let streamError: Error | null = null;

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
          // How the reply ended. Anthropic puts it on message_delta, OpenAI on the choice.
          if (evt?.type === 'message_delta') noteStop(evt.delta?.stop_reason, evt.delta?.stop_details ?? evt.stop_details);
          if (evt?.choices?.[0]?.finish_reason) noteStop(evt.choices[0].finish_reason, evt.choices[0].stop_details ?? evt.stop_details);
          // A failure after the response started (the server was overloaded mid-reply, …)
          // can't change the HTTP status any more, so it arrives as an event instead.
          if (evt?.type === 'error' || (evt?.error && !evt.choices)) {
            const err = evt.error || {};
            streamError = new Error(`The reply was cut off by a server error: ${err.message || err.type || 'unknown error'}${err.message && err.type ? ` (${err.type})` : ''}`);
          }
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
            // A block may open with content already in it (some proxies put the first
            // words here rather than in a delta). Nothing later repeats it, so skipping
            // it silently drops the start of the reply.
            if (cb.type === 'text' && typeof cb.text === 'string' && cb.text) {
              fullText += cb.text;
              callbacks.onText(cb.text);
            } else if (cb.type === 'thinking' && typeof cb.thinking === 'string' && cb.thinking) {
              fullThinking += cb.thinking;
              callbacks.onThinking?.(cb.thinking);
            }
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
      if (streamError) throw streamError;   // outside the per-event try, which swallows everything
    }

    if (stop) stop.requestId = requestId;
    callbacks.onDone({ text: fullText, thinking: fullThinking || undefined, sources: sources.length ? sources : undefined, searched, queries: queries.length ? queries : undefined, stop });
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

// The models the proxy says it serves right now (GET {proxy}/models — the listing both
// the OpenAI and Anthropic APIs define, which proxies pass along or answer themselves).
// Newest first. Only the standard Authorization header, as everywhere else in this file.
export async function fetchProxyModels(settings: Settings): Promise<string[]> {
  const base = settings.reverse_proxy.trim().replace(/\/$/, '');
  if (!base) throw new Error('Set the proxy URL first');
  const resp = await fetch(`${base}/models?limit=1000`, { headers: { Authorization: `Bearer ${settings.proxy_password}` } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(resp.status === 404
      ? 'This proxy has no model list (/models returned 404) — the built-in list stays.'
      : `Loading the model list failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const json: any = await resp.json().catch(() => null);
  const rows: any[] = Array.isArray(json) ? json : json?.data || json?.models || [];
  const when = (r: any) => (typeof r?.created === 'number' ? r.created * 1000 : Date.parse(r?.created_at) || 0);
  const all = rows
    .map(r => ({ id: String(typeof r === 'string' ? r : r?.id || r?.name || '').replace(/^models\//, ''), at: when(r) }))
    .filter(r => r.id);
  // A proxy fronting several providers lists them all; this menu is for Claude. If
  // nothing is named claude (a custom source), show everything rather than nothing.
  const claude = all.filter(r => /claude/i.test(r.id));
  const list = claude.length ? claude : all;
  // By release date when the proxy gives one. Otherwise by the version in the name
  // (claude-fable-5-2 → 5.2, claude-3-5-sonnet → 3.5; an 8-digit date stamp is not a
  // version), then by tier, so the menu still reads newest and biggest first.
  const version = (id: string) => {
    const n = (id.match(/(?<![\d.])\d{1,2}(?![\d])/g) || []).slice(0, 2);
    return n.length ? Number(n[0]) + Number(n[1] || 0) / 100 : 0;
  };
  const tier = (id: string) => ['haiku', 'sonnet', 'opus', 'fable', 'mythos'].findIndex(t => id.includes(t));
  list.sort((a, b) => (b.at - a.at) || (version(b.id) - version(a.id)) || (tier(b.id) - tier(a.id))
    || b.id.localeCompare(a.id, undefined, { numeric: true }));
  return [...new Set(list.map(r => r.id))];
}
