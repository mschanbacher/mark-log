import "fake-indexeddb/auto";
const db = await import("../src/db.js");
const { distanceM } = await import("../src/geo.js");

// seed a grid of marks around Lawrence, KS
const marks = [];
for (let i = 0; i < 3000; i++) {
  marks.push({
    pid: "KX" + String(i).padStart(4, "0"),
    desig: "MARK " + i,
    lat: 38.95 + (Math.random() - 0.5) * 1.2,
    lon: -95.25 + (Math.random() - 0.5) * 1.2,
    kind: "V",
  });
}
const n = await db.importMarks(marks);
console.log("imported:", n, "meta:", (await db.getMarkMeta()).count);

const lat = 38.95, lon = -95.25, radiusM = 1609.344 * 5;
const dLat = radiusM / 111320;
const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
const { rows } = await db.marksInBox(lat - dLat, lat + dLat, lon - dLon, lon + dLon);
const hits = rows.filter(m => distanceM(lat, lon, m.lat, m.lon) <= radiusM);
// brute force check
const brute = marks.filter(m => distanceM(lat, lon, m.lat, m.lon) <= radiusM);
console.log("cells returned:", rows.length, "in radius:", hits.length, "brute force:", brute.length);
console.log(hits.length === brute.length ? "PASS spatial query" : "FAIL spatial query");

// finds + photos round trip
await db.putFind({ id: "a1", pid: "KX0001", desig: "TIDAL 3", lat, lon, condition: "GOOD", date: "2026-08-25", loggedAt: new Date().toISOString() });
await db.putPhoto({ id: "p1", findId: "a1", blob: new Blob(["x"]) });
console.log("finds:", (await db.getFinds()).length, "photos:", (await db.getPhotos("a1")).length);
await db.deleteFind("a1");
console.log("after delete — finds:", (await db.getFinds()).length, "photos:", (await db.getPhotos("a1")).length);
