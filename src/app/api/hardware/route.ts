// Live hardware bridge: the SiteStar PROTECT service (ESP32 data hall + UNO R4 console) runs on the
// demo laptop. This route reads its state for the Command Center cards and forwards grid controls.
import { guardOrigin, HttpError, readJSON, routeError } from '@/lib/http';

export const dynamic = 'force-dynamic';
const BASE = (process.env.PROTECT_URL || 'http://127.0.0.1:8796').replace(/\/$/, '');

type Incident = {
  id: string; kind: string; title: string; room_name: string; severity: string; status: string;
  started: number; agent_state: string; work_order?: string | null;
};

export async function GET() {
  try {
    const r = await fetch(`${BASE}/api/state`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!r.ok) return Response.json({ online: false }, { headers: { 'Cache-Control': 'no-store' } });
    const s = await r.json();
    const power = s.power ?? {};
    return Response.json(
      {
        online: true,
        at: Date.now(),
        live: s.live ?? {},
        power: { ...power, history: (power.history ?? []).slice(-90) },
        incidents: ((s.incidents ?? []) as Incident[]).slice(0, 4).map((i) => ({
          id: i.id, kind: i.kind, title: i.title, room: i.room_name, severity: i.severity,
          status: i.status, started: i.started, agent: i.agent_state, workOrder: i.work_order ?? null,
        })),
        agent: {
          mode: s.agent?.mode ?? null,
          pending: (s.agent?.pending ?? []).map((p: { lines?: string[] }) => p.lines?.[0] ?? ''),
          trace: (s.agent?.trace ?? []).slice(-4).map((t: { t: number; who: string; text: string }) => ({
            t: t.t, who: t.who, text: t.text,
          })),
        },
        badge: s.lobby?.last_badge ?? null,
        messages: (s.phone?.transcript ?? []).slice(-3).map((m: { t: number; dir: string; text: string }) => ({
          t: m.t, dir: m.dir, text: m.text,
        })),
        boards: { esp32: !!s.hardware?.connected, console: !!s.lobby?.alive },
        facilityId: s.team_app?.facility_id ?? null,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json({ online: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

const ACTIONS: Record<string, (depth?: number) => [string, unknown]> = {
  'grid-start': (depth) => [`/api/grid/request${depth ? `?depth=${depth}` : ''}`, {}],
  'grid-end': () => ['/api/grid/end', {}],
  approve: () => ['/api/manager/reply', { text: 'YES', channel: 'dashboard' }],
  decline: () => ['/api/manager/reply', { text: 'NO', channel: 'dashboard' }],
};

export async function POST(req: Request) {
  try {
    guardOrigin(req);
    const body = (await readJSON(req)) as { action?: string; depth?: number };
    const make = body.action ? ACTIONS[body.action] : undefined;
    if (!make) throw new HttpError(400, 'Unknown hardware action.');
    const depth = Number.isInteger(body.depth) && body.depth! >= 10 && body.depth! <= 90 ? body.depth : undefined;
    const [path, payload] = make(depth);
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new HttpError(502, 'The hardware service rejected the action.');
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof TypeError) return routeError(new HttpError(503, 'Live hardware is offline.'));
    return routeError(error);
  }
}
