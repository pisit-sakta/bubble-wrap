import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';

marked.setOptions({
  breaks: true,
  gfm: true,
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
