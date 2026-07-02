import Foundation
import Security

public protocol MoodarrSessionStoring {
  func load() throws -> MoodarrStoredSession?
  func save(_ session: MoodarrStoredSession) throws
  func clear() throws
}

public protocol MoodarrServerURLStoring {
  func load() -> URL?
  func save(_ url: URL)
  func clear()
}

public struct MoodarrStoredSession: Codable, Equatable, Sendable {
  public var baseURL: URL
  public var token: String
  public var expiresAt: String?

  public init(baseURL: URL, token: String, expiresAt: String?) {
    self.baseURL = baseURL
    self.token = token
    self.expiresAt = expiresAt
  }
}

public final class MoodarrUserDefaultsServerURLStore: MoodarrServerURLStoring {
  private let defaults: UserDefaults
  private let key: String

  public init(defaults: UserDefaults = .standard, key: String = "moodarr.serverURL") {
    self.defaults = defaults
    self.key = key
  }

  public func load() -> URL? {
    guard let value = defaults.string(forKey: key) else { return nil }
    return URL(string: value)
  }

  public func save(_ url: URL) {
    defaults.set(url.absoluteString, forKey: key)
  }

  public func clear() {
    defaults.removeObject(forKey: key)
  }
}

public enum MoodarrSessionStoreError: Error, Sendable {
  case encodeFailed
  case decodeFailed
  case keychainStatus(OSStatus)
}

public final class MoodarrKeychainSessionStore: MoodarrSessionStoring {
  private let service: String
  private let account: String
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(service: String = "ai.jarel.moodarr.ios", account: String = "moodarr-user-session") {
    self.service = service
    self.account = account
  }

  public func load() throws -> MoodarrStoredSession? {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw MoodarrSessionStoreError.keychainStatus(status) }
    guard let data = result as? Data else { throw MoodarrSessionStoreError.decodeFailed }
    do {
      return try decoder.decode(MoodarrStoredSession.self, from: data)
    } catch {
      throw MoodarrSessionStoreError.decodeFailed
    }
  }

  public func save(_ session: MoodarrStoredSession) throws {
    let data: Data
    do {
      data = try encoder.encode(session)
    } catch {
      throw MoodarrSessionStoreError.encodeFailed
    }

    var query = baseQuery()
    let attributes = [kSecValueData as String: data]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecSuccess { return }
    if status != errSecItemNotFound { throw MoodarrSessionStoreError.keychainStatus(status) }

    query[kSecValueData as String] = data
    let addStatus = SecItemAdd(query as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw MoodarrSessionStoreError.keychainStatus(addStatus) }
  }

  public func clear() throws {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    if status == errSecItemNotFound || status == errSecSuccess { return }
    throw MoodarrSessionStoreError.keychainStatus(status)
  }

  private func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]
  }
}

public final class MoodarrInMemorySessionStore: MoodarrSessionStoring {
  private var session: MoodarrStoredSession?

  public init(session: MoodarrStoredSession? = nil) {
    self.session = session
  }

  public func load() throws -> MoodarrStoredSession? {
    session
  }

  public func save(_ session: MoodarrStoredSession) throws {
    self.session = session
  }

  public func clear() throws {
    session = nil
  }
}

public final class MoodarrInMemoryServerURLStore: MoodarrServerURLStoring {
  private var url: URL?

  public init(url: URL? = nil) {
    self.url = url
  }

  public func load() -> URL? {
    url
  }

  public func save(_ url: URL) {
    self.url = url
  }

  public func clear() {
    url = nil
  }
}
