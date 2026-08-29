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
- **Exports matter.** Storage is device-local and `navigator.storage.persist()`
  is a request, not a guarantee. CSV and GPX export from My finds are the backup.

## Layout

```
src/App.jsx    all four screens (Nearby, Log, Finds, Mark file)
src/db.js      IndexedDB layer — finds, photos, marks, meta
src/geo.js     distance/bearing, coordinate + CSV parsing, image compression
src/exif.js    EXIF extraction, nearest-mark matching
src/index.css  entire stylesheet
```

Visual language is the USGS 7.5' quadrangle sheet: contour brown, woodland tint,
water blue, and the purple quads reserve for revisions — used here for marks the
user has recovered.

## Commands

```bash
npm run dev     # localhost is a secure origin, so geolocation works
npm run build   # must produce dist/ before deploy
npm test        # spatial index + EXIF matching checks
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
