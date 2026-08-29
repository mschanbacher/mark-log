import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Map tiles you've already looked at keep working with no
            // signal. This is the whole reason the map is usable afield.
            urlPattern: /^https:\/\/basemap\.nationalmap\.gov\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "usgs-tiles",
              expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Mark downloads must be live; a stale cached page would
            // silently truncate an import.
            urlPattern: /^https:\/\/services2\.arcgis\.com\/.*/i,
            handler: "NetworkOnly",
          },
        ],
      },
      manifest: {
        name: "Mark Recovery Log",
        short_name: "Marks",
        description: "Field log for geodetic survey monuments.",
        theme_color: "#1B2620",
        background_color: "#FBFAF7",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      }
    })
  ]
});
