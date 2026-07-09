import Foundation
import SwiftUI

public enum MoodarrSearchDisplayMode: String, CaseIterable, Identifiable, Sendable {
  case swipe
  case grid

  public var id: String { rawValue }
}

public enum MoodarrSavedResultFilter: String, CaseIterable, Identifiable, Sendable {
  case candidates
  case yes
  case maybe

  public var id: String { rawValue }
}

public enum MoodarrRecommendationFeedback: String, Codable, Sendable {
  case up
  case maybe
  case down
}

@MainActor
public final class MoodarrAppViewModel: ObservableObject {
  public static let defaultServerURLText = "http://moodarr.local:4401"
  public static let defaultSearchResultLimit = 50
  public static let maxSearchResultLimit = 200
  nonisolated private static let primaryActionModeKey = "moodarr.primaryActionMode"
  nonisolated public static let plexAuthCallbackURLString = "moodarr://auth/plex"
  public static let plexAuthCallbackURL = URL(string: plexAuthCallbackURLString)!

  @Published public var serverURLText = MoodarrAppViewModel.defaultServerURLText
  @Published public var health: MoodarrHealthResponse?
  @Published public var config: MoodarrConfigStatusResponse?
  @Published public var authSession: MoodarrAuthSessionResponse?
  @Published public var plexStart: MoodarrPlexAuthStartResponse?
  @Published public var searchQuery = ""
  @Published public var watchContext: MoodarrWatchContext = .solo
  @Published public var resultLimit = MoodarrAppViewModel.defaultSearchResultLimit
  @Published public var searchDisplayMode: MoodarrSearchDisplayMode = .swipe
  @Published public var savedResultFilter: MoodarrSavedResultFilter = .candidates
  @Published public var primaryActionMode: MoodarrPrimaryActionMode = MoodarrAppViewModel.storedPrimaryActionMode() {
    didSet {
      UserDefaults.standard.set(primaryActionMode.rawValue, forKey: Self.primaryActionModeKey)
    }
  }
  @Published public var searchResponse: MoodarrSearchResponse?
  @Published public var selectedItem: MoodarrItemSummary?
  @Published public var requestPreview: MoodarrRequestPreview?
  @Published public var confirmationText = ""
  @Published public var hasFeedbackSinceLastSearch = false
  @Published public private(set) var feedbackByItem: [String: MoodarrRecommendationFeedback] = [:]
  @Published public private(set) var savedFeedbackItems: [String: MoodarrItemSummary] = [:]
  @Published public var isLoading = false
  @Published public var statusMessage: String?
  @Published public var errorMessage: String?

  public let feedbackQueue: MoodarrFeedbackQueue
  private let sessionStore: MoodarrSessionStoring
  private let serverURLStore: MoodarrServerURLStoring
  private let clientFactory: @Sendable (URL, String?) -> any MoodarrAPIClienting
  private var client: (any MoodarrAPIClienting)?

  public init(
    sessionStore: MoodarrSessionStoring = MoodarrKeychainSessionStore(),
    serverURLStore: MoodarrServerURLStoring = MoodarrUserDefaultsServerURLStore(),
    feedbackQueue: MoodarrFeedbackQueue = MoodarrFeedbackQueue(),
    clientFactory: @escaping @Sendable (URL, String?) -> any MoodarrAPIClienting = { baseURL, sessionToken in
      MoodarrAPIClient(baseURL: baseURL, sessionToken: sessionToken)
    }
  ) {
    self.sessionStore = sessionStore
    self.serverURLStore = serverURLStore
    self.feedbackQueue = feedbackQueue
    self.clientFactory = clientFactory
    do {
      if let stored = try sessionStore.load() {
        serverURLText = stored.baseURL.absoluteString
        client = clientFactory(stored.baseURL, stored.token)
      } else if let savedServerURL = serverURLStore.load() {
        serverURLText = savedServerURL.absoluteString
        client = clientFactory(savedServerURL, nil)
      }
    } catch {
      try? sessionStore.clear()
      if let savedServerURL = serverURLStore.load() {
        serverURLText = savedServerURL.absoluteString
        client = clientFactory(savedServerURL, nil)
      }
    }
  }

