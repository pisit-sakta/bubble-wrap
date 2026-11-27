// Gemini mode: talks straight to Google's Gemini API with the user's own key, or to
// OpenRouter. Built for one job the hosted apps do badly — very long output, e.g. the
// full transcript of a multi-hour meeting:
//   • recordings are uploaded through Google's Files API (up to 2 GB), not inlined;
//   • every request asks for the model's full output allowance;
//   • when a reply still hits that ceiling, the next request picks up exactly where it
//     stopped, and the pieces are stitched into one message. Repeat until finished.
import type { Settings, Message, Attachment } from './types';
import type { StreamCallbacks, StopInfo } from './api';
import { splitDataUrl, sniffBase64 } from './image';
import { getBlob, getKv, setKv } from './db';

export interface GeminiModel { id: string; out?: number }   // out = output token limit, when known

export interface GeminiCallbacks extends StreamCallbacks {
  // A line of progress to show in the reply while nothing is streaming yet ('' clears it).
  onStatus?: (status: string) => void;
}

// How many times one reply may be extended. At ~65k tokens a piece this is millions of
// tokens of output — a bound against a model that never stops, not a practical limit.
const MAX_ROUNDS = 40;
const CONTINUE_PROMPT =
  'Your previous message was cut off by the output length limit. Continue it from the exact ' +
  'character where it stopped — mid-sentence or mid-word if that is where it ended. Do not ' +
  'repeat anything already written, do not restart, and add no preamble, apology or summary. ' +
  'Keep the same format. Output only the continuation.';

const FILE_TTL = 46 * 60 * 60 * 1000;         // Google keeps an upload 48 h; re-upload a little early
const FILES_API_MAX = 2 * 1024 * 1024 * 1024;
// OpenRouter has no upload API: the recording rides inside the JSON request as base64,
// which a phone has to build in memory. Past this it is the wrong tool for the job.
const OPENROUTER_INLINE_MAX = 40 * 1024 * 1024;
const INLINE_IMAGE_BUDGET = 14 * 1024 * 1024; // Google caps a request body at 20 MB

const trimUrl = (u: string) => (u || '').trim().replace(/\/+$/, '');
const keyTag = (key: string) => key.slice(-6);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function geminiReady(s: Settings): boolean {
  return s.gemini_source === 'openrouter'
    ? !!(s.openrouter_url && s.openrouter_api_key)
    : !!(s.gemini_url && s.gemini_api_key);
}
export function activeGeminiModel(s: Settings): string {
  return s.gemini_source === 'openrouter' ? s.openrouter_model : s.gemini_model;
}

async function failure(resp: Response, what: string): Promise<Error> {
  const raw = await resp.text().catch(() => '');
  let msg = raw.slice(0, 400);
  try { const j = JSON.parse(raw); msg = j?.error?.message || j?.[0]?.error?.message || msg; } catch { /* not JSON */ }
  return new Error(`${what} failed (HTTP ${resp.status})${msg ? `: ${msg}` : ''}`);
}

// ── Model list, live from whichever service the key belongs to ──
const cacheKey = (s: Settings) => (s.gemini_source === 'openrouter' ? 'openrouterModels' : 'geminiModels');
export async function cachedGeminiModels(s: Settings): Promise<GeminiModel[]> {
  return (await getKv<GeminiModel[]>(cacheKey(s))) || [];
}

