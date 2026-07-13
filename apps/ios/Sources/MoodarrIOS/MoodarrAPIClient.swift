import Foundation

public enum MoodarrAPIError: Error, LocalizedError, Equatable, Sendable {
  case invalidBaseURL
  case invalidURL(String)
  case httpStatus(Int, String)
  case missingNativeSessionToken

  public var errorDescription: String? {
    switch self {
    case .invalidBaseURL:
      return "Enter a valid Moodarr server URL."
    case .invalidURL(let path):
      return "Could not build Moodarr API URL for \(path)."
    case .httpStatus(_, let message):
      return message
    case .missingNativeSessionToken:
      return "Plex sign-in completed but did not return a native session token."
    }
  }
}

public protocol MoodarrAPIClienting: Sendable {
  func health() async throws -> MoodarrHealthResponse
  func configStatus() async throws -> MoodarrConfigStatusResponse
  func authSession() async throws -> MoodarrAuthSessionResponse
  func startPlexAuth(returnURL: String?) async throws -> MoodarrPlexAuthStartResponse
  func completePlexAuth(pinId: String, code: String) async throws -> MoodarrPlexAuthCompleteResponse
  func logout() async throws
  func search(_ request: MoodarrSearchRequest) async throws -> MoodarrSearchResponse
  func sendFeedback(_ request: MoodarrFeelFeedbackRequest) async throws -> MoodarrFeelFeedbackResponse
  func previewRequest(_ request: MoodarrPreviewRequest) async throws -> MoodarrRequestPreview
  func createRequest(_ request: MoodarrCreateRequestBody) async throws -> MoodarrOkResponse
  func addToWatchlist(_ request: MoodarrWatchlistRequest) async throws -> MoodarrWatchlistResponse
  func posterData(path: String) async throws -> Data
}

public actor MoodarrAPIClient: MoodarrAPIClienting {
  public private(set) var baseURL: URL
  public private(set) var sessionToken: String?

  private let urlSession: URLSession
  private let jsonEncoder: JSONEncoder
  private let jsonDecoder: JSONDecoder

  public init(baseURL: URL, sessionToken: String? = nil, urlSession: URLSession = .shared) {
    self.baseURL = baseURL.normalizedMoodarrBaseURL()
    self.sessionToken = sessionToken
    self.urlSession = urlSession
    self.jsonEncoder = JSONEncoder()
    self.jsonDecoder = JSONDecoder()
  }

  public func updateBaseURL(_ baseURL: URL) {
    self.baseURL = baseURL.normalizedMoodarrBaseURL()
  }

  public func updateSessionToken(_ token: String?) {
    self.sessionToken = token
  }

  public func health() async throws -> MoodarrHealthResponse {
    try await send("GET", "/api/health")
  }

  public func configStatus() async throws -> MoodarrConfigStatusResponse {
    try await send("GET", "/api/config/status")
  }

  public func authSession() async throws -> MoodarrAuthSessionResponse {
    try await send("GET", "/api/auth/session")
  }

  public func startPlexAuth(returnURL: String? = nil) async throws -> MoodarrPlexAuthStartResponse {
    try await send("POST", "/api/auth/plex/start", body: PlexAuthStartBody(returnUrl: returnURL))
  }

  public func completePlexAuth(pinId: String, code: String) async throws -> MoodarrPlexAuthCompleteResponse {
    let response: MoodarrPlexAuthCompleteResponse = try await send(
      "POST",
      "/api/auth/plex/complete",
      body: PlexAuthCompleteBody(pinId: pinId, code: code, nativeSession: true)
    )
    if response.authenticated {
      guard let token = response.sessionToken else { throw MoodarrAPIError.missingNativeSessionToken }
      sessionToken = token
    }
    return response
  }

  public func logout() async throws {
    let _: MoodarrOkResponse = try await send("POST", "/api/auth/logout", body: EmptyBody())
    sessionToken = nil
  }

  public func search(_ request: MoodarrSearchRequest) async throws -> MoodarrSearchResponse {
    try await send("POST", "/api/search", body: request)
  }

  public func sendFeedback(_ request: MoodarrFeelFeedbackRequest) async throws -> MoodarrFeelFeedbackResponse {
    try await send("POST", "/api/feel-feedback", body: request)
  }

  public func previewRequest(_ request: MoodarrPreviewRequest) async throws -> MoodarrRequestPreview {
    try await send("POST", "/api/requests/preview", body: request)
  }

  public func createRequest(_ request: MoodarrCreateRequestBody) async throws -> MoodarrOkResponse {
    try await send("POST", "/api/requests/create", body: request)
  }

  public func addToWatchlist(_ request: MoodarrWatchlistRequest) async throws -> MoodarrWatchlistResponse {
    try await send("POST", "/api/plex/watchlist", body: request)
  }

  public func posterData(path: String) async throws -> Data {
    let request = try makeRequest("GET", path)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response: response, data: data)
    return data
  }

  private func send<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
    let request = try makeRequest(method, path)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response: response, data: data)
    return try jsonDecoder.decode(Response.self, from: data)
  }

  private func send<Body: Encodable, Response: Decodable>(_ method: String, _ path: String, body: Body) async throws -> Response {
    var request = try makeRequest(method, path)
    request.httpBody = try jsonEncoder.encode(body)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response: response, data: data)
    return try jsonDecoder.decode(Response.self, from: data)
  }

  private func makeRequest(_ method: String, _ path: String) throws -> URLRequest {
    let url: URL
    if path.starts(with: "http://") || path.starts(with: "https://") {
      guard let absolute = URL(string: path) else { throw MoodarrAPIError.invalidURL(path) }
      url = absolute
    } else {
      guard let relative = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw MoodarrAPIError.invalidURL(path) }
      url = relative
    }

    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if method != "GET" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let sessionToken {
      request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
    }
    return request
  }

  private func validate(response: URLResponse, data: Data) throws {
    guard let http = response as? HTTPURLResponse else { return }
    guard 200..<300 ~= http.statusCode else {
      let error = (try? jsonDecoder.decode(MoodarrErrorResponse.self, from: data).error) ?? "Moodarr returned HTTP \(http.statusCode)."
      throw MoodarrAPIError.httpStatus(http.statusCode, error)
    }
  }
}

public struct MoodarrOkResponse: Codable, Equatable, Sendable {
  public let ok: Bool
}

private struct MoodarrErrorResponse: Codable, Sendable {
  let error: String
}

private struct EmptyBody: Encodable, Sendable {}

private struct PlexAuthStartBody: Encodable, Sendable {
  let returnUrl: String?
}

private struct PlexAuthCompleteBody: Encodable, Sendable {
  let pinId: String
  let code: String
  let nativeSession: Bool
}

private extension URL {
  func normalizedMoodarrBaseURL() -> URL {
    var absolute = absoluteURL
    if absolute.path != "/" {
      absolute.deleteLastPathComponent()
    }
    return absolute
  }
}
