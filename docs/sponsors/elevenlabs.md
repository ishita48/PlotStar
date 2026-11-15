# ElevenLabs

**Backend** `services/api/app/sponsors/elevenlabs/` · **Frontend** `src/components/sponsors/elevenlabs/`

- **Voice guide ("Talk to GeoStar"):** an ElevenLabs Agents agent configured from `guide.py` (prompt, voice, client
  tools). The browser connects with a signed URL from `routes_guide.py`. Its client tools let it read the screen, fill
  the brief, pick a site, and ask the copilot.
- **Text-to-speech:** `routes_voice.py` proxies ElevenLabs TTS. Without a key the UI uses the browser voice.
- `ELEVENLABS_API_KEY` stays server-side. The guide is billed per minute.

## HAVEN dispatch: a real phone call to the emergency contact

With `CARTESIA_API_KEY` set, the call goes through Cartesia instead (`services/api/app/sponsors/cartesia/dispatch.py`):
a free Cartesia US number calls the contact, no Twilio account or caller verification needed, with the same prompt.
ElevenLabs is the fallback when no Cartesia key is set.

In the Command Center, a fire or leak incident can ring the facility's emergency contact. The HAVEN Dispatch agent
on ElevenLabs Agents places an outbound call, reads out the incident and answers questions using only the incident
details. It never dials 911. It tells the contact to call 911 if anyone is in danger.

- Code: `services/api/app/sponsors/elevenlabs/dispatch.py`, routes in `routes_dispatch.py`, UI in
  `src/components/sponsors/elevenlabs/emergency-call.tsx`.
- Endpoints: `GET /haven/dispatch/status`, `POST /haven/dispatch/call`, `GET /haven/dispatch/call/{conversation_id}`.
- Settings in `.env`: `HAVEN_EMERGENCY_CONTACT` (E.164), optional `ELEVENLABS_PHONE_NUMBER_ID`.
- Needs a phone number connected to ElevenLabs (Agents, Phone numbers: import a Twilio number or a SIP trunk).
  Easiest: put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` in `.env`; the API imports the
  number into ElevenLabs on first use. Until a number exists, the panel keeps the scripted simulation.
- Safeguards: two taps to dial, one call a minute, the browser only sees the last four digits, and the facility name
  (a CoStar address) is not sent unless `COPILOT_LLM_COSTAR=1`.
