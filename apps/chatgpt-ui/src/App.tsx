import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { MoodarrBridge } from './bridge';
import type { MoodarrResult } from './contracts';
import { ItemCard } from './components/ItemCard';
import { FeedbackOutcome, RequestOutcome, StatsCard, WatchlistOutcome } from './components/OutcomeCard';
import { PreviewCard } from './components/PreviewCard';
import { SearchCard } from './components/SearchCard';
import { ErrorNotice, Notice, StateCard } from './components/common';
import type { RequestLedger } from './state';

function PurposeCard({ result, bridge, canAct, canNavigate, ledger }: {
  result: MoodarrResult; bridge: MoodarrBridge; canAct: boolean; canNavigate: boolean; ledger: RequestLedger;
}) {
  switch (result.kind) {
    case 'search': return <SearchCard search={result.data} bridge={bridge} canAct={canAct} canNavigate={canNavigate} />;
    case 'item': return <ItemCard item={result.data.item} bridge={bridge} canAct={canAct} canNavigate={canNavigate} />;
    case 'preview': return <PreviewCard preview={result.data} bridge={bridge} canAct={canAct} ledger={ledger} />;
    case 'request': return <RequestOutcome outcome={result.data} />;
    case 'feedback': return <FeedbackOutcome outcome={result.data} />;
    case 'watchlist': return <WatchlistOutcome outcome={result.data} />;
    case 'stats': return <StatsCard stats={result.data} />;
    case 'error': return <div className="tool-card card-heading"><ErrorNotice error={result.data} /></div>;
  }
}

export default function App({ bridge }: { bridge: MoodarrBridge }) {
  const subscribe = useCallback((listener: () => void) => bridge.subscribe(listener), [bridge]);
  const getSnapshot = useCallback(() => bridge.getSnapshot(), [bridge]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const requestLedger = useRef<RequestLedger>(new Map());
  useEffect(() => { void bridge.connect(); return () => { void bridge.dispose(); }; }, [bridge]);
  useEffect(() => { document.documentElement.dataset.theme = snapshot.host.theme; }, [snapshot.host.theme]);

  let content;
  if (snapshot.phase === 'idle' || snapshot.phase === 'connecting') content = <StateCard title="Connecting to ChatGPT" busy><p>Waiting for the app connection.</p></StateCard>;
  else if (snapshot.phase === 'unavailable') content = <StateCard title="Open this card in ChatGPT"><p>This card needs an MCP app host. Connect Moodarr in ChatGPT’s app settings, then ask it to search your library.</p></StateCard>;
  else if (snapshot.phase === 'error' || snapshot.phase === 'closed') content = <StateCard title="Connection needs attention" warning><p>{snapshot.interruptedMutation ? 'The app connection has ended. The action’s outcome still needs verification.' : 'Reconnect Moodarr in ChatGPT’s app settings, then ask for a fresh result.'}</p></StateCard>;
  else if (snapshot.tool.state === 'cancelled') content = <StateCard title={snapshot.interruptedMutation ? 'Outcome needs verification' : 'Action cancelled'}><p>{snapshot.interruptedMutation ? 'An action has an unconfirmed outcome. Verify the attempt in Moodarr before trying it again.' : 'No confirmed result was received. Continue in ChatGPT when you’re ready.'}</p></StateCard>;
  else if (snapshot.tool.state === 'waiting') content = <StateCard title="Waiting for Moodarr"><p>ChatGPT may need your approval before it can send this tool’s input. Once approved, the result will appear here.</p></StateCard>;
  else if (snapshot.tool.state === 'pending') content = <StateCard title="Checking your library" busy><p>Waiting for Moodarr’s result.</p></StateCard>;
  else if (snapshot.tool.result) content = <PurposeCard key={snapshot.tool.epoch} result={snapshot.tool.result} bridge={bridge}
    canAct={snapshot.host.canCallTools} canNavigate={snapshot.host.canSendMessages} ledger={requestLedger.current} />;
  else content = <StateCard title="Result could not be read" warning><p>{snapshot.interruptedMutation ? 'The action’s outcome still needs verification in Moodarr.' : 'Moodarr did not return a supported result. Ask ChatGPT to try the read again.'}</p></StateCard>;

  return <main className="widget" aria-label="Moodarr result">
    {snapshot.interruptedMutation && <div className="global-notice"><Notice tone="warning"><strong>Outcome unconfirmed</strong><p>An action has an unconfirmed outcome. Verify the attempt in Moodarr before trying it again.</p></Notice></div>}
    {snapshot.phase === 'ready' && !snapshot.host.canCallTools && snapshot.tool.result && <div className="global-notice"><Notice>Actions are unavailable in this host. Continue in ChatGPT to review Moodarr’s connection and access.</Notice></div>}
    {content}
  </main>;
}
