import { localDate, suggestMark } from "../src/exif.js";

let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fail++; };

// localDate must use local components, not UTC — an evening photo
// west of UTC would otherwise land on the following day.
const d = new Date(2024, 5, 14, 21, 30);
ok(localDate(d) === "2024-06-14", `localDate evening -> ${localDate(d)}`);
ok(localDate(new Date("nope")) === "", "localDate rejects invalid date");
ok(localDate(null) === "", "localDate rejects null");

const marks = [
  { pid: "KX0001", desig: "TIDAL 3", lat: 38.9500, lon: -95.2500 },
  { pid: "KX0002", desig: "FAR ONE", lat: 38.9600, lon: -95.2500 },
];
const near = suggestMark(38.95002, -95.25001, marks);
ok(near?.mark.pid === "KX0001", "matches the closest mark");
ok(near.dist < 5, `match distance ${near.dist.toFixed(1)} m`);
ok(suggestMark(38.9550, -95.2500, marks) === null, "rejects a match beyond tolerance");
ok(suggestMark(38.95, -95.25, []) === null, "empty mark file yields no match");
ok(suggestMark(NaN, NaN, marks) === null, "bad coordinates yield no match");

process.exit(fail ? 1 : 0);