  public func connect() async {
    await run("Connected") {
      let baseURL = try Self.normalizedServerURL(from: serverURLText)
      let storedSession = try? sessionStore.load()
      let previousServerURL = storedSession?.baseURL ?? serverURLStore.load()
      let matchingSession = storedSession.flatMap { Self.hasSameServerOrigin($0.baseURL, baseURL) ? $0 : nil }
      let client = clientFactory(baseURL, matchingSession?.token)
      self.client = client
      self.health = nil
      self.config = nil
      self.authSession = nil
      self.plexStart = nil
      self.serverURLText = baseURL.absoluteString
      self.health = try await client.health()
      self.config = try await client.configStatus()
      self.authSession = try await client.authSession()
      if let storedSession, !Self.hasSameServerOrigin(storedSession.baseURL, baseURL) {
        try sessionStore.clear()
      }
      if let previousServerURL, !Self.hasSameServerOrigin(previousServerURL, baseURL) {
        try? await feedbackQueue.remove(serverURL: previousServerURL)
      }
      self.serverURLStore.save(baseURL)
      await self.flushQueuedFeedback(using: client, baseURL: baseURL)
    }
  }

  public func restoreSession() async {
    errorMessage = nil

    do {
      let stored: MoodarrStoredSession?
      do {
        stored = try sessionStore.load()
      } catch {
        try? sessionStore.clear()
        stored = nil
      }
      let baseURL = stored?.baseURL ?? serverURLStore.load()
      guard let baseURL else { return }
      serverURLText = baseURL.absoluteString
      let client = clientFactory(baseURL, stored?.token)
      self.client = client
      self.health = try await client.health()
      self.config = try await client.configStatus()
      self.authSession = try await client.authSession()
      self.statusMessage = stored == nil ? "Connected" : "Session restored"
      await self.flushQueuedFeedback(using: client, baseURL: baseURL)
    } catch {
      errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }

  public func startPlexSignIn() async {
    await run("Plex sign-in started") {
      let client = try requireClient()
      plexStart = try await client.startPlexAuth(returnURL: Self.plexAuthCallbackURL.absoluteString)
    }
  }

  public func completePlexSignIn() async {
    await run("Signed in") {
      let client = try requireClient()
      guard let plexStart else { throw MoodarrAPIError.httpStatus(400, "Start Plex sign-in first.") }
      let complete = try await client.completePlexAuth(pinId: plexStart.pinId, code: plexStart.code)
      if complete.pending == true {
        throw MoodarrAPIError.httpStatus(202, "Approve the Plex request, then return to Moodarr.")
      }
      authSession = MoodarrAuthSessionResponse(
        authenticated: complete.authenticated,
        plexAuthEnabled: complete.plexAuthEnabled,
        allowNewPlexUsers: complete.allowNewPlexUsers,
        user: complete.user
      )
      if let token = complete.sessionToken {
        let baseURL = try Self.normalizedServerURL(from: serverURLText)
        try sessionStore.save(MoodarrStoredSession(baseURL: baseURL, token: token, expiresAt: complete.sessionExpiresAt))
        serverURLStore.save(baseURL)
        await flushQueuedFeedback(using: client, baseURL: baseURL)
      }
    }
  }

  public func handleOpenURL(_ url: URL) async {
    guard Self.isPlexAuthCallback(url) else { return }
    await completePlexSignIn()
  }

  public func search() async {
    await run(nil) {
      let client = try requireClient()
      let requestedLimit = min(Self.maxSearchResultLimit, resultLimit + hiddenFeedbackCount)
      let request = MoodarrSearchRequest(
        query: searchQuery,
        resultLimit: requestedLimit,
        watchContext: watchContext,
        feedbackContext: buildFeedbackContext()
      )
      searchResponse = try await client.search(request)
      selectedItem = visibleResults.first
      requestPreview = nil
      confirmationText = ""
      hasFeedbackSinceLastSearch = false
      savedResultFilter = .candidates
    }
  }

  public func sendFeedback(action: MoodarrFeedbackAction, item: MoodarrItemSummary, comparedItem: MoodarrItemSummary? = nil, moodTerm: String? = nil, reason: String? = nil) async {
    guard let client, let searchResponse else { return }
    let request = MoodarrFeedbackMapper.request(action: action, item: item, comparedItem: comparedItem, search: searchResponse, moodTerm: moodTerm, reason: reason)
    let storedSession = try? sessionStore.load()
    let queueBaseURL = storedSession?.baseURL ?? (try? Self.normalizedServerURL(from: serverURLText))
    let queueScope = queueBaseURL.map { MoodarrFeedbackQueueScope(baseURL: $0, authUserId: authSession?.user?.id) }
    recordFeedback(action: action, item: item)
    do {
      _ = try await client.sendFeedback(request)
      if let queueScope {
        await feedbackQueue.flush(scope: queueScope, using: client)
      }
    } catch {
      if let queueScope {
        do {
          try await feedbackQueue.enqueue(request, scope: queueScope)
          statusMessage = "Feedback queued"
        } catch {
          errorMessage = "Feedback could not be saved for retry."
        }
      } else {
        errorMessage = "Feedback could not be queued because the server address is invalid."
      }
    }
    hasFeedbackSinceLastSearch = true
  }

  public func previewRequest(for item: MoodarrItemSummary) async {
    await run("Preview ready") {
      let client = try requireClient()
      selectedItem = item
      requestPreview = try await client.previewRequest(MoodarrPreviewRequest(itemId: item.id))
      confirmationText = ""
    }
  }

  public func createRequest() async {
    await run("Request created") {
      let client = try requireClient()
      guard let preview = requestPreview else { throw MoodarrAPIError.httpStatus(400, "Preview the request first.") }
      let body = MoodarrCreateRequestBody(
        itemId: preview.item.id,
        mediaType: nil,
        tmdbId: nil,
        seasons: preview.request.seasons,
        confirmed: true,
        confirmationPhrase: confirmationText
      )
      _ = try await client.createRequest(body)
      requestPreview = nil
      confirmationText = ""
    }
  }

  public func addToWatchlistOrRequest(_ item: MoodarrItemSummary) async {
    if item.availabilityGroup == .availableInPlex {
      await run("Added to Watchlist") {
        let client = try requireClient()
        _ = try await client.addToWatchlist(MoodarrWatchlistRequest(itemId: item.id))
      }
    } else {
      await previewRequest(for: item)
    }
  }

  public func posterData(for item: MoodarrItemSummary) async throws -> Data {
    let client = try requireClient()
    return try await client.posterData(path: item.posterUrl)
  }

  public func logout() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }

