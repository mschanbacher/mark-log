# Mark Recovery Log — context

Personal PWA for logging geodetic survey monuments (NGS/USGS marks) and finding
ones nearby. Single user, no backend, no accounts. Deployed to Cloudflare from
GitHub `main` (`mschanbacher/mark-log`).

## Decisions worth not re-litigating

- **IndexedDB, not localStorage.** Photos are stored as blobs; localStorage caps
  around 5 MB and only holds strings.
- **Marks are indexed by 0.1° cell** (`src/db.js`, `CELL = 10`). Radius queries
  fetch only the cells covering the bounding box, never scan the store. This is
  what keeps a 100k-row county import usable. `npm test` asserts the cell query
  returns exactly what a brute-force scan returns — run it if you touch `CELL`
  or `marksInBox`.
- **Photos:** downscaled to 1400px, JPEG q0.72, stored in their own store keyed
  by `findId`, loaded only when a find is expanded. Keeps the list fast.
- **Google Maps URLs, not `geo:`** — iOS Safari ignores the `geo:` scheme.
- **Build must run before deploy.** Uploading `src/` serves raw JSX and the page
  renders blank. `wrangler.jsonc` pins `assets.directory` to `./dist` so Wrangler
  doesn't guess.
- **EXIF is read from the original `File`, never after compression.**
  `compressToBlob` re-encodes through a canvas and drops every tag, so
  `readExif(file)` must run first. This ordering is load-bearing — see
  `addPhotos` in `SingleLog` and the loop in `PhotoImport`.
- **Dates use `localDate`, not `toISOString`.** An evening photo west of
  UTC otherwise records as the next day.
- **Marks come from the NGS public feature service** (`src/ngs.js`), an ArcGIS
  layer NOAA refreshes weekly, no key. Paged at 2000 features via `resultOffset`.
  Manual CSV import stays as the offline fallback — don't remove it.
- **Basemap treatments are CSS filters on `.leaflet-tile-pane`**, not different
  tile sources. USGS serves only three basemaps and only USGSTopo has contours,
  so "minimal" is achieved by desaturating and fading it. Filtering the tile
  pane specifically (not the container) keeps markers and scale bar at full
  contrast.
- **Basemap is USGS The National Map**, public domain, no key. Tiles are
  runtime-cached CacheFirst in `vite.config.js`, which is what makes the map
  work in the field after you've viewed an area once. NGS queries are
  NetworkOnly — a cached page would silently truncate an import.
- **Exports matter.** Storage is device-local and `navigator.storage.persist()`
  is a request, not a guarantee. CSV and GPX export from My finds are the backup.

## Layout

```
src/App.jsx    all four screens (Nearby, Log, Finds, Mark file)
src/db.js      IndexedDB layer — finds, photos, marks, meta
src/geo.js     distance/bearing, coordinate + CSV parsing, image compression
src/exif.js    EXIF extraction, nearest-mark matching
src/ngs.js     NGS feature service client (bbox download, paging)
src/MapView.jsx Leaflet map — finds, reference marks, live download
src/index.css  entire stylesheet
```

Visual language is the USGS 7.5' quadrangle sheet: contour brown, woodland tint,
water blue, and the purple quads reserve for revisions — used here for marks the
user has recovered.

## Commands

```bash
npm run dev     # localhost is a secure origin, so geolocation works
npm run build   # must produce dist/ before deploy
npm test        # spatial index, EXIF matching, NGS client
```

## Deploy settings (Cloudflare dashboard)

- Build command: `npm install && npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: repo root (where `package.json` lives)

## Known rough edges

- Geolocation fails silently on a plain-http LAN address; the app falls back to
  manual coordinate entry.
- No sync or backup. If the phone is lost, so is anything not exported.
- Mark file import holds the parsed rows in memory before writing; a very large
  file (100k+) will spike memory on the phone during import.
