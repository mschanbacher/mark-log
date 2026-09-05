/* ────────────────────────────────────────────────────────────
   NGS Datasheets feature service.

   NOAA publishes the whole datasheet database as a public ArcGIS
   feature layer, refreshed weekly, no key and no auth. That means
   the app can pull marks for whatever area you're looking at
   instead of making you export a CSV by hand.

   https://services2.arcgis.com/C8EMgrsFcRFL6LrL/ArcGIS/rest/
     services/NGS_Datasheets_Feature_Service/FeatureServer/1

   The service caps a single response at 2000 features, so this
   pages with resultOffset until a short page comes back.
   ──────────────────────────────────────────────────────────── */

const ENDPOINT =
  "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/ArcGIS/rest/services/" +
  "NGS_Datasheets_Feature_Service/FeatureServer/1/query";

const PAGE = 2000;

const FIELDS = [
  "PID", "NAME", "DEC_LAT", "DEC_LON", "ORTHO_HT", "STAMPING",
  "MARKER", "SETTING", "LAST_COND", "LAST_RECV", "SYMBOL", "STATE", "COUNTY",
  "POS_SRCE", "N_ACC_HZ",
].join(",");

/* SYMBOL is four characters: vertical order then horizontal order,
   'v1h2', '--h1', 'v2--'. A leading 'v' means it carries a published
   elevation, which is what the circle glyph means elsewhere. */
/* How far off the published position might be, in metres.

   NGS states these on the datasheet itself rather than leaving them
   to inference:
     scaled from a topographic map   ±6 arc-seconds, printed as ±180 m
     autonomous hand-held GPS        ±10 m
     differentially corrected GPS    ±3 m
     adjusted                        centimetres, carried in N_ACC_HZ

   Returns null when the source is unrecognised — an unknown radius
   must not be drawn as a confident one. */
export function accuracyRadiusM(posSrce, accHz) {
  const src = (posSrce || "").toUpperCase();
  const n = parseFloat(accHz);
  if (/SCALE/.test(src)) return 180;
  if (/HELD2/.test(src)) return 3;
  if (/HELD1|HAND/.test(src)) return 10;
  if (/ADJUST|CLASSIC|GPS|GEOD|VLBI/.test(src)) {
    // N_ACC_HZ is published in centimetres. Anything implying more
    // than 50 m on an adjusted mark is a bad value, not a wide one.
    if (isFinite(n) && n > 0) {
      const m = n / 100;
      return m > 50 ? 1 : Math.max(m, 0.05);
    }
    return 1;
  }
  if (isFinite(n) && n > 0) return Math.min(n / 100, 50);
  return null;
}

/* Three states, because a small glyph carries about three.

   'unknown' means nobody has reported on it lately — which is not
   evidence the mark is gone, only that nobody has looked. That is
   the hunting ground, and the legend says so. */
export function conditionClass(lastCond, lastRecv, now = new Date()) {
  const c = (lastCond || "").toUpperCase();
  if (/DESTROY|NOT FOUND/.test(c)) return "gone";
  const yr = parseInt(String(lastRecv || "").slice(0, 4), 10);
  const age = isFinite(yr) && yr > 1800 ? now.getFullYear() - yr : null;
  if (/GOOD/.test(c) && age !== null && age <= 30) return "good";
  return "unknown";
}

export function recoveryYear(lastRecv) {
  const yr = parseInt(String(lastRecv || "").slice(0, 4), 10);
  return isFinite(yr) && yr > 1800 ? yr : null;
}

function kindFromSymbol(sym) {
  return typeof sym === "string" && sym.startsWith("v") ? "V" : "H";
}

function toMark(feature) {
  const a = feature.attributes || feature.properties || {};
  let lon, lat;
  const g = feature.geometry;
  if (g && Array.isArray(g.coordinates)) {
    [lon, lat] = g.coordinates;
  } else if (g && isFinite(g.x) && isFinite(g.y)) {
    lon = g.x; lat = g.y;
  } else {
    lat = parseFloat(a.DEC_LAT);
    lon = parseFloat(a.DEC_LON);
  }
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    pid: (a.PID || "").trim().toUpperCase(),
    desig: (a.NAME || "").trim(),
    lat, lon,
    elev: (a.ORTHO_HT || "").trim(),
    stamping: (a.STAMPING || "").trim(),
    marker: (a.MARKER || "").trim(),
    setting: (a.SETTING || "").trim(),
    lastCond: (a.LAST_COND || "").trim(),
    lastRecv: (a.LAST_RECV || "").trim(),
    posSrce: (a.POS_SRCE || "").trim(),
    accHz: (a.N_ACC_HZ || "").trim(),
    accM: accuracyRadiusM(a.POS_SRCE, a.N_ACC_HZ),
    kind: kindFromSymbol(a.SYMBOL),
  };
}

/* Rough area of a bounding box in square miles — used to stop
   someone accidentally asking for a whole state over cell data. */
export function bboxAreaSqMi({ minLat, maxLat, minLon, maxLon }) {
  const midLat = (minLat + maxLat) / 2;
  const h = (maxLat - minLat) * 69.0;
  const w = (maxLon - minLon) * 69.0 * Math.cos((midLat * Math.PI) / 180);
  return Math.abs(h * w);
}

export async function fetchMarksInBbox(box, opts = {}) {
  const { onProgress, signal, max = 10000 } = opts;
  const { minLat, maxLat, minLon, maxLon } = box;
  const out = [];
  let offset = 0;

  for (;;) {
    const params = new URLSearchParams({
      f: "geojson",
      where: "1=1",
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: FIELDS,
      returnGeometry: "true",
      resultRecordCount: String(PAGE),
      resultOffset: String(offset),
    });

    let res;
    try {
      res = await fetch(`${ENDPOINT}?${params}`, { signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Couldn't reach the NGS service. Check your connection.");
    }
    if (!res.ok) throw new Error(`NGS service returned ${res.status}.`);

    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "NGS service error.");

    const feats = json.features || [];
    for (const f of feats) {
      const m = toMark(f);
      if (m) out.push(m);
    }
    if (onProgress) onProgress(out.length);

    if (feats.length < PAGE) break;
    offset += PAGE;
    if (out.length >= max) break;
  }

  /* One PID can come back twice across page boundaries. */
  const seen = new Set();
  return out.filter((m) => {
    if (!m.pid) return true;
    if (seen.has(m.pid)) return false;
    seen.add(m.pid);
    return true;
  });
}
