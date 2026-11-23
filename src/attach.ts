import type { Attachment, Message } from './types';
import { fileToDataUrl, fileToText } from './api';
import { normalizeImage, sniffImageType, looksLikePdf, looksLikeSvg, splitDataUrl, base64ToBlob } from './image';

let pdfjsModule: any = null;

async function getPdfjs() {
  if (pdfjsModule) return pdfjsModule;
  // Lazy-load pdf.js
  const lib = await import('pdfjs-dist');
  // Inline-load worker
  // @ts-ignore
  const worker = await import('pdfjs-dist/build/pdf.worker.mjs?url').catch(() => null);
  if (worker?.default) {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
  } else {
    // Fallback: use a CDN worker (browsers will block this if offline; primary path is the bundled worker)
    lib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${lib.version}/build/pdf.worker.min.mjs`;
  }
  pdfjsModule = lib;
  return lib;
}

export async function fileToAttachment(file: File): Promise<Attachment> {
  const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  // What the picker claims the file is. That is frequently empty, or the meaningless
  // application/octet-stream (Android, share sheets), so fall back to the extension —
  // and for images and PDFs the file's own bytes overrule both (see image.ts).
  const claimed = file.type && file.type !== 'application/octet-stream' ? file.type : guessMime(file.name);
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const base = { id, name: file.name, mime: claimed, size: file.size };

  const isSvg = claimed === 'image/svg+xml' || (claimed === 'application/octet-stream' && looksLikeSvg(head));
  const isPdf = looksLikePdf(head);
  if (sniffImageType(head) || (!isPdf && (isSvg || claimed.startsWith('image/')))) {
    try {
      // → JPEG/PNG/GIF/WebP, right-sized, with a media type read from the result's bytes.
      return { ...base, kind: 'image', ...(await normalizeImage(file, isSvg ? 'image/svg+xml' : claimed)) };
    } catch (e) {
      // An SVG the browser can't rasterize (no size, external references) is still
      // perfectly good text — send the markup instead of refusing the file.
      if (!isSvg) throw e;
      return { ...base, mime: 'image/svg+xml', kind: 'text', text: await fileToText(file) };
    }
  }
  if (isPdf || claimed === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    // Keep the raw PDF (base64) so Claude can read it natively via a document block —
    // layout, scanned pages, figures. Text extraction stays as a fallback for the
    // OpenAI-compat path, non-Claude sources, and PDFs too big to send natively.
    const dataUrl = await fileToDataUrl(file)
      .then(u => retagDataUrl(u, 'application/pdf'))
      .catch(() => undefined);
    const text = await extractPdfText(file);
    return { ...base, mime: 'application/pdf', kind: 'pdf', dataUrl, text };
  }
  // text-ish: read as text
  const text = await fileToText(file);
  return { ...base, kind: 'text', text };
}

// Images attached by earlier builds skipped the checks in image.ts: they can carry the
// wrong media type, an unsupported format (HEIC), or a 12 MB original. Any one of those
// fails every request in its chat. Run them through the same normalizer once, in place,
// so an old conversation heals the next time it is sent. `width` marks an image as done.
export async function repairLegacyImages(messages: Message[]): Promise<{ fixed: number; unreadable: number }> {
  const result = { fixed: 0, unreadable: 0 };
  for (const m of messages) {
    for (const a of m.attachments || []) {
      if (a.kind !== 'image' || a.width || a.unreadable) continue;
      try {
        const parts = splitDataUrl(a.dataUrl);
        if (!parts) throw new Error('no image data');
        const before = a.dataUrl;
        Object.assign(a, await normalizeImage(base64ToBlob(parts.b64, parts.mime), parts.mime));
        if (a.dataUrl !== before) result.fixed++;
      } catch {
        a.unreadable = true; // stays visible in the chat, but is left out of requests
        result.unreadable++;
      }
    }
  }
  return result;
}

async function extractPdfText(file: File): Promise<string> {
  try {
    const pdfjs = await getPdfjs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const out: string[] = [];
    const max = Math.min(pdf.numPages, 200); // soft cap
    for (let i = 1; i <= max; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it: any) => it.str).join(' ');
      out.push(`--- page ${i} ---\n${text}`);
    }
    return out.join('\n\n');
  } catch (e) {
    return `[Failed to extract PDF text: ${(e as Error).message}]`;
  }
}

// Force a base64 data URL's media-type header to `mime`, keeping the payload as-is.
// (readAsDataURL always base64-encodes, so the payload is valid for any header.)
function retagDataUrl(dataUrl: string, mime: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma === -1 || !dataUrl.startsWith('data:')) return dataUrl;
  return `data:${mime};base64,${dataUrl.slice(comma + 1)}`;
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    js: 'text/javascript',
    ts: 'text/typescript',
    py: 'text/x-python',
    pdf: 'application/pdf',
    // Claude-native image types
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jfif: 'image/jpeg',
    pjpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    // Convertible image types (transcoded to PNG at attach time)
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    ico: 'image/x-icon',
    heic: 'image/heic',
    heif: 'image/heif',
  };
  return map[ext] || 'application/octet-stream';
}

export function formatBytes(b: number): string {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
