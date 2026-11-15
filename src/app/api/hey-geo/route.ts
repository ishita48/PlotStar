/**
 * POST /api/hey-geo — one Hey Geo turn.
 * Body: AgentRequest (src/lib/hey-geo/schema.ts). Returns newline-delimited JSON:
 *   {"type":"speech","speech","voiceToken"}  as soon as Claude has written the spoken line (Geo starts talking)
 *   {"type":"final","reply","voiceToken"}     the validated reply (annotations, evacuation, tasks, report…)
 *   {"type":"error","error"}
 * voiceToken lets /api/voice speak exactly these server-produced words with Cartesia; the page never sends text to speak.
 *
 * CoStar data stays out of Claude unless COPILOT_LLM_COSTAR=1: every string of the request is redacted here first
 * (src/lib/hey-geo/redact.ts). The X-Hey-Geo-Redacted header reports how many values of each kind were hidden
 * (counts only, never the values).
 */
import { guardOrigin, HttpError } from '@/lib/http';
import { heyGeoConfigured, heyGeoModel, runHeyGeo } from '@/lib/hey-geo/agent';
import { cartesiaConfigured } from '@/lib/hey-geo/cartesia';
import { costarNamesPattern } from '@/lib/hey-geo/costar-names';
import { protectionDigest, protectionFrom } from '@/lib/hey-geo/protection-digest';
import { costarAllowed, emptyCounts, redactDeep, redactText, totalRedactions } from '@/lib/hey-geo/redact';
import { AgentRequestSchema } from '@/lib/hey-geo/schema';
import { issueVoiceToken } from '@/lib/hey-geo/voice-tokens';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const MAX_BODY = 600_000;
const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

/** GET /api/hey-geo → what the panel says about itself (no secrets): configured, model, whether CoStar data is redacted. */
export function GET() {
  return Response.json(
    { configured: heyGeoConfigured(), model: heyGeoConfigured() ? heyGeoModel() : null, costarRedacted: !costarAllowed(), voice: cartesiaConfigured() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  if (!heyGeoConfigured()) return refuse(503, 'Hey Geo needs ANTHROPIC_API_KEY on the server.');
  try {
    guardOrigin(request);
  } catch (e) {
    return refuse(e instanceof HttpError ? e.status : 403, 'Cross-origin requests are not allowed.');
  }
  const raw = await request.text().catch(() => '');
  if (!raw || raw.length > MAX_BODY) return refuse(413, 'That request is too large.');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return refuse(400, 'Expected JSON.');
  }
  const parsed = AgentRequestSchema.safeParse(json);
  if (!parsed.success)
    return refuse(400, `Invalid Hey Geo request: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

  const protection = protectionFrom(parsed.data.protection);
  const redacting = !costarAllowed();
  const counts = emptyCounts();
  let body = { ...parsed.data, protection: undefined };
  let protectionText = protectionDigest(protection, { hideName: redacting });
  let namesListed = true;
  if (redacting) {
    const names = await costarNamesPattern(protection?.facility.name ? [protection.facility.name] : []);
    namesListed = names.listed;
    body = redactDeep(body, counts, names.re);
    protectionText = redactText(protectionText, counts, names.re);
  }
  const reports = body.reports?.map((r) => `- ${r.at} ${r.title} (${r.kind})`).join('\n');
  const extra = {
    now: new Date(Date.now() - (body.tzOffsetMin ?? 0) * 60_000).toISOString().replace('Z', '') + ' (local time)',
    protection: protectionText,
    redaction: redacting
      ? `Licensed CoStar details were removed before you saw this page (${totalRedactions(counts)} values this turn). Placeholders: [property name], [address], [price], [coordinates], [costar-id], [phone], [email].`
      : null,
    reports: reports || undefined,
  };
  const voice = cartesiaConfigured();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // The client aborts superseded turns; writing after that must not throw.
      let open = true;
      const send = (o: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
        } catch {
          open = false;
        }
      };
      try {
        const reply = await runHeyGeo(body, extra, {
          signal: request.signal,
          onSpeech: (speech) => send({ type: 'speech', speech, voiceToken: voice ? issueVoiceToken(speech) : null }),
        });
        send({ type: 'final', reply, voiceToken: voice ? issueVoiceToken(reply.speech) : null });
      } catch (error) {
        if (!request.signal.aborted) {
          // A status line (HTTP code / error type) only, never request content or keys.
          console.error('[hey-geo]', error instanceof Error ? error.message : 'unknown error');
          send({
            type: 'error',
            error: error instanceof Error && error.message.startsWith('Hey Geo') ? error.message : "Hey Geo couldn't reach Claude, try again in a moment.",
          });
        }
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      'X-Hey-Geo-Redacted': redacting ? JSON.stringify(counts) : 'off',
      'X-Hey-Geo-Costar-Names': redacting ? (namesListed ? 'listed' : 'unavailable') : 'off',
    },
  });
}
