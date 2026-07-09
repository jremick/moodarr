import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

struct MoodarrPosterView: View {
  @ObservedObject var model: MoodarrAppViewModel
  let item: MoodarrItemSummary
  let width: CGFloat
  let height: CGFloat
  @State private var imageData: Data?
  @State private var failed = false

  init(model: MoodarrAppViewModel, item: MoodarrItemSummary, width: CGFloat = 88, height: CGFloat = 132) {
    self.model = model
    self.item = item
    self.width = width
    self.height = height
  }

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 10)
        .fill(
          LinearGradient(
            colors: [.moodarrPaper, .moodarrPanelSoft],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      if let image {
        image
          .resizable()
          .scaledToFill()
      } else {
        VStack(spacing: 7) {
          Image(systemName: failed ? "photo" : "ticket.fill")
            .font(.title2)
          Text(item.mediaType.rawValue.uppercased())
            .font(.caption2.weight(.bold))
        }
        .foregroundStyle(Color.moodarrMuted)
      }
    }
    .frame(width: width, height: height)
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.moodarrLineStrong.opacity(0.7)))
    .accessibilityHidden(true)
    .task(id: item.posterUrl) {
      await loadPoster()
    }
  }

  private var image: Image? {
    guard let imageData else { return nil }
    #if os(iOS)
    guard let uiImage = UIImage(data: imageData) else { return nil }
    return Image(uiImage: uiImage)
    #elseif os(macOS)
    guard let nsImage = NSImage(data: imageData) else { return nil }
    return Image(nsImage: nsImage)
    #else
    return nil
    #endif
  }

  private func loadPoster() async {
    guard !item.posterUrl.isEmpty else { return }
    do {
      imageData = try await model.posterData(for: item)
      failed = false
    } catch {
      failed = true
    }
  }
}

struct MoodarrPanel<Content: View>: View {
  let eyebrow: String
  let title: String
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      MoodarrSectionLabel(title: title, detail: eyebrow)
      content
    }
    .padding(16)
    .background(Color.moodarrPanel.opacity(0.96), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.moodarrLine))
    .shadow(color: Color.black.opacity(0.04), radius: 18, x: 0, y: 8)
  }
}

private struct MoodarrSectionLabel: View {
  let title: String
  let detail: String?

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title)
        .font(.headline.weight(.bold))
        .foregroundStyle(Color.moodarrInk)
      Spacer(minLength: 8)
      if let detail {
        Text(detail)
          .font(.caption.weight(.bold))
          .foregroundStyle(Color.moodarrAccentText)
          .textCase(.uppercase)
      }
    }
  }
}

struct MoodarrActionButton: View {
  let title: String
  let systemImage: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(title, systemImage: systemImage)
        .font(.callout.weight(.bold))
        .foregroundStyle(Color.white)
        .lineLimit(1)
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .background(Color.moodarrControl, in: RoundedRectangle(cornerRadius: 9))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
  }
}

struct MoodarrMetricPill: View {
  let label: String
  let value: String

  var body: some View {
    HStack(spacing: 6) {
      Text(label).foregroundStyle(Color.moodarrInk)
      Text(value).foregroundStyle(Color.moodarrMuted)
    }
    .font(.caption.weight(.bold))
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(Color.moodarrPanelSoft, in: Capsule())
    .overlay(Capsule().stroke(Color.moodarrLine))
    .accessibilityElement(children: .combine)
  }
}

struct MoodarrTinyStatus: View {
  let label: String
  let active: Bool

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(active ? Color.moodarrAccent : Color.moodarrFaint)
        .frame(width: 6, height: 6)
      Text(label)
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(Color.moodarrMuted)
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(Color.moodarrPanelSoft.opacity(0.75), in: Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(label), \(active ? "available" : "unavailable")")
  }
}

struct MoodarrMetaCapsule: View {
  let text: String

  init(_ text: String) {
    self.text = text
  }

  var body: some View {
    Text(text)
      .font(.caption2.weight(.bold))
      .foregroundStyle(Color.moodarrMuted)
      .padding(.horizontal, 7)
      .padding(.vertical, 4)
      .background(Color.moodarrPanelSoft, in: Capsule())
  }
}

struct MoodarrScoreBadge: View {
  let score: Double

  var body: some View {
    Text(String(format: "%.0f", score))
      .font(.system(.caption, design: .monospaced).weight(.bold))
      .foregroundStyle(Color.moodarrAccentText)
      .padding(.horizontal, 7)
      .padding(.vertical, 4)
      .background(Color.moodarrAccentSoft, in: RoundedRectangle(cornerRadius: 6))
      .accessibilityLabel("Match score \(Int(score))")
  }
}

struct MoodarrAvailabilityBadge: View {
  let group: MoodarrAvailabilityGroup

  var body: some View {
    Label(group.shortLabel, systemImage: group.systemImage)
      .font(.caption2.weight(.bold))
      .foregroundStyle(group.tint)
      .lineLimit(1)
      .accessibilityLabel(group.label)
  }
}

struct MoodarrAvailabilityRow: View {
  let item: MoodarrItemSummary

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: item.availabilityGroup.systemImage)
        .foregroundStyle(item.availabilityGroup.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(item.availabilityGroup.label)
          .font(.caption.weight(.bold))
          .foregroundStyle(Color.moodarrInk)
        Text(item.availabilityExplanation)
          .font(.caption2)
          .foregroundStyle(Color.moodarrMuted)
          .lineLimit(2)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Availability: \(item.availabilityGroup.label). \(item.availabilityExplanation)")
  }
}

struct MoodarrAvatar: View {
  let text: String

  var body: some View {
    Text(String(text.prefix(1)).uppercased())
      .font(.headline.weight(.bold))
      .foregroundStyle(Color.moodarrInk)
      .frame(width: 42, height: 42)
      .background(Color.moodarrPaper, in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.moodarrLineStrong))
      .accessibilityHidden(true)
  }
}

struct MoodarrLogoMark: View {
  let size: CGFloat

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.22)
        .fill(Color.moodarrPaper)
      TicketShape()
        .fill(Color.moodarrInk)
        .frame(width: size * 0.68, height: size * 0.56)
      VStack(alignment: .leading, spacing: size * 0.08) {
        Capsule().frame(width: size * 0.28, height: size * 0.045)
        Capsule().frame(width: size * 0.2, height: size * 0.045)
        Capsule().frame(width: size * 0.28, height: size * 0.045)
      }
      .foregroundStyle(Color.moodarrPaper)
      .offset(x: size * 0.1)
      Circle()
        .fill(Color.moodarrWarn)
        .frame(width: size * 0.12, height: size * 0.12)
        .offset(x: -size * 0.2)
    }
    .frame(width: size, height: size)
    .shadow(color: Color.black.opacity(0.13), radius: 10, x: 0, y: 5)
    .accessibilityHidden(true)
  }
}

private struct TicketShape: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path(roundedRect: rect, cornerRadius: rect.height * 0.14)
    let notchRadius = rect.height * 0.13
    path.addPath(Path(ellipseIn: CGRect(x: rect.minX - notchRadius, y: rect.midY - notchRadius, width: notchRadius * 2, height: notchRadius * 2)))
    path.addPath(Path(ellipseIn: CGRect(x: rect.maxX - notchRadius, y: rect.midY - notchRadius, width: notchRadius * 2, height: notchRadius * 2)))
    return path
  }
}
