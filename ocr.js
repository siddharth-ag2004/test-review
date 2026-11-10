// Photo helpers: load + orient, read the screen text (Tesseract, in-browser, free),
// and suggest a crop that keeps the question and drops the "Solution" part.
const MAX_SIDE = 1600;

export async function loadPhoto(fileOrBlob) {
  // "from-image" applies the phone's EXIF rotation.
  const bmp = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c;
}

export function rotateCanvas(src, deg) {
  const d = ((deg % 360) + 360) % 360;
  const c = document.createElement("canvas");
  const swap = d === 90 || d === 270;
  c.width = swap ? src.height : src.width;
  c.height = swap ? src.width : src.height;
  const x = c.getContext("2d");
  x.translate(c.width / 2, c.height / 2);
  x.rotate((d * Math.PI) / 180);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function canvasToBlob(c, q = 0.86) {
  return new Promise((res) => c.toBlob(res, "image/jpeg", q));
}

/** Crop (fractions) of a canvas, optionally whiting out the "Correct answer" box. */
export function renderCrop(src, crop, answerBox) {
  const sx = Math.round(crop.x * src.width);
  const sy = Math.round(crop.y * src.height);
  const sw = Math.max(1, Math.round(crop.w * src.width));
  const sh = Math.max(1, Math.round(crop.h * src.height));
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  const x = c.getContext("2d");
  x.fillStyle = "#fff";
  x.fillRect(0, 0, sw, sh);
  x.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  if (answerBox) {
    x.fillStyle = "#fff";
    x.fillRect(
      answerBox.x * src.width - sx,
      answerBox.y * src.height - sy,
      answerBox.w * src.width,
      answerBox.h * src.height
    );
  }
  return c;
}

/* ---------------- OCR ---------------- */
let workerP = null;
let chain = Promise.resolve();

function getWorker() {
  if (!workerP) workerP = Tesseract.createWorker("eng");
  return workerP;
}
const PARAMS_PAGE = { tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" };
const PARAMS_HEADER = { tessedit_char_whitelist: "Q0123456789<>", tessedit_pageseg_mode: "11" };
function ocr(canvas, params = PARAMS_PAGE) {
  const job = chain.then(async () => {
    const w = await getWorker();
    await w.setParameters(params);
    const { data } = await w.recognize(canvas);
    const words = data.words || [];
    words.pageConf = data.confidence || 0; // mean confidence: high when upright, low when sideways/upside-down
    return words;
  });
  chain = job.catch(() => {});
  return job;
}
// How "right-way-up" a reading looks: this app's own words count extra, since a sideways photo
// can still produce plenty of plausible words.
const DOMAIN = /^(Solutions?|Enter|answer|below|Correct|Question|Paper|Chemistry|Mathematics|Maths|Physics)$/i;
const readable = (words) =>
  words.filter((w) => w.confidence > 85 && /^[A-Za-z]{4,}$/.test(w.text)).length +
  5 * words.filter((w) => w.confidence > 70 && DOMAIN.test(w.text)).length;

function looksSideways(words) {
  const a = words.filter((w) => /^[A-Za-z]{4,}$/.test(w.text) && w.confidence > 70);
  if (a.length < 4) return false;
  const tall = a.filter((w) => w.bbox.y1 - w.bbox.y0 > 1.2 * (w.bbox.x1 - w.bbox.x0)).length;
  return tall / a.length > 0.5;
}

/** Reads the photo, fixes sideways/upside-down photos, and suggests crop / Q number. */
const score = (p) => (p.words.pageConf || 0) * Math.min(1, p.words.length / 15);

// Tesseract reads sideways pages fine, so confidence alone can't tell upright from sideways.
// Words in an upright page are wider than tall; in a sideways page they are tall.
function uprightness(words) {
  const a = words.filter((w) => /^[A-Za-z]{3,}$/.test(w.text) && w.confidence > 60);
  if (a.length < 3) return 0.5;
  return a.filter((w) => w.bbox.x1 - w.bbox.x0 > w.bbox.y1 - w.bbox.y0).length / a.length;
}
const orient = (p) => score(p) + 40 * uprightness(p.words);

export async function analyze(canvas, { autoRotate = true } = {}) {
  let cur = canvas;
  let best = await readPage(cur);
  if (autoRotate && orient(best) < 115) {
    let bestO = orient(best);
    for (const deg of [180, 90, 270]) {
      const r = rotateCanvas(canvas, deg);
      const p = await readPage(r);
      if (orient(p) > bestO + 8) { best = p; cur = r; bestO = orient(p); }
    }
  }
  const hdr = await readHeader(best.reg);
  const sg = suggest(best.reg, best.words, hdr);

  // Map suggestions (relative to the screen area) back to the whole photo.
  const { rect } = best;
  const W = cur.width, H = cur.height, rw = rect.x1 - rect.x0, rh = rect.y1 - rect.y0;
  const toFull = (b) => b && { x: (rect.x0 + b.x * rw) / W, y: (rect.y0 + b.y * rh) / H, w: (b.w * rw) / W, h: (b.h * rh) / H };
  return { canvas: cur, q: sg.q, foundSolution: sg.foundSolution, crop: clampCrop(toFull(sg.crop)), answerBox: toFull(sg.answerBox) };
}

// Tesseract copes poorly with a busy photo (tablet, case, table). Cut the photo down to the lit
// screen first; this made the difference between reading nothing and reading everything.
async function readPage(canvas) {
  const rect = screenRect(canvas);
  const whole = { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
  const isWhole = rect.x0 === 0 && rect.y0 === 0 && rect.x1 === canvas.width && rect.y1 === canvas.height;
  // Try gentler options first; only fall back to heavier ones when the reading looks poor.
  const plans = [[rect, false], [rect, true], ...(isWhole ? [] : [[whole, false], [whole, true]])];
  let best = null;
  for (const [r, contrast] of plans) {
    const reg = document.createElement("canvas");
    reg.width = r.x1 - r.x0;
    reg.height = r.y1 - r.y0;
    const g = reg.getContext("2d");
    if (contrast) g.filter = "grayscale(1) contrast(2.2)"; // dim/shadowed photos need this
    g.drawImage(canvas, r.x0, r.y0, reg.width, reg.height, 0, 0, reg.width, reg.height);
    g.filter = "none";
    const cand = { rect: r, reg, words: await ocr(reg) };
    if (!best || score(cand) > score(best)) best = cand;
    if (score(best) >= 50) break;
  }
  return best;
}

// The big "< Q 42 >" header is stylised, so the page-wide pass garbles it. Read the centre strip
// on its own with digits only. The number is still only a suggestion (the UI flags it to double-check).
async function readHeader(canvas) {
  const votes = new Map(); // number -> { n: votes, top: y of the "Q" in canvas pixels }
  // Narrow, short bands read most reliably; try a few bands and scales and let them vote.
  for (const [x0, w0, h0] of [[0.2, 0.6, 0.15], [0.2, 0.6, 0.25], [0.25, 0.5, 0.4]]) {
    const sx = Math.round(canvas.width * x0);
    const sw = Math.round(canvas.width * w0);
    const sh = Math.round(canvas.height * h0);
    for (const sc of [1, 1.5, 0.75]) {
      const t = document.createElement("canvas");
      t.width = Math.round(sw * sc);
      t.height = Math.round(sh * sc);
      t.getContext("2d").drawImage(canvas, sx, 0, sw, sh, 0, 0, t.width, t.height);
      for (const w of await ocr(t, PARAMS_HEADER)) {
        const n = parseHeaderToken(w);
        if (n == null) continue;
        const v = votes.get(n) || { n: 0, top: Infinity };
        v.n++;
        v.top = Math.min(v.top, w.bbox.y0 / sc);
        votes.set(n, v);
      }
    }
    if ([...votes.values()].some((v) => v.n >= 3)) break;
  }
  if (!votes.size) return null;
  // A missed digit is more common than an extra one, so "2" and "26" both count toward "26".
  const total = (k) => [...votes.entries()].reduce((t, [o, v]) => t + (String(k).startsWith(String(o)) ? v.n : 0), 0);
  const best = [...votes.entries()].sort((a, b) => total(b[0]) - total(a[0]) || String(b[0]).length - String(a[0]).length)[0];
  return { q: best[0], top: best[1].top };
}

// "<Q26>", "Q40>", "22>" ... The ">" chevron is sometimes read as an extra digit, so use glyph widths
// and the fact that papers have fewer than 100 questions per subject.
function parseHeaderToken(w) {
  if (!/[Q<>]/.test(w.text)) return null;
  const m = /^<?Q?(\d{1,4})>?$/.exec(w.text);
  if (!m) return null;
  let digits = m[1];
  const ds = (w.symbols || []).filter((s) => /\d/.test(s.text));
  if (ds.length >= 2 && ds.length === digits.length) {
    const wd = ds.map((s) => s.bbox.x1 - s.bbox.x0);
    const rest = wd.slice(0, -1).sort((a, b) => a - b);
    if (wd[wd.length - 1] > 1.6 * rest[Math.floor(rest.length / 2)]) digits = digits.slice(0, -1);
  }
  if (digits.length >= 3) digits = digits.slice(0, 2);
  const n = +digits;
  return n > 0 && n <= 200 ? n : null;
}

/** Bounding box of the bright screen, found by walking out from the centre until it goes dark. */
function screenRect(canvas) {
  const W = canvas.width, H = canvas.height;
  const sc = Math.min(1, 300 / W);
  const w = Math.max(8, Math.round(W * sc)), h = Math.max(8, Math.round(H * sc));
  const t = document.createElement("canvas");
  t.width = w; t.height = h;
  const x = t.getContext("2d");
  x.drawImage(canvas, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const lum = (px, py) => { const i = (py * w + px) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  const DARK = 110;
  const colMean = (px) => { let s = 0, n = 0; for (let py = Math.round(h * 0.25); py < h * 0.75; py++) { s += lum(px, py); n++; } return s / n; };
  let l = 0, r = w - 1;
  for (let px = w >> 1; px >= 0; px--) if (colMean(px) < DARK) { l = px + 1; break; }
  for (let px = w >> 1; px < w; px++) if (colMean(px) < DARK) { r = px - 1; break; }
  const rowMean = (py) => { let s = 0, n = 0; for (let px = l; px <= r; px++) { s += lum(px, py); n++; } return s / Math.max(1, n); };
  let t0 = 0, b0 = h - 1;
  for (let py = h >> 1; py >= 0; py--) if (rowMean(py) < DARK) { t0 = py + 1; break; }
  for (let py = h >> 1; py < h; py++) if (rowMean(py) < DARK) { b0 = py - 1; break; }
  const inset = 3;
  const rect = {
    x0: Math.round(l / sc) + inset, x1: Math.round((r + 1) / sc) - inset,
    y0: Math.round(t0 / sc) + inset, y1: Math.round((b0 + 1) / sc) - inset,
  };
  rect.x0 = Math.max(0, rect.x0); rect.y0 = Math.max(0, rect.y0);
  rect.x1 = Math.min(W, rect.x1); rect.y1 = Math.min(H, rect.y1);
  // If something looks off (tiny area), fall back to the whole photo.
  if (rect.x1 - rect.x0 < W * 0.3 || rect.y1 - rect.y0 < H * 0.3) return { x0: 0, y0: 0, x1: W, y1: H };
  return rect;
}

// Everything below works in the coordinates of the screen area ("canvas" here).
function suggest(canvas, words, hdr) {
  const W = canvas.width;
  const H = canvas.height;
  const box = (w) => w.bbox;
  const sameLine = (a, b) => Math.abs((box(a).y0 + box(a).y1) / 2 - (box(b).y0 + box(b).y1) / 2) < H * 0.015;
  const ws = [...words].sort((a, b) => box(a).y0 - box(b).y0 || box(a).x0 - box(b).x0);

  // "Q 48" header (may be read as "Q" "48" or "Q48")
  let q = hdr ? hdr.q : null;
  let qTop = hdr ? hdr.top : null;
  for (let i = 0; i < ws.length && q == null; i++) {
    const t = ws[i].text;
    if (box(ws[i]).y0 > H * 0.5) break;
    const one = /^Q\.?(\d{1,3})$/i.exec(t);
    if (one) { q = +one[1]; qTop = box(ws[i]).y0; break; }
    if (/^Q$/i.test(t)) {
      const nxt = ws.find((w, j) => j !== i && /^\d{1,3}$/.test(w.text) && sameLine(ws[i], w) && box(w).x0 > box(ws[i]).x1 - 5 && box(w).x0 - box(ws[i]).x1 < W * 0.1);
      if (nxt) { q = +nxt.text; qTop = Math.min(box(ws[i]).y0, box(nxt).y0); break; }
    }
  }

  // The "Solution" label that starts the answer explanation (sits at the left edge).
  const minY = qTop != null ? qTop + H * 0.03 : H * 0.2;
  const sol = ws.find((w) => /^s[o0][l1i][uv]t[i1l][o0]n:?$/i.test(w.text) && box(w).y0 > minY && box(w).x0 < W * 0.35);

  // "Correct answer : 1885" line (optional hide, and a fallback cut-off)
  let answerBox = null;
  const ca = ws.find((w, i) => /^Correct$/i.test(w.text) && box(w).y0 > minY && ws.slice(i + 1, i + 3).some((n) => /^answers?:?$/i.test(n.text)));
  if (ca) {
    const line = ws.filter((w) => sameLine(ca, w) && box(w).x0 >= box(ca).x0 - 3);
    const x1 = Math.max(...line.map((w) => box(w).x1));
    const y0 = Math.min(...line.map((w) => box(w).y0));
    const y1 = Math.max(...line.map((w) => box(w).y1));
    const pad = H * 0.004;
    answerBox = { x: (box(ca).x0 - pad) / W, y: (y0 - pad) / H, w: (x1 - box(ca).x0 + pad * 2) / W, h: (y1 - y0 + pad * 2) / H };
  }

  const top = qTop != null ? Math.max(0, qTop - H * 0.012) : 0;
  let bottom = H;
  if (sol) bottom = Math.max(top + H * 0.05, box(sol).y0 - H * 0.008);
  else if (answerBox) bottom = Math.min(H, (answerBox.y + answerBox.h) * H + H * 0.012);

  const crop = { x: 0, y: top / H, w: 1, h: Math.max(0.02, (bottom - top) / H) };
  return { q, crop, answerBox, foundSolution: !!(sol || answerBox) };
}

export function clampCrop(c) {
  const x = Math.min(Math.max(c.x, 0), 0.98);
  const y = Math.min(Math.max(c.y, 0), 0.98);
  return { x, y, w: Math.min(Math.max(c.w, 0.02), 1 - x), h: Math.min(Math.max(c.h, 0.02), 1 - y) };
}
export const _debug = { readPage, readHeader, screenRect, readable, ocr, PARAMS_HEADER };
