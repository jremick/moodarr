import Foundation

public enum MoodarrWatchContext: String, Codable, CaseIterable, Identifiable, Sendable {
  case solo
  case group

  public var id: String { rawValue }
}

public enum MoodarrPrimaryActionMode: String, Codable, CaseIterable, Identifiable, Sendable {
  case watch
  case watchlist

  public var id: String { rawValue }
}

public enum MoodarrMediaType: String, Codable, Sendable {
  case movie
  case tv
}

public enum MoodarrAvailabilityGroup: String, Codable, Sendable {
  case availableInPlex = "available_in_plex"
  case notInPlexRequestable = "not_in_plex_requestable"
  case alreadyRequested = "already_requested"
  case partiallyAvailable = "partially_available"
  case unavailable
}

public enum MoodarrFeedbackAction: String, Codable, Sendable {
  case swipeRight = "swipe_right"
  case swipeLeft = "swipe_left"
  case swipeSkip = "swipe_skip"
  case open
  case expand
  case save
  case hide
  case moreLike = "more_like"
  case lessLike = "less_like"
  case rightMood = "right_mood"
  case wrongMood = "wrong_mood"
  case pairwisePick = "pairwise_pick"
  case requestPreview = "request_preview"
  case requestCreate = "request_create"
}

public struct MoodarrHealthResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let fixtureMode: Bool
  public let version: String
}

public struct MoodarrConfigStatusResponse: Codable, Equatable, Sendable {
  public struct IntegrationStatus: Codable, Equatable, Sendable {
    public let configured: Bool
    public let baseUrlConfigured: Bool?
  }

  public struct AIStatus: Codable, Equatable, Sendable {
    public let provider: String
    public let configured: Bool
    public let openaiModel: String?
    public let openaiEmbeddingModel: String?
    public let openaiReasoningEffort: String?
  }

  public struct AdminStatus: Codable, Equatable, Sendable {
    public let authRequired: Bool
    public let configured: Bool
    public let autoSession: Bool
  }

  public struct AuthStatus: Codable, Equatable, Sendable {
    public let plexAuthEnabled: Bool
    public let allowNewPlexUsers: Bool
  }

  public let fixtureMode: Bool
  public let plex: IntegrationStatus
  public let seerr: IntegrationStatus
  public let ai: AIStatus
  public let admin: AdminStatus
  public let auth: AuthStatus
}

public struct MoodarrAuthUser: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let provider: String
  public let providerUserId: String
  public let username: String?
  public let displayName: String?
  public let email: String?
  public let avatarUrl: String?
  public let enabled: Bool
  public let createdAt: String
  public let updatedAt: String
  public let lastLoginAt: String?

  public var label: String {
    displayName ?? username ?? email ?? "Plex user"
  }
}

public struct MoodarrAuthSessionResponse: Codable, Equatable, Sendable {
  public let authenticated: Bool
  public let plexAuthEnabled: Bool
  public let allowNewPlexUsers: Bool
  public let user: MoodarrAuthUser?
}

public struct MoodarrPlexAuthStartResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let pinId: String
  public let code: String
  public let authUrl: String
  public let expiresAt: String?
}

public struct MoodarrPlexAuthCompleteResponse: Codable, Equatable, Sendable {
  public let authenticated: Bool
  public let plexAuthEnabled: Bool
  public let allowNewPlexUsers: Bool
  public let user: MoodarrAuthUser?
  public let pending: Bool?
  public let sessionToken: String?
  public let sessionExpiresAt: String?
}

public struct MoodarrSearchRequest: Codable, Equatable, Sendable {
  public var query: String
  public var filters: MoodarrSearchFilters?
  public var useAi: Bool?
  public var resultLimit: Int?
  public var watchContext: MoodarrWatchContext?
  public var feedbackContext: MoodarrFeedbackContext?

  public init(
    query: String,
    filters: MoodarrSearchFilters? = nil,
    useAi: Bool? = nil,
    resultLimit: Int? = nil,
    watchContext: MoodarrWatchContext? = nil,
    feedbackContext: MoodarrFeedbackContext? = nil
  ) {
    self.query = query
    self.filters = filters
    self.useAi = useAi
    self.resultLimit = resultLimit
    self.watchContext = watchContext
    self.feedbackContext = feedbackContext
  }
}

public struct MoodarrSearchFilters: Codable, Equatable, Sendable {
  public var mediaTypes: [MoodarrMediaType]?
  public var minRuntimeMinutes: Int?
  public var maxRuntimeMinutes: Int?
  public var minYear: Int?
  public var maxYear: Int?
  public var genres: [String]?
  public var excludedGenres: [String]?
  public var contentRating: String?
  public var availability: [MoodarrAvailabilityGroup]?
  public var requestStatus: [String]?
}

public struct MoodarrFeedbackContext: Codable, Equatable, Sendable {
  public var moreLikeItemIds: [String]?
  public var maybeItemIds: [String]?
  public var lessLikeItemIds: [String]?
  public var hiddenItemIds: [String]?
  public var showRatedItems: Bool?
}