    let storedSession = try? sessionStore.load()
    let queueBaseURL = storedSession?.baseURL ?? (try? Self.normalizedServerURL(from: serverURLText))
    let queueScope = queueBaseURL.map { MoodarrFeedbackQueueScope(baseURL: $0, authUserId: authSession?.user?.id) }
    var remoteError: Error?
    if let client {
      do {
        try await client.logout()
      } catch {
        remoteError = error
      }
    }

    var localError: Error?
    do {
      try sessionStore.clear()
    } catch {
      localError = error
    }
    if let queueScope {
      try? await feedbackQueue.remove(scope: queueScope)
    }

    let baseURL = storedSession?.baseURL ?? (try? Self.normalizedServerURL(from: serverURLText))
    client = baseURL.map { clientFactory($0, nil) }
    authSession = nil
    plexStart = nil
    searchResponse = nil
    requestPreview = nil
    selectedItem = nil
    confirmationText = ""
    statusMessage = remoteError == nil ? "Signed out" : "Signed out on this device"
    if let localError {
      errorMessage = "The app signed out, but could not remove the saved session: \(Self.errorDescription(localError))"
    } else if let remoteError {
      errorMessage = "Signed out on this device, but server revocation could not be confirmed: \(Self.errorDescription(remoteError))"
    }
  }

  public var visibleResults: [MoodarrItemSummary] {
    switch savedResultFilter {
    case .candidates:
      return (searchResponse?.results ?? []).filter { feedbackByItem[$0.id] == nil }
    case .yes:
      return savedItems(matching: .up)
    case .maybe:
      return savedItems(matching: .maybe)
    }
  }

  public func count(for filter: MoodarrSavedResultFilter) -> Int {
    switch filter {
    case .candidates:
      return visibleResults.count
    case .yes:
      return feedbackByItem.values.filter { $0 == .up }.count
    case .maybe:
      return feedbackByItem.values.filter { $0 == .maybe }.count
    }
  }

  private var hiddenFeedbackCount: Int {
    feedbackByItem.count
  }

  private func run(_ successMessage: String?, operation: () async throws -> Void) async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }
    do {
      try await operation()
      if let successMessage {
        statusMessage = successMessage
      }
    } catch {
      errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }

  private func requireClient() throws -> any MoodarrAPIClienting {
    guard let client else { throw MoodarrAPIError.invalidBaseURL }
    return client
  }

  private func feedbackQueueScope() throws -> MoodarrFeedbackQueueScope {
    MoodarrFeedbackQueueScope(
      baseURL: try Self.normalizedServerURL(from: serverURLText),
      authUserId: authSession?.user?.id
    )
  }

  private func flushQueuedFeedback(using client: any MoodarrAPIClienting, baseURL: URL) async {
    let scope = MoodarrFeedbackQueueScope(baseURL: baseURL, authUserId: authSession?.user?.id)
    await feedbackQueue.flush(scope: scope, using: client)
  }

  nonisolated public static func normalizedServerURL(from text: String) throws -> URL {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw MoodarrAPIError.invalidBaseURL }
    let urlText = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
    guard let url = URL(string: urlText), var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          components.host?.isEmpty == false else {
      throw MoodarrAPIError.invalidBaseURL
    }
    guard components.user == nil, components.password == nil else { throw MoodarrAPIError.embeddedCredentials }
    components.scheme = scheme
    components.path = ""
    components.query = nil
    components.fragment = nil
    guard let normalized = components.url else { throw MoodarrAPIError.invalidBaseURL }
    return normalized
  }

  nonisolated public static func isPlexAuthCallback(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "moodarr" &&
      url.host?.lowercased() == "auth" &&
      url.path == "/plex"
  }

  nonisolated private static func storedPrimaryActionMode() -> MoodarrPrimaryActionMode {
    guard let rawValue = UserDefaults.standard.string(forKey: primaryActionModeKey) else { return .watch }
    return MoodarrPrimaryActionMode(rawValue: rawValue) ?? .watch
  }

  nonisolated private static func hasSameServerOrigin(_ first: URL, _ second: URL) -> Bool {
    guard let lhs = URLComponents(url: first, resolvingAgainstBaseURL: false),
          let rhs = URLComponents(url: second, resolvingAgainstBaseURL: false) else {
      return false
    }
    return lhs.scheme?.lowercased() == rhs.scheme?.lowercased() &&
      lhs.host?.lowercased() == rhs.host?.lowercased() &&
      effectivePort(lhs) == effectivePort(rhs)
  }

  nonisolated private static func effectivePort(_ components: URLComponents) -> Int? {
    if let port = components.port { return port }
    return components.scheme?.lowercased() == "https" ? 443 : 80
  }

  nonisolated private static func errorDescription(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
  }

  private func savedItems(matching feedback: MoodarrRecommendationFeedback) -> [MoodarrItemSummary] {
    feedbackByItem
      .filter { $0.value == feedback }
      .compactMap { savedFeedbackItems[$0.key] }
      .sorted { lhs, rhs in
        if lhs.score == rhs.score {
          return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
        return lhs.score > rhs.score
      }
  }

  private func recordFeedback(action: MoodarrFeedbackAction, item: MoodarrItemSummary) {
    guard let feedback = Self.recommendationFeedback(for: action) else { return }
    feedbackByItem[item.id] = feedback
    savedFeedbackItems[item.id] = item
  }

  private func buildFeedbackContext() -> MoodarrFeedbackContext? {
    guard !feedbackByItem.isEmpty else { return nil }
    let moreLikeItemIds = feedbackByItem.filter { $0.value == .up }.map(\.key)
    let maybeItemIds = feedbackByItem.filter { $0.value == .maybe }.map(\.key)
    let lessLikeItemIds = feedbackByItem.filter { $0.value == .down }.map(\.key)
    let hiddenItemIds = Array(feedbackByItem.keys)
    return MoodarrFeedbackContext(
      moreLikeItemIds: moreLikeItemIds.sorted(),
      maybeItemIds: maybeItemIds.sorted(),
      lessLikeItemIds: lessLikeItemIds.sorted(),
      hiddenItemIds: hiddenItemIds.sorted(),
      showRatedItems: false
    )
  }

  nonisolated private static func recommendationFeedback(for action: MoodarrFeedbackAction) -> MoodarrRecommendationFeedback? {
    switch action {
    case .rightMood, .swipeRight, .moreLike, .pairwisePick, .open:
      return .up
    case .save:
      return .maybe
    case .wrongMood, .swipeLeft, .lessLike, .hide, .swipeSkip:
      return .down
    case .requestPreview, .requestCreate, .expand:
      return nil
    }
  }
}
