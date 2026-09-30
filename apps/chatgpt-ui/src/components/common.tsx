import { CheckCircle, CircleNotch, Info, WarningCircle } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { ErrorResult, Item } from '../contracts';

export function Notice({ children, tone = 'neutral', busy = false }: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning';
  busy?: boolean;
}) {
  const Icon = busy ? CircleNotch : tone === 'success' ? CheckCircle : tone === 'warning' ? WarningCircle : Info;
  return <div className={`notice notice--${tone}`} role={tone === 'warning' ? 'alert' : 'status'}>
    <Icon size={18} className={busy ? 'spinner' : undefined} aria-hidden="true" />
    <div>{children}</div>
  </div>;
}

export function StateCard({ title, children, busy = false, warning = false }: {
  title: string;
  children: ReactNode;
  busy?: boolean;
  warning?: boolean;
}) {
  const Icon = busy ? CircleNotch : warning ? WarningCircle : Info;
  return <section className="state-card" aria-label={title} aria-busy={busy}>
    <Icon size={24} weight="regular" className={busy ? 'spinner' : undefined} aria-hidden="true" />
    <div><h1>{title}</h1><div className="state-copy">{children}</div></div>
  </section>;
}

export function ErrorNotice({ error }: { error: ErrorResult }) {
  const unconfirmed = error.status === 'uncertain';
  const auth = /auth|session|reconnect|token|unauthorized/i.test(error.code) || error.httpStatus === 401;
  const scope = /scope|permission|forbidden/i.test(error.code) || error.httpStatus === 403;
  return <Notice tone="warning">
    <strong>{unconfirmed ? 'Outcome unconfirmed' : auth ? 'Reconnect to Moodarr' : scope ? 'Permission required' : 'Action could not be completed'}</strong>
    <p>{error.message}</p>
    {unconfirmed && <p>Verify this attempt in Moodarr before trying again. This card will not send another attempt.</p>}
    {auth && !unconfirmed && <p>Reconnect Moodarr in ChatGPT’s app settings, then ask for a fresh result.</p>}
    {scope && !unconfirmed && <p>Review the access granted to Moodarr in ChatGPT’s app settings.</p>}
  </Notice>;
}

export function Followup({ prompt, label = 'Continue in ChatGPT' }: { prompt: string; label?: string }) {
  return <div className="followup"><span>{label}</span><p className="followup-prompt">{prompt}</p></div>;
}

const availabilityLabels: Record<Item['availabilityGroup'], string> = {
  available_in_plex: 'In your Plex library',
  not_in_plex_requestable: 'Request can be attempted',
  already_requested: 'Already requested',
  partially_available: 'Partly available',
  unavailable: 'Unavailable',
};

export function Availability({ item, explanation = false }: { item: Item; explanation?: boolean }) {
  return <div className="availability-block"><p className={`availability${item.availabilityGroup === 'available_in_plex' ? ' availability--available' : ''}`}>
    <span className="availability-dot" aria-hidden="true" />{availabilityLabels[item.availabilityGroup]}
  </p>{explanation && item.availabilityExplanation && <p className="muted detail-copy">{item.availabilityExplanation}</p>}</div>;
}

export function Metadata({ item }: { item: Item }) {
  const minutes = item.runtimeMinutes ? Math.round(item.runtimeMinutes) : undefined;
  const duration = minutes ? minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m` : undefined;
  const parts = [item.mediaType === 'tv' ? 'TV series' : undefined, item.year,
    duration, item.contentRating].filter(value => value !== undefined && value !== '');
  return <p className="metadata">{parts.map((part, index) => <span key={`${part}-${index}`}>{part}</span>)}</p>;
}

export function RequestIdentity({ request }: { request: { title: string; mediaType: 'movie' | 'tv'; mediaId: number; seasons?: number[] } }) {
  return <dl className="request-identity">
    <div><dt>Title</dt><dd>{request.title}</dd></div>
    <div><dt>Type</dt><dd>{request.mediaType === 'tv' ? 'TV series' : 'Movie'}</dd></div>
    {request.mediaType === 'tv' && <div><dt>Selected seasons</dt><dd>{request.seasons?.join(', ') || 'No seasons selected'}</dd></div>}
  </dl>;
}
