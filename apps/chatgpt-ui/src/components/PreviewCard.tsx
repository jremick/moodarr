import { CheckCircle } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { MoodarrBridge } from '../bridge';
import type { PreviewResult, RequestResult } from '../contracts';
import { actionError, previewPrompt, requestKey, useCardLifetime, type RequestAttempt, type RequestLedger } from '../state';
import { ErrorNotice, Followup, Notice, RequestIdentity } from './common';
import { Poster } from './Poster';

function exactRequest(a: RequestResult['request'], b: PreviewResult['request']) {
  const seasonSet = (seasons?: number[]) => [...new Set(seasons ?? [])].sort((x, y) => x - y).join(',');
  return a.title === b.title && a.mediaType === b.mediaType && a.mediaId === b.mediaId && seasonSet(a.seasons) === seasonSet(b.seasons);
}

export function PreviewCard({ preview, bridge, canAct, ledger }: {
  preview: PreviewResult; bridge: MoodarrBridge; canAct: boolean; ledger: RequestLedger;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [key, setKey] = useState<string>();
  const [attempt, setAttempt] = useState<RequestAttempt>({ state: 'idle' });
  const [clock, setClock] = useState(Date.now());
  const lock = useRef(false);
  const lifetime = useCardLifetime();
  const ready = preview.status === 'ready_for_confirmation';
  const expired = ready && Date.parse(preview.previewExpiresAt) <= clock;
  const requestLabel = `${preview.request.title}${preview.request.mediaType === 'tv' ? `, seasons ${preview.request.seasons?.join(', ')}` : ''}`;
  const freshPrompt = previewPrompt(preview.request.title, preview.item.id, preview.request.seasons);

  useEffect(() => {
    if (preview.status !== 'ready_for_confirmation') return;
    let active = true;
    void requestKey(preview).then(value => {
      if (!active) return;
      setKey(value);
      const previous = ledger.get(value);
      if (previous) { lock.current = true; setAttempt(previous); }
    }).catch(() => {
      if (active) setAttempt({ state: 'error', error: actionError(undefined) });
    });
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [preview, ledger]);

  function saveAttempt(value: RequestAttempt) {
    if (key) ledger.set(key, value);
    if (lifetime.current) setAttempt(value);
  }

  function cancel() {
    if (lock.current || attempt.state !== 'idle') return;
    lock.current = true;
    setConfirmed(false);
    saveAttempt({ state: 'cancelled' });
  }

  async function createRequest() {
    if (lock.current || !canAct || !confirmed || !key || preview.status !== 'ready_for_confirmation'
      || Date.parse(preview.previewExpiresAt) <= Date.now() || attempt.state !== 'idle') return;
    lock.current = true;
    saveAttempt({ state: 'pending' });
    try {
      const result = await bridge.callTool('moodarr_create_request', { previewHandle: preview.previewHandle, confirmed: true, idempotencyKey: key });
      if (result.kind === 'error') saveAttempt({ state: 'error', error: result.data });
      else if (result.kind === 'request' && exactRequest(result.data.request, preview.request)) saveAttempt({ state: 'complete', result });
      else if (result.kind === 'preview' && result.data.status === 'blocked') saveAttempt({ state: 'complete', result });
      else saveAttempt({ state: 'error', error: actionError(undefined, true) });
    } catch (error) { saveAttempt({ state: 'error', error: actionError(error, true) }); }
  }

  const outcome = attempt.state === 'complete' && attempt.result.kind === 'request' ? attempt.result.data : undefined;
  const blocked = attempt.state === 'complete' && attempt.result.kind === 'preview' ? attempt.result.data : undefined;
  const activePreview = ready && !expired && attempt.state === 'idle';
  return <section className="tool-card" aria-label="Moodarr request preview" aria-busy={attempt.state === 'pending'}>
    <div className="card-heading"><h1>{outcome ? 'Request confirmed' : attempt.state === 'cancelled' ? 'Request cancelled' : 'Review your request'}</h1>
      <p>{outcome ? 'Moodarr confirmed the result of this request attempt.' : 'Check the exact title and selection before you send this request.'}</p></div>
    <div className="detail-body">
      <div className="request-target"><Poster item={preview.item} /><RequestIdentity request={preview.request} /></div>
      {preview.status === 'blocked' && <Notice tone="warning"><strong>Request unavailable</strong><p>{preview.blockedReason || 'Moodarr blocked this request. Ask ChatGPT to check the title again.'}</p></Notice>}
      {activePreview && <>
        <p className="request-note">This will attempt a Seerr request. Live availability has not been checked; Seerr may find that the title is already available or requested.</p>
        <label className="confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!canAct || !key} /><span>I confirm this request for <strong>{requestLabel}</strong>.</span></label>
        <div className="action-group"><button className="button button--primary" onClick={createRequest} disabled={!canAct || !confirmed || !key}><CheckCircle size={17} aria-hidden="true" />Confirm request</button>
          <button className="button" onClick={cancel}>Cancel request</button></div>
        <p className="expires">This confirmation expires at {new Date(preview.previewExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
      </>}
      {expired && attempt.state === 'idle' && <><Notice tone="warning"><strong>Preview expired</strong><p>Ask ChatGPT for a fresh preview, then confirm the title and selected seasons again.</p></Notice><Followup prompt={freshPrompt} /></>}
      {attempt.state === 'pending' && <Notice busy>Sending this request… Wait for a confirmed result before taking another action.</Notice>}
      {outcome && <Notice tone="success"><strong>{outcome.status === 'reconciled' ? 'Request reconciled' : 'Request created'}</strong><p>Seerr status: {outcome.seerr.status}.</p></Notice>}
      {blocked && <Notice tone="warning"><strong>Request blocked</strong><p>{blocked.blockedReason || 'Moodarr blocked this attempt. A fresh preview and confirmation are needed.'}</p></Notice>}
      {attempt.state === 'error' && <ErrorNotice error={attempt.error} />}
      {attempt.state === 'cancelled' && <Notice>The request was cancelled before it was sent. Ask ChatGPT for a fresh preview if you change your mind.</Notice>}
    </div>
  </section>;
}
