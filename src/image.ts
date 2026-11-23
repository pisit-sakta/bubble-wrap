// Image intake: whatever a phone or desktop hands us → an image Claude will accept.
//
// The API takes JPEG/PNG/GIF/WebP only, and rejects the WHOLE request when an image's
// media type is missing, wrong, or doesn't match its bytes. Because history is resent
// every turn, one rejected image then blocks every later send in that chat.
//
// File pickers can't be trusted for this. `file.type` is guessed from the extension (a
// PNG saved as photo.jpg claims image/jpeg), is empty or application/octet-stream for a
// lot of Android and share-sheet files, and is sometimes a non-standard alias
// (image/jpg). So nothing here believes the label: the format is read from the file's
// own bytes, and the media type we store and send is sniffed from the bytes we produced.

export const CLAUDE_NATIVE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Limits, from platform.claude.com/docs/en/build-with-claude/vision. Where platforms
// differ these are the strictest, so a proxy in front of any of them works:
//   - 5 MB per image, counted on the base64 text (Bedrock; the first-party API allows 10)
//   - 8000 px per side, tightening to ~3000 px once a request carries more than 20
//     images — and every request resends all earlier images, so a long chat gets there
//   - nothing beyond 2576 px on the long edge / 4784 visual tokens (28 px patches) is
//     ever seen: bigger images are downscaled server-side. Doing that here loses no
//     detail and turns a 6 MB phone photo into a ~1 MB upload.
const MAX_EDGE = 2576;
const PATCH = 28;
const MAX_PATCHES = 4784;
const MAX_BYTES = 3.5 * 1024 * 1024;      // raw bytes; ×4/3 as base64 ≈ 4.7 MB
const PNG_KEEP_BYTES = 2 * 1024 * 1024;   // re-encoded screenshots stay lossless up to here
const MAX_CANVAS_AREA = 16_000_000;       // iOS Safari silently draws nothing past ~16.7 MP
const HEAD_BYTES = 64 * 1024;             // any signature, plus a JPEG's EXIF block
const VECTOR_MIN_EDGE = 1024;             // an SVG icon rasterized at 24 px is unreadable

const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

// The image format these bytes really are, or null if they aren't an image we know.
export function sniffImageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  const six = ascii(b, 0, 6);
  if (six === 'GIF87a' || six === 'GIF89a') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(b, 4, 4) === 'ftyp') {
    // ISO-BMFF container: HEIC / HEIF / AVIF — and MP4 / MOV video, which is not ours.
    // The major brand is often the generic "mif1", so the compatible brands decide.
    const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const end = Math.min(b.length, size >= 16 ? size : 64);
    const brands: string[] = [];
    for (let i = 8; i + 4 <= end; i += 4) if (i !== 12) brands.push(ascii(b, i, 4)); // 12..16 is a version, not a brand
    if (brands.some(x => x === 'avif' || x === 'avis')) return 'image/avif';
    if (brands.some(x => /^he[iv][cxms]$/.test(x))) return 'image/heic';
    if (brands.some(x => x === 'mif1' || x === 'msf1')) return 'image/heif';
    return null;
  }
  // "BM" alone would catch any text file starting with those letters — also require a real DIB header size.
  if (ascii(b, 0, 2) === 'BM' && [12, 40, 52, 56, 64, 108, 124].includes(b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24))) return 'image/bmp';
  const four = ascii(b, 0, 4);
  if (four === 'II*\0' || four === 'MM\0*') return 'image/tiff';
  return null;
}

export function looksLikePdf(b: Uint8Array): boolean {
  return ascii(b, 0, 5) === '%PDF-';
}

// SVG is text, so it has no magic number — look for the root element after the usual preamble.
export function looksLikeSvg(b: Uint8Array): boolean {
  const text = ascii(b, 0, 1024).replace(/^\xef\xbb\xbf/, '');
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s>]/i.test(text);
}

