// Hey Geo: the model's reply is parsed robustly; the person never sees a parse error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstJsonObject, lenientJson, NOT_CAUGHT, parseModelReply } from '../src/lib/hey-geo/reply';

const ids = new Set(['e1', 'e2']);

test('plain JSON parses and keeps annotations on known elements only', () => {
  const r = parseModelReply(
    JSON.stringify({ speech: 'Here it is.', annotations: [{ type: 'circle', target: { kind: 'element', elementId: 'e1' } }, { type: 'circle', target: { kind: 'element', elementId: 'e9' } }] }),
    ids,
  );
  assert.ok(r);
  assert.equal(r.speech, 'Here it is.');
  assert.equal(r.annotations.length, 1);
});

test('code fences, prose around the object and trailing commas are repaired', () => {
  const fenced = '```json\n{"speech": "Fenced.", "tasks": [],}\n```';
  assert.equal(parseModelReply(fenced, ids)?.speech, 'Fenced.');
  const prose = 'Sure! Here you go: {"speech": "Inside {braces} and \\"quotes\\".", "annotations": []} Hope that helps.';
  assert.equal(parseModelReply(prose, ids)?.speech, 'Inside {braces} and "quotes".');
});

test('first balanced object respects strings', () => {
  assert.equal(firstJsonObject('x {"a": "}", "b": {"c": 1}} y {"z": 2}'), '{"a": "}", "b": {"c": 1}}');
  assert.equal(lenientJson('no json here'), null);
});

test('strict mode asks for a retry; the final attempt falls back to speaking the text', () => {
  const prose = "*Pewds* isn't something I know. Try asking about the site.";
  assert.equal(parseModelReply(prose, ids, true), null);
  assert.equal(parseModelReply(prose, ids, false)?.speech, "Pewds isn't something I know. Try asking about the site.");
});

test('a reply cut off after the speech field keeps the speech', () => {
  const cut = '{"speech": "Half a reply.", "annotations": [{"type": "circ';
  assert.equal(parseModelReply(cut, ids, false)?.speech, 'Half a reply.');
});

test('nothing usable becomes a friendly "didn\'t catch that"', () => {
  assert.equal(parseModelReply('', ids, false)?.speech, NOT_CAUGHT);
  assert.equal(parseModelReply('{"foo": 1}', ids, false)?.speech, NOT_CAUGHT);
});
