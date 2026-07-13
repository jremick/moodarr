import Foundation

public struct MoodarrQueuedFeedback: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let request: MoodarrFeelFeedbackRequest
  public let createdAt: Date

  public init(id: UUID = UUID(), request: MoodarrFeelFeedbackRequest, createdAt: Date = Date()) {
    self.id = id
    self.request = request
    self.createdAt = createdAt
  }
}

public actor MoodarrFeedbackQueue {
  private var items: [MoodarrQueuedFeedback] = []

  public init() {}

  public func enqueue(_ request: MoodarrFeelFeedbackRequest) {
    items.append(MoodarrQueuedFeedback(request: request))
  }

  public func snapshot() -> [MoodarrQueuedFeedback] {
    items
  }

  public func remove(id: UUID) {
    items.removeAll { $0.id == id }
  }

  public func flush(using client: any MoodarrAPIClienting) async {
    for item in snapshot() {
      do {
        _ = try await client.sendFeedback(item.request)
        remove(id: item.id)
      } catch {
        return
      }
    }
  }
}

public enum MoodarrFeedbackMapper {
  public static func request(
    action: MoodarrFeedbackAction,
    item: MoodarrItemSummary,
    comparedItem: MoodarrItemSummary? = nil,
    search: MoodarrSearchResponse,
    moodTerm: String? = nil,
    reason: String? = nil
  ) -> MoodarrFeelFeedbackRequest {
    MoodarrFeelFeedbackRequest(
      action: action,
      clientEventId: UUID().uuidString,
      watchContext: search.watchContext,
      sessionId: search.sessionId,
      itemId: item.id,
      comparedItemId: comparedItem?.id,
      moodTerm: moodTerm,
      reason: reason,
      metadata: [
        "resultRank": .number(Double((search.results.firstIndex { $0.id == item.id } ?? 0) + 1))
      ]
    )
  }
}
