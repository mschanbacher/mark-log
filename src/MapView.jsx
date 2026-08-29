import React, { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as db from "./db.js";
import { fetchMarksInBbox, bboxAreaSqMi } from "./ngs.js";
import { distanceM, fmtDist } from "./geo.js";

/* USGS The National Map. Public domain, no key, and it looks like
   the quad sheets the rest of the app is dressed as. */
const BASEMAPS = {
  topo: {
    label: "Topo",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    max: 16,
  },
  imagery: {
    label: "Imagery",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}",
    max: 16,
  },
};
const ATTRIB = "USGS The National Map";

const MARK_LIMIT = 800;   // circles we're willing to draw at once
const MARK_ZOOM = 12;     // below this, reference marks stay hidden

export default function MapView({ finds, pos, metric, onLog, flash, onMarksChanged }) {
  const holder = useRef(null);
  const map = useRef(null);
  const tiles = useRef(null);
  const findLayer = useRef(null);
  const markLayer = useRef(null);
  const meLayer = useRef(null);
  const abort = useRef(null);

  const [base, setBase] = useState("topo");
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
    for (const r of inView.slice(0, MARK_LIMIT)) {
      if (found.has((r.pid || "").toUpperCase())) continue; // drawn as a find
      L.circleMarker([r.lat, r.lon], {
        radius: 5,
        color: "#8A5A2B",
        weight: 1.8,
        fillColor: "#FBFAF7",
        fillOpacity: 0.85,
      })
        .on("click", () => setSel({ ...r, found: false }))
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

    const m = L.map(holder.current, { zoomControl: true, attributionControl: true })
      .setView(start, zoom);
    tiles.current = L.tileLayer(BASEMAPS.topo.url, {
      maxZoom: BASEMAPS.topo.max,
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
      L.circleMarker([f.lat, f.lon], {
        radius: 7,
        color: "#FBFAF7",
        weight: 2,
        fillColor: "#6E4A8E",
        fillOpacity: 1,
      })
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

  /* ── pull this viewport from NGS ───────────────────────── */
  const download = async () => {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    const box = {
      minLat: b.getSouth(), maxLat: b.getNorth(),
      minLon: b.getWest(), maxLon: b.getEast(),
    };
    const area = bboxAreaSqMi(box);
    if (area > 4000) {
      setDl({ state: "error", msg: `That view covers about ${Math.round(area).toLocaleString()} sq mi. Zoom in to under 4,000 before downloading.` });
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
      /* Don't re-add what's already stored for this area. */
      const { rows: existing } = await db.marksInBox(
        box.minLat, box.maxLat, box.minLon, box.maxLon);
      const have = new Set(existing.map((r) => (r.pid || "").toUpperCase()).filter(Boolean));
      const fresh = marks.filter((m2) => !m2.pid || !have.has(m2.pid));

      if (!fresh.length) {
        setDl({ state: "done", msg: `All ${marks.length.toLocaleString()} already on file.` });
        return;
      }
      await db.importMarks(fresh, { replace: false });
      await onMarksChanged();
      await drawMarks();
      setDl({ state: "done", msg: `Added ${fresh.length.toLocaleString()} marks.` });
    } catch (e) {
      if (e.name === "AbortError") return;
      setDl({ state: "error", msg: e.message });
    }
  };

  const dist = sel && pos ? distanceM(pos.lat, pos.lon, sel.lat, sel.lon) : null;

  return (
    <div className="mapwrap">
      <div ref={holder} className="mapcanvas" />

      <div className="maptools">
        <div className="radius">
          {Object.entries(BASEMAPS).map(([k, v]) => (
            <button key={k} className={base === k ? "chip on" : "chip"}
              onClick={() => setBase(k)}>{v.label}</button>
          ))}
          <button className="chip" onClick={goToMe}>My position</button>
          <button className="chip" onClick={fitFinds}>All finds</button>
        </div>

        <button className="btn sm" onClick={download}
          disabled={dl?.state === "working"}>
          {dl?.state === "working" ? dl.msg : "Download marks for this view"}
        </button>

        {dl && dl.state !== "working" && (
          <p className={dl.state === "error" ? "note" : "note small"}>{dl.msg}</p>
        )}

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
              {sel.lastCond && (
                <div className="mono coord">
                  NGS last reported {sel.lastCond}{sel.lastRecv ? ` (${sel.lastRecv})` : ""}
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
