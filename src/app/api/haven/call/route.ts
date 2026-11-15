// Real emergency-contact call from a Command Center. The browser asks this route; this route checks the facility's
// saved HAVEN state (Neon) for an active fire or leak incident, builds the call from that saved incident (never from
// what the browser sent), and asks the data service to dial with the shared DISPATCH_TOKEN. The data service refuses
// any call through its public tunnel without that token, and allows one call a minute.
import { z } from 'zod';
import { guardOrigin, HttpError, readJSON, routeError } from '@/lib/http';
import { loadProtection } from '@/lib/haven/store';
import { activeIncidents } from '@/lib/haven/engine';

export const dynamic = 'force-dynamic';
const API = (process.env.PLOTSTAR_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const facilitySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,150}$/),
  name: z.string().trim().min(1).max(160),
  city: z.string().max(120),
  type: z.string().max(60),
});

export async function POST(req: Request) {
  try {
    guardOrigin(req);
    const { facility } = z.object({ facility: facilitySchema }).parse(await readJSON(req));
    const state = await loadProtection(facility);
    const incident = activeIncidents(state).find((i) => i.kind === 'fire' || i.kind === 'leak');
    if (!incident) throw new HttpError(409, 'There is no active fire or leak at this facility, so no call was placed.');
    const token = process.env.DISPATCH_TOKEN?.trim();
    const r = await fetch(`${API}/haven/dispatch/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Dispatch-Token': token } : {}) },
      body: JSON.stringify({
        incident_id: incident.id,
        incident: incident.name,
        zone: incident.zone,
        severity: incident.severity,
        detail: incident.message,
        actions: incident.recommendation,
        facility: state.facility.name,
        city: state.facility.city,
      }),
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    }).catch(() => {
      throw new HttpError(503, 'The calling service is offline. Start the GeoStar data service and try again.');
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status === 403 ? 503 : r.status, body.detail || 'The call could not be placed.');
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return routeError(error);
  }
}
