import React, { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as db from "./db.js";
import { fetchMarksInBbox, bboxAreaSqMi, accuracyRadiusM,
  conditionClass, recoveryYear } from "./ngs.js";
import { distanceM, fmtDist } from "./geo.js";

/* USGS The National Map. Public domain, no key, and it looks like
   the quad sheets the rest of the app is dressed as. */
/* USGS The National Map. Public domain, no key. Only three services
   exist and just one carries contours, so "minimal topo" means
   quieting USGSTopo rather than finding a plainer source: drop the
   colour, ease the contrast, and let it sit back so the marks read
   as the foreground. The filters live in index.css. */
const BASEMAPS = {
  quiet: {
    label: "Quiet",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    max: 16,
    note: "contours, muted",
  },
  relief: {
    label: "Relief",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}",
    max: 16,
    note: "landform only, no labels",
  },
  imagery: {
    label: "Imagery",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}",
    max: 16,
    note: "aerial with contours",
  },
};

const ATTRIB = "USGS The National Map";

const MARK_LIMIT = 800;   // glyphs we're willing to draw at once
const MARK_ZOOM = 12;     // below this, reference marks stay hidden
const HALO_ZOOM = 15;     // uncertainty circles only make sense up close
const HALO_MIN_M = 25;    // below this the circle is smaller than the dot

const BROWN = "#8A5A2B";
const PURPLE = "#6E4A8E";
const PAPER = "#FBFAF7";

/* Shape carries what kind of control it is, fill carries how much
   NGS knows about it. Two channels is what a 14px glyph supports. */
