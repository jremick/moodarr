import { ArrowRight, ThumbsDown, ThumbsUp } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import type { MoodarrBridge } from '../bridge';
import type { Item, SearchResult } from '../contracts';
import { actionError, useCardLifetime, type ActionState } from '../state';
import { Availability, ErrorNotice, Followup, Metadata, Notice } from './common';
import { Poster } from './Poster';

function SearchRow({ item, search, bridge, canAct, canNavigate, feedbackGate }: {
  item: Item; search: SearchResult; bridge: MoodarrBridge; canAct: boolean; canNavigate: boolean;
  feedbackGate: { busy: boolean; acquire: () => boolean; release: () => void };
}) {
  const [feedback, setFeedback] = useState<ActionState>({ state: 'idle' });
  const [chosen, setChosen] = useState<'more_like' | 'less_like'>();
  const [navigation, setNavigation] = useState<'idle' | 'pending' | 'sent' | 'followup'>('idle');
  const feedbackLock = useRef(false);
  const navigationLock = useRef(false);
  const lifetime = useCardLifetime();
  const followup = `Show the Moodarr details for ${JSON.stringify(item.title)} (item ID ${item.id}).`;

  async function viewTitle() {
    if (navigationLock.current) return;
    if (!canNavigate) { setNavigation('followup'); return; }
    navigationLock.current = true;
    setNavigation('pending');
    try {
      await bridge.updateSelectionContext({ itemId: item.id, title: item.title, ...(search.sessionId ? { sessionId: search.sessionId } : {}) });
      if (!lifetime.current) return;
      const sent = await bridge.requestNavigation('moodarr_get_item', { itemId: item.id });
      if (lifetime.current) setNavigation(sent ? 'sent' : 'followup');
    } catch { if (lifetime.current) setNavigation('followup'); }
    finally { navigationLock.current = false; }
  }

  async function recordFeedback(action: 'more_like' | 'less_like') {
    if (feedbackLock.current || !canAct || !search.sessionId || !feedbackGate.acquire()) return;
    feedbackLock.current = true;
    setChosen(action);
    setFeedback({ state: 'pending' });
    try {
      const result = await bridge.callTool('moodarr_record_feedback', {
        action, sessionId: search.sessionId, itemId: item.id,
        clientEventId: `feedback.${crypto.randomUUID()}`, watchContext: search.watchContext,
      });
      if (!lifetime.current) return;
      setFeedback(result.kind === 'error' ? { state: 'error', error: result.data }
        : result.kind === 'feedback' ? { state: 'complete', result }
        : { state: 'error', error: actionError(undefined, true) });
    } catch (error) {
      const fault = actionError(error, true);
      if (fault.status === 'error') feedbackLock.current = false;
      if (lifetime.current) setFeedback({ state: 'error', error: fault });
    } finally { feedbackGate.release(); }
  }

  const feedbackDisabled = !canAct || !search.sessionId || feedbackGate.busy || feedback.state === 'pending' || feedback.state === 'complete'
    || (feedback.state === 'error' && feedbackLock.current);
  return <li><article className="movie-card" aria-label={item.title}>
      <Poster item={item} />
      <h2 className="movie-title">{item.title}</h2>
      <Metadata item={item} />
      {item.matchExplanation && <p className="movie-reason">{item.matchExplanation.length > 240 ? `${item.matchExplanation.slice(0, 237)}…` : item.matchExplanation}</p>}
      <Availability item={item} />
    <div className="movie-actions">
      <button className="button" aria-label={`View ${item.title}`} onClick={viewTitle} disabled={navigation === 'pending' || navigation === 'sent'}>
        {navigation === 'pending' ? 'Opening…' : navigation === 'sent' ? 'Title requested' : 'View title'}<ArrowRight size={15} aria-hidden="true" />
      </button>
      {search.sessionId && <div className="feedback-actions" role="group" aria-label={`Feedback for ${item.title}`}>
        <button className="button feedback-button" aria-label={`More like this: ${item.title}`} title="More like this" aria-pressed={chosen === 'more_like'} disabled={feedbackDisabled} onClick={() => recordFeedback('more_like')}><ThumbsUp size={18} aria-hidden="true" /></button>
        <button className="button feedback-button" aria-label={`Less like this: ${item.title}`} title="Less like this" aria-pressed={chosen === 'less_like'} disabled={feedbackDisabled} onClick={() => recordFeedback('less_like')}><ThumbsDown size={18} aria-hidden="true" /></button>
      </div>}
    </div>
    {navigation === 'followup' && <div className="row-status"><Followup prompt={followup} /></div>}
    {feedback.state === 'pending' && <div className="row-status"><Notice busy>Saving feedback…</Notice></div>}
    {feedback.state === 'complete' && <div className="row-status"><Notice tone="success">Feedback recorded. Ask ChatGPT for another shortlist when you’re ready.</Notice></div>}
    {feedback.state === 'error' && <div className="row-status"><ErrorNotice error={feedback.error} /></div>}
  </article></li>;
}

export function SearchCard({ search, bridge, canAct, canNavigate }: {
  search: SearchResult; bridge: MoodarrBridge; canAct: boolean; canNavigate: boolean;
}) {
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const feedbackPending = useRef(false);
  const feedbackGate = {
    busy: feedbackBusy,
    acquire: () => { if (feedbackPending.current) return false; feedbackPending.current = true; setFeedbackBusy(true); return true; },
    release: () => { feedbackPending.current = false; setFeedbackBusy(false); },
  };
  const items = search.results.slice(0, 8);
  return <section className="tool-card" aria-label="Moodarr recommendations">
    <div className="card-heading"><div className="card-heading-line"><h1>{items.length ? 'Your shortlist' : 'No titles matched'}</h1>
      {items.length > 0 && <span className="result-count">{items.length} {items.length === 1 ? 'title' : 'titles'}</span>}</div>
      <p>{search.summary || (items.length ? 'Explore a title, or tell Moodarr what fits your mood.' : 'Try a broader mood or change one of your constraints in ChatGPT.')}</p>
    </div>
    {items.length > 0 && <ul className="poster-grid">{items.map(item => <SearchRow key={item.id} item={item} search={search} bridge={bridge} canAct={canAct} canNavigate={canNavigate} feedbackGate={feedbackGate} />)}</ul>}
    <div className="card-foot search-foot">
      {!search.sessionId && items.length > 0 && <p>Feedback needs a recommendation session. Ask ChatGPT for a fresh shortlist.</p>}
      {search.watchContext === 'group' && search.sessionId && <p>Feedback applies to the household profile for this group search.</p>}
      {search.results.length > 8 && <p>Showing the first 8 of {search.results.length} results. Ask ChatGPT to narrow the shortlist.</p>}
      <span>Availability from your connected library</span>
      {search.refinementOptions.length > 0 && <details className="refinement"><summary>{search.refinementOptions[0].label}</summary><Followup prompt={search.refinementOptions[0].prompt} /></details>}
    </div>
  </section>;
}
