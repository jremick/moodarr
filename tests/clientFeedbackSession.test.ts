import { describe, expect, it, vi } from "vitest";
import { FeedbackSessionController, feedbackPrincipalKey, type FeedbackChoice } from "../src/client/feedbackSession";
import type { AuthSessionResponse, FeelFeedbackResponse } from "../src/shared/types";

const acknowledged: FeelFeedbackResponse = { ok: true, eventId: 1, reliability: "high", appliedPreferenceSignal: true };
const up: FeedbackChoice = { slot: "rating", action: "more_like" };
const down: FeedbackChoice = { slot: "rating", action: "less_like" };
const maybe: FeedbackChoice = { slot: "rating", action: "swipe_skip" };
const heart: FeedbackChoice = { slot: "preferred_example", action: "right_mood" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function setup() {
  const send = vi.fn<(request: import("../src/shared/types").FeelFeedbackRequest) => Promise<FeelFeedbackResponse>>().mockResolvedValue(acknowledged);
  let id = 0;
  const controller = new FeedbackSessionController(send, () => `event-${++id}`);
  const input = {
    principalKey: "user:alice",
    searchGeneration: 3,
    sessionId: "search-1",
    watchContext: "solo" as const,
    query: "Something cozy and funny",
    items: [{ id: "first", title: "Harbor Comfort" }, { id: "second", title: "Quiet Nights" }]
  };
  const session = controller.activate(input);
  return { send, controller, input, session };
}

describe("displayed recommendation feedback session", () => {
  it("captures the displayed slate context and waits for acknowledgement before selecting", async () => {
    const { send, controller, input, session } = setup();
    const pending = deferred<FeelFeedbackResponse>();
    send.mockReturnValueOnce(pending.promise);
    input.query = "a dark movie";
    input.items[1]!.title = "A different title";
    const saving = controller.choose(session, "second", heart);

    expect(controller.hasInFlight).toBe(true);
    expect(controller.snapshot().preferredExampleByItem).toEqual({});
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      action: "right_mood", clientEventId: "event-1", sessionId: "search-1", source: "web",
      itemId: "second", watchContext: "solo", moodTerm: "cozy", strength: 5,
      metadata: { feedbackSlot: "preferred_example", surface: "finder-result-card-heart", resultRank: 2, resultCount: 2 }
    }));
    pending.resolve(acknowledged);
    expect(await saving).toMatchObject({ status: "acknowledged", selection: {
      preferredExampleByItem: { second: true }, preferredExampleTitleByItem: { second: "Quiet Nights" }
    } });
    expect(controller.hasInFlight).toBe(false);
  });

  it("replaces the latest slot event and records toggling off as a new clear event", async () => {
    const { send, controller, session } = setup();
    await controller.choose(session, "first", up);
    await controller.choose(session, "first", up);
    expect(controller.snapshot().feedbackByItem).toEqual({});
    await controller.choose(session, "first", up);
    await controller.choose(session, "first", maybe);

    expect(send.mock.calls.map(([body]) => [body.action, body.clientEventId, body.replacesClientEventId])).toEqual([
      ["more_like", "event-1", undefined],
      ["clear_feedback", "event-2", "event-1"],
      ["more_like", "event-3", "event-2"],
      ["swipe_skip", "event-4", "event-3"]
    ]);
    expect(send.mock.calls.every(([body]) => body.metadata?.feedbackSlot === "rating")).toBe(true);
    expect(controller.snapshot().feedbackByItem).toEqual({ first: "maybe" });
  });

  it("retries an uncertain response with the identical body and event ID before allowing a new intention", async () => {
    const { send, controller, session } = setup();
    send.mockRejectedValueOnce(new Error("Connection closed after sending."));
    expect(await controller.choose(session, "first", up)).toMatchObject({ status: "failed", selection: { feedbackByItem: {} } });
    const original = send.mock.calls[0]![0];
    expect(await controller.choose(session, "first", down)).toMatchObject({ status: "failed", message: expect.stringContaining("Click More like Harbor Comfort again") });
    expect(send).toHaveBeenCalledTimes(1);

    send.mockResolvedValueOnce({ ...acknowledged, deduped: true });
    expect(await controller.choose(session, "first", up)).toMatchObject({ status: "acknowledged", selection: { feedbackByItem: { first: "up" } } });
    expect(send.mock.calls[1]![0]).toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
    await controller.choose(session, "first", up);
    expect(send.mock.calls[2]![0]).toMatchObject({ action: "clear_feedback", clientEventId: "event-2", replacesClientEventId: "event-1" });
  });

  it("serializes mutations for one item while allowing independent items to save", async () => {
    const { send, controller, session } = setup();
    const first = deferred<FeelFeedbackResponse>();
    send.mockReturnValueOnce(first.promise);
    const saving = controller.choose(session, "first", up);
    expect(await controller.choose(session, "first", up)).toEqual({ status: "busy" });
    expect(await controller.choose(session, "first", heart)).toEqual({ status: "busy" });
    await controller.choose(session, "second", maybe);
    expect(send).toHaveBeenCalledTimes(2);
    first.resolve(acknowledged);
    expect(await saving).toMatchObject({ status: "acknowledged", selection: { feedbackByItem: { first: "up", second: "maybe" } } });
  });

  it("keeps an actionable retry notice when another title saves successfully", async () => {
    const { send, controller, session } = setup();
    send.mockRejectedValueOnce(new Error("Response lost."));
    await controller.choose(session, "first", heart);
    await controller.choose(session, "second", up);
    expect(controller.retryNotice).toContain("Click the heart for Harbor Comfort again");
    await controller.choose(session, "first", heart);
    expect(controller.retryNotice).toBeUndefined();
  });

  it("clears an opposing slot before setting a choice and retains acknowledged partial progress on failure", async () => {
    const { send, controller, session } = setup();
    await controller.choose(session, "first", up);
    await controller.choose(session, "first", heart);
    send.mockResolvedValueOnce(acknowledged).mockRejectedValueOnce(new Error("Reply lost."));
    expect(await controller.choose(session, "first", down)).toMatchObject({
      status: "failed", selection: { feedbackByItem: { first: "up" }, preferredExampleByItem: {} }
    });
    expect(send.mock.calls[2]![0]).toMatchObject({ action: "clear_feedback", replacesClientEventId: "event-2", metadata: { feedbackSlot: "preferred_example" } });
    const pendingReplacement = send.mock.calls[3]![0];
    expect(pendingReplacement).toMatchObject({ action: "less_like", clientEventId: "event-4", replacesClientEventId: "event-1" });

    await controller.choose(session, "first", down);
    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[4]![0]).toBe(pendingReplacement);
    expect(controller.snapshot().feedbackByItem).toEqual({ first: "down" });
    await controller.choose(session, "first", heart);
    expect(send.mock.calls[5]![0]).toMatchObject({ action: "clear_feedback", replacesClientEventId: "event-4", metadata: { feedbackSlot: "rating" } });
    expect(controller.snapshot()).toMatchObject({ feedbackByItem: {}, preferredExampleByItem: { first: true } });
  });

  it.each(["account change", "new accepted slate"])("ignores old completions and retries after %s", async (reason) => {
    const { send, controller, input, session } = setup();
    const pending = deferred<FeelFeedbackResponse>();
    send.mockReturnValueOnce(pending.promise);
    const saving = controller.choose(session, "first", up);
    if (reason === "account change") controller.invalidate();
    const next = controller.activate({ ...input, principalKey: reason === "account change" ? "user:bob" : input.principalKey, sessionId: "search-2", searchGeneration: 4 });
    pending.resolve(acknowledged);
    expect(await saving).toEqual({ status: "stale" });
    expect(await controller.choose(session, "first", up)).toEqual({ status: "stale" });
    expect(controller.snapshot().feedbackByItem).toEqual({});
    await controller.choose(next, "first", up);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ sessionId: "search-2", clientEventId: "event-2", replacesClientEventId: undefined });
  });

  it("drops earlier Maybe cards and slot references when a new slate is accepted", async () => {
    const { send, controller, input, session } = setup();
    await controller.choose(session, "first", maybe);
    const next = controller.activate({ ...input, sessionId: "search-2", searchGeneration: 4, items: [input.items[1]!] });
    expect(controller.snapshot().feedbackByItem).toEqual({});
    expect(await controller.choose(next, "first", up)).toMatchObject({ status: "failed" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["missing session", "unresolved principal"])("does not persist selections with %s", async (reason) => {
    const { send, controller, input } = setup();
    const session = controller.activate({ ...input, sessionId: reason === "missing session" ? undefined : input.sessionId, principalKey: reason === "unresolved principal" ? null : input.principalKey });
    expect(await controller.choose(session, "first", up)).toMatchObject({ status: "failed", selection: { feedbackByItem: {} } });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not acknowledge malformed success bodies or reuse their ID for a different write", async () => {
    const { send, controller, session } = setup();
    send.mockResolvedValueOnce(null as unknown as FeelFeedbackResponse);
    expect(await controller.choose(session, "first", heart)).toMatchObject({ status: "failed" });
    await controller.choose(session, "first", heart);
    expect(send.mock.calls[1]![0]).toBe(send.mock.calls[0]![0]);
  });

  it("distinguishes named accounts from resolved shared access and unresolved authentication", () => {
    const session = { authenticated: false, plexAuthEnabled: true, allowNewPlexUsers: false };
    expect(feedbackPrincipalKey(null)).toBe(null);
    expect(feedbackPrincipalKey(session)).toBe("shared");
    expect(feedbackPrincipalKey({ ...session, authenticated: true })).toBe(null);
    expect(feedbackPrincipalKey({ ...session, authenticated: true, user: { id: "alice" } } as AuthSessionResponse)).toBe("user:alice");
    expect(feedbackPrincipalKey({ ...session, authenticated: true, user: { id: "bob" } } as AuthSessionResponse)).toBe("user:bob");
  });
});
