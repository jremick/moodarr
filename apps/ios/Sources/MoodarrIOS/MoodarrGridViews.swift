import SwiftUI

struct MoodarrGridResultsView: View {
  @ObservedObject var model: MoodarrAppViewModel
  let results: [MoodarrItemSummary]
  let moodTerm: String?
  let onNeedsRequestConfirmation: () -> Void
  @Environment(\.openURL) private var openURL
  @State private var selectedItemId: String?

  private var selectedItem: MoodarrItemSummary? {
    guard let selectedItemId else { return results.first }
    return results.first { $0.id == selectedItemId } ?? results.first
  }

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: 145, maximum: 210), spacing: 10)]
  }

  var body: some View {
    ScrollView {
      LazyVGrid(columns: columns, spacing: 10) {
        ForEach(results) { item in
          Button {
            selectedItemId = item.id
          } label: {
            MoodarrGridPosterCard(
              model: model,
              item: item,
              isSelected: selectedItem?.id == item.id
            )
          }
          .buttonStyle(.plain)
          .accessibilityHint("Selects this title and shows its details and actions below")
          .contextMenu {
            Button {
              watchOrRequest(item)
            } label: {
              Label(
                item.primaryActionTitle(for: model.primaryActionMode),
                systemImage: item.primaryActionIcon(for: model.primaryActionMode)
              )
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if let selectedItem {
        MoodarrSelectedItemShelf(
          item: selectedItem,
          primaryActionMode: model.primaryActionMode,
          onYes: { tag(selectedItem, action: .rightMood) },
          onNo: { tag(selectedItem, action: .wrongMood) },
          onMaybe: { tag(selectedItem, action: .save) },
          onPrimaryAction: { watchOrRequest(selectedItem) }
        )
      }
    }
    .onAppear {
      if selectedItemId == nil {
        selectedItemId = results.first?.id
      }
    }
    .onChange(of: results.map(\.id)) { _, ids in
      if let selectedItemId, ids.contains(selectedItemId) { return }
      self.selectedItemId = ids.first
    }
  }

  private func tag(_ item: MoodarrItemSummary, action: MoodarrFeedbackAction) {
    Task {
      await model.sendFeedback(action: action, item: item, moodTerm: moodTerm)
      selectedItemId = model.visibleResults.first?.id
    }
  }

  private func watchOrRequest(_ item: MoodarrItemSummary) {
    Task {
      if item.isAvailableToWatch {
        if model.primaryActionMode == .watch {
          await model.sendFeedback(action: .open, item: item, moodTerm: moodTerm)
          if let url = item.watchURL {
            openURL(url)
          }
        } else {
          await model.addToWatchlistOrRequest(item)
        }
      } else {
        await model.sendFeedback(action: .requestPreview, item: item, moodTerm: moodTerm)
        await model.previewRequest(for: item)
        if model.requestPreview?.item.id == item.id {
          onNeedsRequestConfirmation()
        }
      }
    }
  }
}

private struct MoodarrSelectedItemShelf: View {
  let item: MoodarrItemSummary
  let primaryActionMode: MoodarrPrimaryActionMode
  let onYes: () -> Void
  let onNo: () -> Void
  let onMaybe: () -> Void
  let onPrimaryAction: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(item.title)
          .font(.headline.weight(.bold))
          .foregroundStyle(Color.moodarrInk)
          .lineLimit(1)
        Spacer(minLength: 8)
        MoodarrScoreBadge(score: item.score)
      }

      MoodarrAvailabilityRow(item: item)

      Label(item.matchExplanation, systemImage: "sparkles")
        .font(.caption)
        .foregroundStyle(Color.moodarrMuted)
        .lineLimit(2)

      HStack(spacing: 7) {
        MoodarrDeckActionButton(
          title: "Yes",
          systemImage: "hand.thumbsup.fill",
          tint: .moodarrAccentStrong,
          accessibilityHint: "Saves this as a strong match",
          action: onYes
        )
        MoodarrDeckActionButton(
          title: "No",
          systemImage: "xmark",
          tint: .moodarrWarn,
          accessibilityHint: "Removes this and tunes future results",
          action: onNo
        )
        MoodarrDeckActionButton(
          title: "Maybe",
          systemImage: "bookmark.fill",
          tint: .moodarrFaint,
          accessibilityHint: "Saves this for later review",
          action: onMaybe
        )
        MoodarrDeckActionButton(
          title: item.primaryActionTitle(for: primaryActionMode),
          systemImage: item.primaryActionIcon(for: primaryActionMode),
          tint: item.upActionTint,
          accessibilityHint: item.primaryActionAccessibilityHint(for: primaryActionMode),
          action: onPrimaryAction
        )
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 11)
    .background(.ultraThinMaterial)
    .overlay(alignment: .top) {
      Rectangle()
        .fill(Color.moodarrLine)
        .frame(height: 1)
    }
    .accessibilityElement(children: .contain)
  }
}

private struct MoodarrGridPosterCard: View {
  @ObservedObject var model: MoodarrAppViewModel
  let item: MoodarrItemSummary
  let isSelected: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      MoodarrPosterView(model: model, item: item, width: 148, height: 220)
        .frame(maxWidth: .infinity)
      Text(item.title)
        .font(.caption.weight(.bold))
        .foregroundStyle(Color.moodarrInk)
        .lineLimit(2)
        .frame(minHeight: 34, alignment: .topLeading)
      HStack(spacing: 6) {
        if let year = item.year { MoodarrMetaCapsule(String(year)) }
        MoodarrAvailabilityBadge(group: item.availabilityGroup)
        Spacer(minLength: 0)
        Text(String(format: "%.0f", item.score))
          .font(.caption2.monospacedDigit().weight(.bold))
          .foregroundStyle(Color.moodarrAccentStrong)
      }
    }
    .padding(9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.moodarrPanel, in: RoundedRectangle(cornerRadius: 10))
    .overlay(
      RoundedRectangle(cornerRadius: 10)
        .stroke(isSelected ? Color.moodarrAccentStrong : Color.moodarrLine, lineWidth: isSelected ? 2 : 1)
    )
    .shadow(color: Color.black.opacity(isSelected ? 0.09 : 0.04), radius: isSelected ? 16 : 10, x: 0, y: 8)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(item.accessibilitySummary)
    .accessibilityValue(isSelected ? "Selected" : "Not selected")
  }
}

struct MoodarrEmptyResultsView: View {
  let filter: MoodarrSavedResultFilter

  var body: some View {
    MoodarrPanel(eyebrow: "Slate", title: filter.emptyTitle) {
      Text(filter.emptyMessage)
        .font(.callout.weight(.medium))
        .foregroundStyle(Color.moodarrMuted)
    }
    .frame(maxHeight: .infinity, alignment: .center)
  }
}
