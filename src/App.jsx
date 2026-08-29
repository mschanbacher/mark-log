import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import * as db from "./db.js";
import {
  distanceM, bearingDeg, compass, fmtDist, rad,
  parseCoord, parseDelimited, guessColumn, uid, compressToBlob,
} from "./geo.js";
import { readExif, localDate, suggestMark, explainNoGps } from "./exif.js";

/* ── condition vocabulary (NGS recovery codes) ───────────── */
const CONDITIONS = [
  { code: "GOOD", label: "Good", color: "var(--patina)" },
  { code: "POOR", label: "Poor", color: "var(--brass)" },
  { code: "NOT FOUND", label: "Not found", color: "var(--rule-dk)" },
  { code: "DESTROYED", label: "Destroyed", color: "var(--alert)" },
];
const condColor = (c) => (CONDITIONS.find((x) => x.code === c) || CONDITIONS[0]).color;

/* ── plot symbols: circle = vertical, triangle = horizontal ─ */
function MarkGlyph({ x, y, kind, found, r = 5, onClick, active }) {
  const fill = found ? "var(--revision)" : "none";
  const stroke = found ? "var(--revision)" : "var(--contour)";
  return (
    <g onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      {active && <circle cx={x} cy={y} r={r + 6} fill="none" stroke="var(--water)" strokeWidth="1.5" />}
      {kind === "H" ? (
        <polygon points={`${x},${y - r - 1} ${x + r + 1},${y + r} ${x - r - 1},${y + r}`}
          fill={fill} stroke={stroke} strokeWidth="1.6" />
      ) : (
        <circle cx={x} cy={y} r={r} fill={fill} stroke={stroke} strokeWidth="1.6" />
      )}
      <circle cx={x} cy={y} r={r + 9} fill="transparent" />
    </g>
  );
}

function PlanePlot({ items, radiusM, metric, selectedId, onSelect }) {
  const SZ = 300, C = 150, RPX = 122;
  const rings = [1 / 3, 2 / 3, 1];
  return (
    <svg viewBox={`0 0 ${SZ} ${SZ}`} className="plot" role="img"
      aria-label="Plan view of nearby marks, north up">
      {rings.map((f, i) => (
        <circle key={i} cx={C} cy={C} r={RPX * f} fill="none" stroke="var(--rule)"
          strokeWidth="1" strokeDasharray={f === 1 ? "none" : "3 4"} />
      ))}
      <line x1={C} y1={C - RPX - 8} x2={C} y2={C + RPX + 8} stroke="var(--rule)" strokeWidth="0.75" />
      <line x1={C - RPX - 8} y1={C} x2={C + RPX + 8} y2={C} stroke="var(--rule)" strokeWidth="0.75" />
      <text x={C} y={16} className="plot-lbl" textAnchor="middle">N</text>
      {rings.map((f, i) => (
        <text key={i} x={C + 3} y={C - RPX * f + 11} className="plot-tick">
          {fmtDist(radiusM * f, metric)}
        </text>
      ))}
      <circle cx={C} cy={C} r={4} fill="var(--water)" />
      <circle cx={C} cy={C} r={9} fill="none" stroke="var(--water)" strokeWidth="1" opacity="0.5" />
      {items.map((m) => {
        const f = Math.min(m.dist / radiusM, 1);
        const x = C + Math.sin(rad(m.brg)) * RPX * f;
        const y = C - Math.cos(rad(m.brg)) * RPX * f;
        return (
          <MarkGlyph key={m.key} x={x} y={y} kind={m.kind} found={m.found}
            active={selectedId === m.key} onClick={() => onSelect(m.key)} />
        );
      })}
    </svg>
  );
}

