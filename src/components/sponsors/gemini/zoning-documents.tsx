'use client';
// Define > Requirements > Documents: upload a zoning code, permit or deed restriction (PDF) and ask Gemini about it.
// Answers cite the PDF's pages. The file is held in the API's memory only (3 hours), never saved to disk.
import { useRef, useState } from 'react';
import { FileText, LoaderCircle, Send, Trash2, Upload } from 'lucide-react';
import { gemini, load, postJson, save } from './api';
import s from './gemini.module.css';

type Doc = { id: string; name: string; title: string; kind: string; pages: number | null; summary: string; suggested: string[]; storage: string };
type Citation = { page: number; section: string; quote: string; page_ok: boolean };
type Answer = { question: string; found: boolean; answer: string; citations: Citation[]; model: string };
const KEY = 'gs-zoning-docs';

export function ZoningDocuments() {
  const [doc, setDoc] = useState<Doc | null>(() => load<{ doc: Doc }>(KEY)?.doc ?? null);
  const [qa, setQa] = useState<Answer[]>(() => load<{ qa: Answer[] }>(KEY)?.qa ?? []);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<'upload' | 'ask' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const persist = (d: Doc | null, a: Answer[]) => { setDoc(d); setQa(a); save(KEY, d ? { doc: d, qa: a } : null); };

  async function upload(f: File) {
    setBusy('upload'); setError(null);
    try {
      const form = new FormData();
      form.append('file', f, f.name);
      persist(await gemini<Doc>('/docs', { method: 'POST', body: form }), []);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); if (file.current) file.current.value = ''; }
  }
  async function ask(question: string) {
    if (!doc || !question.trim()) return;
    setBusy('ask'); setError(null);
    try {
      const a = await gemini<Answer>(`/docs/${doc.id}/ask`, postJson({ question }));
      persist(doc, [a, ...qa].slice(0, 8)); setQ('');
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg.includes('not found') ? 'The API no longer holds this PDF (it keeps documents in memory for 3 hours). Upload it again.' : msg);
    } finally { setBusy(null); }
  }
  function remove() {
    if (doc) void gemini(`/docs/${doc.id}`, { method: 'DELETE' }).catch(() => {});
    persist(null, []);
  }

  return (
    <section className={s.docs} aria-label="Documents">
      <div className={s.docsHead}>
        <span><b>Documents</b><small>Zoning code, permit or deed restriction. Gemini answers from the PDF with page citations.</small></span>
        <input ref={file} type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <button type="button" className="st-btn" onClick={() => file.current?.click()} disabled={busy !== null}>
          {busy === 'upload' ? <><LoaderCircle size={13} className={s.spin} /> Reading…</> : <><Upload size={13} /> {doc ? 'Replace PDF' : 'Upload PDF'}</>}
        </button>
      </div>
      {doc && (
        <div className={s.doc}>
          <div className={s.docMeta}>
            <FileText size={15} />
            <span><b>{doc.title || doc.name}</b><small>{doc.kind}{doc.pages ? ` · ${doc.pages} pages` : ''} · {doc.name}</small></span>
            <button type="button" className={s.x} onClick={remove} title="Forget this document" aria-label="Forget this document"><Trash2 size={13} /></button>
          </div>
          <p className={s.muted}>{doc.summary}</p>
          <form className={s.ask} onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about setbacks, height, noise, generators…" maxLength={600} />
            <button type="submit" className="st-btn primary" disabled={busy !== null || q.trim().length < 2} aria-label="Ask">
              {busy === 'ask' ? <LoaderCircle size={13} className={s.spin} /> : <Send size={13} />}
            </button>
          </form>
          {!qa.length && doc.suggested.length > 0 && (
            <div className={s.chips}>{doc.suggested.map((x) => <button type="button" key={x} onClick={() => void ask(x)} disabled={busy !== null}>{x}</button>)}</div>
          )}
          {qa.map((a, i) => (
            <div key={i} className={s.answer}>
              <b>{a.question}</b>
              <p>{a.found ? a.answer : <span className={s.muted}>{a.answer || 'The document does not answer this.'}</span>}</p>
              {a.citations.map((c, j) => (
                <blockquote key={j} className={c.page_ok ? '' : s.badCite}>
                  <span className={s.page}>p. {c.page}{c.section ? ` · ${c.section}` : ''}</span> “{c.quote}”
                  {!c.page_ok && <em> The PDF has no page {c.page}; check this citation.</em>}
                </blockquote>
              ))}
            </div>
          ))}
          <small className={s.muted}>AI answers from your document; check the cited pages. {doc.storage}</small>
        </div>
      )}
      {error && <p className={s.err}>{error}</p>}
    </section>
  );
}