export async function fetchGeminiModels(s: Settings): Promise<GeminiModel[]> {
  let models: GeminiModel[];
  if (s.gemini_source === 'openrouter') {
    const resp = await fetch(`${trimUrl(s.openrouter_url)}/models`);
    if (!resp.ok) throw await failure(resp, 'Loading the model list');
    const json: any = await resp.json();
    models = (json?.data || [])
      .filter((m: any) => typeof m?.id === 'string' && m.id.startsWith('google/gemini'))
      .map((m: any) => ({ id: m.id, out: m.top_provider?.max_completion_tokens || undefined }));
  } else {
    const resp = await fetch(`${trimUrl(s.gemini_url)}/models?pageSize=1000`, { headers: { 'x-goog-api-key': s.gemini_api_key.trim() } });
    if (!resp.ok) throw await failure(resp, 'Loading the model list');
    const json: any = await resp.json();
    models = (json?.models || [])
      .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m: any) => ({ id: String(m.name || '').replace(/^models\//, ''), out: m.outputTokenLimit || undefined }))
      // Chat models only: no speech, image-generation, embedding or live-session variants.
      .filter((m: GeminiModel) => /^gemini/.test(m.id) && !/tts|image|embedding|live|native-audio|robotics|computer-use/.test(m.id));
  }
  // Newest first: version numbers sort higher, and names are otherwise alphabetical.
  models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  if (models.length) await setKv(cacheKey(s), models);
  return models;
}

// ── Recordings ──
const AUDIO_FORMAT: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/flac': 'flac', 'audio/aiff': 'aiff', 'audio/webm': 'webm',
};

async function waitUntilUsable(base: string, key: string, file: any, a: Attachment, cb: GeminiCallbacks, signal?: AbortSignal): Promise<any> {
  // Audio is ready at once; video is processed first and can't be referenced until then.
  for (let i = 0; file?.state === 'PROCESSING'; i++) {
    if (i > 300) throw new Error(`Google is still processing "${a.name}" after 10 minutes — try sending again shortly.`);
    cb.onStatus?.(`⏳ Google is processing ${a.name}…`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 2000);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
    const resp = await fetch(`${base}/${file.name}`, { headers: { 'x-goog-api-key': key }, signal });
    if (!resp.ok) throw await failure(resp, `Checking "${a.name}"`);
    file = await resp.json();
  }
  if (file?.state === 'FAILED') throw new Error(`Google could not process "${a.name}"${file.error?.message ? `: ${file.error.message}` : ''}.`);
  if (!file?.uri) throw new Error(`Uploading "${a.name}" returned no file address.`);
  return file;
}

async function uploadToGoogle(s: Settings, a: Attachment, blob: Blob, cb: GeminiCallbacks, signal?: AbortSignal): Promise<void> {
  const base = trimUrl(s.gemini_url);
  const key = s.gemini_api_key.trim();
  const u = new URL(base);
  const uploadUrl = `${u.origin}/upload${u.pathname}/files`;
  const meta = JSON.stringify({ file: { displayName: a.name.slice(0, 200) } });
  cb.onStatus?.(`⬆ Uploading ${a.name} (${mb(blob.size)})…`);

  let resp: Response | null = null;
  // Resumable protocol, as Google documents it: announce the file, get a one-off upload
  // address back in a response header, send the bytes there.
  const start = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(blob.size),
      'X-Goog-Upload-Header-Content-Type': a.mime,
      'Content-Type': 'application/json',
    },
    body: meta,
    signal,
  });
  if (!start.ok) throw await failure(start, `Uploading "${a.name}"`);
  const session = start.headers.get('x-goog-upload-url');
  if (session) {
    resp = await fetch(session, {
      method: 'POST',
      headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: blob,
      signal,
    });
  } else {
    // The address wasn't readable from the page (a browser only sees response headers the
    // server chooses to expose). Same upload as a single request instead.
    const boundary = `bubble${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${a.mime}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    resp = await fetch(`${uploadUrl}?uploadType=multipart`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
      signal,
    });
  }
  if (!resp.ok) throw await failure(resp, `Uploading "${a.name}"`);
  const file = await waitUntilUsable(base, key, (await resp.json())?.file, a, cb, signal);
  a.fileUri = file.uri;
  a.fileExpires = (Date.parse(file.expirationTime) || Date.now() + 48 * 60 * 60 * 1000) - (48 * 60 * 60 * 1000 - FILE_TTL);
  a.fileKeyTag = keyTag(key);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error || new Error('could not read the file'));
    r.readAsDataURL(blob);
  });
}

// ── Request building ──
// One pass over the chat → provider-neutral parts, so both wire formats agree on what
// is sent and what is replaced by a note.
type Part =
  | { t: 'text'; text: string }
  | { t: 'inline'; mime: string; b64: string; name: string }
  | { t: 'media'; a: Attachment; blob?: Blob };
interface Turn { role: 'user' | 'model'; parts: Part[] }

async function gatherTurns(messages: Message[]): Promise<Turn[]> {
  const turns: Turn[] = [];
  let imageBytes = 0;
  // Newest first, so when images outgrow one request it is the oldest that are left out.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'system') continue;
    const parts: Part[] = [];
    const notes: string[] = [];
    for (const a of m.attachments || []) {
      if (a.kind === 'media') {
        const usable = !!a.fileUri && (a.fileExpires || 0) > Date.now();
        const blob = await getBlob(a.id).catch(() => undefined);
        if (blob || usable) parts.push({ t: 'media', a, blob });
        else notes.push(`[recording "${a.name}" is no longer stored on this device and its upload has expired, so it is not attached]`);
      } else if (a.kind === 'image' || (a.kind === 'pdf' && a.dataUrl)) {
        const d = a.unreadable ? null : splitDataUrl(a.dataUrl);
        const mime = a.kind === 'pdf' ? 'application/pdf' : d && sniffBase64(d.b64);
        if (d && mime && imageBytes + d.b64.length <= INLINE_IMAGE_BUDGET) {
          imageBytes += d.b64.length;
          parts.push({ t: 'inline', mime, b64: d.b64, name: a.name });
        } else if (a.kind === 'pdf' && a.text) {
          notes.push(`<attached_file name="${a.name}" type="application/pdf">\n${a.text}\n</attached_file>`);
        } else {
          notes.push(`[attached file "${a.name}" is not included: ${d && mime ? 'this conversation holds more than fits in one request' : 'it could not be read'}]`);
        }
      } else {
        notes.push(`<attached_file name="${a.name}" type="${a.mime}">\n${a.text || ''}\n</attached_file>`);
      }
    }
    const text = [...notes, m.content || ''].filter(Boolean).join('\n\n');
    if (text) parts.push({ t: 'text', text });
    if (!parts.length) parts.push({ t: 'text', text: '…' });
    turns.unshift({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return turns;
}

const BLOCK_REASONS = /SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII|LANGUAGE|IMAGE_|OTHER|content_filter/;

export async function streamGemini(
  settings: Settings,
  messages: Message[],
  systemPrompt: string,
  cb: GeminiCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const viaOpenRouter = settings.gemini_source === 'openrouter';
  const model = activeGeminiModel(settings);
  let allText = '';
  let allThinking = '';
  let stop: StopInfo | undefined;

  try {
    const turns = await gatherTurns(messages);
    const outLimit = (await cachedGeminiModels(settings)).find(m => m.id === model)?.out;

    // Get every recording where the service can read it, before the first request.
    for (const turn of turns) {
      for (const p of turn.parts) {
        if (p.t !== 'media') continue;
        if (viaOpenRouter) {
          if (!p.blob) throw new Error(`"${p.a.name}" is no longer stored on this device — attach it again.`);
          if (p.blob.size > OPENROUTER_INLINE_MAX) {
            throw new Error(`"${p.a.name}" is ${mb(p.blob.size)}. OpenRouter has no file upload, so recordings over ${mb(OPENROUTER_INLINE_MAX)} need a Google API key (Settings → Gemini → Source: Google) — that route takes files up to 2 GB.`);
          }
        } else if (!(p.a.fileUri && (p.a.fileExpires || 0) > Date.now() && p.a.fileKeyTag === keyTag(settings.gemini_api_key.trim()))) {
          if (!p.blob) throw new Error(`"${p.a.name}" was uploaded with a different API key and is no longer stored on this device — attach it again.`);
          if (p.blob.size > FILES_API_MAX) throw new Error(`"${p.a.name}" is ${mb(p.blob.size)}; Google accepts files up to 2 GB.`);
          await uploadToGoogle(settings, p.a, p.blob, cb, signal);
        }
      }
    }

    // The two wire formats.
    let url: string;
    let headers: Record<string, string>;
    let makeBody: (extra: Turn[]) => any;
    if (viaOpenRouter) {
      url = `${trimUrl(settings.openrouter_url)}/chat/completions`;
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.openrouter_api_key.trim()}` };
      const encoded = new Map<Attachment, string>();
      for (const t of turns) for (const p of t.parts) if (p.t === 'media') encoded.set(p.a, await blobToBase64(p.blob!));
      makeBody = (extra) => {
        const msgs: any[] = [];
        if (systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt });
        for (const t of [...turns, ...extra]) {
          const content = t.parts.map((p): any => {
            if (p.t === 'text') return { type: 'text', text: p.text };
            if (p.t === 'inline') {
              return p.mime === 'application/pdf'
                ? { type: 'file', file: { filename: p.name, file_data: `data:${p.mime};base64,${p.b64}` } }
                : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.b64}` } };
            }
            const b64 = encoded.get(p.a)!;
            return p.a.mime.startsWith('video/')
              ? { type: 'video_url', video_url: { url: `data:${p.a.mime};base64,${b64}` } }
              : { type: 'input_audio', input_audio: { data: b64, format: AUDIO_FORMAT[p.a.mime] || p.a.mime.split('/')[1] || 'mp3' } };
          });
          msgs.push({
            role: t.role === 'model' ? 'assistant' : 'user',
            content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
          });
        }
        // Ask for the model's whole allowance; unknown model → leave it to the provider's default.
        const body: any = { model, messages: msgs, stream: true };
        if (outLimit) body.max_tokens = outLimit;
        return body;
      };
    } else {
      url = `${trimUrl(settings.gemini_url)}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': settings.gemini_api_key.trim() };
      makeBody = (extra) => {
        const body: any = {
          contents: [...turns, ...extra].map(t => ({
            role: t.role,
            parts: t.parts.map((p): any =>
              p.t === 'text' ? { text: p.text }
              : p.t === 'inline' ? { inlineData: { mimeType: p.mime, data: p.b64 } }
              : { fileData: { mimeType: p.a.mime, fileUri: p.a.fileUri } }),
          })),
          // The content filters are adjustable settings on this API, and at their defaults
          // they cut transcripts short whenever a meeting touches a rough subject.
          safetySettings: ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT']
            .map(c => ({ category: `HARM_CATEGORY_${c}`, threshold: 'BLOCK_NONE' })),
        };
        if (systemPrompt.trim()) body.systemInstruction = { parts: [{ text: systemPrompt }] };
        if (outLimit) body.generationConfig = { maxOutputTokens: outLimit };
        return body;
      };
    }

    for (let round = 1; ; round++) {
      // From the second round on: the reply so far goes back as the model's own turn,
      // followed by the instruction to carry straight on.
      const extra: Turn[] = round === 1 ? [] : [
        { role: 'model', parts: [{ t: 'text', text: allText }] },
        { role: 'user', parts: [{ t: 'text', text: CONTINUE_PROMPT }] },
      ];
      cb.onStatus?.(round === 1 ? '' : `✦ Hit the output limit — continuing (part ${round})…`);
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(makeBody(extra)), signal });
      if (!resp.ok) throw await failure(resp, round === 1 ? 'The request' : `Part ${round} of the reply`);
      const reader = resp.body?.getReader();
      if (!reader) throw new Error('No response body for streaming');

      // A continuation sometimes re-says the last few words before carrying on. Hold its
      // first stretch back until there is enough to compare against the end of the text
      // so far, and drop the overlap, so the seam doesn't show.
      let held = '';
      let holding = round > 1;
      const release = () => {
        if (!holding) return;
        holding = false;
        const tail = allText.slice(-400);
        let cut = 0;
        for (let n = Math.min(tail.length, held.length); n >= 20; n--) {
          if (tail.endsWith(held.slice(0, n))) { cut = n; break; }
        }
        const out = held.slice(cut);
        held = '';
        if (out) { allText += out; cb.onText(out); }
      };
      const emit = (text: string) => {
        if (!text) return;
        cb.onStatus?.('');
        if (holding) { held += text; if (held.length >= 400) release(); return; }
        allText += text;
        cb.onText(text);
      };
      const think = (text: string) => { if (text) { allThinking += text; cb.onThinking?.(text); } };

      let finish = '';
      let blocked = '';
      let produced = 0;
      let streamError: Error | null = null;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let evt: any;
          try { evt = JSON.parse(data); } catch { continue; }
          if (evt?.error) {
            streamError = new Error(`The reply was cut off by a server error: ${evt.error.message || evt.error.status || evt.error.code || 'unknown error'}`);
            continue;
          }
          // Google
          if (evt?.promptFeedback?.blockReason) blocked = evt.promptFeedback.blockReason;
          const cand = evt?.candidates?.[0];
          if (cand) {
            for (const p of cand.content?.parts || []) {
              if (typeof p?.text !== 'string') continue;
              if (p.thought) think(p.text);
              else { produced += p.text.length; emit(p.text); }
            }
            if (cand.finishReason) finish = cand.finishReason;
          }
          // OpenRouter
          const choice = evt?.choices?.[0];
          if (choice) {
            const d = choice.delta || {};
            if (typeof d.content === 'string') { produced += d.content.length; emit(d.content); }
            if (typeof d.reasoning === 'string') think(d.reasoning);
            if (choice.finish_reason) finish = choice.native_finish_reason === 'MAX_TOKENS' ? 'MAX_TOKENS' : choice.finish_reason;
          }
        }
        if (streamError) throw streamError;
      }
      release();

      const cutOff = finish === 'MAX_TOKENS' || finish === 'length';
      if (blocked || BLOCK_REASONS.test(finish)) {
        stop = { reason: 'refusal', category: blocked || finish };
        break;
      }
      if (!cutOff) break;
      // Cut off without writing anything (the whole allowance went on thinking, say):
      // asking again would loop without progress.
      if (!produced || round >= MAX_ROUNDS) { stop = { reason: 'length' }; break; }
    }

    cb.onStatus?.('');
    cb.onDone({ text: allText, thinking: allThinking || undefined, stop });
  } catch (e) {
    cb.onStatus?.('');
    if ((e as Error).name === 'AbortError') {
      cb.onDone({ text: allText, thinking: allThinking || undefined });
      return;
    }
    cb.onError(e as Error);
  }
}
