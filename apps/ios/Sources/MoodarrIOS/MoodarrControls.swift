import SwiftUI

struct MoodarrHeader: View {
  @ObservedObject var model: MoodarrAppViewModel
  let onSettings: () -> Void
  var body: some View {
    HStack(alignment: .center, spacing: 7) {
      MoodarrLogoMark(size: 34)
      Text("Moodarr")
        .font(.system(size: 20, weight: .bold, design: .rounded))
        .foregroundStyle(Color.moodarrInk)
        .lineLimit(1)
        .minimumScaleFactor(0.78)
        .allowsTightening(true)
        .frame(maxWidth: 92, alignment: .leading)
        .layoutPriority(1)
      Spacer(minLength: 2)
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 7) {
          MoodarrContextToggle(selection: $model.watchContext)
          MoodarrCountPill(count: model.resultLimit)
          MoodarrStateChip(model: model)
            .fixedSize(horizontal: true, vertical: false)
          settingsButton
        }
        HStack(spacing: 7) {
          MoodarrContextToggle(selection: $model.watchContext)
          settingsButton
        }
      }
    }
    .padding(.vertical, 4)
  }

  private var settingsButton: some View {
    Button(action: onSettings) {
        Image(systemName: "gearshape.fill")
          .font(.callout.weight(.bold))
          .foregroundStyle(Color.moodarrAccentStrong)
          .frame(width: 44, height: 44)
          .background(Color.moodarrPanelSoft, in: RoundedRectangle(cornerRadius: 10))
          .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.moodarrLine))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Settings")
      .accessibilityHint("Opens server, account, and primary action settings")
  }
}

struct MoodarrFinderBar: View {
  @ObservedObject var model: MoodarrAppViewModel
  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      MoodarrSearchField(
        text: $model.searchQuery,
        isInitialSearch: model.searchResponse == nil,
        canSearch: canSearch,
        onSearch: search
      )

      HStack(spacing: 8) {
        MoodarrModeButton(mode: $model.searchDisplayMode)
        MoodarrSavedResultFilterBar(model: model)
      }

      if let response = model.searchResponse {
        Text(response.summary)
          .font(.caption.weight(.medium))
          .lineLimit(3, reservesSpace: true)
          .foregroundStyle(Color.moodarrMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(12)
    .background(Color.moodarrPanel.opacity(0.97), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.moodarrLine))
    .shadow(color: Color.black.opacity(0.08), radius: 22, x: 0, y: -6)
  }

  private var canSearch: Bool {
    model.health != nil &&
      !model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
      !model.isLoading
  }

  private func search() {
    Task { await model.search() }
  }
}

private struct MoodarrStateChip: View {
  @ObservedObject var model: MoodarrAppViewModel
  var body: some View {
    let signedIn = model.authSession?.authenticated == true
    let connected = model.health != nil
    HStack(spacing: 6) {
      Circle()
        .fill(signedIn ? Color.moodarrAccent : (connected ? Color.moodarrWarn : Color.moodarrFaint))
        .frame(width: 7, height: 7)
      Text(signedIn ? "Signed in" : (connected ? "Ready" : "Offline"))
        .font(.caption2.weight(.bold))
        .foregroundStyle(Color.moodarrInk)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(Color.moodarrPanelSoft, in: Capsule())
    .overlay(Capsule().stroke(Color.moodarrLine))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(signedIn ? "Signed in" : (connected ? "Server ready" : "Server offline"))
  }
}

private struct MoodarrCountPill: View {
  let count: Int
  var body: some View {
    Text("\(count)")
      .font(.caption.weight(.black))
      .foregroundStyle(Color.moodarrInk)
      .lineLimit(1)
      .frame(width: 34, height: 30)
      .background(Color.moodarrPanelSoft, in: Capsule())
      .overlay(Capsule().stroke(Color.moodarrLine))
      .accessibilityLabel("\(count) search items")
  }
}

private struct MoodarrIconBox: View {
  let systemImage: String
  let tint: Color
  let fill: Color
  var width: CGFloat = 44
  var height: CGFloat = 44

  var body: some View {
    Image(systemName: systemImage)
      .font(.caption.weight(.black))
      .foregroundStyle(tint)
      .frame(width: width, height: height)
      .background(fill, in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.moodarrLineStrong.opacity(0.8)))
  }
}

