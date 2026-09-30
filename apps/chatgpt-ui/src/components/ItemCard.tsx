import { ArrowRight, Plus } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import type { MoodarrBridge } from '../bridge';
import type { ItemDetail } from '../contracts';
import { actionError, parseSeasons, previewPrompt, useCardLifetime, type ActionState } from '../state';
import { Availability, ErrorNotice, Followup, Metadata, Notice } from './common';
import { Poster } from './Poster';

export function ItemCard({ item, bridge, canAct, canNavigate }: {
  item: ItemDetail; bridge: MoodarrBridge; canAct: boolean; canNavigate: boolean;
}) {
  const [watchlist, setWatchlist] = useState<ActionState>({ state: 'idle' });
  const [navigation, setNavigation] = useState<'idle' | 'pending' | 'sent' | 'followup'>('idle');
  const [seasonInput, setSeasonInput] = useState('');
  const [seasonError, setSeasonError] = useState(false);
  const [followup, setFollowup] = useState('');
  const watchlistLock = useRef(false);
  const navigationLock = useRef(false);
  const lifetime = useCardLifetime();
  const eligibleWatchlist = item.plex?.available === true && item.availabilityGroup === 'available_in_plex' && !item.catalogIdentityAmbiguous;
  const requestable = !item.catalogIdentityAmbiguous && item.availabilityGroup !== 'already_requested' && Boolean(item.requestAttempt?.available || item.seerr?.requestable);

  async function addWatchlist() {
    if (watchlistLock.current || !canAct || !eligibleWatchlist) return;
    watchlistLock.current = true;
    setWatchlist({ state: 'pending' });
    try {
      const result = await bridge.callTool('moodarr_add_to_watchlist', { itemId: item.id });
      if (!lifetime.current) return;
      setWatchlist(result.kind === 'error' ? { state: 'error', error: result.data }
        : result.kind === 'watchlist' ? { state: 'complete', result }
        : { state: 'error', error: actionError(undefined, true) });
    } catch (error) { if (lifetime.current) setWatchlist({ state: 'error', error: actionError(error, true) }); }
  }

  async function previewRequest() {
    if (navigationLock.current || !requestable) return;
    const seasons = item.mediaType === 'tv' ? parseSeasons(seasonInput) : undefined;
    if (item.mediaType === 'tv' && !seasons) { setSeasonError(true); return; }
    setSeasonError(false);
    const prompt = previewPrompt(item.title, item.id, seasons);
    if (!canNavigate) { setFollowup(prompt); setNavigation('followup'); return; }
    navigationLock.current = true;
    setNavigation('pending');
    try {
      await bridge.updateSelectionContext({ itemId: item.id, title: item.title });
      if (!lifetime.current) return;
      const sent = await bridge.requestNavigation('moodarr_preview_request', { itemId: item.id, ...(seasons ? { seasons } : {}) });
      if (lifetime.current) { setFollowup(sent ? '' : prompt); setNavigation(sent ? 'sent' : 'followup'); }
    } catch { if (lifetime.current) { setFollowup(prompt); setNavigation('followup'); } }
    finally { navigationLock.current = false; }
  }

  return <section className="tool-card title-card" aria-label="Moodarr title details">
    <div className="title-layout">
      <Poster item={item} className="detail-poster" />
      <div className="title-body">
      {item.genres.length > 0 && <p className="genre-eyebrow">{item.genres.join(' · ')}</p>}
      <h1>{item.title}</h1>
      <Metadata item={item} />
      {item.directors.length > 0 && <p className="title-director">Directed by {item.directors.slice(0, 4).join(', ')}</p>}
      <Availability item={item} />
      {item.summary && <p className="title-description">{item.summary}</p>}
      {item.matchExplanation && <div className="match-note"><strong>Why it fits</strong><p>{item.matchExplanation}</p></div>}
      {item.availabilityExplanation && <p className="content-note">{item.availabilityExplanation}</p>}
      <dl className="detail-meta">
        {item.cast.length > 0 && <div><dt>Cast</dt><dd>{item.cast.slice(0, 6).join(', ')}</dd></div>}
      </dl>
      {item.catalogIdentityAmbiguous && <Notice tone="warning">This title has an ambiguous catalog identity. Ask ChatGPT to find the exact title before taking an action.</Notice>}
      {requestable && item.mediaType === 'tv' && <div className="season-field">
        <label htmlFor="selected-seasons">Selected seasons</label>
        <input id="selected-seasons" inputMode="numeric" value={seasonInput} onChange={event => { setSeasonInput(event.target.value); setSeasonError(false); }} placeholder="For example: 1, 2" aria-describedby="season-hint season-error" aria-invalid={seasonError} maxLength={500} disabled={navigation === 'pending' || navigation === 'sent'} />
        <p id="season-hint" className="field-hint">Enter the exact seasons you want. Moodarr has not provided a season inventory for this title.</p>
        {seasonError && <p id="season-error" className="field-error" role="alert">Enter season numbers from 1 to 1000, separated by commas.</p>}
      </div>}
      {(eligibleWatchlist || requestable) && <div className="action-group">
        {eligibleWatchlist && <button className="button button--primary" onClick={addWatchlist} disabled={!canAct || watchlist.state !== 'idle'}><Plus size={17} aria-hidden="true" />{watchlist.state === 'pending' ? 'Adding…' : watchlist.state === 'complete' ? 'Added to Watchlist' : 'Add to Plex Watchlist'}</button>}
        {requestable && <button className={`button${eligibleWatchlist ? '' : ' button--primary'}`} onClick={previewRequest} disabled={navigation === 'pending' || navigation === 'sent'}>{navigation === 'pending' ? 'Opening preview…' : navigation === 'sent' ? 'Preview requested' : 'Preview request'}<ArrowRight size={16} aria-hidden="true" /></button>}
      </div>}
      {watchlist.state === 'pending' && <Notice busy>Adding to Plex Watchlist…</Notice>}
      {watchlist.state === 'complete' && <Notice tone="success">{watchlist.result.kind === 'watchlist' && watchlist.result.data.alreadyWatchlisted ? 'This title is already on your Plex Watchlist.' : 'Added to your Plex Watchlist.'}</Notice>}
      {watchlist.state === 'error' && <ErrorNotice error={watchlist.error} />}
      {navigation === 'followup' && <Followup prompt={followup} />}
      {requestable && <p className="field-hint">The preview shows the exact request before you confirm. Live Seerr availability has not been checked.</p>}
      </div>
    </div>
  </section>;
}