function glyphHtml(kind, state, mine) {
  const stroke = mine ? PURPLE : BROWN;
  const solid = mine || state === "good";
  const fill = solid ? stroke : PAPER;
  const dim = state === "gone" ? 0.5 : 1;
  const body = kind === "H"
    ? `<polygon points="8,2 14,13 2,13" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`
    : `<circle cx="8" cy="8" r="5.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  const slash = state === "gone"
    ? `<line x1="2" y1="14" x2="14" y2="2" stroke="${stroke}" stroke-width="2"/>` : "";
  return `<svg width="16" height="16" viewBox="0 0 16 16" opacity="${dim}">${body}${slash}</svg>`;
}

const glyphIcon = (kind, state, mine) =>
  L.divIcon({
    html: glyphHtml(kind, state, mine),
    className: "markglyph",
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

export default function MapView({ finds, pos, metric, onLog, flash, onMarksChanged }) {
  const holder = useRef(null);
  const map = useRef(null);
  const tiles = useRef(null);
  const findLayer = useRef(null);
  const markLayer = useRef(null);
  const meLayer = useRef(null);
  const abort = useRef(null);

  const [base, setBase] = useState("quiet");
  const [sel, setSel] = useState(null);
  const [shown, setShown] = useState(0);
  const [tooMany, setTooMany] = useState(false);
  const [zoomedOut, setZoomedOut] = useState(false);
  const [dl, setDl] = useState(null);   // null | {state, msg}

  /* ── redraw reference marks for the current viewport ───── */
  const drawMarks = useCallback(async () => {
    const m = map.current;
    if (!m || !markLayer.current) return;
    if (m.getZoom() < MARK_ZOOM) {
      markLayer.current.clearLayers();
      setShown(0);
      setZoomedOut(true);
      setTooMany(false);
      return;
    }
    setZoomedOut(false);
    const b = m.getBounds();
    let rows = [];
    try {
      const r = await db.marksInBox(
        b.getSouth(), b.getNorth(), b.getWest(), b.getEast());
      rows = r.rows;
    } catch (e) { /* empty mark file is fine */ }

    const found = new Set(finds.map((f) => (f.pid || "").toUpperCase()).filter(Boolean));
    const inView = rows.filter((r) => b.contains([r.lat, r.lon]));
    setTooMany(inView.length > MARK_LIMIT);
    setShown(inView.length);

    markLayer.current.clearLayers();
    const showHalo = m.getZoom() >= HALO_ZOOM;
    for (const r of inView.slice(0, MARK_LIMIT)) {
      if (found.has((r.pid || "").toUpperCase())) continue; // drawn as a find
      const state = conditionClass(r.lastCond, r.lastRecv);
      const acc = r.accM != null ? r.accM : accuracyRadiusM(r.posSrce, r.accHz);

      // The search area, drawn before the glyph so the glyph sits on top.
      if (showHalo && acc != null && acc >= HALO_MIN_M) {
        L.circle([r.lat, r.lon], {
          radius: acc,
          color: BROWN,
          weight: 1,
          opacity: 0.32,
          dashArray: "3 5",
          fill: false,
          interactive: false,
        }).addTo(markLayer.current);
      }

      L.marker([r.lat, r.lon], { icon: glyphIcon(r.kind, state, false) })
        .on("click", () => setSel({ ...r, found: false, state, acc }))
        .addTo(markLayer.current);
    }
  }, [finds]);

  /* ── init once ─────────────────────────────────────────── */
  useEffect(() => {
    if (map.current || !holder.current) return;
    const start = pos
      ? [pos.lat, pos.lon]
      : finds.length
        ? [finds[0].lat, finds[0].lon]
        : [39.5, -98.35];
    const zoom = pos || finds.length ? 14 : 4;

    const m = L.map(holder.current, { zoomControl: false, attributionControl: true })
      .setView(start, zoom);
    L.control.scale({ imperial: true, metric: true, position: "bottomleft" }).addTo(m);
    tiles.current = L.tileLayer(BASEMAPS.quiet.url, {
      maxZoom: BASEMAPS.quiet.max,
      attribution: ATTRIB,
      crossOrigin: true,
    }).addTo(m);
    markLayer.current = L.layerGroup().addTo(m);
    findLayer.current = L.layerGroup().addTo(m);
    meLayer.current = L.layerGroup().addTo(m);
    m.on("moveend zoomend", drawMarks);
    map.current = m;
    setTimeout(() => m.invalidateSize(), 60);
    drawMarks();

    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { if (abort.current) abort.current.abort(); }, []);

  /* ── basemap switch ────────────────────────────────────── */
  useEffect(() => {
    if (!map.current || !tiles.current) return;
    tiles.current.setUrl(BASEMAPS[base].url);
  }, [base]);

  /* ── your finds ────────────────────────────────────────── */
  useEffect(() => {
    if (!findLayer.current) return;
    findLayer.current.clearLayers();
    for (const f of finds) {
      if (!isFinite(f.lat) || !isFinite(f.lon)) continue;
      L.marker([f.lat, f.lon], { icon: glyphIcon(f.kind, "good", true) })
        .on("click", () => setSel({ ...f, found: true }))
        .addTo(findLayer.current);
    }
    drawMarks();
  }, [finds, drawMarks]);

  /* ── your position ─────────────────────────────────────── */
  useEffect(() => {
    if (!meLayer.current) return;
    meLayer.current.clearLayers();
    if (!pos) return;
    L.circleMarker([pos.lat, pos.lon], {
      radius: 6, color: "#2E6E8E", weight: 2,
      fillColor: "#2E6E8E", fillOpacity: 0.45,
    }).addTo(meLayer.current);
    if (pos.acc)
      L.circle([pos.lat, pos.lon], {
        radius: pos.acc, color: "#2E6E8E", weight: 1,
        opacity: 0.4, fillOpacity: 0.06,
      }).addTo(meLayer.current);
  }, [pos]);

  const goToMe = () => {
    if (!pos) { flash("No position yet — set one on the Nearby screen."); return; }
    map.current?.setView([pos.lat, pos.lon], 16);
  };

  const fitFinds = () => {
    const pts = finds.filter((f) => isFinite(f.lat) && isFinite(f.lon))
      .map((f) => [f.lat, f.lon]);
    if (!pts.length) { flash("No finds to show yet."); return; }
    map.current?.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 });
  };

  /* ── refresh this viewport from NGS ────────────────────────
     Fetch first, replace second. Clearing up front would mean a
     dropped connection leaves the area empty. */
  const refresh = async () => {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    const box = {
      minLat: b.getSouth(), maxLat: b.getNorth(),
      minLon: b.getWest(), maxLon: b.getEast(),
    };
    const area = bboxAreaSqMi(box);
    if (area > 4000) {
      setDl({ state: "error", msg: `That view covers about ${Math.round(area).toLocaleString()} sq mi. Zoom in to under 4,000 first.` });
      return;
    }
    abort.current = new AbortController();
    setDl({ state: "working", msg: "Asking NGS…" });
    try {
      const marks = await fetchMarksInBbox(box, {
        signal: abort.current.signal,
        onProgress: (n) => setDl({ state: "working", msg: `${n.toLocaleString()} marks…` }),
      });
      if (!marks.length) {
        setDl({ state: "done", msg: "NGS has no marks in this view." });
        return;
      }
      const removed = await db.deleteMarksInBox(
        box.minLat, box.maxLat, box.minLon, box.maxLon);
      await db.importMarks(marks, { replace: false });
      await onMarksChanged();
      await drawMarks();
      setDl({
        state: "done",
        msg: removed
          ? `${marks.length.toLocaleString()} marks refreshed (${removed.toLocaleString()} replaced).`
          : `${marks.length.toLocaleString()} marks added.`,
      });
    } catch (e) {
      if (e.name === "AbortError") return;
      setDl({ state: "error", msg: e.message });
    }
  };

  const dist = sel && pos ? distanceM(pos.lat, pos.lon, sel.lat, sel.lon) : null;

  return (
    <div className="mapwrap">
      <div ref={holder} className={`mapcanvas base-${base}`} />

      <div className="maptools">
        <div className="radius">
          {Object.entries(BASEMAPS).map(([k, v]) => (
            <button key={k} className={base === k ? "chip on" : "chip"}
              onClick={() => setBase(k)}>{v.label}</button>
          ))}
          <button className="chip" onClick={goToMe}>My position</button>
          <button className="chip" onClick={fitFinds}>All finds</button>
        </div>

        <button className="btn sm" onClick={refresh}
          disabled={dl?.state === "working"}>
          {dl?.state === "working" ? dl.msg : "Refresh marks in this view"}
        </button>

        {dl && dl.state !== "working" && (
          <p className={dl.state === "error" ? "note" : "note small"}>{dl.msg}</p>
        )}

        <p className="maphint">{BASEMAPS[base].note}</p>

        <div className="legend maplegend">
          <span dangerouslySetInnerHTML={{ __html: glyphHtml("V", "good", false) }} /> reported good
          <span dangerouslySetInnerHTML={{ __html: glyphHtml("V", "unknown", false) }} /> not reported lately
          <span dangerouslySetInnerHTML={{ __html: glyphHtml("V", "gone", false) }} /> reported gone
          <span dangerouslySetInnerHTML={{ __html: glyphHtml("V", "good", true) }} /> yours
        </div>
        <p className="maphint">
          Circle = vertical control, triangle = horizontal. A dashed ring is how far
          the published position may be off — hollow marks mean nobody has reported
          in, not that the mark is missing.
        </p>

        {zoomedOut ? (
          <p className="maphint">Zoom in to see marks on file.</p>
        ) : (
          <p className="maphint">
            {shown.toLocaleString()} on file in view
            {tooMany ? ` · drawing the first ${MARK_LIMIT}` : ""}
          </p>
        )}

        {sel && (
          <div className="card sel">
            <div className="card-hd">
              <div>
                <div className="desig">{sel.desig || sel.pid || "unnamed mark"}</div>
                <div className="pid mono">{sel.pid || "no PID"}</div>
              </div>
              {dist != null && <div className="dist"><b>{fmtDist(dist, metric)}</b></div>}
            </div>
            <div className="card-body">
              {sel.found && (
                <div className="flag">
                  Recovered {sel.date || ""}{sel.condition ? ` · ${sel.condition}` : ""}
                </div>
              )}
              {sel.stamping && <div className="stamp mono">{sel.stamping}</div>}
              <div className="mono coord">{sel.lat.toFixed(6)}, {sel.lon.toFixed(6)}</div>
              {sel.elev && <div className="mono coord">elev {sel.elev}</div>}
              {sel.setting && <p className="notes">{sel.setting}</p>}
              {sel.notes && <p className="notes">{sel.notes}</p>}
              {sel.lastCond ? (
                <div className="mono coord">
                  NGS last reported {sel.lastCond.toLowerCase()}
                  {recoveryYear(sel.lastRecv) ? ` in ${recoveryYear(sel.lastRecv)}` : ""}
                </div>
              ) : sel.found ? null : (
                <div className="mono coord">No recovery on record.</div>
              )}
              {!sel.found && (
                <div className="mono coord">
                  {sel.acc == null
                    ? `Position source ${sel.posSrce || "unknown"} — accuracy not published.`
                    : sel.acc >= HALO_MIN_M
                      ? `Position ${(sel.posSrce || "").toLowerCase() || "scaled"} — search within about ${fmtDist(sel.acc, metric)}.`
                      : `Position adjusted — good to about ${fmtDist(sel.acc, metric)}.`}
                </div>
              )}
              <div className="card-acts">
                <button className="btn sm" onClick={() => onLog({
                  pid: sel.pid, desig: sel.desig, lat: sel.lat, lon: sel.lon,
                  kind: sel.kind, elev: sel.elev,
                })}>{sel.found ? "Log another visit" : "Log this find"}</button>
                <a className="btn sm ghost" target="_blank" rel="noreferrer"
                  href={`https://www.google.com/maps/search/?api=1&query=${sel.lat},${sel.lon}`}>
                  Navigate</a>
                <button className="btn sm ghost" onClick={() => setSel(null)}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
