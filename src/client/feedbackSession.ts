import type { AuthSessionResponse, FeelFeedbackRequest, FeelFeedbackResponse, ItemSummary, WatchContext } from "../shared/types";
import { createId, extractFeedbackMoodTerm, type RecommendationFeedback } from "./features/finder/finderModel";

type RatingAction = "more_like" | "less_like" | "swipe_skip";
type SelectionAction = RatingAction | "right_mood";
type FeedbackSlot = "rating" | "preferred_example";

export type FeedbackChoice =
  | { slot: "rating"; action: RatingAction }
  | { slot: "preferred_example"; action: "right_mood" }
  | { slot: "restore"; feedback?: RecommendationFeedback; preferred: boolean };

export interface DisplayedFeedbackSession {
  readonly principalKey: string | null;
  readonly searchGeneration: number;
  readonly sessionId?: string;
  readonly watchContext: WatchContext;
  readonly moodTerm?: string;
  readonly items: readonly { readonly id: string; readonly title: string }[];
}

export interface FeedbackSelectionSnapshot {
  feedbackByItem: Record<string, RecommendationFeedback>;
  feedbackTitleByItem: Record<string, string>;
  preferredExampleByItem: Record<string, boolean>;
  preferredExampleTitleByItem: Record<string, string>;
}

export type FeedbackMutationResult =
  | { status: "stale" }
  | { status: "busy" }
  | { status: "acknowledged"; selection: FeedbackSelectionSnapshot }
  | { status: "failed"; selection: FeedbackSelectionSnapshot; message: string };

interface ActiveSelection {
  action: SelectionAction;
}

interface MutationStep {
  slot: FeedbackSlot;
  action: SelectionAction | null;
  request?: FeelFeedbackRequest;
}

interface ItemFeedbackState {
  active: Partial<Record<FeedbackSlot, ActiveSelection>>;
  latestEventIds: Partial<Record<FeedbackSlot, string>>;
  inFlight: boolean;
  operation?: { choice: FeedbackChoice; remaining: MutationStep[] };
}

export function feedbackPrincipalKey(session: AuthSessionResponse | null): string | null {
  if (!session) return null;
  if (!session.authenticated) return "shared";
  return session.user?.id ? `user:${session.user.id}` : null;
}

/** Keeps immutable feedback writes attached to the slate and account that produced them. */
export class FeedbackSessionController {
  private displayed: DisplayedFeedbackSession | null = null;
  private itemStates = new Map<string, ItemFeedbackState>();

  constructor(
    private readonly send: (request: FeelFeedbackRequest) => Promise<FeelFeedbackResponse>,
    private readonly newId: () => string = createId
  ) {}

  activate(input: {
    principalKey: string | null;
    searchGeneration: number;
    sessionId?: string;
    watchContext: WatchContext;
    query: string;
    items: readonly Pick<ItemSummary, "id" | "title">[];
  }): DisplayedFeedbackSession {
    this.invalidate();
    this.displayed = Object.freeze({
      principalKey: input.principalKey,
      searchGeneration: input.searchGeneration,
      sessionId: input.sessionId,
      watchContext: input.watchContext,
      moodTerm: extractFeedbackMoodTerm(input.query),
      items: Object.freeze(input.items.map(({ id, title }) => Object.freeze({ id, title })))
    });
    return this.displayed;
  }

  invalidate() {
    this.displayed = null;
    this.itemStates = new Map();
  }

  isCurrent(session: DisplayedFeedbackSession | null): session is DisplayedFeedbackSession {
    return session !== null && session === this.displayed;
  }

  get hasInFlight() {
    return [...this.itemStates.values()].some((state) => state.inFlight);
  }

  isItemInFlight(itemId: string) {
    return this.itemStates.get(itemId)?.inFlight === true;
  }

  get retryNotice(): string | undefined {
    for (const [itemId, state] of this.itemStates) {
      if (state.operation && !state.inFlight) return `Some feedback could not be confirmed. ${this.retryInstruction(itemId, state.operation.choice)}`;
    }
    return undefined;
  }

  snapshot(): FeedbackSelectionSnapshot {
    const selection: FeedbackSelectionSnapshot = {
      feedbackByItem: {}, feedbackTitleByItem: {}, preferredExampleByItem: {}, preferredExampleTitleByItem: {}
    };
    for (const item of this.displayed?.items ?? []) {
      const active = this.itemStates.get(item.id)?.active;
      if (active?.rating) {
        selection.feedbackByItem[item.id] = active.rating.action === "more_like" ? "up" : active.rating.action === "less_like" ? "down" : "maybe";
        selection.feedbackTitleByItem[item.id] = item.title;
      }
      if (active?.preferred_example) {
        selection.preferredExampleByItem[item.id] = true;
        selection.preferredExampleTitleByItem[item.id] = item.title;
      }
    }
    return selection;
  }

