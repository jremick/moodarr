import { useState } from 'react';
import type { Item } from '../contracts';

/** Only component-only raster bytes projected by the bridge can reach this image. */
export function Poster({ item, className = '' }: {
  item: Pick<Item, 'id' | 'title'> & { poster?: { dataUrl: string } };
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const source = item.poster?.dataUrl;
  const imageAvailable = source && /^data:image\/(?:jpeg|png|webp);base64,/.test(source) && source !== failedSource;
  return <div className={`poster ${className}`}>
    <div className="poster-fallback" aria-hidden="true">
      <svg viewBox="0 0 64 64" focusable="false"><rect width="64" height="64" rx="14" fill="#f7dfbd" /><path d="M12 18a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v9a5 5 0 0 0 0 10v9a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4v-9a5 5 0 0 0 0-10Z" fill="#2f3d3a" /><path d="M29 24h13M29 32h9M29 40h13" stroke="#f7dfbd" strokeWidth="3" strokeLinecap="round" /><circle cx="21" cy="32" r="4" fill="#bf7f70" /></svg>
      <span>{item.title}</span><small>Poster unavailable</small>
    </div>
    {imageAvailable && <img src={source} alt={`${item.title} poster`} decoding="async" onError={() => setFailedSource(source)} />}
  </div>;
}
