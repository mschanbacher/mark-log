import { fetchMarksInBbox, bboxAreaSqMi } from "../src/ngs.js";

let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fail++; };

const feat = (pid, lon, lat, sym = "v1--") => ({
  geometry: { coordinates: [lon, lat] },
  properties: { PID: pid, NAME: "MARK " + pid, SYMBOL: sym, ORTHO_HT: "271.4" },
});

// Paging: a full 2000 page must trigger a second request; a short page stops.
let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const offset = Number(new URL(url).searchParams.get("resultOffset"));
  const n = offset === 0 ? 2000 : 3;
  const features = Array.from({ length: n }, (_, i) =>
    feat("K" + (offset + i), -95.25, 38.95));
  return { ok: true, json: async () => ({ features }) };
};
let marks = await fetchMarksInBbox({ minLat: 38.9, maxLat: 39, minLon: -95.3, maxLon: -95.2 });
ok(calls === 2, `pages until a short page (${calls} requests)`);
ok(marks.length === 2003, `collected ${marks.length} marks`);

// Duplicate PIDs across page boundaries collapse.
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ features: [feat("KX1", -95.25, 38.95), feat("KX1", -95.25, 38.95)] }),
});
marks = await fetchMarksInBbox({ minLat: 38.9, maxLat: 39, minLon: -95.3, maxLon: -95.2 });
ok(marks.length === 1, "deduplicates repeated PIDs");
ok(marks[0].kind === "V", "SYMBOL v1-- reads as vertical control");
ok(marks[0].elev === "271.4", "carries the orthometric height");

// Horizontal-only station.
globalThis.fetch = async () => ({
  ok: true, json: async () => ({ features: [feat("KX2", -95.25, 38.95, "--h1")] }),
});
marks = await fetchMarksInBbox({ minLat: 38.9, maxLat: 39, minLon: -95.3, maxLon: -95.2 });
ok(marks[0].kind === "H", "SYMBOL --h1 reads as horizontal control");

// Garbage geometry is dropped, not stored as NaN.
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ features: [{ geometry: null, properties: { PID: "BAD" } }] }),
});
marks = await fetchMarksInBbox({ minLat: 38.9, maxLat: 39, minLon: -95.3, maxLon: -95.2 });
ok(marks.length === 0, "drops features with no usable coordinates");

// Service-level errors surface as thrown messages, not silent empties.
globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: { message: "Invalid URL" } }) });
try {
  await fetchMarksInBbox({ minLat: 38.9, maxLat: 39, minLon: -95.3, maxLon: -95.2 });
  ok(false, "throws on a service error payload");
} catch (e) { ok(e.message === "Invalid URL", "throws on a service error payload"); }

globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
try {
  await fetchMarksInBbox({ minLat: 38.9, maxLat: 39, minLon: -95.3, maxLon: -95.2 });
  ok(false, "throws on HTTP failure");
} catch (e) { ok(/503/.test(e.message), "throws on HTTP failure"); }

// Area guard: one degree square near 39°N is roughly 3,700 sq mi.
const a = bboxAreaSqMi({ minLat: 38.5, maxLat: 39.5, minLon: -95.5, maxLon: -94.5 });
ok(a > 3000 && a < 4200, `degree-square area ≈ ${Math.round(a)} sq mi`);



// ── accuracy radius ─────────────────────────────────────────
const { accuracyRadiusM, conditionClass, recoveryYear } =
  await import("../src/ngs.js");

ok(accuracyRadiusM("SCALED", "") === 180, "scaled positions get the published 180 m");
ok(accuracyRadiusM("SCALED FROM TOPO", "5") === 180, "scaled wins over any N_ACC_HZ");
ok(accuracyRadiusM("HD_HELD2", "") === 3, "differentially corrected handheld = 3 m");
ok(accuracyRadiusM("HD_HELD1", "") === 10, "autonomous handheld = 10 m");
ok(accuracyRadiusM("ADJUSTED", "90") === 0.9, "adjusted reads N_ACC_HZ as centimetres");
ok(accuracyRadiusM("ADJUSTED", "") === 1, "adjusted with no figure falls back to 1 m");
ok(accuracyRadiusM("ADJUSTED", "999999") === 1, "absurd N_ACC_HZ is rejected, not drawn");
ok(accuracyRadiusM("", "") === null, "unknown source returns null, never a fake radius");
ok(accuracyRadiusM("NO CHECK", "") === null, "NO CHECK is treated as unknown");

// ── condition classes ───────────────────────────────────────
const now = new Date(2026, 0, 1);
ok(conditionClass("GOOD", "20200612", now) === "good", "recent good report");
ok(conditionClass("GOOD", "19780612", now) === "unknown", "a 1978 report is not current evidence");
ok(conditionClass("DESTROYED", "19900101", now) === "gone", "destroyed reads as gone");
ok(conditionClass("MARK NOT FOUND", "20150101", now) === "gone", "not found reads as gone");
ok(conditionClass("", "", now) === "unknown", "no report at all is unknown");
ok(conditionClass("POOR", "20240101", now) === "unknown", "poor is not promoted to good");
ok(recoveryYear("20120415") === 2012, "recovery year parses from YYYYMMDD");
ok(recoveryYear("") === null, "blank recovery date yields null");

process.exit(fail ? 1 : 0);
