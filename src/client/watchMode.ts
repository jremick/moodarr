import type { WatchContext, WatchContextSource } from "../shared/types";
import { settledWatchContext, type ChatCriteria } from "./chatCriteria";

/**
 * The Finder's For Me / Together mode. `picked` is true once the user chooses a mode with the toggle.
 * A picked mode always wins: wording and catalogue titles never replace or clear it. Only a reset does.
 */
export interface WatchModeState {
  readonly watchContext: WatchContext;
  readonly picked: boolean;
}

export const initialWatchMode: WatchModeState = { watchContext: "solo", picked: false };

/** The toggle: the user picked this mode. */
export function pickWatchMode(watchContext: WatchContext): WatchModeState {
  return { watchContext, picked: true };
}

/** Starting a search. A picked mode is kept; an unpicked one shows the context the search will send. */
export function watchModeBeforeSearch(state: WatchModeState, criteria: Pick<ChatCriteria, "watchContext">): WatchModeState {
  if (state.picked) return state;
  return { watchContext: criteria.watchContext, picked: false };
}

/**
 * A search succeeded. A picked mode, including one picked while the search ran, is kept.
 * An unpicked one follows the context the server applied.
 */
export function watchModeAfterSearch(
  state: WatchModeState,
  criteria: Pick<ChatCriteria, "watchContext" | "watchContextSource">,
  appliedContext: WatchContext
): WatchModeState {
  if (state.picked) return state;
  return settledWatchContext(criteria, appliedContext);
}

/** Reset search: back to an unpicked For Me. */
export function resetWatchMode(): WatchModeState {
  return initialWatchMode;
}

/** The watch-context fields for a rerun with the current criteria. */
export function currentWatchModeCriteria(state: WatchModeState): { watchContext: WatchContext; watchContextSource: WatchContextSource } {
  return { watchContext: state.watchContext, watchContextSource: state.picked ? "explicit" : "inferred" };
}
