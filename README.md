# Gas Price Checker

A browser-based fuel-purchase decision aid and installable PWA. It combines vehicle range, current fuel level, weekly gasoline benchmarks, manually entered station prices, reward discounts, and travel cost to explain whether filling now or waiting appears more practical.

## Features

- Vehicle profiles with tank size, fuel economy, and weekly mileage
- Visual fuel gauge and estimated days of fuel remaining
- EIA weekly regular-gasoline history through a small Netlify function
- Conservative regional fallback when the EIA endpoint is unavailable
- Manual local-price comparison against the benchmark
- GasBuddy/Upside reward and stackability comparisons
- Alternate-station travel-cost break-even analysis
- Nearby fuel-station lookup through OpenStreetMap's Overpass API
- Fill-up history and summary statistics stored in the browser
- Offline shell caching through a service worker

## Important limitations

This is a decision aid, not a live station-price feed. The EIA series is a weekly national benchmark, and the fallback history is an estimate. Current and alternate station prices must be entered by the user. Results can be stale or inaccurate and should be checked before making a purchase decision.

## Run locally

The static application works without an API key and falls back to its regional estimate when the Netlify function is unavailable:

```bash
python -m http.server 8080
```

Open `http://localhost:8080`.

For the EIA-backed path, install the Netlify CLI, copy the example environment file, add your own EIA key, and run `netlify dev`:

```bash
cp .env.example .env
netlify dev
```

For deployment, configure `EIA_API_KEY` as a server-side Netlify environment variable. It is read by `netlify/functions/eia-proxy.js` and is never embedded in browser code.

## Privacy and data flow

The repository contains no saved profiles, ZIP codes, coordinates, or fill-up history.

The app stores user-entered vehicle details, ZIP code, profiles, and fill-up records in browser `localStorage`. A geocoded coordinate may be cached for the current tab in `sessionStorage`. Using location/station features sends a ZIP code or coordinates to third-party services including Zippopotam, BigDataCloud, OpenStreetMap Overpass, Google Maps, or GasBuddy. Browser storage can be cleared through the browser's site-data controls.

## Project structure

- `index.html`, `style.css`, `main.js` — static application
- `netlify/functions/eia-proxy.js` — server-side EIA request
- `service-worker.js`, `manifest.json` — PWA shell
- `icon*.png`, `icon.svg` — application icons