private struct MoodarrSearchField: View {
  @Binding var text: String
  let isInitialSearch: Bool
  let canSearch: Bool
  let onSearch: () -> Void
  @StateObject private var voiceInput = MoodarrVoiceInputController()
  @FocusState private var isFocused: Bool
  private let controlHeight: CGFloat = 96
  private let buttonWidth: CGFloat = 44
  private let buttonSpacing: CGFloat = 8

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      TextField("dry, witty, low-stakes comfort", text: $text, axis: .vertical)
        .lineLimit(3, reservesSpace: true)
        .submitLabel(.search)
        .focused($isFocused)
        .moodarrTextField(prominent: true)
        .frame(height: controlHeight, alignment: .topLeading)
        .accessibilityLabel("Mood search")
        .accessibilityHint("Describe what you feel like watching")
        .onSubmit(onSearch)
        #if os(iOS)
        .toolbar {
          ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("Done") { isFocused = false }
          }
        }
        #endif

      VStack(spacing: buttonSpacing) {
        Button(action: toggleVoiceInput) {
          MoodarrIconBox(
            systemImage: voiceInput.isRecording ? "waveform.circle.fill" : "mic.fill",
            tint: voiceInput.isRecording ? .moodarrAccentStrong : .moodarrInk,
            fill: voiceInput.isRecording ? .moodarrAccentSoft : .moodarrPanelSoft,
            width: buttonWidth,
            height: buttonHeight
          )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(voiceInput.isRecording ? "Stop voice input" : "Start voice input")
        .accessibilityHint("Uses speech to fill the mood search")

        Button(action: onSearch) {
          MoodarrIconBox(
            systemImage: isInitialSearch ? "paperplane.fill" : "arrow.triangle.2.circlepath",
            tint: .white,
            fill: .moodarrControl,
            width: buttonWidth,
            height: buttonHeight
          )
        }
        .buttonStyle(.plain)
        .disabled(!canSearch)
        .opacity(canSearch ? 1 : 0.45)
        .accessibilityLabel(isInitialSearch ? "Search recommendations" : "Update recommendations")
        .accessibilityHint("Searches Moodarr using the current mood description")
      }
      .frame(width: buttonWidth, height: controlHeight)
    }
  }

  private var buttonHeight: CGFloat {
    (controlHeight - buttonSpacing) / 2
  }

  private func toggleVoiceInput() {
    voiceInput.toggle { transcript in
      text = transcript
      isFocused = false
    }
  }
}

private struct MoodarrContextToggle: View {
  @Binding var selection: MoodarrWatchContext

  var body: some View {
    HStack(spacing: 2) {
      ForEach(MoodarrWatchContext.allCases) { context in
        Button {
          selection = context
        } label: {
          Image(systemName: context.systemImage)
            .font(.caption.weight(.black))
            .foregroundStyle(selection == context ? Color.moodarrInk : Color.moodarrMuted)
            .frame(width: 32, height: 32)
            .background(selection == context ? Color.moodarrPanel : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(context.rawValue.capitalized) context")
        .accessibilityValue(selection == context ? "Selected" : "Not selected")
        .accessibilityHint("Changes whose viewing preferences guide recommendations")
      }
    }
    .padding(2)
    .background(Color.moodarrPanelSoft, in: Capsule())
    .overlay(Capsule().stroke(Color.moodarrLine))
  }
}

private struct MoodarrModeButton: View {
  @Binding var mode: MoodarrSearchDisplayMode
  var body: some View {
    Button(action: toggleMode) {
      Image(systemName: mode == .swipe ? "square.grid.2x2.fill" : "rectangle.stack.fill")
        .font(.caption.weight(.black))
        .foregroundStyle(Color.moodarrInk)
        .frame(width: 44, height: 36)
        .background(Color.moodarrPanelSoft, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.moodarrLine))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(mode == .swipe ? "Switch to grid view" : "Switch to swipe view")
    .accessibilityHint("Changes how recommendations are reviewed")
  }

  private func toggleMode() {
    mode = mode == .swipe ? .grid : .swipe
  }
}

private struct MoodarrSavedResultFilterBar: View {
  @ObservedObject var model: MoodarrAppViewModel

  var body: some View {
    HStack(spacing: 5) {
      ForEach(MoodarrSavedResultFilter.allCases) { filter in
        Button {
          model.savedResultFilter = filter
        } label: {
          HStack(spacing: 4) {
            Image(systemName: filter.systemImage)
              .font(.caption2.weight(.black))
            Text(filter.title)
            Text("\(model.count(for: filter))")
              .foregroundStyle(model.savedResultFilter == filter ? Color.moodarrInk.opacity(0.72) : Color.moodarrMuted.opacity(0.72))
          }
          .font(.caption2.weight(.bold))
          .foregroundStyle(model.savedResultFilter == filter ? Color.moodarrInk : Color.moodarrMuted)
          .lineLimit(1)
          .minimumScaleFactor(0.82)
          .padding(.horizontal, 8)
          .frame(maxWidth: .infinity, minHeight: 36)
          .background(model.savedResultFilter == filter ? Color.moodarrPanel : Color.moodarrPanelSoft.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))
          .overlay(RoundedRectangle(cornerRadius: 8).stroke(model.savedResultFilter == filter ? Color.moodarrLineStrong : Color.moodarrLine))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(filter.title), \(model.count(for: filter)) items")
        .accessibilityValue(model.savedResultFilter == filter ? "Selected" : "Not selected")
      }
    }
  }
}