public struct MoodarrSearchResponse: Codable, Equatable, Sendable {
  public let sessionId: String?
  public let query: String
  public let optimizedQuery: String
  public let usedAi: Bool
  public let summary: String
  public let refinementOptions: [MoodarrRefinementOption]
  public let resolvedFilters: MoodarrSearchFilters
  public let watchContext: MoodarrWatchContext
  public let resultLimit: Int
  public let results: [MoodarrItemSummary]
}

public struct MoodarrRefinementOption: Codable, Equatable, Identifiable, Sendable {
  public var id: String { "\(label):\(prompt)" }
  public let label: String
  public let prompt: String
}

public struct MoodarrItemSummary: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let mediaType: MoodarrMediaType
  public let title: String
  public let year: Int?
  public let runtimeMinutes: Int?
  public let summary: String?
  public let genres: [String]
  public let contentRating: String?
  public let ratings: MoodarrRatingSet
  public let posterUrl: String
  public let availabilityGroup: MoodarrAvailabilityGroup
  public let availabilityExplanation: String
  public let matchExplanation: String
  public let score: Double
  public let plex: MoodarrPlexState?
  public let seerr: MoodarrSeerrState?
}

public struct MoodarrRatingSet: Codable, Equatable, Sendable {
  public let critic: Double?
  public let audience: Double?
  public let user: Double?
}

public struct MoodarrPlexState: Codable, Equatable, Sendable {
  public let available: Bool
  public let url: String?
  public let appUrl: String?
  public let library: String?
}

public struct MoodarrSeerrState: Codable, Equatable, Sendable {
  public let status: String
  public let requestStatus: String?
  public let requestable: Bool
  public let url: String?
  public let mediaId: Int?
}

public struct MoodarrFeelFeedbackRequest: Codable, Equatable, Sendable {
  public var action: MoodarrFeedbackAction
  public var source: String = "ios"
  public var clientEventId: String?
  public var watchContext: MoodarrWatchContext?
  public var sessionId: String?
  public var itemId: String?
  public var comparedItemId: String?
  public var moodTerm: String?
  public var reason: String?
  public var strength: Int?
  public var metadata: [String: MoodarrJSONValue]?

  public init(
    action: MoodarrFeedbackAction,
    clientEventId: String? = nil,
    watchContext: MoodarrWatchContext? = nil,
    sessionId: String? = nil,
    itemId: String? = nil,
    comparedItemId: String? = nil,
    moodTerm: String? = nil,
    reason: String? = nil,
    strength: Int? = nil,
    metadata: [String: MoodarrJSONValue]? = nil
  ) {
    self.action = action
    self.clientEventId = clientEventId
    self.watchContext = watchContext
    self.sessionId = sessionId
    self.itemId = itemId
    self.comparedItemId = comparedItemId
    self.moodTerm = moodTerm
    self.reason = reason
    self.strength = strength
    self.metadata = metadata
  }
}

public struct MoodarrFeelFeedbackResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let eventId: Int
  public let deduped: Bool?
  public let reliability: String
  public let profileVersion: Int?
  public let profileHoldout: Bool?
  public let appliedPreferenceSignal: Bool
  public let appliedProfileSignal: Bool?
}

public struct MoodarrPreviewRequest: Codable, Equatable, Sendable {
  public var itemId: String?
  public var mediaType: MoodarrMediaType?
  public var tmdbId: Int?
  public var seasons: [Int]?

  public init(itemId: String? = nil, mediaType: MoodarrMediaType? = nil, tmdbId: Int? = nil, seasons: [Int]? = nil) {
    self.itemId = itemId
    self.mediaType = mediaType
    self.tmdbId = tmdbId
    self.seasons = seasons
  }
}

public struct MoodarrRequestPreview: Codable, Equatable, Sendable {
  public struct Request: Codable, Equatable, Sendable {
    public let mediaType: MoodarrMediaType
    public let mediaId: Int
    public let seasons: [Int]?
    public let title: String
  }

  public let canRequest: Bool
  public let blockedReason: String?
  public let requiresConfirmation: Bool
  public let confirmationPhrase: String
  public let request: Request
  public let item: MoodarrItemSummary
}

public struct MoodarrCreateRequestBody: Codable, Equatable, Sendable {
  public var itemId: String?
  public var mediaType: MoodarrMediaType?
  public var tmdbId: Int?
  public var seasons: [Int]?
  public var confirmed: Bool?
  public var confirmationPhrase: String?
}

public struct MoodarrWatchlistRequest: Codable, Equatable, Sendable {
  public var itemId: String
}

public struct MoodarrWatchlistResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let itemId: String
  public let alreadyWatchlisted: Bool
}

public enum MoodarrJSONValue: Codable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else {
      self = .string(try container.decode(String.self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .bool(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}
