import XCTest
@testable import MoodarrIOS

final class MoodarrModelTests: XCTestCase {
  func testNormalizesBareLanServerAddress() throws {
    let url = try MoodarrAppViewModel.normalizedServerURL(from: " moodarr.local:4401 ")

    XCTAssertEqual(url.absoluteString, "http://moodarr.local:4401")
  }

  func testRejectsEmptyServerAddress() {
    XCTAssertThrowsError(try MoodarrAppViewModel.normalizedServerURL(from: "  "))
  }

  @MainActor
  func testDefaultsServerURLForAlphaLanTesting() {
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(),
      clientFactory: { _, _ in MockMoodarrAPIClient() }
    )

    XCTAssertEqual(model.serverURLText, MoodarrAppViewModel.defaultServerURLText)
  }

  func testRecognizesPlexAuthCallbackURL() throws {
    XCTAssertTrue(MoodarrAppViewModel.isPlexAuthCallback(try XCTUnwrap(URL(string: "moodarr://auth/plex"))))
    XCTAssertFalse(MoodarrAppViewModel.isPlexAuthCallback(try XCTUnwrap(URL(string: "moodarr://auth/other"))))
    XCTAssertFalse(MoodarrAppViewModel.isPlexAuthCallback(try XCTUnwrap(URL(string: "https://app.plex.tv/auth"))))
  }

  @MainActor
  func testConnectPersistsServerURLWithoutAuthSession() async throws {
    let serverURLStore = MoodarrInMemoryServerURLStore()
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: serverURLStore,
      clientFactory: { _, _ in MockMoodarrAPIClient() }
    )
    model.serverURLText = "moodarr.local:4401"

    await model.connect()

    XCTAssertEqual(serverURLStore.load()?.absoluteString, "http://moodarr.local:4401")
    XCTAssertEqual(model.statusMessage, "Connected")
    XCTAssertNil(model.errorMessage)
  }

  @MainActor
  func testRestoreSessionWithoutStoredSessionDoesNotReportSuccess() async {
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(),
      clientFactory: { _, _ in MockMoodarrAPIClient() }
    )

    await model.restoreSession()

    XCTAssertNil(model.statusMessage)
    XCTAssertNil(model.health)
    XCTAssertNil(model.config)
    XCTAssertNil(model.authSession)
  }

  @MainActor
  func testRestoreSessionRefreshesSavedServerURLWithoutAuthToken() async throws {
    let savedURL = try XCTUnwrap(URL(string: "http://moodarr.local:4401"))
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(url: savedURL),
      clientFactory: { _, _ in
        MockMoodarrAPIClient(
          healthResponse: MoodarrHealthResponse(ok: true, fixtureMode: false, version: "0.1.0"),
          configResponse: MoodarrConfigStatusResponse(
            fixtureMode: false,
            plex: MoodarrConfigStatusResponse.IntegrationStatus(configured: true, baseUrlConfigured: true),
            seerr: MoodarrConfigStatusResponse.IntegrationStatus(configured: true, baseUrlConfigured: true),
            ai: MoodarrConfigStatusResponse.AIStatus(
              provider: "openai",
              configured: true,
              openaiModel: "gpt-5.5",
              openaiEmbeddingModel: "text-embedding-3-large",
              openaiReasoningEffort: "low"
            ),
            admin: MoodarrConfigStatusResponse.AdminStatus(authRequired: true, configured: true, autoSession: true),
            auth: MoodarrConfigStatusResponse.AuthStatus(plexAuthEnabled: true, allowNewPlexUsers: true)
          ),
          authResponse: MoodarrAuthSessionResponse(authenticated: false, plexAuthEnabled: true, allowNewPlexUsers: true, user: nil)
        )
      }
    )

    await model.restoreSession()

    XCTAssertEqual(model.serverURLText, "http://moodarr.local:4401")
    XCTAssertEqual(model.health?.version, "0.1.0")
    XCTAssertEqual(model.config?.auth.plexAuthEnabled, true)
    XCTAssertEqual(model.statusMessage, "Connected")
    XCTAssertNil(model.errorMessage)
  }

  @MainActor
  func testRestoreSessionIgnoresUnreadableStoredSessionAndUsesSavedServerURL() async throws {
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrThrowingSessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(url: try XCTUnwrap(URL(string: "http://moodarr.local:4401"))),
      clientFactory: { _, _ in MockMoodarrAPIClient() }
    )

    await model.restoreSession()

    XCTAssertEqual(model.serverURLText, "http://moodarr.local:4401")
    XCTAssertEqual(model.statusMessage, "Connected")
    XCTAssertNil(model.errorMessage)
  }

  @MainActor
  func testRestoreSessionRefreshesConnectionState() async throws {
    let stored = MoodarrStoredSession(
      baseURL: try XCTUnwrap(URL(string: "http://127.0.0.1:4401")),
      token: "session-token",
      expiresAt: nil
    )
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(session: stored),
      serverURLStore: MoodarrInMemoryServerURLStore(),
      clientFactory: { _, _ in
        MockMoodarrAPIClient(
          healthResponse: MoodarrHealthResponse(ok: true, fixtureMode: false, version: "0.1.0"),
          configResponse: MoodarrConfigStatusResponse(
            fixtureMode: false,
            plex: MoodarrConfigStatusResponse.IntegrationStatus(configured: true, baseUrlConfigured: true),
            seerr: MoodarrConfigStatusResponse.IntegrationStatus(configured: true, baseUrlConfigured: true),
            ai: MoodarrConfigStatusResponse.AIStatus(
              provider: "openai",
              configured: true,
              openaiModel: "gpt-5-mini",
              openaiEmbeddingModel: "text-embedding-3-small",
              openaiReasoningEffort: nil
            ),
            admin: MoodarrConfigStatusResponse.AdminStatus(authRequired: false, configured: true, autoSession: true),
            auth: MoodarrConfigStatusResponse.AuthStatus(plexAuthEnabled: true, allowNewPlexUsers: false)
          ),
          authResponse: MoodarrAuthSessionResponse(authenticated: false, plexAuthEnabled: true, allowNewPlexUsers: false, user: nil)
        )
      }
    )

    await model.restoreSession()

    XCTAssertEqual(model.serverURLText, "http://127.0.0.1:4401")
    XCTAssertEqual(model.health?.version, "0.1.0")
    XCTAssertEqual(model.config?.auth.plexAuthEnabled, true)
    XCTAssertEqual(model.authSession?.plexAuthEnabled, true)
    XCTAssertEqual(model.statusMessage, "Session restored")
    XCTAssertNil(model.errorMessage)
  }

  @MainActor
  func testPlexSignInUsesNativeCallbackURL() async {
    let client = MockMoodarrAPIClient(startResponse: MoodarrPlexAuthStartResponse(ok: true, pinId: "pin-1", code: "ABCD", authUrl: "https://app.plex.tv/auth", expiresAt: nil))
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(url: URL(string: "http://moodarr.local:4401")),
      clientFactory: { _, _ in client }
    )

    await model.startPlexSignIn()
    let startReturnURL = await client.recordedStartReturnURL()

    XCTAssertEqual(startReturnURL, MoodarrAppViewModel.plexAuthCallbackURL.absoluteString)
    XCTAssertEqual(model.plexStart?.pinId, "pin-1")
    XCTAssertEqual(model.statusMessage, "Plex sign-in started")
  }

  @MainActor
  func testPlexCallbackCompletesNativeSessionAndSavesServerURL() async throws {
    let sessionStore = MoodarrInMemorySessionStore()
    let serverURLStore = MoodarrInMemoryServerURLStore(url: try XCTUnwrap(URL(string: "http://moodarr.local:4401")))
    let user = MoodarrAuthUser(
      id: "user-1",
      provider: "plex",
      providerUserId: "plex-1",
      username: "fixture-user",
      displayName: "Fixture User",
      email: nil,
      avatarUrl: nil,
      enabled: true,
      createdAt: "2026-06-18T00:00:00Z",
      updatedAt: "2026-06-18T00:00:00Z",
      lastLoginAt: nil
    )
    let client = MockMoodarrAPIClient(
      startResponse: MoodarrPlexAuthStartResponse(ok: true, pinId: "pin-1", code: "ABCD", authUrl: "https://app.plex.tv/auth", expiresAt: nil),
      completeResponse: MoodarrPlexAuthCompleteResponse(
        authenticated: true,
        plexAuthEnabled: true,
        allowNewPlexUsers: true,
        user: user,
        pending: false,
        sessionToken: "native-token",
        sessionExpiresAt: "2026-06-19T00:00:00Z"
      )
    )
    let model = MoodarrAppViewModel(
      sessionStore: sessionStore,
      serverURLStore: serverURLStore,
      clientFactory: { _, _ in client }
    )

    await model.startPlexSignIn()
    await model.handleOpenURL(try XCTUnwrap(URL(string: "moodarr://auth/plex")))

    XCTAssertEqual(model.authSession?.authenticated, true)
    XCTAssertEqual(try sessionStore.load()?.token, "native-token")
    XCTAssertEqual(serverURLStore.load()?.absoluteString, "http://moodarr.local:4401")
    XCTAssertEqual(model.statusMessage, "Signed in")
  }

  func testDecodesSearchResponseWithSessionId() throws {
    let json = """
    {
      "sessionId": "session-1",
      "query": "funny fantasy",
      "optimizedQuery": "funny fantasy",
      "usedAi": false,
      "summary": "A few light fantasy picks.",
      "refinementOptions": [],
      "resolvedFilters": {},
      "watchContext": "group",
      "resultLimit": 5,
      "results": [{
        "id": "item-1",
        "mediaType": "movie",
        "title": "The Princess Bride",
        "year": 1987,
        "runtimeMinutes": 98,
        "summary": "A storybook adventure.",
        "genres": ["Comedy", "Fantasy"],
        "ratings": {},
        "posterUrl": "/api/items/item-1/poster",
        "availabilityGroup": "not_in_plex_requestable",
        "availabilityExplanation": "Requestable in Seerr",
        "matchExplanation": "Playful, fast, and warm.",
        "score": 92,
        "seerr": { "status": "unknown", "requestable": true, "mediaId": 123 }
      }]
    }
    """

    let response = try JSONDecoder().decode(MoodarrSearchResponse.self, from: Data(json.utf8))

    XCTAssertEqual(response.sessionId, "session-1")
    XCTAssertEqual(response.watchContext, .group)
    XCTAssertEqual(response.results.first?.availabilityGroup, .notInPlexRequestable)
  }

  func testFeedbackMapperUsesReturnedSessionAndNeverRawPrompt() {
    let item = fixtureItem(id: "winner")
    let response = MoodarrSearchResponse(
      sessionId: "session-1",
      query: "cozy funny",
      optimizedQuery: "cozy funny",
      usedAi: false,
      summary: "Summary",
      refinementOptions: [],
      resolvedFilters: MoodarrSearchFilters(),
      watchContext: .solo,
      resultLimit: 2,
      results: [item]
    )

    let request = MoodarrFeedbackMapper.request(action: .swipeRight, item: item, search: response, moodTerm: "cozy")

    XCTAssertEqual(request.source, "ios")
    XCTAssertNotNil(request.clientEventId)
    XCTAssertEqual(request.sessionId, "session-1")
    XCTAssertEqual(request.itemId, "winner")
    XCTAssertEqual(request.moodTerm, "cozy")
    XCTAssertNil(request.metadata?["rawPrompt"])
  }

  func testFeedbackQueuePersistsClientEventAndPartitionsByServerAndUser() async throws {
    let suiteName = "MoodarrFeedbackQueueTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = MoodarrUserDefaultsFeedbackQueueStore(defaults: defaults, key: "queue")
    let server = try XCTUnwrap(URL(string: "http://moodarr.local:4401"))
    let userScope = MoodarrFeedbackQueueScope(baseURL: server, authUserId: "user-1")
    let otherScope = MoodarrFeedbackQueueScope(baseURL: server, authUserId: "user-2")
    let request = MoodarrFeelFeedbackRequest(action: .rightMood, clientEventId: "event-1", itemId: "item-1")

    let firstQueue = MoodarrFeedbackQueue(persistence: store)
    try await firstQueue.enqueue(request, scope: userScope)
    try await firstQueue.enqueue(request, scope: userScope)
    try await firstQueue.enqueue(
      MoodarrFeelFeedbackRequest(action: .wrongMood, clientEventId: "event-2", itemId: "item-2"),
      scope: otherScope
    )

    let restoredQueue = MoodarrFeedbackQueue(persistence: store)
    let userItems = await restoredQueue.snapshot(scope: userScope)
    let otherItems = await restoredQueue.snapshot(scope: otherScope)

    XCTAssertEqual(userItems.count, 1)
    XCTAssertEqual(userItems.first?.request.clientEventId, "event-1")
    XCTAssertEqual(otherItems.map(\.request.clientEventId), ["event-2"])
  }

  func testFeedbackQueueBacksOffThenRetriesWithoutChangingClientEventId() async throws {
    let clock = MoodarrTestClock(date: Date(timeIntervalSince1970: 1_000))
    let scope = MoodarrFeedbackQueueScope(
      baseURL: try XCTUnwrap(URL(string: "https://moodarr.example")),
      authUserId: "user-1"
    )
    let queue = MoodarrFeedbackQueue(
      persistence: MoodarrInMemoryFeedbackQueueStore(),
      now: { clock.now() }
    )
    let client = MockMoodarrAPIClient(feedbackFailuresBeforeSuccess: 1)
    let request = MoodarrFeelFeedbackRequest(action: .save, clientEventId: "stable-event", itemId: "item-1")
    try await queue.enqueue(request, scope: scope)

    await queue.flush(scope: scope, using: client)
    await queue.flush(scope: scope, using: client)
    let firstAttemptEventIds = await client.recordedFeedbackEventIds()
    let backedOffItems = await queue.snapshot(scope: scope)
    XCTAssertEqual(firstAttemptEventIds, ["stable-event"])
    XCTAssertEqual(backedOffItems.first?.attemptCount, 1)

    clock.advance(by: 5)
    await queue.flush(scope: scope, using: client)

    let retriedEventIds = await client.recordedFeedbackEventIds()
    let remainingItems = await queue.snapshot(scope: scope)
    XCTAssertEqual(retriedEventIds, ["stable-event", "stable-event"])
    XCTAssertTrue(remainingItems.isEmpty)
  }

  @MainActor
  func testFeedbackMarksSearchAsNeedingUpdate() async throws {
    let item = fixtureItem(id: "winner")
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(url: try XCTUnwrap(URL(string: "http://moodarr.local:4401"))),
      clientFactory: { _, _ in MockMoodarrAPIClient() }
    )
    model.searchResponse = MoodarrSearchResponse(
      sessionId: "session-1",
      query: "warm comedy",
      optimizedQuery: "warm comedy",
      usedAi: false,
      summary: "Summary",
      refinementOptions: [],
      resolvedFilters: MoodarrSearchFilters(),
      watchContext: .solo,
      resultLimit: 1,
      results: [item]
    )

    await model.sendFeedback(action: .rightMood, item: item, moodTerm: "warm")

    XCTAssertTrue(model.hasFeedbackSinceLastSearch)
  }

  @MainActor
  func testSearchDefaultsToFiftyItemsWithoutSuccessToast() async throws {
    let client = MockMoodarrAPIClient(searchResponse: searchResponse(results: []))
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(url: try XCTUnwrap(URL(string: "http://moodarr.local:4401"))),
      clientFactory: { _, _ in client }
    )
    model.searchQuery = "warm comedy"

    await model.search()
    let request = await client.recordedSearchRequest()

    XCTAssertEqual(request?.resultLimit, MoodarrAppViewModel.defaultSearchResultLimit)
    XCTAssertEqual(request?.watchContext, .solo)
    XCTAssertNil(request?.feedbackContext)
    XCTAssertNil(model.statusMessage)
  }

  @MainActor
  func testSearchSendsFeedbackContextAndHidesRatedItemsOnUpdate() async throws {
    let liked = fixtureItem(id: "liked")
    let maybe = fixtureItem(id: "maybe")
    let disliked = fixtureItem(id: "disliked")
    let client = MockMoodarrAPIClient(searchResponse: searchResponse(results: [liked, maybe, disliked]))
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(url: try XCTUnwrap(URL(string: "http://moodarr.local:4401"))),
      clientFactory: { _, _ in client }
    )
    model.searchQuery = "warm comedy"
    model.searchResponse = searchResponse(results: [liked, maybe, disliked])

    await model.sendFeedback(action: .rightMood, item: liked, moodTerm: "warm")
    await model.sendFeedback(action: .save, item: maybe, moodTerm: "warm")
    await model.sendFeedback(action: .wrongMood, item: disliked, moodTerm: "warm")
    await model.search()

    let request = await client.recordedSearchRequest()
    XCTAssertEqual(request?.resultLimit, MoodarrAppViewModel.defaultSearchResultLimit + 3)
    XCTAssertEqual(request?.feedbackContext?.moreLikeItemIds, ["liked"])
    XCTAssertEqual(request?.feedbackContext?.maybeItemIds, ["maybe"])
    XCTAssertEqual(request?.feedbackContext?.lessLikeItemIds, ["disliked"])
    XCTAssertEqual(request?.feedbackContext?.hiddenItemIds, ["disliked", "liked", "maybe"])
    XCTAssertEqual(request?.feedbackContext?.showRatedItems, false)
  }

  @MainActor
  func testWatchlistActionCallsPlexWatchlistEndpointForAvailableItem() async throws {
    let item = fixtureItem(id: "available")
    let client = MockMoodarrAPIClient(watchlistResponse: MoodarrWatchlistResponse(ok: true, itemId: item.id, alreadyWatchlisted: false))
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(url: try XCTUnwrap(URL(string: "http://moodarr.local:4401"))),
      clientFactory: { _, _ in client }
    )

    await model.addToWatchlistOrRequest(item)
    let request = await client.recordedWatchlistRequest()

    XCTAssertEqual(request?.itemId, "available")
    XCTAssertEqual(model.statusMessage, "Added to Watchlist")
    XCTAssertNil(model.errorMessage)
  }

  @MainActor
  func testUnavailableWatchlistActionStopsAtPreviewUntilExplicitCreate() async throws {
    let item = fixtureItem(id: "requestable", availabilityGroup: .notInPlexRequestable)
    let preview = MoodarrRequestPreview(
      canRequest: true,
      blockedReason: nil,
      requiresConfirmation: true,
      confirmationPhrase: "REQUEST",
      request: .init(mediaType: .movie, mediaId: 42, seasons: nil, title: item.title),
      item: item
    )
    let client = MockMoodarrAPIClient(previewResponse: preview)
    let model = MoodarrAppViewModel(
      sessionStore: MoodarrInMemorySessionStore(),
      serverURLStore: MoodarrInMemoryServerURLStore(url: try XCTUnwrap(URL(string: "http://moodarr.local:4401"))),
      feedbackQueue: MoodarrFeedbackQueue(persistence: MoodarrInMemoryFeedbackQueueStore()),
      clientFactory: { _, _ in client }
    )

    await model.addToWatchlistOrRequest(item)

    let createRequest = await client.recordedCreateRequest()
    XCTAssertEqual(model.requestPreview?.item.id, item.id)
    XCTAssertNil(createRequest)
    XCTAssertEqual(model.statusMessage, "Preview ready")
  }

  func testPairwiseFeedbackIncludesComparedItem() {
    let winner = fixtureItem(id: "winner")
    let compared = fixtureItem(id: "compared")
    let response = MoodarrSearchResponse(
      sessionId: "session-1",
      query: "cozy",
      optimizedQuery: "cozy",
      usedAi: false,
      summary: "Summary",
      refinementOptions: [],
      resolvedFilters: MoodarrSearchFilters(),
      watchContext: .group,
      resultLimit: 2,
      results: [winner, compared]
    )

    let request = MoodarrFeedbackMapper.request(action: .pairwisePick, item: winner, comparedItem: compared, search: response, moodTerm: "cozy")

    XCTAssertEqual(request.action, .pairwisePick)
    XCTAssertEqual(request.itemId, "winner")
    XCTAssertEqual(request.comparedItemId, "compared")
  }

  private func fixtureItem(
    id: String,
    availabilityGroup: MoodarrAvailabilityGroup = .availableInPlex
  ) -> MoodarrItemSummary {
    MoodarrItemSummary(
      id: id,
      mediaType: .movie,
      title: "Fixture",
      year: 2026,
      runtimeMinutes: 100,
      summary: nil,
      genres: ["Comedy"],
      contentRating: nil,
      ratings: MoodarrRatingSet(critic: nil, audience: nil, user: nil),
      posterUrl: "/api/items/\(id)/poster",
      availabilityGroup: availabilityGroup,
      availabilityExplanation: "Available",
      matchExplanation: "Good fit",
      score: 80,
      plex: nil,
      seerr: nil
    )
  }

  private func searchResponse(results: [MoodarrItemSummary]) -> MoodarrSearchResponse {
    MoodarrSearchResponse(
      sessionId: "session-1",
      query: "warm comedy",
      optimizedQuery: "warm comedy",
      usedAi: false,
      summary: "Summary",
      refinementOptions: [],
      resolvedFilters: MoodarrSearchFilters(),
      watchContext: .solo,
      resultLimit: results.count,
      results: results
    )
  }
}

