import type { NextConfig } from 'next';

// On the hosted site there is no local database or secret keys. When GEOSTAR_WEB_ORIGIN is set at build time
// (scripts/go-live.ps1 sets it to a tunnel to the laptop's own website), these routes are forwarded to the laptop,
// which owns the SQLite workspace (projects, HAVEN protection) and the server-side AI and voice keys.
// Drone and phone-app routes are never forwarded: they stay local to the demo laptop.
const laptop = (process.env.GEOSTAR_WEB_ORIGIN || '').replace(/\/$/, '');
const FORWARDED = ['protection', 'projects', 'telemetry', 'hey-geo', 'voice'];

const config: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ['@prisma/client'],
  // /dashboard-2 was retired; /studio is the dashboard now.
  async redirects() {
    return [{ source: '/dashboard-2', destination: '/studio', permanent: false }];
  },
  async rewrites() {
    if (!laptop) return { beforeFiles: [] };
    return {
      beforeFiles: FORWARDED.flatMap((name) => [
        { source: `/api/${name}`, destination: `${laptop}/api/${name}` },
        { source: `/api/${name}/:path*`, destination: `${laptop}/api/${name}/:path*` },
      ]),
    };
  },
};
export default config;
