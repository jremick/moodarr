import SwiftUI

struct MoodarrSwipeDeck: View {
  @ObservedObject var model: MoodarrAppViewModel
  let results: [MoodarrItemSummary]
  let moodTerm: String?
  let onNeedsRequestConfirmation: () -> Void
  @Environment(\.openURL) private var openURL
  @State private var currentIndex = 0
  @State private var dragOffset: CGSize = .zero
  @State private var isAdvancing = false

  var body: some View {
    GeometryReader { proxy in
      VStack(spacing: 10) {
        if results.indices.contains(currentIndex) {
          cardStack(in: proxy)
          actionBar(for: results[currentIndex], in: proxy)
        } else {
          completedPanel
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private func cardStack(in proxy: GeometryProxy) -> some View {
    ZStack {
      if results.indices.contains(currentIndex + 1) {
        MoodarrSwipeCard(model: model, item: results[currentIndex + 1], isTopCard: false)
          .scaleEffect(0.95)
          .offset(y: 16)
          .opacity(0.58)
      }
      MoodarrSwipeCard(model: model, item: results[currentIndex], isTopCard: true)
        .overlay(alignment: .top) {
          if let cue = swipeCue(for: results[currentIndex]) {
            MoodarrSwipeCue(cue: cue)
              .padding(.top, 16)
          }
        }
        .offset(dragOffset)
        .rotationEffect(.degrees(Double(dragOffset.width / 22)))
        .gesture(cardDragGesture)
    }
    .frame(height: max(430, proxy.size.height - 58))
  }

  private var cardDragGesture: some Gesture {
    DragGesture(minimumDistance: 16)
      .onChanged { value in
        guard !isAdvancing else { return }
        dragOffset = value.translation
      }
      .onEnded { value in
        guard results.indices.contains(currentIndex), !isAdvancing else { return }
        handleSwipe(value.translation, item: results[currentIndex])
      }
  }

  private func actionBar(for item: MoodarrItemSummary, in proxy: GeometryProxy) -> some View {
    HStack(spacing: 8) {
      MoodarrDeckActionButton(
        title: "Yes",
        systemImage: "hand.thumbsup.fill",
        tint: .moodarrAccentText,
        accessibilityHint: "Saves this as a strong match"
      ) {
        accept(item, action: .rightMood, exitOffset: CGSize(width: -proxy.size.width - 140, height: -12))
      }
      MoodarrDeckActionButton(
        title: "No",
        systemImage: "xmark",
        tint: .moodarrWarnText,
        accessibilityHint: "Removes this and tunes future results"
      ) {
        accept(item, action: .wrongMood, exitOffset: CGSize(width: proxy.size.width + 140, height: 12))
      }
      MoodarrDeckActionButton(
        title: "Maybe",
        systemImage: "bookmark.fill",
        tint: .moodarrFaint,
        accessibilityHint: "Saves this for later review"
      ) {
        accept(item, action: .save, exitOffset: CGSize(width: 0, height: proxy.size.height + 120))
      }
      MoodarrDeckActionButton(
        title: item.primaryActionTitle(for: model.primaryActionMode),
        systemImage: item.primaryActionIcon(for: model.primaryActionMode),
        tint: item.upActionTint,
        accessibilityHint: item.primaryActionAccessibilityHint(for: model.primaryActionMode)
      ) {
        watchOrRequest(item, exitOffset: CGSize(width: 0, height: -proxy.size.height - 120))
      }
    }
  }

  private var completedPanel: some View {
    MoodarrPanel(eyebrow: "Complete", title: "Slate cleared") {
      Label("Search again for a fresh slate.", systemImage: "checkmark.circle.fill")
        .font(.callout.weight(.medium))
        .foregroundStyle(Color.moodarrMuted)
    }
    .frame(maxHeight: .infinity, alignment: .center)
  }

  private func handleSwipe(_ translation: CGSize, item: MoodarrItemSummary) {
    let threshold: CGFloat = 86
    if abs(translation.width) > abs(translation.height), abs(translation.width) > threshold {
      let exit = CGSize(width: translation.width < 0 ? -520 : 520, height: translation.height)
      accept(item, action: translation.width < 0 ? .rightMood : .wrongMood, exitOffset: exit)
    } else if abs(translation.height) > threshold {
      if translation.height > 0 {
        accept(item, action: .save, exitOffset: CGSize(width: translation.width, height: 680))
      } else {
        watchOrRequest(item, exitOffset: CGSize(width: translation.width, height: -680))
      }
    } else {
      resetCardPosition()
    }
  }

  private func accept(_ item: MoodarrItemSummary, action: MoodarrFeedbackAction, exitOffset: CGSize) {
    animateAway(to: exitOffset)
    Task { await model.sendFeedback(action: action, item: item, moodTerm: moodTerm) }
  }

  private func watchOrRequest(_ item: MoodarrItemSummary, exitOffset: CGSize) {
    if item.isAvailableToWatch {
      animateAway(to: exitOffset)
      Task {
        if model.primaryActionMode == .watch {
          await model.sendFeedback(action: .open, item: item, moodTerm: moodTerm)
          if let url = item.watchURL {
            openURL(url)
          }
        } else {
          await model.addToWatchlistOrRequest(item)
        }
      }
    } else {
      resetCardPosition()
      Task {
        await model.sendFeedback(action: .requestPreview, item: item, moodTerm: moodTerm)
        await model.previewRequest(for: item)
        if model.requestPreview?.item.id == item.id {
          onNeedsRequestConfirmation()
        }
      }
    }
  }

  private func resetCardPosition() {
    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
      dragOffset = .zero
    }
  }

  private func animateAway(to exitOffset: CGSize) {
    guard !isAdvancing else { return }
    isAdvancing = true
    withAnimation(.easeOut(duration: 0.22)) {
      dragOffset = exitOffset
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.23) {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) {
        currentIndex = min(currentIndex + 1, results.count)
        dragOffset = .zero
        isAdvancing = false
      }
    }
  }

  private func swipeCue(for item: MoodarrItemSummary) -> MoodarrSwipeCue.Kind? {
    let threshold: CGFloat = 32
    if abs(dragOffset.width) > abs(dragOffset.height), abs(dragOffset.width) > threshold {
      return dragOffset.width < 0 ? .yes : .no
    }
    if abs(dragOffset.height) > threshold {
      return dragOffset.height > 0 ? .maybe : (item.isAvailableToWatch ? .watch : .request)
    }
    return nil
  }
}

private struct MoodarrSwipeCard: View {
  @ObservedObject var model: MoodarrAppViewModel
  let item: MoodarrItemSummary
  let isTopCard: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 13) {
      MoodarrPosterView(
        model: model,
        item: item,
        width: isTopCard ? 238 : 220,
        height: isTopCard ? 354 : 326
      )
      .frame(maxWidth: .infinity)

      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(item.title)
          .font(.title3.weight(.bold))
          .foregroundStyle(Color.moodarrInk)
          .lineLimit(2)
        Spacer(minLength: 8)
        MoodarrScoreBadge(score: item.score)
      }

      HStack(spacing: 6) {
        if let year = item.year { MoodarrMetaCapsule(String(year)) }
        if let runtime = item.runtimeMinutes { MoodarrMetaCapsule("\(runtime)m") }
        MoodarrMetaCapsule(item.mediaType.rawValue.uppercased())
      }

      Label(item.matchExplanation, systemImage: "sparkles")
        .font(.callout)
        .lineSpacing(2)
        .foregroundStyle(Color.moodarrMuted)
        .lineLimit(2)

      MoodarrAvailabilityRow(item: item)

      Label(
        item.primaryActionTitle(for: model.primaryActionMode),
        systemImage: item.primaryActionIcon(for: model.primaryActionMode)
      )
      .font(.caption.weight(.bold))
      .foregroundStyle(item.upActionTint)
      .accessibilityLabel("Primary action: \(item.primaryActionTitle(for: model.primaryActionMode))")
    }
    .padding(14)
    .background(Color.moodarrPanel, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(isTopCard ? Color.moodarrLineStrong : Color.moodarrLine))
    .shadow(color: Color.black.opacity(isTopCard ? 0.08 : 0.035), radius: isTopCard ? 24 : 14, x: 0, y: isTopCard ? 14 : 8)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(item.accessibilitySummary)
    .accessibilityHint("Swipe or use the action buttons below")
  }
}

struct MoodarrSwipeCue: View {
  enum Kind {
    case yes
    case no
    case maybe
    case watch
    case request
  }

  let cue: Kind

  var body: some View {
    Label(cue.title, systemImage: cue.systemImage)
      .font(.headline.weight(.black))
      .foregroundStyle(cue.tint)
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      .background(cue.tint.opacity(0.13), in: Capsule())
      .overlay(Capsule().stroke(cue.tint.opacity(0.38)))
  }
}

struct MoodarrDeckActionButton: View {
  let title: String
  let systemImage: String
  let tint: Color
  var accessibilityHint: String = ""
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 4) {
        Image(systemName: systemImage)
          .font(.caption.weight(.black))
        Text(title)
          .font(.caption2.weight(.bold))
      }
      .foregroundStyle(tint)
      .frame(maxWidth: .infinity, minHeight: 48)
      .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).stroke(tint.opacity(0.24)))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityHint(accessibilityHint)
  }
}