private final class MoodarrThrowingSessionStore: MoodarrSessionStoring {
  func load() throws -> MoodarrStoredSession? {
    throw MoodarrSessionStoreError.decodeFailed
  }

  func save(_ session: MoodarrStoredSession) throws {}

  func clear() throws {}
}

private final class MoodarrTestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var date: Date

  init(date: Date) {
    self.date = date
  }

  func now() -> Date {
    lock.withLock { date }
  }

  func advance(by interval: TimeInterval) {
    lock.withLock { date = date.addingTimeInterval(interval) }
  }
}

private actor MockMoodarrAPIClient: MoodarrAPIClienting {
  let healthResponse: MoodarrHealthResponse
  let configResponse: MoodarrConfigStatusResponse
  let authResponse: MoodarrAuthSessionResponse
  let startResponse: MoodarrPlexAuthStartResponse?
  let completeResponse: MoodarrPlexAuthCompleteResponse?
  let searchResponse: MoodarrSearchResponse?
  let watchlistResponse: MoodarrWatchlistResponse?
  let previewResponse: MoodarrRequestPreview?
  private var feedbackFailuresRemaining: Int
  private(set) var lastStartReturnURL: String?
  private(set) var lastSearchRequest: MoodarrSearchRequest?
  private(set) var lastWatchlistRequest: MoodarrWatchlistRequest?
  private(set) var lastCreateRequest: MoodarrCreateRequestBody?
  private(set) var feedbackEventIds: [String?] = []

  init(
    healthResponse: MoodarrHealthResponse = MoodarrHealthResponse(ok: true, fixtureMode: true, version: "test"),
    configResponse: MoodarrConfigStatusResponse = MoodarrConfigStatusResponse(
      fixtureMode: true,
      plex: MoodarrConfigStatusResponse.IntegrationStatus(configured: false, baseUrlConfigured: false),
      seerr: MoodarrConfigStatusResponse.IntegrationStatus(configured: false, baseUrlConfigured: false),
      ai: MoodarrConfigStatusResponse.AIStatus(
        provider: "none",
        configured: false,
        openaiModel: nil,
        openaiEmbeddingModel: nil,
        openaiReasoningEffort: nil
      ),
      admin: MoodarrConfigStatusResponse.AdminStatus(authRequired: false, configured: false, autoSession: false),
      auth: MoodarrConfigStatusResponse.AuthStatus(plexAuthEnabled: false, allowNewPlexUsers: false)
    ),
    authResponse: MoodarrAuthSessionResponse = MoodarrAuthSessionResponse(
      authenticated: false,
      plexAuthEnabled: false,
      allowNewPlexUsers: false,
      user: nil
    ),
    startResponse: MoodarrPlexAuthStartResponse? = nil,
    completeResponse: MoodarrPlexAuthCompleteResponse? = nil,
    searchResponse: MoodarrSearchResponse? = nil,
    watchlistResponse: MoodarrWatchlistResponse? = nil,
    previewResponse: MoodarrRequestPreview? = nil,
    feedbackFailuresBeforeSuccess: Int = .max
  ) {
    self.healthResponse = healthResponse
    self.configResponse = configResponse
    self.authResponse = authResponse
    self.startResponse = startResponse
    self.completeResponse = completeResponse
    self.searchResponse = searchResponse
    self.watchlistResponse = watchlistResponse
    self.previewResponse = previewResponse
    feedbackFailuresRemaining = feedbackFailuresBeforeSuccess
  }

  func health() async throws -> MoodarrHealthResponse {
    healthResponse
  }

  func configStatus() async throws -> MoodarrConfigStatusResponse {
    configResponse
  }

  func authSession() async throws -> MoodarrAuthSessionResponse {
    authResponse
  }

  func recordedStartReturnURL() -> String? {
    lastStartReturnURL
  }

  func recordedSearchRequest() -> MoodarrSearchRequest? {
    lastSearchRequest
  }

  func recordedWatchlistRequest() -> MoodarrWatchlistRequest? {
    lastWatchlistRequest
  }

  func recordedCreateRequest() -> MoodarrCreateRequestBody? {
    lastCreateRequest
  }

  func recordedFeedbackEventIds() -> [String] {
    feedbackEventIds.compactMap { $0 }
  }

  func startPlexAuth(returnURL: String?) async throws -> MoodarrPlexAuthStartResponse {
    lastStartReturnURL = returnURL
    guard let startResponse else { throw MoodarrAPIError.invalidURL("unexpected startPlexAuth") }
    return startResponse
  }

  func completePlexAuth(pinId: String, code: String) async throws -> MoodarrPlexAuthCompleteResponse {
    guard let completeResponse else { throw MoodarrAPIError.invalidURL("unexpected completePlexAuth") }
    return completeResponse
  }

  func logout() async throws {
    throw MoodarrAPIError.invalidURL("unexpected logout")
  }

  func search(_ request: MoodarrSearchRequest) async throws -> MoodarrSearchResponse {
    lastSearchRequest = request
    guard let searchResponse else { throw MoodarrAPIError.invalidURL("unexpected search") }
    return searchResponse
  }

  func sendFeedback(_ request: MoodarrFeelFeedbackRequest) async throws -> MoodarrFeelFeedbackResponse {
    feedbackEventIds.append(request.clientEventId)
    if feedbackFailuresRemaining > 0 {
      feedbackFailuresRemaining -= 1
      throw MoodarrAPIError.invalidURL("feedback unavailable")
    }
    return MoodarrFeelFeedbackResponse(
      ok: true,
      eventId: feedbackEventIds.count,
      deduped: false,
      reliability: "direct",
      profileVersion: nil,
      profileHoldout: nil,
      appliedPreferenceSignal: true,
      appliedProfileSignal: true
    )
  }

  func previewRequest(_ request: MoodarrPreviewRequest) async throws -> MoodarrRequestPreview {
    guard let previewResponse else { throw MoodarrAPIError.invalidURL("unexpected previewRequest") }
    return previewResponse
  }

  func createRequest(_ request: MoodarrCreateRequestBody) async throws -> MoodarrOkResponse {
    lastCreateRequest = request
    return MoodarrOkResponse(ok: true)
  }

  func addToWatchlist(_ request: MoodarrWatchlistRequest) async throws -> MoodarrWatchlistResponse {
    lastWatchlistRequest = request
    guard let watchlistResponse else { throw MoodarrAPIError.invalidURL("unexpected addToWatchlist") }
    return watchlistResponse
  }

  func posterData(path: String) async throws -> Data {
    throw MoodarrAPIError.invalidURL("unexpected posterData")
  }
}
