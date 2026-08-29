import exifr from "exifr";
import { distanceM } from "./geo.js";

/* ────────────────────────────────────────────────────────────
   EXIF. Read tags off the ORIGINAL File, before the canvas
   re-encode in compressToBlob strips them. Order matters:
   read first, compress second, always.
   ──────────────────────────────────────────────────────────── */

const OPTS = {
  gps: true,
  translateValues: true,
  pick: [
    "GPSLatitude", "GPSLongitude", "GPSAltitude", "GPSImgDirection",
    "GPSImgDirectionRef", "DateTimeOriginal", "CreateDate",
    "Make", "Model", "Orientation",
  ],
};

/* Returns {lat, lon, alt, heading, date, camera, hasGps} — every
   field optional. Never throws; a photo with no tags is normal. */
export async function readExif(file) {
  const out = {
    lat: null, lon: null, alt: null, heading: null,
    date: null, camera: null, hasGps: false, error: null,
  };
  try {
    const gps = await exifr.gps(file).catch(() => null);
    if (gps && isFinite(gps.latitude) && isFinite(gps.longitude)) {
      out.lat = gps.latitude;
      out.lon = gps.longitude;
      out.hasGps = true;
    }
    const tags = await exifr.parse(file, OPTS).catch(() => null);
    if (tags) {
      if (isFinite(tags.GPSAltitude)) out.alt = tags.GPSAltitude;
      if (isFinite(tags.GPSImgDirection)) out.heading = tags.GPSImgDirection;
      const d = tags.DateTimeOriginal || tags.CreateDate;
      if (d instanceof Date && !isNaN(d)) out.date = d;
      else if (typeof d === "string") {
        const parsed = new Date(d.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));
        if (!isNaN(parsed)) out.date = parsed;
      }
      out.camera = [tags.Make, tags.Model].filter(Boolean).join(" ").trim() || null;
    }
  } catch (e) {
    out.error = "unreadable";
  }
  // Fall back to the file's own timestamp when EXIF has no date.
  if (!out.date && file.lastModified) {
    const d = new Date(file.lastModified);
    if (!isNaN(d)) out.date = d;
  }
  return out;
}

/* Local date string (YYYY-MM-DD) — not toISOString, which shifts
   an evening photo to the next day for anyone west of UTC. */
export function localDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* Nearest mark to a photo's coordinates, if it's close enough to
   be plausibly the thing photographed. */
export function suggestMark(lat, lon, marks, toleranceM = 40) {
  if (!isFinite(lat) || !isFinite(lon) || !marks?.length) return null;
  let best = null, bestD = Infinity;
  for (const m of marks) {
    const d = distanceM(lat, lon, m.lat, m.lon);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (!best || bestD > toleranceM) return null;
  return { mark: best, dist: bestD };
}

/* Why a photo has no coordinates — shown to the user verbatim, so
   it has to say what to do, not just what failed. */
export function explainNoGps(file) {
  const name = (file.name || "").toLowerCase();
  if (/\.(heic|heif)$/.test(name))
    return "HEIC photos can't be read in this browser. Open the app in Safari, or export as JPEG.";
  return "No location saved in this photo. Either location was off when it was taken, or it was stripped in transit — sending photos through a messaging app usually removes it.";
}
