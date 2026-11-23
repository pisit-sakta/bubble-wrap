import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';

marked.setOptions({
  breaks: true,
  gfm: true,
});

// ── Tags in a reply ──
// By default markdown passes any <tag> in the text straight to the browser, which then
// treats it as markup: it draws nothing for tags it doesn't know, so "wrap it in a
// <Button>" loses a word, and a reply that opens with a <thinking> block has those
// letters flash and vanish, with every line after them run together as raw text. It
// also means a reply (or a web page quoted in one) can inject live HTML — an
// <img onerror=…> runs script inside the app, next to the stored proxy password.
//
// So only plain formatting tags are honoured, and even those are rebuilt from scratch
// with a handful of harmless attributes. Everything else stays what it was written as:
// text, shown literally, with normal markdown around it.
const SAFE_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'samp', 'var',
  'code', 'pre', 'br', 'hr', 'wbr', 'p', 'div', 'span', 'center', 'blockquote', 'q', 'cite', 'abbr',
  'details', 'summary', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'font', 'ruby', 'rt', 'rp', 'a',
]);
const SAFE_ATTRS = new Set(['title', 'align', 'color', 'open', 'colspan', 'rowspan', 'start', 'reversed', 'lang', 'dir', 'href']);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// Does the text at this point open with a tag we render? (Up to 3 spaces of indent, as markdown allows.)
function startsWithSafeTag(src: string): boolean {
  const m = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(src);
  return !!m && SAFE_TAGS.has(m[1].toLowerCase());
}

// A chunk of raw HTML → the same thing with only tags WE wrote in it. Every "<" that
// isn't part of a rebuilt safe tag is escaped, so nothing in the input can open one.
function cleanHtml(raw: string): string {
  const text = (t: string) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(TAG)) {
    out += text(raw.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (!SAFE_TAGS.has(name)) { out += text(m[0]); continue; }
    if (m[1]) { out += `</${name}>`; continue; }
    let attrs = '';
    for (const a of m[3].matchAll(ATTR)) {
      const key = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      if (!SAFE_ATTRS.has(key)) continue;
      if (key === 'href' && !/^(https?:|mailto:|#)/i.test(value)) continue;   // no javascript: and friends
      attrs += ` ${key}="${value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`;
    }
    if (name === 'a') attrs += ' target="_blank" rel="noopener noreferrer"';
    out += `<${name}${attrs}>`;
  }
  return out + text(raw.slice(last));
}

marked.use({
  tokenizer: {
    // `false` = carry on with the built-in rule; `undefined` = this is not HTML, so the
    // text falls through to the ordinary paragraph/inline rules and is escaped there.
    html: (src) => (startsWithSafeTag(src) ? false : undefined),
    tag: (src) => (startsWithSafeTag(src) ? false : undefined),
  },
  renderer: {
    html: ({ text }) => cleanHtml(text),
    // Same rule for markdown links: [label](javascript:…) must not become a live link.
    // `false` = render the normal anchor; otherwise just the label.
    link(token) {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(token.href.replace(/[\u0000-\u0020]/g, ''));
      return !scheme || /^(https?|mailto|tel)$/i.test(scheme[1]) ? false : this.parser.parseInline(token.tokens);
    },
  },
});

// Streaming render: parse markdown WITHOUT the (expensive) syntax-highlight pass,
// and temporarily close any unterminated code fence so the layout stays stable
// mid-stream. Cheap enough to run every animation frame. The full renderMarkdown()
// (with highlighting) runs once when the message finishes — only colors change, so
// there is no layout shift on completion.
export function renderMarkdownStreaming(text: string): string {
  return marked.parse(balanceFences(text || '')) as string;
}

function balanceFences(t: string): string {
  // Count lines that start a fenced code block (``` or ~~~).
  const fences = (t.match(/^[ \t]*(```|~~~)/gm) || []).length;
  if (fences % 2 === 1) return t + '\n```';
  return t;
}

// Render markdown to HTML and apply syntax highlighting
export function renderMarkdown(text: string): string {
  const html = marked.parse(text || '') as string;
  // Quick syntax highlight by parsing the resulting HTML
  return html.replace(/<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_m, lang: string | undefined, code: string) => {
    const decoded = decodeEntities(code);
    let highlighted: string;
    try {
      highlighted = lang && hljs.getLanguage(lang)
        ? hljs.highlight(decoded, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(decoded).value;
    } catch {
      highlighted = escapeHtml(decoded);
    }
    return `<pre><code class="hljs ${lang ? `language-${lang}` : ''}">${highlighted}</code></pre>`;
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