  async choose(session: DisplayedFeedbackSession | null, itemId: string, choice: FeedbackChoice): Promise<FeedbackMutationResult> {
    if (!this.isCurrent(session)) return { status: "stale" };
    if (!session.sessionId || !session.principalKey) {
      return this.failed("This search could not be recorded. Search again before saving feedback.");
    }
    const itemRank = session.items.findIndex((item) => item.id === itemId);
    if (itemRank < 0) return this.failed("That title is no longer in this search. Search again before saving feedback.");
    const state: ItemFeedbackState = this.itemStates.get(itemId) ?? { active: {}, latestEventIds: {}, inFlight: false };
    this.itemStates.set(itemId, state);
    if (state.inFlight) return { status: "busy" };
    if (state.operation && !this.sameChoice(state.operation.choice, choice)) {
      return this.failed(`The previous feedback could not be confirmed. ${this.retryInstruction(itemId, state.operation.choice)}`);
    }
    state.operation ??= { choice: { ...choice }, remaining: this.planChoice(state, choice) };
    state.inFlight = true;
    try {
      while (state.operation.remaining.length) {
        if (!this.isCurrent(session)) return { status: "stale" };
        const step = state.operation.remaining[0]!;
        step.request ??= Object.freeze({
          action: step.action ?? "clear_feedback",
          source: "web",
          clientEventId: this.newId(),
          replacesClientEventId: state.latestEventIds[step.slot],
          sessionId: session.sessionId,
          itemId,
          watchContext: session.watchContext,
          moodTerm: session.moodTerm,
          strength: step.action === "right_mood" ? 5 : undefined,
          metadata: Object.freeze({
            feedbackSlot: step.slot,
            surface: step.slot === "rating" ? "finder-result-card" : "finder-result-card-heart",
            resultRank: itemRank + 1,
            resultCount: session.items.length
          })
        });
        const response = await this.send(step.request);
        if (!this.isCurrent(session)) return { status: "stale" };
        if (response?.ok !== true) throw new Error("The server did not confirm the feedback.");
        state.latestEventIds[step.slot] = step.request.clientEventId!;
        if (step.action) state.active[step.slot] = { action: step.action };
        else delete state.active[step.slot];
        state.operation.remaining.shift();
      }
      delete state.operation;
      return { status: "acknowledged", selection: this.snapshot() };
    } catch (error) {
      if (!this.isCurrent(session)) return { status: "stale" };
      const detail = error instanceof Error ? error.message : String(error);
      return this.failed(`${detail} ${this.retryInstruction(itemId, state.operation!.choice)}`);
    } finally {
      state.inFlight = false;
    }
  }

  private failed(message: string): FeedbackMutationResult {
    return { status: "failed", selection: this.snapshot(), message };
  }

  private retryInstruction(itemId: string, choice: FeedbackChoice) {
    const title = this.displayed?.items.find((item) => item.id === itemId)?.title ?? "this title";
    if (choice.slot === "restore") return `Click Undo for ${title} again to retry, or start a new search.`;
    const control = choice.slot === "preferred_example" ? `the heart for ${title}`
      : `${choice.action === "more_like" ? "More like" : choice.action === "less_like" ? "Less like" : "Maybe"} ${title}`;
    return `Click ${control} again to retry, or start a new search.`;
  }

  private planChoice(state: ItemFeedbackState, choice: FeedbackChoice): MutationStep[] {
    if (choice.slot === "restore") {
      const rating = choice.feedback === "up" ? "more_like" : choice.feedback === "down" ? "less_like" : choice.feedback === "maybe" ? "swipe_skip" : null;
      const preferred = choice.preferred && rating !== "less_like" ? "right_mood" : null;
      const steps: MutationStep[] = [];
      if (!preferred && state.active.preferred_example) steps.push({ slot: "preferred_example", action: null });
      if ((state.active.rating?.action ?? null) !== rating) steps.push({ slot: "rating", action: rating });
      if (preferred && !state.active.preferred_example) steps.push({ slot: "preferred_example", action: preferred });
      return steps;
    }
    const action = state.active[choice.slot]?.action === choice.action ? null : choice.action;
    const steps: MutationStep[] = [];
    if (action === "less_like" && state.active.preferred_example) steps.push({ slot: "preferred_example", action: null });
    if (action === "right_mood" && state.active.rating?.action === "less_like") steps.push({ slot: "rating", action: null });
    steps.push({ slot: choice.slot, action });
    return steps;
  }

  private sameChoice(left: FeedbackChoice, right: FeedbackChoice) {
    if (left.slot === "restore" || right.slot === "restore") {
      return left.slot === "restore" && right.slot === "restore" && left.feedback === right.feedback && left.preferred === right.preferred;
    }
    return left.slot === right.slot && left.action === right.action;
  }
}
