import SwiftUI

extension View {
  func moodarrTextField(prominent: Bool = false) -> some View {
    self
      .font(prominent ? .headline.weight(.semibold) : .callout.weight(.medium))
      .foregroundStyle(Color.moodarrInk)
      .padding(.horizontal, 12)
      .padding(.vertical, prominent ? 14 : 11)
      .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.moodarrLineStrong.opacity(0.72)))
  }
}

extension MoodarrAvailabilityGroup {
  var label: String {
    switch self {
    case .availableInPlex: "Available in Plex"
    case .notInPlexRequestable: "Requestable in Seerr"
    case .alreadyRequested: "Already requested"
    case .partiallyAvailable: "Partially available"
    case .unavailable: "Unavailable"
    }
  }

  var shortLabel: String {
    switch self {
    case .availableInPlex: "Plex"
    case .notInPlexRequestable: "Request"
    case .alreadyRequested: "Pending"
    case .partiallyAvailable: "Partial"
    case .unavailable: "Missing"
    }
  }

  var systemImage: String {
    switch self {
    case .availableInPlex: "play.rectangle.fill"
    case .notInPlexRequestable: "paperplane.fill"
    case .alreadyRequested: "clock.fill"
    case .partiallyAvailable: "circle.lefthalf.filled"
    case .unavailable: "nosign"
    }
  }

  var tint: Color {
    switch self {
    case .availableInPlex: .moodarrAccentText
    case .notInPlexRequestable: .moodarrPlexText
    case .alreadyRequested: .moodarrWarnText
    case .partiallyAvailable: .moodarrAccentText
    case .unavailable: .moodarrFaint
    }
  }
}

extension MoodarrItemSummary {
  var isAvailableToWatch: Bool {
    availabilityGroup == .availableInPlex
  }

  var watchURL: URL? {
    if let webUrl = plex?.url, let url = URL(string: webUrl) {
      return url
    }
    if let appUrl = plex?.appUrl, let url = URL(string: appUrl) {
      return url
    }
    return nil
  }

  func primaryActionTitle(for mode: MoodarrPrimaryActionMode) -> String {
    if !isAvailableToWatch { return "Request" }
    return mode == .watchlist ? "Watchlist" : "Watch"
  }

  func primaryActionIcon(for mode: MoodarrPrimaryActionMode) -> String {
    if !isAvailableToWatch { return "paperplane.fill" }
    return mode == .watchlist ? "bookmark.fill" : "play.fill"
  }

  func primaryActionAccessibilityHint(for mode: MoodarrPrimaryActionMode) -> String {
    if !isAvailableToWatch {
      return "Opens a Seerr request preview. A separate confirmation is always required."
    }
    return mode == .watchlist
      ? "Adds this available title to your Plex Watchlist"
      : "Opens this available title in Plex"
  }

  var upActionTint: Color {
    isAvailableToWatch ? .moodarrAccentText : .moodarrWarnText
  }

  var accessibilitySummary: String {
    "\(title), \(availabilityGroup.label), match score \(Int(score)). \(matchExplanation). \(availabilityExplanation)"
  }
}

extension MoodarrWatchContext {
  var systemImage: String {
    switch self {
    case .solo: "person.fill"
    case .group: "person.2.fill"
    }
  }
}

extension MoodarrSavedResultFilter {
  var title: String {
    switch self {
    case .candidates: "New"
    case .yes: "Yes"
    case .maybe: "Maybe"
    }
  }

  var systemImage: String {
    switch self {
    case .candidates: "sparkles"
    case .yes: "hand.thumbsup.fill"
    case .maybe: "bookmark.fill"
    }
  }

  var emptyTitle: String {
    switch self {
    case .candidates: "No new candidates"
    case .yes: "No yes picks"
    case .maybe: "No maybe picks"
    }
  }

  var emptyMessage: String {
    switch self {
    case .candidates: "Update the search to rerank around your latest choices."
    case .yes: "Swipe or tag titles as yes, then come back here to choose one."
    case .maybe: "Swipe or tag titles as maybe, then review them here."
    }
  }
}

extension MoodarrSwipeCue.Kind {
  var title: String {
    switch self {
    case .yes: "YES"
    case .no: "NO"
    case .maybe: "MAYBE"
    case .watch: "WATCH"
    case .request: "PREVIEW"
    }
  }

  var systemImage: String {
    switch self {
    case .yes: "hand.thumbsup.fill"
    case .no: "xmark"
    case .maybe: "bookmark.fill"
    case .watch: "play.fill"
    case .request: "doc.text.magnifyingglass"
    }
  }

  var tint: Color {
    switch self {
    case .yes: .moodarrAccentText
    case .no: .moodarrWarnText
    case .maybe: .moodarrFaint
    case .watch: .moodarrAccentText
    case .request: .moodarrWarnText
    }
  }
}

extension String {
  var firstMoodTerm: String? {
    split(separator: " ")
      .map { $0.trimmingCharacters(in: .punctuationCharacters).lowercased() }
      .first { $0.count > 2 }
  }
}

extension Color {
  static let moodarrBackground = Color(red: 251 / 255, green: 246 / 255, blue: 238 / 255)
  static let moodarrPanel = Color(red: 255 / 255, green: 253 / 255, blue: 248 / 255)
  static let moodarrPanelSoft = Color(red: 244 / 255, green: 238 / 255, blue: 230 / 255)
  static let moodarrPaper = Color(red: 247 / 255, green: 223 / 255, blue: 189 / 255)
  static let moodarrInk = Color(red: 47 / 255, green: 61 / 255, blue: 58 / 255)
  static let moodarrMuted = Color(red: 87 / 255, green: 104 / 255, blue: 98 / 255)
  static let moodarrFaint = Color(red: 94 / 255, green: 111 / 255, blue: 106 / 255)
  static let moodarrLine = Color(red: 234 / 255, green: 223 / 255, blue: 209 / 255)
  static let moodarrLineStrong = Color(red: 215 / 255, green: 199 / 255, blue: 182 / 255)
  static let moodarrAccent = Color(red: 95 / 255, green: 151 / 255, blue: 139 / 255)
  static let moodarrAccentStrong = Color(red: 74 / 255, green: 125 / 255, blue: 117 / 255)
  static let moodarrAccentText = Color(red: 62 / 255, green: 108 / 255, blue: 101 / 255)
  static let moodarrAccentSoft = Color(red: 228 / 255, green: 241 / 255, blue: 237 / 255)
  static let moodarrControl = Color(red: 80 / 255, green: 106 / 255, blue: 100 / 255)
  static let moodarrWarn = Color(red: 191 / 255, green: 127 / 255, blue: 112 / 255)
  static let moodarrWarnText = Color(red: 152 / 255, green: 91 / 255, blue: 79 / 255)
  static let moodarrPlex = Color(red: 229 / 255, green: 160 / 255, blue: 13 / 255)
  static let moodarrPlexText = Color(red: 143 / 255, green: 96 / 255, blue: 0 / 255)
}