// Split a base64 data URL without running a regex over megabytes of payload. Tolerates
// an empty or parameterised media type ("data:;base64," / "data:image/png;charset=x;base64,").
export function splitDataUrl(url: string | undefined): { mime: string; b64: string } | null {
  if (!url || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma).toLowerCase();
  if (!meta.endsWith(';base64')) return null;
  let b64 = url.slice(comma + 1);
  if (/\s/.test(b64.slice(0, 128))) b64 = b64.replace(/\s+/g, ''); // line-wrapped, e.g. a hand-edited import
  return b64 ? { mime: meta.split(';')[0].trim(), b64 } : null;
}

// What a base64 payload really is, judged from its first bytes.
export function sniffBase64(b64: string): string | null {
  try {
    const bin = atob(b64.slice(0, 64));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return sniffImageType(bytes);
  } catch {
    return null;
  }
}

export function base64ToBlob(b64: string, type = ''): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export interface NormalizedImage {
  dataUrl: string;
  mime: string;     // always one of CLAUDE_NATIVE_IMAGE, read back from the bytes in dataUrl
  size: number;     // bytes
  width: number;
  height: number;
}

// Turn any image file into one the API is guaranteed to take: a supported format whose
// label matches its bytes, within the size limits, upright, and proven decodable.
// A file that already is all of that passes through byte-for-byte (keeps quality, and
// animation in the chat); anything else is redrawn through a canvas. Throws a message
// that reads naturally after "Couldn't attach <name>: ".
export async function normalizeImage(src: Blob, claimedType = ''): Promise<NormalizedImage> {
  const sniffed = sniffImageType(new Uint8Array(await src.slice(0, HEAD_BYTES).arrayBuffer()));
  let type = sniffed || claimedType;
  // Tag the bytes as what they are — the decoder needs that to treat SVG as SVG.
  let blob = src.type === type ? src : new Blob([src], { type });

  let loaded: Loaded;
  try {
    loaded = await loadImage(blob);
  } catch {
    if (type !== 'image/heic' && type !== 'image/heif') throw new Error(cantRead(type, !!sniffed));
    // Only Safari decodes HEIC itself. Everywhere else a wasm decoder (lazy-loaded, ~1.3 MB)
    // turns it into a JPEG first, which then goes through the same checks as any other.
    try {
      blob = await heicToJpeg(blob);
      loaded = await loadImage(blob);
    } catch {
      throw new Error(cantRead(type, true));
    }
    type = 'image/jpeg';
  }

  const { img, decoded } = loaded;
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('it has no pixel size to draw at.'); // e.g. an SVG with no width/height/viewBox
    const fit = fitBox(w, h, type === 'image/svg+xml');
    const asIs = decoded && CLAUDE_NATIVE_IMAGE.has(type) && fit.w === w && fit.h === h
      && blob.size <= MAX_BYTES && await looksIntact(blob, type);
    return asIs ? await pack(blob, w, h) : await redraw(img, w, h, fit.w, fit.h, type);
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

const FORMAT_NAMES: Record<string, string> = {
  'image/heic': 'HEIC', 'image/heif': 'HEIF', 'image/avif': 'AVIF', 'image/tiff': 'TIFF',
  'image/jxl': 'JPEG XL', 'image/x-icon': 'ICO', 'image/vnd.microsoft.icon': 'ICO',
};

function cantRead(type: string, recognised: boolean): string {
  // A real file in a format this browser has no decoder for (TIFF outside Safari, …)
  if (recognised && !CLAUDE_NATIVE_IMAGE.has(type)) {
    return `this browser can't open ${FORMAT_NAMES[type] || type} images. Save it as JPEG or PNG and try again.`;
  }
  return `it isn't a readable image — the file may be damaged or an incomplete download.`;
}

interface Loaded {
  img: HTMLImageElement;
  decoded: boolean;   // every pixel decoded cleanly, not just the header
}

// Rejects when the browser can't open the bytes as an image at all. `load` only proves
// the header parsed, so a full decode() follows; if that one fails the file is suspect
// rather than hopeless — it loses the right to pass through untouched and gets redrawn,
// which either salvages what decodes or reports a blank.
async function loadImage(blob: Blob): Promise<Loaded> {
  const img = new Image();
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('not an image'));
      img.src = url;
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  const decoded = typeof img.decode !== 'function' || await img.decode().then(() => true, () => false);
  return { img, decoded };
}

