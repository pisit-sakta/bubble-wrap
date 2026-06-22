// Client-side file generation: turn an assistant reply (markdown) into a real
// .pdf / .docx / .html / .xlsx, entirely in the browser. The heavy libraries
// (docx, xlsx) are dynamically imported so they only load when first used.
import { marked } from 'marked';
import { renderMarkdown } from './markdown';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function sanitize(s: string): string {
  return (s || 'document').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'document';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function decode(s: string): string {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'");
}

// ─── HTML / PDF (no extra dependency) ───
const DOC_CSS = `
*{box-sizing:border-box}
body{margin:0}
.doc{max-width:720px;margin:40px auto;padding:0 24px;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:12pt;line-height:1.6;color:#1a1a1a}
.doc h1,.doc h2,.doc h3,.doc h4{line-height:1.25;margin:1.2em 0 .5em;font-weight:600}
.doc h1{font-size:1.9em}.doc h2{font-size:1.5em}.doc h3{font-size:1.25em}
.doc p{margin:0 0 .8em}
.doc ul,.doc ol{margin:.4em 0 .9em;padding-left:1.5em}
.doc li{margin:.25em 0}
.doc pre{background:#f4f1e9;border:1px solid #e0ddd2;border-radius:6px;padding:12px 14px;overflow:auto;font-size:10.5pt;line-height:1.45}
.doc code{font-family:"Consolas","SF Mono",Menlo,monospace}
.doc :not(pre)>code{background:#f0ede3;padding:1px 5px;border-radius:4px;font-size:.9em}
.doc table{border-collapse:collapse;width:100%;margin:.8em 0;font-size:11pt}
.doc th,.doc td{border:1px solid #ccc;padding:6px 10px;text-align:left}
.doc th{background:#f0ede3}
.doc blockquote{border-left:3px solid #d0cdc2;margin:.8em 0;padding-left:14px;color:#555}
.doc img{max-width:100%}
.doc a{color:#b1542f}
@page{margin:18mm}
`;

export function replyToHtml(markdown: string, title: string): string {
  const body = renderMarkdown(markdown);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${DOC_CSS}</style></head><body><main class="doc">${body}</main></body></html>`;
}

export function saveReplyAsHtml(markdown: string, title: string) {
  downloadBlob(`${sanitize(title)}.html`, new Blob([replyToHtml(markdown, title)], { type: 'text/html' }));
}

export function saveReplyAsPdf(markdown: string, title: string) {
  const html = replyToHtml(markdown, title);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  iframe.srcdoc = html;
  iframe.onload = () => {
    const w = iframe.contentWindow;
    if (!w) { iframe.remove(); return; }
    const cleanup = () => setTimeout(() => iframe.remove(), 500);
    w.addEventListener('afterprint', cleanup);
    try { w.focus(); w.print(); } catch { cleanup(); }
    setTimeout(() => { if (document.body.contains(iframe)) iframe.remove(); }, 120000);
  };
  document.body.appendChild(iframe);
}

// ─── DOCX (lazy docx) ───
export async function saveReplyAsDocx(markdown: string, title: string) {
  const docx: any = await import('docx');
  const children = markdownToDocx(docx, markdown);
  const doc = new docx.Document({ sections: [{ properties: {}, children }] });
  const blob = await docx.Packer.toBlob(doc);
  downloadBlob(`${sanitize(title)}.docx`, blob);
}

function markdownToDocx(docx: any, md: string): any[] {
  const { Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = docx;
  const headingMap: Record<number, any> = {
    1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
  };
  const out: any[] = [];
  const tokens = marked.lexer(md) as any[];

  for (const tk of tokens) {
    switch (tk.type) {
      case 'heading':
        out.push(new Paragraph({ heading: headingMap[tk.depth] || HeadingLevel.HEADING_3, children: inlineRuns(docx, tk.tokens) }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: inlineRuns(docx, tk.tokens) }));
        break;
      case 'list':
        pushList(docx, out, tk, 0);
        break;
      case 'code':
        for (const line of String(tk.text).split('\n')) {
          out.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })] }));
        }
        break;
      case 'blockquote':
        for (const sub of (tk.tokens || [])) {
          out.push(new Paragraph({ indent: { left: 360 }, children: inlineRuns(docx, sub.tokens || [{ type: 'text', text: sub.text || '' }]) }));
        }
        break;
      case 'table':
        out.push(tableToDocx(docx, tk, { Table, TableRow, TableCell, Paragraph, TextRun, WidthType }));
        out.push(new Paragraph({ text: '' }));
        break;
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { color: 'auto', space: 1, style: BorderStyle.SINGLE, size: 6 } }, children: [new TextRun('')] }));
        break;
      case 'space':
        break;
      default:
        if (tk.text) out.push(new Paragraph({ children: [new TextRun(decode(String(tk.text)))] }));
        break;
    }
  }
  if (!out.length) out.push(new Paragraph({ children: [new TextRun(md)] }));
  return out;
}

function inlineRuns(docx: any, tokens: any[], opts: { bold?: boolean; italics?: boolean; strike?: boolean } = {}): any[] {
  const { TextRun, ExternalHyperlink } = docx;
  const runs: any[] = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text':
        if (t.tokens && t.tokens.length) runs.push(...inlineRuns(docx, t.tokens, opts));
        else runs.push(new TextRun({ text: decode(t.text), bold: opts.bold, italics: opts.italics, strike: opts.strike }));
        break;
      case 'strong':
        runs.push(...inlineRuns(docx, t.tokens, { ...opts, bold: true }));
        break;
      case 'em':
        runs.push(...inlineRuns(docx, t.tokens, { ...opts, italics: true }));
        break;
      case 'del':
        runs.push(...inlineRuns(docx, t.tokens, { ...opts, strike: true }));
        break;
      case 'codespan':
        runs.push(new TextRun({ text: decode(t.text), font: 'Consolas', bold: opts.bold, italics: opts.italics }));
        break;
      case 'br':
        runs.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'link':
        runs.push(new ExternalHyperlink({ link: t.href, children: inlineRuns(docx, t.tokens, opts) }));
        break;
      case 'escape':
        runs.push(new TextRun({ text: t.text, bold: opts.bold, italics: opts.italics, strike: opts.strike }));
        break;
      case 'html':
        break;
      default:
        if (t.text) runs.push(new TextRun({ text: decode(t.text), bold: opts.bold, italics: opts.italics, strike: opts.strike }));
        break;
    }
  }
  return runs.length ? runs : [new TextRun('')];
}

function pushList(docx: any, out: any[], list: any, level: number) {
  const { Paragraph, TextRun } = docx;
  let n = list.start || 1;
  for (const item of list.items || []) {
    const inline: any[] = [];
    for (const t of item.tokens || []) {
      if (t.type === 'text' || t.type === 'paragraph') inline.push(...(t.tokens || [{ type: 'text', text: t.text || '' }]));
    }
    if (list.ordered) {
      out.push(new Paragraph({ indent: { left: 360 * (level + 1) }, children: [new TextRun(`${n}. `), ...inlineRuns(docx, inline)] }));
    } else {
      out.push(new Paragraph({ bullet: { level }, children: inlineRuns(docx, inline) }));
    }
    for (const sub of item.tokens || []) {
      if (sub.type === 'list') pushList(docx, out, sub, level + 1);
    }
    n++;
  }
}

function cellText(cell: any): string {
  return decode(String((cell && cell.text) || ''));
}

function tableToDocx(_docx: any, tk: any, ctor: any): any {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType } = ctor;
  const headerCells = (tk.header || []).map((c: any) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: cellText(c), bold: true })] })] }));
  const rows: any[] = [new TableRow({ tableHeader: true, children: headerCells })];
  for (const r of tk.rows || []) {
    rows.push(new TableRow({ children: r.map((c: any) => new TableCell({ children: [new Paragraph({ children: [new TextRun(cellText(c))] })] })) }));
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

// ─── XLSX (lazy SheetJS) ───
interface ExtractedTable { headers: string[]; rows: string[][]; }

export function extractTables(md: string): ExtractedTable[] {
  const out: ExtractedTable[] = [];
  for (const tk of marked.lexer(md) as any[]) {
    if (tk.type === 'table') {
      out.push({
        headers: (tk.header || []).map(cellText),
        rows: (tk.rows || []).map((r: any[]) => r.map(cellText)),
      });
    }
  }
  return out;
}

export async function saveTablesAsXlsx(markdown: string, title: string) {
  const tables = extractTables(markdown);
  if (!tables.length) throw new Error('No tables found in this reply');
  const XLSX: any = await import('xlsx');
  const wb = XLSX.utils.book_new();
  tables.forEach((t, i) => {
    const ws = XLSX.utils.aoa_to_sheet([t.headers, ...t.rows]);
    XLSX.utils.book_append_sheet(wb, ws, `Table ${i + 1}`);
  });
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(`${sanitize(title)}.xlsx`, new Blob([out], { type: XLSX_MIME }));
}

export async function csvToXlsx(csv: string, name: string) {
  const XLSX: any = await import('xlsx');
  const wb = XLSX.read(csv, { type: 'string' });
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(`${sanitize(name)}.xlsx`, new Blob([out], { type: XLSX_MIME }));
}
