# PlotStar web

Next.js 16 (App Router) + React 19 + Tailwind 4. Leaflet map, lucide icons.

- `src/app/page.tsx`: landing page
- `src/app/dashboard/*`: six tabs (portfolio, sites, power, optimize, live-grid, reports)
- `src/lib/api.ts`: typed API client (`NEXT_PUBLIC_API_URL`, default `http://localhost:8000`)
- `src/components/AuditProvider.tsx`: click-any-number evidence drawer

Run `npm run dev` with the API running. See the root README.