const Field = ({ label, hint, children }) => (
  <label className="field">
    <span className="field-lbl">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

function Disk({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="var(--brass)" strokeWidth="2" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="var(--brass)" strokeWidth="1" />
      <path d="M16 7v18M7 16h18" stroke="var(--brass)" strokeWidth="1" />
      <circle cx="16" cy="16" r="2" fill="var(--brass)" />
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════ */
export default function App() {
  const [view, setView] = useState("nearby");
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [finds, setFinds] = useState([]);
  const [markMeta, setMarkMeta] = useState(null);
  const [pos, setPos] = useState(null);
  const [locState, setLocState] = useState("idle");
  const [locMsg, setLocMsg] = useState("");
  const [metric, setMetric] = useState(false);
  const [radiusMi, setRadiusMi] = useState(1);
  const [draft, setDraft] = useState(null);
  const [toast, setToast] = useState("");
  const [boxMarks, setBoxMarks] = useState([]);

  const flash = useCallback((m) => {
    setToast(m);
    setTimeout(() => setToast(""), 2800);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await db.openDb();
        setFinds(await db.getFinds());
        setMarkMeta(await db.getMarkMeta());
        db.persist();
      } catch (e) {
        setFatal("This browser is blocking local storage. Private browsing usually causes it — open the app in a normal window.");
      }
      setReady(true);
    })();
  }, []);

  const refreshFinds = useCallback(async () => setFinds(await db.getFinds()), []);

  /* location */
  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setLocState("blocked");
      setLocMsg("This browser doesn't offer location. Enter coordinates below.");
      return;
    }
    setLocState("locating");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, manual: false });
        setLocState("ok");
      },
      (e) => {
        setLocState("blocked");
        setLocMsg(
          e.code === 1
            ? "Location permission was denied. Allow it in your browser settings, or enter coordinates below."
            : "Location is unavailable right now. Enter coordinates below."
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }
    );
  }, []);

  /* pull the covering cells whenever position or radius moves */
  const radiusM = radiusMi * 1609.344;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pos) { setBoxMarks([]); return; }
      const dLat = radiusM / 111320;
      const dLon = radiusM / (111320 * Math.max(0.1, Math.cos(rad(pos.lat))));
      try {
        const { rows } = await db.marksInBox(
          pos.lat - dLat, pos.lat + dLat, pos.lon - dLon, pos.lon + dLon
        );
        if (!cancelled) setBoxMarks(rows);
      } catch (e) {
        if (!cancelled) setBoxMarks([]);
      }
    })();
    return () => { cancelled = true; };
  }, [pos, radiusM, markMeta]);

  const nearby = useMemo(() => {
    if (!pos) return [];
    const foundByPid = new Map();
    finds.forEach((f) => { if (f.pid) foundByPid.set(f.pid.toUpperCase(), f); });
    const out = [], seen = new Set();
    for (const m of boxMarks) {
      const d = distanceM(pos.lat, pos.lon, m.lat, m.lon);
      if (d > radiusM) continue;
      const pid = (m.pid || "").toUpperCase();
      const hit = pid ? foundByPid.get(pid) : null;
      if (pid) seen.add(pid);
      out.push({
        key: "m:" + (pid || `${m.lat},${m.lon}`), pid: m.pid, desig: m.desig,
        lat: m.lat, lon: m.lon, elev: m.elev, kind: m.kind || "V", dist: d,
        brg: bearingDeg(pos.lat, pos.lon, m.lat, m.lon),
        found: !!hit, find: hit || null,
      });
    }
    for (const f of finds) {
      const pid = (f.pid || "").toUpperCase();
      if (pid && seen.has(pid)) continue;
      if (!isFinite(f.lat) || !isFinite(f.lon)) continue;
      const d = distanceM(pos.lat, pos.lon, f.lat, f.lon);
      if (d > radiusM) continue;
      out.push({
        key: "f:" + f.id, pid: f.pid, desig: f.desig, lat: f.lat, lon: f.lon,
        elev: f.elev, kind: f.kind || "V", dist: d,
        brg: bearingDeg(pos.lat, pos.lon, f.lat, f.lon), found: true, find: f,
      });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }, [pos, boxMarks, finds, radiusM]);

  const startLog = (seed) => { setDraft(seed || {}); setView("log"); };

  if (!ready) return <div className="app"><div className="boot">Opening the log…</div></div>;
  if (fatal) return <div className="app"><div className="boot">{fatal}</div></div>;

  return (
    <div className="app">
      <header className="hd">
        <div className="hd-mark"><Disk /></div>
        <div className="hd-txt">
          <h1>Mark Recovery Log</h1>
          <p>{finds.length} recovered · {markMeta ? markMeta.count.toLocaleString() : 0} on file</p>
        </div>
        <button className="unit" onClick={() => setMetric(!metric)}>
          {metric ? "m/km" : "ft/mi"}
        </button>
      </header>

      <main className="body">
        {view === "nearby" && (
          <NearbyView pos={pos} setPos={setPos} locate={locate} locState={locState}
            locMsg={locMsg} nearby={nearby} radiusMi={radiusMi} setRadiusMi={setRadiusMi}
            radiusM={radiusM} metric={metric} onLog={startLog}
            hasDb={!!markMeta?.count} goData={() => setView("data")} />
        )}
        {view === "log" && (
          <LogView draft={draft} setDraft={setDraft} pos={pos}
            refresh={refreshFinds} flash={flash} done={() => setView("finds")} />
        )}
        {view === "finds" && (
          <FindsView finds={finds} refresh={refreshFinds} onEdit={(f) => startLog(f)} flash={flash} />
        )}
        {view === "data" && (
          <DataView markMeta={markMeta} setMarkMeta={setMarkMeta} finds={finds} flash={flash} />
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}

      <nav className="nav">
        {[["nearby", "Nearby"], ["log", "Log a find"], ["finds", "My finds"], ["data", "Mark file"]]
          .map(([k, l]) => (
            <button key={k} className={view === k ? "nav-b on" : "nav-b"}
              onClick={() => { if (k === "log" && view !== "log") setDraft(null); setView(k); }}>
              {l}
            </button>
          ))}
      </nav>
    </div>
  );
}

/* ═══ NEARBY ═══════════════════════════════════════════════ */
function NearbyView({ pos, setPos, locate, locState, locMsg, nearby, radiusMi,
  setRadiusMi, radiusM, metric, onLog, hasDb, goData }) {
  const [sel, setSel] = useState(null);
  const [mLat, setMLat] = useState("");
  const [mLon, setMLon] = useState("");

  const applyManual = () => {
    const la = parseCoord(mLat), lo = parseCoord(mLon);
    if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return;
    setPos({ lat: la, lon: lo, acc: null, manual: true });
  };

  return (
    <section>
      <div className="pos-bar">
        <button className="btn primary" onClick={locate}>
          {locState === "locating" ? "Locating…" : pos ? "Update position" : "Use my location"}
        </button>
        {pos && (
          <div className="pos-read">
            <span className="mono">{pos.lat.toFixed(5)}, {pos.lon.toFixed(5)}</span>
            <span className="pos-acc">
              {pos.manual ? "entered by hand" : pos.acc ? `±${Math.round(pos.acc)} m` : ""}
            </span>
          </div>
        )}
      </div>

      {locState === "blocked" && <p className="note">{locMsg}</p>}

      {(!pos || locState === "blocked") && (
        <div className="manual">
          <div className="row2">
            <Field label="Latitude">
              <input className="in mono" placeholder="39.12345" value={mLat}
                onChange={(e) => setMLat(e.target.value)} /></Field>
            <Field label="Longitude">
              <input className="in mono" placeholder="-95.20876" value={mLon}
                onChange={(e) => setMLon(e.target.value)} /></Field>
          </div>
          <button className="btn" onClick={applyManual}>Set position</button>
          <p className="field-hint">Decimal degrees or 39 04 12.3 both work.</p>
        </div>
      )}

      {pos && (
        <>
          <div className="radius">
            {[0.25, 1, 5, 25].map((r) => (
              <button key={r} className={radiusMi === r ? "chip on" : "chip"}
                onClick={() => setRadiusMi(r)}>
                {metric ? fmtDist(r * 1609.344, true) : r < 1 ? `${Math.round(r * 5280)} ft` : `${r} mi`}
              </button>
            ))}
          </div>

          <PlanePlot items={nearby.slice(0, 120)} radiusM={radiusM} metric={metric}
            selectedId={sel} onSelect={setSel} />

          <div className="legend">
            <span><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--contour)" strokeWidth="1.6" /></svg> vertical control</span>
            <span><svg width="14" height="14" viewBox="0 0 14 14"><polygon points="7,1 13,12 1,12" fill="none" stroke="var(--contour)" strokeWidth="1.6" /></svg> horizontal control</span>
            <span><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--revision)" /></svg> recovered by you</span>
          </div>

          <h2 className="sec">
            Within {metric ? fmtDist(radiusM, true) : radiusMi < 1 ? `${Math.round(radiusMi * 5280)} ft` : `${radiusMi} mi`}
            <span className="sec-n">{nearby.length}</span>
          </h2>

          {nearby.length === 0 && (
            <p className="empty">
              Nothing on file inside this radius.{" "}
              {hasDb ? "Try a wider radius, or log a mark you're standing on." : (
                <>Import a mark list in <button className="link" onClick={goData}>Mark file</button> to see marks you haven't found yet.</>
              )}
            </p>
          )}

          <ul className="list">
            {nearby.slice(0, 200).map((m) => (
              <li key={m.key} className={sel === m.key ? "card sel" : "card"}
                onClick={() => setSel(sel === m.key ? null : m.key)}>
                <div className="card-hd">
                  <div>
                    <div className="desig">{m.desig || m.pid || "unnamed mark"}</div>
                    <div className="pid mono">{m.pid || "no PID"}</div>
                  </div>
                  <div className="dist">
                    <b>{fmtDist(m.dist, metric)}</b>
                    <span className="mono">{compass(m.brg)} {Math.round(m.brg)}°</span>
                  </div>
                </div>
                {m.found && (
                  <div className="flag">
                    Recovered {m.find?.date || ""}{m.find?.condition ? ` · ${m.find.condition}` : ""}
                  </div>
                )}
                {sel === m.key && (
                  <div className="card-body">
                    <div className="mono coord">{m.lat.toFixed(6)}, {m.lon.toFixed(6)}</div>
                    {m.elev && <div className="mono coord">elev {m.elev}</div>}
                    <div className="card-acts">
                      <button className="btn sm" onClick={(e) => {
                        e.stopPropagation();
                        onLog({ pid: m.pid, desig: m.desig, lat: m.lat, lon: m.lon, kind: m.kind, elev: m.elev });
                      }}>{m.found ? "Log another visit" : "Log this find"}</button>
                      <a className="btn sm ghost" onClick={(e) => e.stopPropagation()}
                        href={`https://www.google.com/maps/search/?api=1&query=${m.lat},${m.lon}`}
                        target="_blank" rel="noreferrer">Navigate</a>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/* ═══ LOG — single entry, or a bulk backfill from old photos ══ */
function LogView(props) {
  const seeded = !!(props.draft && Object.keys(props.draft).length);
  const [mode, setMode] = useState("single");
  const active = seeded ? "single" : mode;
  return (
    <section>
      {!seeded && (
        <div className="modes">
          <button className={active === "single" ? "cchip on" : "cchip"}
            onClick={() => setMode("single")}>One find</button>
          <button className={active === "bulk" ? "cchip on" : "cchip"}
            onClick={() => setMode("bulk")}>From old photos</button>
        </div>
      )}
      {active === "single"
        ? <SingleLog {...props} />
        : <PhotoImport pos={props.pos} refresh={props.refresh}
            flash={props.flash} done={props.done} />}
    </section>
  );
}

/* ═══ PHOTO BACKFILL ═══════════════════════════════════════
   Reads GPS and capture date out of photos you already took,
   matches each against the mark file, and turns a batch into
   entries in one pass.
   ─────────────────────────────────────────────────────────── */
function PhotoImport({ pos, refresh, flash, done }) {
  const [rows, setRows] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const urls = useRef([]);
  const fileRef = useRef(null);

  useEffect(() => () => { urls.current.forEach(URL.revokeObjectURL); }, []);

  const pick = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    setWarnings([]);
    const warn = new Set();
    const drafts = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setProg(`${i + 1} of ${files.length}`);
      const ex = await readExif(f);          // original file, tags intact
      let blob;
      try {
        blob = await compressToBlob(f);       // canvas re-encode, tags gone
      } catch (err) {
        warn.add(explainNoGps(f));
        continue;
      }
      const url = URL.createObjectURL(blob);
      urls.current.push(url);

      let sugg = null;
      if (ex.hasGps) {
        const dLat = 150 / 111320;
        const dLon = 150 / (111320 * Math.max(0.1, Math.cos(rad(ex.lat))));
        try {
          const { rows: near } = await db.marksInBox(
            ex.lat - dLat, ex.lat + dLat, ex.lon - dLon, ex.lon + dLon);
          sugg = suggestMark(ex.lat, ex.lon, near);
        } catch (err) { /* no mark file loaded is fine */ }
      } else {
        warn.add(explainNoGps(f));
      }
      drafts.push({ photo: { id: uid(), blob, url }, ex, sugg, name: f.name });
      await new Promise((r) => setTimeout(r, 0));
    }

    /* Several photos of the same disk collapse into one entry. */
    const groups = new Map();
    for (const d of drafts) {
      const key = d.sugg?.mark?.pid ? `pid:${d.sugg.mark.pid}` : `solo:${d.photo.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }

    const out = [];
    for (const [key, items] of groups) {
      const withGps = items.find((i) => i.ex.hasGps);
      const dated = items.map((i) => i.ex.date).filter(Boolean).sort((a, b) => a - b)[0];
      const m = items[0].sugg;
      out.push({
        key,
        photos: items.map((i) => i.photo),
        lat: withGps ? withGps.ex.lat.toFixed(6) : "",
        lon: withGps ? withGps.ex.lon.toFixed(6) : "",
        date: dated ? localDate(dated) : "",
        pid: m?.mark?.pid || "",
        desig: m?.mark?.desig || "",
        kind: m?.mark?.kind || "V",
        condition: "GOOD",
        notes: "",
        matchDist: m ? m.dist : null,
        fileNames: items.map((i) => i.name),
      });
    }

    setRows((prev) => [...prev, ...out]);
    setWarnings([...warn]);
    setBusy(false);
    setProg("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const edit = (key, patch) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const drop = (key) => setRows((rs) => rs.filter((r) => r.key !== key));

  const ready = rows.filter(
    (r) => isFinite(parseCoord(r.lat)) && isFinite(parseCoord(r.lon)) && (r.pid || r.desig));
  const blocked = rows.length - ready.length;

  const saveAll = async () => {
    if (!ready.length) { flash("Nothing ready to save — each entry needs coordinates and a name."); return; }
    setBusy(true);
    let n = 0;
    try {
      for (const r of ready) {
        const id = uid();
        for (const p of r.photos) await db.putPhoto({ id: p.id, findId: id, blob: p.blob });
        await db.putFind({
          id, pid: r.pid.trim().toUpperCase(), desig: r.desig.trim(), stamping: "",
          kind: r.kind, lat: parseCoord(r.lat), lon: parseCoord(r.lon), elev: "",
          condition: r.condition, notes: r.notes.trim(),
          date: r.date || localDate(new Date()),
          photoCount: r.photos.length,
          loggedAt: new Date().toISOString(),
        });
        n++;
      }
      await refresh();
      flash(`${n} ${n === 1 ? "entry" : "entries"} added.`);
      setRows([]);
      done();
    } catch (e) {
      flash(`Saved ${n} before running out of room. Delete some photos and retry the rest.`);
    }
    setBusy(false);
  };

  return (
    <>
      <h2 className="sec">Backfill from photos</h2>
      <p className="note">
        Pick photos you already took of marks. Coordinates and capture date come out
        of the photo itself, and anything within 40 m of a mark in your file gets
        matched automatically. Choose them from your photo library — sending photos
        through a messaging app strips the location first.
      </p>

      <label className="btn as-label primary">
        {busy ? `Reading ${prog}…` : "Choose photos"}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden
          onChange={pick} disabled={busy} />
      </label>

      {warnings.map((w, i) => <p className="note" key={i}>{w}</p>)}

      {rows.length > 0 && (
        <>
          <h2 className="sec">Review<span className="sec-n">{rows.length}</span></h2>
          {rows.map((r) => (
            <div className="card imp" key={r.key}>
              <div className="imp-strip">
                {r.photos.map((p) => <img key={p.id} src={p.url} alt="" />)}
              </div>

              {r.matchDist != null ? (
                <div className="matched">
                  Matched <b>{r.desig || r.pid}</b> · {fmtDist(r.matchDist, false)} away
                </div>
              ) : (
                <div className="unmatched">
                  {r.lat ? "No mark on file near this spot — name it yourself."
                         : "No location in this photo. Enter coordinates or skip it."}
                </div>
              )}

              <div className="row2">
                <Field label="PID">
                  <input className="in mono" value={r.pid}
                    onChange={(e) => edit(r.key, { pid: e.target.value.toUpperCase() })} /></Field>
                <Field label="Date">
                  <input className="in mono" type="date" value={r.date}
                    onChange={(e) => edit(r.key, { date: e.target.value })} /></Field>
              </div>
              <Field label="Designation">
                <input className="in" value={r.desig}
                  onChange={(e) => edit(r.key, { desig: e.target.value })} /></Field>
              <div className="row2">
                <Field label="Latitude">
                  <input className="in mono" value={r.lat}
                    onChange={(e) => edit(r.key, { lat: e.target.value })} /></Field>
                <Field label="Longitude">
                  <input className="in mono" value={r.lon}
                    onChange={(e) => edit(r.key, { lon: e.target.value })} /></Field>
              </div>
              <div className="cond">
                {CONDITIONS.map((c) => (
                  <button key={c.code} className={r.condition === c.code ? "cchip on" : "cchip"}
                    style={r.condition === c.code ? { background: c.color, borderColor: c.color } : {}}
                    onClick={() => edit(r.key, { condition: c.code })}>{c.label}</button>
                ))}
              </div>
              <Field label="Notes">
                <textarea className="in ta" rows={2} value={r.notes}
                  onChange={(e) => edit(r.key, { notes: e.target.value })} /></Field>
              <button className="btn sm danger" onClick={() => drop(r.key)}>Skip this one</button>
            </div>
          ))}

          {blocked > 0 && (
            <p className="note">
              {blocked} {blocked === 1 ? "entry is" : "entries are"} missing coordinates or a name
              and won't be saved.
            </p>
          )}
          <button className="btn primary big" onClick={saveAll} disabled={busy || !ready.length}>
            {busy ? "Saving…" : `Save ${ready.length} ${ready.length === 1 ? "entry" : "entries"}`}
          </button>
        </>
      )}
    </>
  );
}

function SingleLog({ draft, setDraft, pos, refresh, flash, done }) {
  const editing = !!draft?.id;
  const [pid, setPid] = useState(draft?.pid || "");
  const [desig, setDesig] = useState(draft?.desig || "");
  const [stamping, setStamping] = useState(draft?.stamping || "");
  const [kind, setKind] = useState(draft?.kind || "V");
  const [lat, setLat] = useState(draft?.lat != null ? String(draft.lat) : "");
  const [lon, setLon] = useState(draft?.lon != null ? String(draft.lon) : "");
  const [condition, setCondition] = useState(draft?.condition || "GOOD");
  const [notes, setNotes] = useState(draft?.notes || "");
  const [date, setDate] = useState(draft?.date || new Date().toISOString().slice(0, 10));
  const [photos, setPhotos] = useState([]);  // {id, blob, url, isNew}
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const urls = useRef([]);

  useEffect(() => {
    let dead = false;
    (async () => {
      if (!editing) return;
      const rows = await db.getPhotos(draft.id);
      if (dead) return;
      const withUrls = rows.map((r) => {
        const url = URL.createObjectURL(r.blob);
        urls.current.push(url);
        return { ...r, url, isNew: false };
      });
      setPhotos(withUrls);
    })();
    return () => { dead = true; };
  }, [draft, editing]);

  useEffect(() => () => { urls.current.forEach(URL.revokeObjectURL); }, []);

  const useHere = () => {
    if (!pos) { flash("No position yet — set one on the Nearby screen."); return; }
    setLat(pos.lat.toFixed(6));
    setLon(pos.lon.toFixed(6));
  };

  const addPhotos = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    const next = [...photos];
    let filled = null;
    for (const f of files.slice(0, 6 - photos.length)) {
      // EXIF comes off the original file — compressToBlob re-encodes
      // through a canvas and drops every tag.
      const ex = await readExif(f);
      try {
        const blob = await compressToBlob(f);
        const url = URL.createObjectURL(blob);
        urls.current.push(url);
        next.push({ id: uid(), blob, url, isNew: true });
      } catch (err) {
        flash(explainNoGps(f));
        continue;
      }
      if (ex.hasGps && !lat && !lon) {
        setLat(ex.lat.toFixed(6));
        setLon(ex.lon.toFixed(6));
        filled = "coordinates";
      }
      if (ex.date && !draft?.date) {
        const d = localDate(ex.date);
        if (d) { setDate(d); filled = filled ? "coordinates and date" : "date"; }
      }
    }
    setPhotos(next);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    if (filled) flash(`Filled ${filled} from the photo.`);
  };

  const dropPhoto = async (p) => {
    setPhotos(photos.filter((x) => x.id !== p.id));
    if (!p.isNew) await db.deletePhoto(p.id);
  };

  const save = async () => {
    const la = parseCoord(lat), lo = parseCoord(lon);
    if (!pid.trim() && !desig.trim()) { flash("Give it a PID or a designation so you can find it later."); return; }
    if (!isFinite(la) || !isFinite(lo)) { flash("Coordinates are missing. Tap “Use my position” or type them in."); return; }
    setBusy(true);
    const id = draft?.id || uid();
    try {
      for (const p of photos.filter((x) => x.isNew))
        await db.putPhoto({ id: p.id, findId: id, blob: p.blob });
      await db.putFind({
        id, pid: pid.trim().toUpperCase(), desig: desig.trim(), stamping: stamping.trim(),
        kind, lat: la, lon: lo, elev: draft?.elev || "", condition,
        notes: notes.trim(), date, photoCount: photos.length,
        loggedAt: draft?.loggedAt || new Date().toISOString(),
      });
      await refresh();
      setDraft(null);
      flash(editing ? "Entry updated." : "Find logged.");
      done();
    } catch (e) {
      flash("Saving failed — storage may be full. Delete a few photos and try again.");
    }
    setBusy(false);
  };

  return (
    <>
      <h2 className="sec">{editing ? "Edit entry" : "Log a find"}</h2>
      <div className="row2">
        <Field label="PID">
          <input className="in mono" placeholder="KX1234" value={pid}
            onChange={(e) => setPid(e.target.value.toUpperCase())} /></Field>
        <Field label="Type">
          <select className="in" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="V">Vertical (bench mark)</option>
            <option value="H">Horizontal (station)</option>
          </select></Field>
      </div>
      <Field label="Designation">
        <input className="in" placeholder="TIDAL 3 RESET" value={desig}
          onChange={(e) => setDesig(e.target.value)} /></Field>
      <Field label="Stamping" hint="What's actually struck into the disk.">
        <input className="in mono" placeholder="H 42 1934" value={stamping}
          onChange={(e) => setStamping(e.target.value)} /></Field>

      <div className="row2">
        <Field label="Latitude">
          <input className="in mono" value={lat} onChange={(e) => setLat(e.target.value)}
            placeholder="39.123456" /></Field>
        <Field label="Longitude">
          <input className="in mono" value={lon} onChange={(e) => setLon(e.target.value)}
            placeholder="-95.208764" /></Field>
      </div>
      <button className="btn" onClick={useHere}>Use my position</button>

      <Field label="Condition">
        <div className="cond">
          {CONDITIONS.map((c) => (
            <button key={c.code} className={condition === c.code ? "cchip on" : "cchip"}
              style={condition === c.code ? { background: c.color, borderColor: c.color } : {}}
              onClick={() => setCondition(c.code)}>{c.label}</button>
          ))}
        </div>
      </Field>

      <Field label="Date">
        <input className="in mono" type="date" value={date}
          onChange={(e) => setDate(e.target.value)} /></Field>

      <Field label="Notes" hint="How you got there, what it's set in, what's changed.">
        <textarea className="in ta" rows={4} value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Set in the NE wingwall of the concrete box culvert, 14 ft E of centerline. Disk clean, no rust." />
      </Field>

      <Field label={`Photos (${photos.length}/6)`}>
        <input ref={fileRef} className="file" type="file" accept="image/*"
          capture="environment" multiple onChange={addPhotos} disabled={photos.length >= 6} />
      </Field>
      {photos.length > 0 && (
        <div className="thumbs">
          {photos.map((p) => (
            <div className="thumb" key={p.id}>
              <img src={p.url} alt="" />
              <button onClick={() => dropPhoto(p)} aria-label="Remove photo">×</button>
            </div>
          ))}
        </div>
      )}

      <button className="btn primary big" onClick={save} disabled={busy}>
        {busy ? "Saving…" : editing ? "Save changes" : "Log this find"}
      </button>
    </>
  );
}

/* ═══ FINDS ════════════════════════════════════════════════ */
function FindsView({ finds, refresh, onEdit, flash }) {
  const [open, setOpen] = useState(null);
  const [photos, setPhotos] = useState({});
  const [q, setQ] = useState("");
  const urls = useRef([]);

  useEffect(() => () => { urls.current.forEach(URL.revokeObjectURL); }, []);

  const expand = async (f) => {
    if (open === f.id) { setOpen(null); return; }
    setOpen(f.id);
    if (!photos[f.id]) {
      const rows = await db.getPhotos(f.id);
      const list = rows.map((r) => {
        const u = URL.createObjectURL(r.blob);
        urls.current.push(u);
        return u;
      });
      setPhotos((p) => ({ ...p, [f.id]: list }));
    }
  };

  const remove = async (f) => {
    await db.deleteFind(f.id);
    await refresh();
    flash("Entry deleted.");
  };

  const exportCsv = () => {
    const head = ["pid","designation","stamping","type","latitude","longitude","condition","date","notes"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [head.join(",")].concat(
      finds.map((f) => [f.pid, f.desig, f.stamping, f.kind === "H" ? "horizontal" : "vertical",
        f.lat, f.lon, f.condition, f.date, f.notes].map(esc).join(","))
    ).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `recoveries-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportGpx = () => {
    const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const body = finds.map((f) =>
      `  <wpt lat="${f.lat}" lon="${f.lon}"><name>${esc(f.desig || f.pid)}</name>` +
      `<desc>${esc(f.pid + " " + f.condition + " " + f.date)}</desc></wpt>`).join("\n");
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Mark Recovery Log" xmlns="http://www.topografix.com/GPX/1/1">\n${body}\n</gpx>`;
    const url = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "recoveries.gpx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!finds.length)
    return (
      <section>
        <h2 className="sec">My finds</h2>
        <p className="empty">No entries yet. The first one goes in from the field — tap “Log a find.”</p>
      </section>
    );

  const shown = finds.filter((f) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return [f.pid, f.desig, f.stamping, f.notes].some((v) => (v || "").toLowerCase().includes(s));
  });

  return (
    <section>
      <h2 className="sec">My finds<span className="sec-n">{finds.length}</span></h2>
      <input className="in" placeholder="Search PID, designation, notes"
        value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="list">
        {shown.map((f) => (
          <li key={f.id} className="card" onClick={() => expand(f)}>
            <div className="card-hd">
              <div>
                <div className="desig">{f.desig || f.pid}</div>
                <div className="pid mono">{f.pid} · {f.date}</div>
              </div>
              <span className="cond-dot" style={{ background: condColor(f.condition) }}>
                {f.condition}
              </span>
            </div>
            {open === f.id && (
              <div className="card-body">
                {f.stamping && <div className="stamp mono">{f.stamping}</div>}
                <div className="mono coord">{f.lat.toFixed(6)}, {f.lon.toFixed(6)}</div>
                {f.notes && <p className="notes">{f.notes}</p>}
                {(photos[f.id] || []).map((src, i) => (
                  <img key={i} className="photo" src={src} alt="" loading="lazy" />
                ))}
                <div className="card-acts">
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); onEdit(f); }}>Edit</button>
                  <a className="btn sm ghost" onClick={(e) => e.stopPropagation()}
                    href={`https://www.google.com/maps/search/?api=1&query=${f.lat},${f.lon}`}
                    target="_blank" rel="noreferrer">Navigate</a>
                  <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); remove(f); }}>Delete</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="row2">
        <button className="btn" onClick={exportCsv}>Export CSV</button>
        <button className="btn" onClick={exportGpx}>Export GPX</button>
      </div>
    </section>
  );
}

/* ═══ DATA ═════════════════════════════════════════════════ */
function DataView({ markMeta, setMarkMeta, finds, flash }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [map, setMap] = useState({ pid: -1, desig: -1, lat: -1, lon: -1, elev: -1 });
  const [mode, setMode] = useState("replace");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null);
  const [space, setSpace] = useState(null);

  useEffect(() => { db.usage().then(setSpace); }, [markMeta, finds.length]);

  const analyze = (raw) => {
    const r = parseDelimited(raw);
    if (r.length < 2) { flash("That didn't parse as CSV — check that there's a header row."); return; }
    const h = r[0];
    setHeaders(h);
    setRows(r.slice(1));
    setMap({
      pid: guessColumn(h, ["pid", "pointid", "markid", "id"]),
      desig: guessColumn(h, ["designation", "desig", "name", "station"]),
      lat: guessColumn(h, ["declat", "latitude", "lat", "y"]),
      lon: guessColumn(h, ["declon", "declong", "longitude", "long", "lon", "x"]),
      elev: guessColumn(h, ["orthoht", "elevation", "elev", "height", "z"]),
    });
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const t = await f.text();
    setText(t.slice(0, 400) + (t.length > 400 ? "\n…" : ""));
    analyze(t);
  };

  const commit = async () => {
    if (map.lat < 0 || map.lon < 0) { flash("Pick which columns hold latitude and longitude."); return; }
    setBusy(true);
    const out = [];
    for (const r of rows) {
      const la = parseCoord(r[map.lat]), lo = parseCoord(r[map.lon]);
      if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
      out.push({
        pid: map.pid >= 0 ? (r[map.pid] || "").toUpperCase() : "",
        desig: map.desig >= 0 ? r[map.desig] || "" : "",
        lat: la, lon: lo,
        elev: map.elev >= 0 ? r[map.elev] || "" : "",
        kind: "V",
      });
    }
    if (!out.length) { setBusy(false); flash("No usable coordinates in those columns."); return; }
    try {
      await db.importMarks(out, {
        replace: mode === "replace",
        onProgress: (n, t) => setProg(`${n.toLocaleString()} / ${t.toLocaleString()}`),
      });
      setMarkMeta(await db.getMarkMeta());
      setRows(null); setText(""); setProg(null);
      flash(`${out.length.toLocaleString()} marks loaded.`);
    } catch (e) {
      flash("Import failed — the file may be larger than this device will store.");
    }
    setBusy(false);
  };

  const clearDb = async () => {
    await db.clearMarks();
    setMarkMeta(await db.getMarkMeta());
    flash("Mark file cleared.");
  };

  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

  return (
    <section>
      <h2 className="sec">Mark file</h2>
      <div className="stat">
        <b>{markMeta ? markMeta.count.toLocaleString() : 0}</b>
        <span>reference marks stored on this device</span>
      </div>

      <p className="note">
        Get a mark list from the NGS Data Explorer (geodesy.noaa.gov/NGSDataExplorer) — draw a box
        around your county, export the results, then load the file here. It stays on this device,
        so Nearby keeps working with no signal.
      </p>

      <div className="row2">
        <label className="btn as-label">
          Choose a CSV file
          <input type="file" accept=".csv,.txt,.tsv" onChange={onFile} hidden />
        </label>
        <button className="btn" onClick={() => analyze(text)} disabled={!text.trim()}>
          Parse pasted text
        </button>
      </div>

      <Field label="Or paste rows">
        <textarea className="in ta mono" rows={4} value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"pid,designation,lat,lon\nKX1234,TIDAL 3,39.123456,-95.208764"} />
      </Field>

      {rows && (
        <div className="mapper">
          <h3>Match up the columns</h3>
          {[["pid", "PID"], ["desig", "Designation"], ["lat", "Latitude"],
            ["lon", "Longitude"], ["elev", "Elevation"]].map(([k, l]) => (
            <Field key={k} label={l}>
              <select className="in" value={map[k]}
                onChange={(e) => setMap({ ...map, [k]: parseInt(e.target.value, 10) })}>
                <option value={-1}>— skip —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `column ${i + 1}`}</option>)}
              </select>
            </Field>
          ))}
          <div className="cond">
            <button className={mode === "replace" ? "cchip on" : "cchip"}
              onClick={() => setMode("replace")}>Replace file</button>
            <button className={mode === "append" ? "cchip on" : "cchip"}
              onClick={() => setMode("append")}>Add to file</button>
          </div>
          <button className="btn primary big" onClick={commit} disabled={busy}>
            {busy ? (prog ? `Loading ${prog}` : "Loading…") : `Load ${rows.length.toLocaleString()} rows`}
          </button>
        </div>
      )}

      {!!markMeta?.count && (
        <button className="btn danger" onClick={clearDb}>Clear the mark file</button>
      )}

      {space && (
        <p className="note small">
          Using {mb(space.used)} of roughly {mb(space.quota)} available to this app.
          {" "}Export your recoveries from My finds to keep a copy off the device.
        </p>
      )}
    </section>
  );
}
