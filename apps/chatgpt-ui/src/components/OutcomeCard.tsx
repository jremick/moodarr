import { CheckCircle } from '@phosphor-icons/react';
import type { FeedbackResult, LibraryStats, RequestResult, WatchlistResult } from '../contracts';
import { Notice, RequestIdentity } from './common';

export function RequestOutcome({ outcome }: { outcome: RequestResult }) {
  return <section className="tool-card" aria-label="Moodarr request outcome">
    <div className="card-heading"><div className="outcome-heading"><CheckCircle size={23} aria-hidden="true" /><h1>{outcome.status === 'reconciled' ? 'Request reconciled' : 'Request created'}</h1></div><p>Moodarr confirmed the result of this request attempt.</p></div>
    <div className="detail-body"><RequestIdentity request={outcome.request} /><Notice tone="success">Seerr status: {outcome.seerr.status}.</Notice></div>
  </section>;
}

export function FeedbackOutcome({ outcome }: { outcome: FeedbackResult }) {
  return <section className="tool-card" aria-label="Moodarr feedback outcome"><div className="card-heading"><div className="outcome-heading"><CheckCircle size={23} aria-hidden="true" /><h1>Feedback recorded</h1></div><p>{outcome.deduped ? 'Moodarr already recorded this feedback.' : 'Moodarr confirmed your feedback.'}</p></div><div className="detail-body"><p className="detail-copy muted">Ask ChatGPT for another shortlist when you’re ready.</p></div></section>;
}

export function WatchlistOutcome({ outcome }: { outcome: WatchlistResult }) {
  return <section className="tool-card" aria-label="Moodarr Watchlist outcome"><div className="card-heading"><div className="outcome-heading"><CheckCircle size={23} aria-hidden="true" /><h1>{outcome.alreadyWatchlisted ? 'Already on your Watchlist' : 'Added to Plex Watchlist'}</h1></div><p>Moodarr confirmed this title is on your Plex Watchlist.</p></div></section>;
}

export function StatsCard({ stats }: { stats: LibraryStats }) {
  const rows = [['Titles', stats.totalItems], ['Movies', stats.movies], ['TV series', stats.tv], ['In Plex', stats.availableInPlex], ['Requestable', stats.requestable], ['Already requested', stats.alreadyRequested]] as const;
  return <section className="tool-card" aria-label="Moodarr library summary"><div className="card-heading"><h1>Your library at a glance</h1></div><div className="detail-body"><dl className="stats-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl>{stats.lastLibrarySync && <p className="field-hint">Last library sync: {stats.lastLibrarySync}</p>}</div></section>;
}