// HEIC/HEIF photos have no canvas decoder outside Safari, so a wasm one is lazy-loaded
// only when such a file is actually attached — keeps ~1.3MB out of the main bundle.
let heic2anyModule: any = null;
async function heicToJpeg(blob: Blob): Promise<Blob> {
  if (!heic2anyModule) {
    // @ts-ignore — heic2any ships no type declarations
    heic2anyModule = (await import('heic2any')).default;
  }
  const out = await heic2anyModule({ blob, toType: 'image/jpeg', quality: 0.92 });
  return Array.isArray(out) ? out[0] : out; // multi-image HEIC → first frame
}

// The largest size Claude will actually look at (see the limits above). Small vector
// images are scaled UP instead: they stay sharp at any size, and tiny rasters don't read.
function fitBox(w: number, h: number, vector: boolean): { w: number; h: number } {
  const long = Math.max(w, h);
  let s = Math.min(1, MAX_EDGE / long);
  if (vector && long < VECTOR_MIN_EDGE) s = VECTOR_MIN_EDGE / long;
  const dims = () => ({ w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) });
  const patches = () => { const d = dims(); return Math.ceil(d.w / PATCH) * Math.ceil(d.h / PATCH); };
  if (patches() > MAX_PATCHES) {
    s = Math.min(s, Math.sqrt((MAX_PATCHES * PATCH * PATCH) / (w * h)));
    while (patches() > MAX_PATCHES) s *= 0.995;
  }
  return dims();
}

// Cheap structural checks before trusting a file's original bytes: is it complete, and
// does it display upright without help? Cut-off downloads still decode in a browser (it
// just shows the part it has) but the API may refuse them; and a JPEG that relies on its
// EXIF orientation tag can arrive sideways, since the API reads no image metadata.
async function looksIntact(blob: Blob, type: string): Promise<boolean> {
  const tail = new Uint8Array(await blob.slice(-16).arrayBuffer());
  const n = tail.length;
  if (type === 'image/jpeg') {
    if (!(tail[n - 2] === 0xff && tail[n - 1] === 0xd9)) return false; // no end-of-image marker
    return jpegOrientation(new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer())) === 1;
  }
  if (type === 'image/png') return ascii(tail, n - 8, 4) === 'IEND';
  if (type === 'image/gif') return tail[n - 1] === 0x3b;
  if (type === 'image/webp') {
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const riff = (head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24)) >>> 0;
    return riff + 8 <= blob.size;
  }
  return false;
}

// EXIF orientation of a JPEG: 1 = stored upright (or no tag at all).
function jpegOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xda || len < 2) break; // pixel data starts — no EXIF ahead of it
    if (marker === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') {
      const t = i + 10; // TIFF header: byte order, magic, offset of the first directory
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o: number) => (le ? u16(o) | (u16(o + 2) << 16) : (u16(o) << 16) | u16(o + 2)) >>> 0;
      const dir = t + u32(t + 4);
      const count = u16(dir);
      for (let k = 0; k < count; k++) {
        const e = dir + 2 + k * 12;
        if (e + 12 > b.length) break;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
// iOS caps total canvas memory and is slow to collect it — hand it back explicitly.
function freeCanvas(c: HTMLCanvasElement | null) {
  if (c) c.width = c.height = 0;
}

function ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('this device ran out of memory for it.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

// Draw the image at w×h. Shrinking by more than 2× in one step skips source pixels and
// shreds fine text, so big reductions go through a chain of exact halvings.
function drawScaled(img: HTMLImageElement, sw: number, sh: number, w: number, h: number): HTMLCanvasElement {
  const chain: Array<[number, number]> = [[w, h]];
  while (chain[0][0] * 2 <= sw && chain[0][1] * 2 <= sh && chain[0][0] * chain[0][1] * 4 <= MAX_CANVAS_AREA) {
    chain.unshift([chain[0][0] * 2, chain[0][1] * 2]);
  }
  let from: CanvasImageSource = img;
  let prev: HTMLCanvasElement | null = null;
  for (const [cw, ch] of chain) {
    const c = newCanvas(cw, ch);
    ctxOf(c).drawImage(from, 0, 0, cw, ch);
    freeCanvas(prev);
    prev = c;
    from = c;
  }
  return prev!;
}

function encode(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error('this device ran out of memory for it.'))), type, quality);
  });
}

