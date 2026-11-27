// All settings tracked. Mirrors what's in ST's "AI Response Configuration" + "API Connections" tabs.
// Naming kept close to ST's `oai_settings.*` keys so bootstrap-from-ST is a 1:1 copy.

export type ChatCompletionSource = 'claude' | 'openai' | 'custom';

export interface Settings {
  // ── API Connections ──
  chat_completion_source: ChatCompletionSource;
  reverse_proxy: string;          // e.g. https://your-proxy.example.com/v1
  proxy_password: string;         // sent as Bearer token
  claude_model: string;
  claude_alt_model: string;       // The other-model in the quick toggle
  compact_model: string;           // Used by /compact (defaults to Sonnet 4.6 for 1M context)
  custom_model: string;
  custom_url: string;
  bypass_status_check: boolean;
  show_external_models: boolean;

  // ── Sampling ──
  temp_openai: number;
  top_p_openai: number;
  top_k_openai: number;
  freq_pen_openai: number;
  pres_pen_openai: number;
  repetition_penalty_openai: number;
  min_p_openai: number;
  top_a_openai: number;

  // ── Limits ──
  openai_max_tokens: number;
  openai_max_context: number;
  max_context_unlocked: boolean;
  seed: number;
  n: number;

  // ── Behavior ──
  stream_openai: boolean;
  reasoning_effort: 'auto' | 'low' | 'medium' | 'high';
  show_thoughts: boolean;
  show_decline_notices: boolean;   // explain on the message when the API declines a reply
  squash_system_messages: boolean;
  use_sysprompt: boolean;
  names_behavior: number;
  verbosity: 'auto' | 'low' | 'medium' | 'high';
  tool_reasoning_mode: 'disabled' | 'auto' | 'always';
  function_calling: boolean;
  enable_web_search: boolean;

  // ── Prompts ──
  system_prompt: string;          // Bubble-specific: system message used by default
  system_prompt_enabled: boolean;
  userstyle1_name: string;
  userstyle1: string;
  userstyle1_enabled: boolean;
  userstyle2_name: string;
  userstyle2: string;
  userstyle2_enabled: boolean;
  assistant_prefill: string;
  assistant_impersonation: string;
  continue_prefill: boolean;
  continue_postfix: string;
  continue_nudge_prompt: string;
  new_chat_prompt: string;
  new_example_chat_prompt: string;
  new_group_chat_prompt: string;
  impersonation_prompt: string;
  group_nudge_prompt: string;
  personality_format: string;
  scenario_format: string;
  wi_format: string;
  send_if_empty: string;

  // ── Bubble-specific ──
  st_url: string;                 // Used only for the "re-sync from SillyTavern" feature
  st_basic_user: string;
  st_basic_pass: string;

  // ── Appearance ──
  theme: 'auto' | 'light' | 'dark';
  // work = surface the proactive "save as document/table" offer bar; casual = hide it
  // (the manual per-reply "Save ▾" menu stays available in both modes).
  chat_mode: 'work' | 'casual';

  // ── Thinking ──
  thinking_effort: 'off' | 'low' | 'medium' | 'high' | 'max';

  // ── Gemini mode (/gemini, /claude) ──
  // Which engine the app is talking to. Gemini mode goes straight to Google (or
  // OpenRouter) with its own key, model list and instructions — no proxy involved.
  app_mode: 'claude' | 'gemini';
  gemini_source: 'google' | 'openrouter';
  gemini_url: string;             // https://generativelanguage.googleapis.com/v1beta
  gemini_api_key: string;         // AIza…
  gemini_model: string;
  openrouter_url: string;         // https://openrouter.ai/api/v1
  openrouter_api_key: string;     // sk-or-v1-…
  openrouter_model: string;       // google/gemini-…
  gemini_system_prompt: string;   // instructions used in Gemini mode instead of the Claude prompts

  // ── Sync (PocketBase) — device-local, never synced ──
  sync_enabled: boolean;
  sync_url: string;       // PocketBase base URL, e.g. https://bubble-pb.up.railway.app
  sync_email: string;
  sync_password: string;
}

export interface Attachment {
  id: string;
  // 'media' = audio or video. Its bytes are too big for the chat record, so they live in
  // the `blobs` store under this attachment's id (this device only) — see media.ts.
  kind: 'image' | 'pdf' | 'text' | 'media';
  name: string;
  mime: string;
  size: number;
  // For images: data URL (base64). For text: extracted plain text.
  // For PDF: dataUrl = raw PDF base64 (sent as a native document block); text = extracted-text fallback.
  dataUrl?: string;
  text?: string;
  // Images only. Pixel size as stored — its presence also means the image has been
  // through normalizeImage (image.ts), i.e. it is a format, size and label the API takes.
  width?: number;
  height?: number;
  // Images only. An image from an older build that no decoder here could open: kept in
  // the chat for the record, never put in a request.
  unreadable?: boolean;
  // Media only. Where Google holds the uploaded copy (Files API). Uploads expire after
  // 48 hours and belong to one API key, so both are remembered alongside the address.
  fileUri?: string;
  fileExpires?: number;
  fileKeyTag?: string;
}

export interface WebSource {
  url: string;
  title?: string;
}

export interface MessageVariant {
  content: string;
  thinking?: string;
  attachments?: Attachment[];
  webSources?: WebSource[];
  webSearchQueries?: string[];
  offerDismissed?: boolean;
  createdAt: number;
  error?: string;
  // Snapshot of all messages that came AFTER this variant in the conversation.
  // Empty for the live variant. When switching to another variant, the live
  // downstream gets archived here and the snapshot is restored.
  downstreamSnapshot?: Message[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  // Live values — kept in sync with variants[activeVariant] when variants exists.
  content: string;
  thinking?: string;
  attachments?: Attachment[];
  webSources?: WebSource[];
  webSearchQueries?: string[];
  offerDismissed?: boolean;  // user dismissed the "save as document" offer
  createdAt: number;
  error?: string;
  // Branching: edit or regenerate pushes a new variant.
  variants?: MessageVariant[];
  activeVariant?: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  systemPromptOverride?: string;  // optional per-chat override
  compactionSummary?: string;      // injected as system context after /compact
  compactedAt?: number;            // timestamp of last compaction
  compactedTokenCount?: number;    // approx tokens that were summarized
  createdAt: number;
  updatedAt: number;
}
