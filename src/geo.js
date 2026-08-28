const R_EARTH = 6371008.8;
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;

export function distanceM(a, b, c, d) {
  const dLat = rad(c - a), dLon = rad(d - b);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

export function bearingDeg(a, b, c, d) {
  const y = Math.sin(rad(d - b)) * Math.cos(rad(c));
  const x =
    Math.cos(rad(a)) * Math.sin(rad(c)) -
    Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const POINTS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
export const compass = (d) => POINTS[Math.round(d / 22.5) % 16];

export function fmtDist(m, metric) {
  if (m == null || !isFinite(m)) return "—";
  if (metric) return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  const ft = m * 3.28084;
  return ft < 1000 ? `${Math.round(ft)} ft` : `${(ft / 5280).toFixed(2)} mi`;
}

/* 39.123456 | 39 04 12.3 | N39°04'12.3" | W095 12 34.5 */
export function parseCoord(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().toUpperCase();
  if (!s) return NaN;
  let sign = 1;
  if (/[SW]/.test(s)) sign = -1;
  s = s.replace(/[NSEW]/g, " ").replace(/[°'"′″]/g, " ").replace(/,/g, " ");
  const nums = s.match(/-?\d+(\.\d+)?/g);
  if (!nums) return NaN;
  if (nums.length === 1) {
    const v = parseFloat(nums[0]);
    return sign < 0 ? -Math.abs(v) : v;
  }
  const d = Math.abs(parseFloat(nums[0]));
  const m = parseFloat(nums[1] || 0);
  const sec = parseFloat(nums[2] || 0);
  const v = d + m / 60 + sec / 3600;
  return sign < 0 || parseFloat(nums[0]) < 0 ? -v : v;
}

export function parseDelimited(text) {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (!t) return [];
  const head = t.slice(0, 2000);
  const delim =
    (head.match(/\t/g) || []).length > (head.match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell.trim());
  rows.push(row);
  return rows.filter((r) => r.some((c) => c !== ""));
}

export function guessColumn(headers, keys) {
  const lower = headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  for (const k of keys) {
    const i = lower.findIndex((h) => h === k);
    if (i >= 0) return i;
  }
  for (const k of keys) {
    const i = lower.findIndex((h) => h.includes(k));
    if (i >= 0) return i;
  }
  return -1;
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ── photos: decode, downscale, hand back a JPEG blob ─────── */
async function loadImage(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file); } catch (e) { /* fall through */ }
  }
  return await new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode failed")); };
    img.src = url;
  });
}

export async function compressToBlob(file, max = 1400, q = 0.72) {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", q)
  );
}