// Redraw through a canvas at the target size and encode as PNG or JPEG. This is what
// converts foreign formats, bakes in EXIF rotation, drops metadata (GPS included) and
// repairs half-broken files, all in one step.
async function redraw(img: HTMLImageElement, sw: number, sh: number, w: number, h: number, type: string): Promise<NormalizedImage> {
  let canvas = drawScaled(img, sw, sh, w, h);
  try {
    const ctx = ctxOf(canvas);
    const px = ctx.getImageData(0, 0, w, h).data;
    let transparent = false, blank = true;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) transparent = true;
      if (px[i] !== 0) blank = false;
      if (transparent && !blank) break;
    }
    // Nothing landed on the canvas: the decoder accepted the header and then produced no
    // pixels (a file cut off early, or an image too big for a phone's canvas). Say so
    // rather than send a blank rectangle.
    if (blank) throw new Error('it could not be decoded — the file is damaged, or too large for this device.');

    // Screenshots, diagrams and logos come from lossless formats: keep them pixel-exact
    // as PNG while that stays small. Transparency needs PNG regardless.
    const lossless = /png|gif|bmp|svg|icon|tiff/.test(type);
    if (lossless || transparent) {
      const png = await encode(canvas, 'image/png');
      if (png.size <= PNG_KEEP_BYTES) return await pack(png, w, h);
    }
    // Photos (and anything too heavy as PNG) → JPEG. It has no alpha and the encoder
    // would paint see-through areas black, so lay white underneath first.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (transparent) {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
        transparent = false;
      }
      for (const q of [0.9, 0.8, 0.7]) {
        const jpg = await encode(canvas, 'image/jpeg', q);
        if (jpg.size <= MAX_BYTES) return await pack(jpg, canvas.width, canvas.height);
      }
      // Still over the byte cap at this size (dense noise-like detail): shrink and go again.
      const smaller = newCanvas(Math.max(1, Math.round(canvas.width * 0.75)), Math.max(1, Math.round(canvas.height * 0.75)));
      ctxOf(smaller).drawImage(canvas, 0, 0, smaller.width, smaller.height);
      freeCanvas(canvas);
      canvas = smaller;
    }
    throw new Error('it could not be compressed enough to send.');
  } finally {
    freeCanvas(canvas);
  }
}

// Final gate. The media type comes from the bytes we are about to store, never from
// what the file or the encoder claimed — so the label and the data cannot disagree.
async function pack(blob: Blob, width: number, height: number): Promise<NormalizedImage> {
  const b64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const url = String(r.result); resolve(url.slice(url.indexOf(',') + 1)); };
    r.onerror = () => reject(new Error('it could not be read from disk.'));
    r.readAsDataURL(blob);
  });
  const mime = sniffBase64(b64);
  if (!mime || !CLAUDE_NATIVE_IMAGE.has(mime)) throw new Error(cantRead(mime || '', !!mime));
  return { dataUrl: `data:${mime};base64,${b64}`, mime, size: blob.size, width, height };
}
