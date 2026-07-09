import Foundation

public struct MoodarrFeedbackQueueScope: Codable, Equatable, Hashable, Sendable {
  public let serverURL: String
  public let authUserId: String?

  public init(baseURL: URL, authUserId: String?) {
    serverURL = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
    self.authUserId = authUserId
  }
}

public struct MoodarrQueuedFeedback: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let scope: MoodarrFeedbackQueueScope
  public let request: MoodarrFeelFeedbackRequest
  public let createdAt: Date
  public var attemptCount: Int
  public var nextAttemptAt: Date

  public init(
    id: UUID = UUID(),
    scope: MoodarrFeedbackQueueScope,
    request: MoodarrFeelFeedbackRequest,
    createdAt: Date = Date(),
    attemptCount: Int = 0,
    nextAttemptAt: Date? = nil
  ) {
    self.id = id
    self.scope = scope
    self.request = request
    self.createdAt = createdAt
    self.attemptCount = attemptCount
    self.nextAttemptAt = nextAttemptAt ?? createdAt
  }
}

public protocol MoodarrFeedbackQueuePersisting: Sendable {
  func load() throws -> [MoodarrQueuedFeedback]
  func save(_ items: [MoodarrQueuedFeedback]) throws
}

public enum MoodarrFeedbackQueueStoreError: Error, Sendable {
  case decodeFailed
  case encodeFailed
}

public final class MoodarrUserDefaultsFeedbackQueueStore: MoodarrFeedbackQueuePersisting, @unchecked Sendable {
  private let defaults: UserDefaults
  private let key: String
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(defaults: UserDefaults = .standard, key: String = "moodarr.feedbackQueue.v1") {
    self.defaults = defaults
    self.key = key
  }

  public func load() throws -> [MoodarrQueuedFeedback] {
    guard let data = defaults.data(forKey: key) else { return [] }
    do {
      return try decoder.decode([MoodarrQueuedFeedback].self, from: data)
    } catch {
      throw MoodarrFeedbackQueueStoreError.decodeFailed
    }
  }

  public func save(_ items: [MoodarrQueuedFeedback]) throws {
    guard !items.isEmpty else {
      defaults.removeObject(forKey: key)
      return
    }
    do {
      defaults.set(try encoder.encode(items), forKey: key)
    } catch {
      throw MoodarrFeedbackQueueStoreError.encodeFailed
    }
  }
}

public final class MoodarrInMemoryFeedbackQueueStore: MoodarrFeedbackQueuePersisting, @unchecked Sendable {
  private let lock = NSLock()
  private var items: [MoodarrQueuedFeedback]

  public init(items: [MoodarrQueuedFeedback] = []) {
    self.items = items
  }

  public func load() throws -> [MoodarrQueuedFeedback] {
    lock.withLock { items }
  }

  public func save(_ items: [MoodarrQueuedFeedback]) throws {
    lock.withLock { self.items = items }
  }
}

public actor MoodarrFeedbackQueue {
  private static let baseRetryDelay: TimeInterval = 5
  private static let maximumRetryDelay: TimeInterval = 60 * 60

  private let persistence: any MoodarrFeedbackQueuePersisting
  private let now: @Sendable () -> Date
  private var items: [MoodarrQueuedFeedback]

  public init(
    persistence: any MoodarrFeedbackQueuePersisting = MoodarrUserDefaultsFeedbackQueueStore(),
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.persistence = persistence
    self.now = now
    items = (try? persistence.load()) ?? []
  }

  public func enqueue(_ request: MoodarrFeelFeedbackRequest, scope: MoodarrFeedbackQueueScope) throws {
    if let clientEventId = request.clientEventId,
       items.contains(where: { $0.scope == scope && $0.request.clientEventId == clientEventId }) {
      return
    }
    let queued = MoodarrQueuedFeedback(scope: scope, request: request, createdAt: now())
    items.append(queued)
    try persist()
  }

  public func snapshot(scope: MoodarrFeedbackQueueScope? = nil) -> [MoodarrQueuedFeedback] {
    guard let scope else { return items }
    return items.filter { $0.scope == scope }
  }

  public func flush(scope: MoodarrFeedbackQueueScope, using client: any MoodarrAPIClienting) async {
    let eligibleIds = items
      .filter { $0.scope == scope && $0.nextAttemptAt <= now() }
      .map(\.id)

    for id in eligibleIds {
      guard let index = items.firstIndex(where: { $0.id == id }) else { continue }
      let queued = items[index]
      do {
        _ = try await client.sendFeedback(queued.request)
        items.remove(at: index)
        try persist()
      } catch {
        guard let retryIndex = items.firstIndex(where: { $0.id == id }) else { return }
        items[retryIndex].attemptCount += 1
        let delay = min(
          Self.maximumRetryDelay,
          Self.baseRetryDelay * pow(2, Double(items[retryIndex].attemptCount - 1))
        )
        items[retryIndex].nextAttemptAt = now().addingTimeInterval(delay)
        try? persist()
        return
      }
    }
  }

  private func persist() throws {
    try persistence.save(items)
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
