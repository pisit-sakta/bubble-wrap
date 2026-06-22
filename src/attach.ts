import type { Attachment } from './types';
import { fileToDataUrl, fileToText, CLAUDE_NATIVE_IMAGE } from './api';

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
  // file.type is often empty for files dragged in or with odd extensions — fall back
  // to extension-based guessing so e.g. a .jfif (which is JPEG) isn't misread as text.
  const mime = file.type || guessMime(file.name);
  const isImage = mime.startsWith('image/');
  const isPdf   = mime === 'application/pdf' || /\.pdf$/i.test(file.name);

  const base = { id, name: file.name, mime, size: file.size };

  if (isImage) {
    // readAsDataURL tags files with no file.type as application/octet-stream; rewrite the
    // header to our detected type so the embedded MIME matches (the API reads it back from
    // here) and so a typeless blob still decodes for transcoding below.
    let dataUrl = retagDataUrl(await fileToDataUrl(file), mime);
    let outMime = mime;
    // Native formats (jpeg/png/gif/webp) pass through untouched — preserves quality
    // and animation. Anything else (bmp, svg, avif, tiff, heic, jfif…) gets rasterized
    // to PNG so Claude can actually read it instead of rejecting the whole request.
    if (!CLAUDE_NATIVE_IMAGE.has(mime)) {
      const png = await transcodeToPng(dataUrl).catch(() => null);
      if (!png) {
        throw new Error(
          `${mime || 'that image format'} can't be read by your browser to convert it. Save it as PNG or JPEG and try again.`
        );
      }
      dataUrl = png;
      outMime = 'image/png';
    }
    return { ...base, mime: outMime, kind: 'image', dataUrl };
  }
  if (isPdf) {
    const text = await extractPdfText(file);
    return { ...base, kind: 'pdf', text };
  }
  // text-ish: read as text
  const text = await fileToText(file);
  return { ...base, kind: 'text', text };
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

// Rasterize a non-native image (bmp/svg/avif/tiff/heic/…) to a PNG data URL via an
// off-screen canvas. Rejects if the browser can't decode the source (e.g. HEIC on
// Chrome, TIFF anywhere) so the caller can show a friendly message.
async function transcodeToPng(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('image has no intrinsic size'); // e.g. a viewBox-less SVG
  // Anthropic caps images at 8000px on the long edge; downscale to stay under canvas
  // limits and avoid a needless server-side rejection.
  const MAX = 8000;
  if (w > MAX || h > MAX) {
    const s = MAX / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas context');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

// Force a base64 data URL's media-type header to `mime`, keeping the payload as-is.
// (readAsDataURL always base64-encodes, so the payload is valid for any header.)
function retagDataUrl(dataUrl: string, mime: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma === -1 || !dataUrl.startsWith('data:')) return dataUrl;
  return `data:${mime};base64,${dataUrl.slice(comma + 1)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
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
