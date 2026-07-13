import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

public struct MoodarrRootView: View {
  @StateObject private var model: MoodarrAppViewModel
  @State private var isSettingsPresented = false

  public init(model: MoodarrAppViewModel = MoodarrAppViewModel()) {
    _model = StateObject(wrappedValue: model)
  }

  public var body: some View {
    NavigationStack {
      ZStack {
        MoodarrBackdrop()
        VStack(spacing: 0) {
          MoodarrHeader(model: model) {
            isSettingsPresented = true
          }
          .padding(.horizontal, 16)
          .padding(.top, 8)
          .padding(.bottom, 8)
          .background(.ultraThinMaterial)
          .overlay(alignment: .bottom) {
            Rectangle()
              .fill(Color.moodarrLine)
              .frame(height: 1)
          }

          resultsPanel
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.bottom, 190)
        }
      }
      #if os(iOS)
      .toolbar(.hidden, for: .navigationBar)
      #endif
      .sheet(isPresented: $isSettingsPresented) {
        settingsPage
      }
      .onOpenURL { url in
        Task {
          await model.handleOpenURL(url)
        }
      }
      .task {
        await model.restoreSession()
      }
      .overlay(alignment: .bottom) {
        finderPanel
          .padding(.horizontal, 16)
          .padding(.bottom, 10)
      }
      .overlay(alignment: .top) {
        MoodarrStatusToast(model: model)
          .padding(.horizontal, 16)
          .padding(.top, 68)
      }
      .overlay {
        if model.isLoading {
          MoodarrLoadingView()
        }
      }
    }
  }

  private var settingsPage: some View {
    NavigationStack {
      ZStack {
        MoodarrBackdrop()
        ScrollView {
          VStack(spacing: 16) {
            connectionPanel
            accessPanel
            actionPanel
            requestPanel
          }
          .padding(.horizontal, 16)
          .padding(.top, 18)
          .padding(.bottom, 28)
        }
      }
      .navigationTitle("Settings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            isSettingsPresented = false
          }
        }
      }
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
    }
  }

  private var connectionPanel: some View {
    MoodarrPanel(eyebrow: "LAN / VPN", title: "Server") {
      VStack(alignment: .leading, spacing: 12) {
        #if os(iOS)
        TextField("http://moodarr.local:4401", text: $model.serverURLText)
          .textInputAutocapitalization(.never)
          .keyboardType(.URL)
          .autocorrectionDisabled()
          .moodarrTextField()
        #else
        TextField("http://moodarr.local:4401", text: $model.serverURLText)
          .moodarrTextField()
        #endif

        HStack(spacing: 10) {
          MoodarrActionButton(title: "Check", systemImage: "waveform.path.ecg") {
            Task { await model.connect() }
          }
          .disabled(model.serverURLText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isLoading)
          if let health = model.health {
            MoodarrMetricPill(label: "v\(health.version)", value: health.fixtureMode ? "Fixture" : "Live")
          }
        }

        if let config = model.config {
          HStack(spacing: 8) {
            MoodarrTinyStatus(label: "Plex", active: config.plex.configured || config.auth.plexAuthEnabled)
            MoodarrTinyStatus(label: "Seerr", active: config.seerr.configured)
            MoodarrTinyStatus(label: "AI", active: config.ai.configured)
          }
        }
      }
    }
  }

  private var accessPanel: some View {
    MoodarrPanel(eyebrow: "Plex session", title: "Access") {
      VStack(alignment: .leading, spacing: 12) {
        if let user = model.authSession?.user, model.authSession?.authenticated == true {
          HStack(spacing: 12) {
            MoodarrAvatar(text: user.label)
            VStack(alignment: .leading, spacing: 2) {
              Text(user.label)
                .font(.headline.weight(.semibold))
                .foregroundStyle(Color.moodarrInk)
              Text(user.provider.capitalized)
                .font(.caption.weight(.medium))
                .foregroundStyle(Color.moodarrMuted)
            }
            Spacer(minLength: 10)
            Button(role: .destructive) {
              Task { await model.logout() }
            } label: {
              Image(systemName: "rectangle.portrait.and.arrow.right")
                .font(.body.weight(.semibold))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Sign out")
          }
        } else {
          HStack(spacing: 10) {
          MoodarrActionButton(title: "Plex", systemImage: "person.crop.circle.badge.checkmark") {
            Task { await model.startPlexSignIn() }
          }
          .disabled(model.health == nil || model.config?.auth.plexAuthEnabled != true || model.isLoading)
          if model.config?.auth.plexAuthEnabled == false {
            Text("Unavailable")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.moodarrMuted)
            }
          }

          if let start = model.plexStart {
            VStack(alignment: .leading, spacing: 10) {
              HStack {
                Text(start.code)
                  .font(.system(size: 28, weight: .bold, design: .monospaced))
                  .foregroundStyle(Color.moodarrInk)
                  .padding(.horizontal, 12)
                  .padding(.vertical, 7)
                  .background(Color.moodarrPaper, in: RoundedRectangle(cornerRadius: 8))
                Spacer()
                if let url = URL(string: start.authUrl) {
                  Link(destination: url) {
                    Label("Open", systemImage: "safari")
                  }
                  .font(.callout.weight(.semibold))
                  .foregroundStyle(Color.moodarrAccentStrong)
                }
              }
              MoodarrActionButton(title: "Complete", systemImage: "checkmark.circle") {
                Task { await model.completePlexSignIn() }
              }
              .disabled(model.isLoading)
            }
          }
        }
      }
    }
  }

  private var actionPanel: some View {
    MoodarrPanel(eyebrow: "User preference", title: "Primary action") {
      VStack(alignment: .leading, spacing: 10) {
        Picker("Primary action", selection: $model.primaryActionMode) {
          Label("Watch", systemImage: "play.fill").tag(MoodarrPrimaryActionMode.watch)
          Label("Watchlist", systemImage: "bookmark.fill").tag(MoodarrPrimaryActionMode.watchlist)
        }
        .pickerStyle(.segmented)

        Text(model.primaryActionMode == .watch ? "Open available titles in Plex." : "Save available Plex titles to Watchlist; request unavailable titles in Seerr.")
          .font(.caption.weight(.medium))
          .foregroundStyle(Color.moodarrMuted)
      }
    }
  }

  private var finderPanel: some View {
    VStack(alignment: .leading, spacing: 9) {
      MoodarrSearchField(
        text: $model.searchQuery,
        isInitialSearch: model.searchResponse == nil,
        canSearch: model.health != nil && !model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isLoading,
        onSearch: { Task { await model.search() } }
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

  @ViewBuilder
  private var resultsPanel: some View {
    let results = model.visibleResults
    if !results.isEmpty {
      switch model.searchDisplayMode {
      case .swipe:
        MoodarrSwipeDeck(model: model, results: results, moodTerm: model.searchQuery.firstMoodTerm) {
          isSettingsPresented = true
        }
        .id("\(model.searchResponse?.sessionId ?? model.searchResponse?.query ?? "")-\(results.map(\.id).joined(separator: "|"))")
        .padding(.horizontal, 16)
        .padding(.top, 12)
      case .grid:
        MoodarrGridResultsView(model: model, results: results, moodTerm: model.searchQuery.firstMoodTerm) {
          isSettingsPresented = true
        }
      }
    } else if model.searchResponse != nil {
      MoodarrEmptyResultsView(filter: model.savedResultFilter)
        .padding(.horizontal, 16)
    } else {
      Spacer(minLength: 0)
    }
  }

  private var requestPanel: some View {
    MoodarrPanel(eyebrow: "Seerr", title: "Request") {
      VStack(alignment: .leading, spacing: 12) {
        if let preview = model.requestPreview {
          HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
              Text(preview.request.title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(Color.moodarrInk)
              Text(preview.canRequest ? "Ready to request" : (preview.blockedReason ?? "Blocked"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(preview.canRequest ? Color.moodarrAccentStrong : Color.moodarrWarn)
            }
            Spacer()
            if preview.canRequest {
              Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(Color.moodarrAccent)
            }
          }

          TextField(preview.confirmationPhrase, text: $model.confirmationText)
            .moodarrTextField()

          MoodarrActionButton(title: "Create", systemImage: "paperplane.fill") {
            Task { await model.createRequest() }
          }
          .disabled(!preview.canRequest || model.confirmationText != preview.confirmationPhrase || model.isLoading)
        } else {
          HStack(spacing: 10) {
            Image(systemName: "tray")
              .font(.title3)
              .foregroundStyle(Color.moodarrFaint)
            Text("No request selected")
              .font(.callout.weight(.medium))
              .foregroundStyle(Color.moodarrMuted)
          }
        }
      }
    }
  }
}

private struct MoodarrHeader: View {
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
      MoodarrContextToggle(selection: $model.watchContext)
      MoodarrCountPill(count: model.resultLimit)
      MoodarrStateChip(model: model)
        .fixedSize(horizontal: true, vertical: false)
      Button(action: onSettings) {
        Image(systemName: "gearshape.fill")
          .font(.callout.weight(.bold))
          .foregroundStyle(Color.moodarrAccentStrong)
          .frame(width: 32, height: 32)
          .background(Color.moodarrPanelSoft, in: RoundedRectangle(cornerRadius: 8))
          .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.moodarrLine))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Settings")
    }
    .padding(.vertical, 4)
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
  var width: CGFloat = 40
  var height: CGFloat = 35

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
  private let buttonWidth: CGFloat = 40
  private let buttonSpacing: CGFloat = 6

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      TextField("dry, witty, low-stakes comfort", text: $text, axis: .vertical)
        .lineLimit(3, reservesSpace: true)
        .submitLabel(.done)
        .focused($isFocused)
        .moodarrTextField(prominent: true)
        .frame(height: controlHeight, alignment: .topLeading)
        #if os(iOS)
        .toolbar {
          ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("Done") {
              isFocused = false
            }
          }
        }
        #endif

      VStack(spacing: 6) {
        Button {
          voiceInput.toggle { transcript in
            text = transcript
            isFocused = false
          }
        } label: {
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
        .accessibilityLabel(modelSearchAccessibilityLabel)
      }
      .frame(width: buttonWidth, height: controlHeight)
    }
  }

  private var buttonHeight: CGFloat {
    (controlHeight - buttonSpacing) / 2
  }

  private var modelSearchAccessibilityLabel: String {
    isInitialSearch ? "Search recommendations" : "Update recommendations"
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
            .frame(width: 25, height: 26)
            .background(selection == context ? Color.moodarrPanel : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(context.rawValue.capitalized) context")
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
    Button {
      mode = mode == .swipe ? .grid : .swipe
    } label: {
      Image(systemName: mode == .swipe ? "square.grid.2x2.fill" : "rectangle.stack.fill")
        .font(.caption.weight(.black))
        .foregroundStyle(Color.moodarrInk)
        .frame(width: 34, height: 30)
        .background(Color.moodarrPanelSoft, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.moodarrLine))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(mode == .swipe ? "Switch to grid view" : "Switch to swipe view")
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
          .frame(maxWidth: .infinity, minHeight: 30)
          .background(model.savedResultFilter == filter ? Color.moodarrPanel : Color.moodarrPanelSoft.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))
          .overlay(RoundedRectangle(cornerRadius: 8).stroke(model.savedResultFilter == filter ? Color.moodarrLineStrong : Color.moodarrLine))
        }
        .buttonStyle(.plain)
      }
    }
  }
}

private struct MoodarrSwipeDeck: View {
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
        if currentIndex < results.count {
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
              .gesture(
                DragGesture(minimumDistance: 16)
                  .onChanged { value in
                    guard !isAdvancing else { return }
                    dragOffset = value.translation
                  }
                  .onEnded { value in
                    guard results.indices.contains(currentIndex), !isAdvancing else { return }
                    handleSwipe(value.translation, item: results[currentIndex])
                  }
              )
          }
          .frame(height: max(430, proxy.size.height - 58))

          HStack(spacing: 8) {
            MoodarrDeckActionButton(title: "Yes", systemImage: "hand.thumbsup.fill", tint: .moodarrAccentStrong) {
              accept(results[currentIndex], action: .rightMood, exitOffset: CGSize(width: -proxy.size.width - 140, height: -12))
            }
            MoodarrDeckActionButton(title: "No", systemImage: "xmark", tint: .moodarrWarn) {
              accept(results[currentIndex], action: .wrongMood, exitOffset: CGSize(width: proxy.size.width + 140, height: 12))
            }
            MoodarrDeckActionButton(title: "Maybe", systemImage: "bookmark.fill", tint: .moodarrFaint) {
              accept(results[currentIndex], action: .save, exitOffset: CGSize(width: 0, height: proxy.size.height + 120))
            }
            MoodarrDeckActionButton(title: results[currentIndex].primaryActionTitle(for: model.primaryActionMode), systemImage: results[currentIndex].primaryActionIcon(for: model.primaryActionMode), tint: results[currentIndex].upActionTint) {
              watchOrRequest(results[currentIndex], exitOffset: CGSize(width: 0, height: -proxy.size.height - 120))
            }
          }
        } else {
          MoodarrPanel(eyebrow: "Complete", title: "Slate cleared") {
            HStack(spacing: 10) {
              Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.moodarrAccentStrong)
              Text("Search again for a fresh slate.")
                .font(.callout.weight(.medium))
                .foregroundStyle(Color.moodarrMuted)
            }
          }
          .frame(maxHeight: .infinity, alignment: .center)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
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
      withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
        dragOffset = .zero
      }
    }
  }

  private func accept(_ item: MoodarrItemSummary, action: MoodarrFeedbackAction, exitOffset: CGSize) {
    animateAway(to: exitOffset)
    Task {
      await model.sendFeedback(action: action, item: item, moodTerm: moodTerm)
    }
  }

  private func watchOrRequest(_ item: MoodarrItemSummary, exitOffset: CGSize) {
    animateAway(to: exitOffset)
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
        if model.primaryActionMode == .watchlist {
          await model.addToWatchlistOrRequest(item)
        } else {
          await model.sendFeedback(action: .requestPreview, item: item, moodTerm: moodTerm)
          await model.previewRequest(for: item)
          onNeedsRequestConfirmation()
        }
      }
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

private struct MoodarrGridResultsView: View {
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

  var body: some View {
    ZStack(alignment: .bottom) {
      ScrollView {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
          ForEach(results) { item in
            MoodarrGridPosterCard(model: model, item: item, isSelected: selectedItem?.id == item.id)
              .onTapGesture {
                selectedItemId = item.id
              }
              .onLongPressGesture {
                watchOrRequest(item)
              }
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 82)
      }

      if let selectedItem {
        HStack(spacing: 8) {
          MoodarrDeckActionButton(title: "Yes", systemImage: "hand.thumbsup.fill", tint: .moodarrAccentStrong) {
            tag(selectedItem, action: .rightMood)
          }
          MoodarrDeckActionButton(title: "No", systemImage: "xmark", tint: .moodarrWarn) {
            tag(selectedItem, action: .wrongMood)
          }
          MoodarrDeckActionButton(title: "Maybe", systemImage: "bookmark.fill", tint: .moodarrFaint) {
            tag(selectedItem, action: .save)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
          Rectangle()
            .fill(Color.moodarrLine)
            .frame(height: 1)
        }
      }
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
        if model.primaryActionMode == .watchlist {
          await model.addToWatchlistOrRequest(item)
        } else {
          await model.sendFeedback(action: .requestPreview, item: item, moodTerm: moodTerm)
          await model.previewRequest(for: item)
          onNeedsRequestConfirmation()
        }
      }
    }
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
        if let year = item.year {
          MoodarrMetaCapsule(String(year))
        }
        MoodarrMetaCapsule(String(format: "%.0f", item.score))
      }
    }
    .padding(9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.moodarrPanel, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(isSelected ? Color.moodarrAccentStrong : Color.moodarrLine, lineWidth: isSelected ? 2 : 1))
    .shadow(color: Color.black.opacity(isSelected ? 0.09 : 0.04), radius: isSelected ? 16 : 10, x: 0, y: 8)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(item.title), \(item.availabilityGroup.label), match score \(Int(item.score))")
    .accessibilityHint("Tap to select. Long press to watch or request.")
  }
}

private struct MoodarrEmptyResultsView: View {
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

private struct MoodarrSwipeCard: View {
  @ObservedObject var model: MoodarrAppViewModel
  let item: MoodarrItemSummary
  let isTopCard: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 13) {
      MoodarrPosterView(model: model, item: item, width: isTopCard ? 238 : 220, height: isTopCard ? 354 : 326)
        .frame(maxWidth: .infinity)

      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(item.title)
          .font(.title3.weight(.bold))
          .foregroundStyle(Color.moodarrInk)
          .lineLimit(2)
        Spacer(minLength: 8)
        Text(String(format: "%.0f", item.score))
          .font(.system(.body, design: .monospaced).weight(.bold))
          .foregroundStyle(Color.moodarrAccentStrong)
          .padding(.horizontal, 8)
          .padding(.vertical, 5)
          .background(Color.moodarrAccentSoft, in: RoundedRectangle(cornerRadius: 7))
      }

      HStack(spacing: 6) {
        if let year = item.year {
          MoodarrMetaCapsule(String(year))
        }
        if let runtime = item.runtimeMinutes {
          MoodarrMetaCapsule("\(runtime)m")
        }
        MoodarrMetaCapsule(item.mediaType.rawValue.uppercased())
      }

      Text(item.matchExplanation)
        .font(.callout)
        .lineSpacing(2)
        .foregroundStyle(Color.moodarrMuted)
        .lineLimit(2)

      HStack(spacing: 6) {
        Circle()
          .fill(item.availabilityGroup.tint)
          .frame(width: 7, height: 7)
        Text(item.availabilityGroup.label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(Color.moodarrMuted)
      }
    }
    .padding(14)
    .background(Color.moodarrPanel, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(isTopCard ? Color.moodarrLineStrong : Color.moodarrLine))
    .shadow(color: Color.black.opacity(isTopCard ? 0.08 : 0.035), radius: isTopCard ? 24 : 14, x: 0, y: isTopCard ? 14 : 8)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(item.title), \(item.availabilityGroup.label), match score \(Int(item.score))")
  }
}

private struct MoodarrSwipeCue: View {
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

private struct MoodarrDeckActionButton: View {
  let title: String
  let systemImage: String
  let tint: Color
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
      .frame(maxWidth: .infinity, minHeight: 44)
      .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).stroke(tint.opacity(0.24)))
    }
    .buttonStyle(.plain)
  }
}

private struct MoodarrResultCard: View {
  @ObservedObject var model: MoodarrAppViewModel
  let item: MoodarrItemSummary
  let moodTerm: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        MoodarrPosterView(model: model, item: item)
        VStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .firstTextBaseline) {
            Text(item.title)
              .font(.headline.weight(.bold))
              .foregroundStyle(Color.moodarrInk)
              .lineLimit(2)
            Spacer(minLength: 8)
            Text(String(format: "%.0f", item.score))
              .font(.system(.caption, design: .monospaced).weight(.bold))
              .foregroundStyle(Color.moodarrAccentStrong)
              .padding(.horizontal, 7)
              .padding(.vertical, 4)
              .background(Color.moodarrAccentSoft, in: RoundedRectangle(cornerRadius: 6))
          }

          HStack(spacing: 6) {
            if let year = item.year {
              MoodarrMetaCapsule(String(year))
            }
            if let runtime = item.runtimeMinutes {
              MoodarrMetaCapsule("\(runtime)m")
            }
            MoodarrMetaCapsule(item.mediaType.rawValue.uppercased())
          }

          Text(item.matchExplanation)
            .font(.callout)
            .lineSpacing(2)
            .foregroundStyle(Color.moodarrMuted)
            .fixedSize(horizontal: false, vertical: true)

          HStack(spacing: 6) {
            Circle()
              .fill(item.availabilityGroup.tint)
              .frame(width: 7, height: 7)
            Text(item.availabilityGroup.label)
              .font(.caption.weight(.semibold))
              .foregroundStyle(Color.moodarrMuted)
          }
        }
      }

      HStack(spacing: 8) {
        MoodarrFeedbackButton(title: "Right", systemImage: "hand.thumbsup.fill", tint: .moodarrAccentStrong) {
          Task { await model.sendFeedback(action: .rightMood, item: item, moodTerm: moodTerm) }
        }
        MoodarrFeedbackButton(title: "More", systemImage: "arrow.up.right", tint: .moodarrAccent) {
          Task { await model.sendFeedback(action: .swipeRight, item: item, moodTerm: moodTerm) }
        }
        MoodarrFeedbackButton(title: "Less", systemImage: "arrow.down.left", tint: .moodarrWarn) {
          Task { await model.sendFeedback(action: .swipeLeft, item: item, moodTerm: moodTerm) }
        }
        MoodarrFeedbackButton(title: "Skip", systemImage: "forward.end.fill", tint: .moodarrFaint) {
          Task { await model.sendFeedback(action: .swipeSkip, item: item) }
        }
      }
    }
    .padding(14)
    .background(Color.moodarrPanel, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.moodarrLine))
    .shadow(color: Color.black.opacity(0.045), radius: 18, x: 0, y: 10)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(item.title), \(item.availabilityGroup.label), match score \(Int(item.score))")
    .accessibilityHint("Use the feedback buttons to tune Moodarr or open the context menu to preview a request.")
    .contextMenu {
      Button {
        Task { await model.previewRequest(for: item) }
      } label: {
        Label("Preview request", systemImage: "tray.and.arrow.down")
      }
      Button {
        Task { await model.sendFeedback(action: .wrongMood, item: item, moodTerm: moodTerm) }
      } label: {
        Label("Wrong mood", systemImage: "xmark.octagon")
      }
    }
  }
}

private struct MoodarrPosterView: View {
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
    .task(id: item.posterUrl) {
      guard !item.posterUrl.isEmpty else { return }
      do {
        imageData = try await model.posterData(for: item)
        failed = false
      } catch {
        failed = true
      }
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
}

private struct MoodarrPanel<Content: View>: View {
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

  init(title: String, detail: String? = nil) {
    self.title = title
    self.detail = detail
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title)
        .font(.headline.weight(.bold))
        .foregroundStyle(Color.moodarrInk)
      Spacer(minLength: 8)
      if let detail {
        Text(detail)
          .font(.caption.weight(.bold))
          .foregroundStyle(Color.moodarrAccentStrong)
          .textCase(.uppercase)
      }
    }
  }
}

private struct MoodarrActionButton: View {
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
        .frame(minHeight: 42)
        .background(Color.moodarrControl, in: RoundedRectangle(cornerRadius: 9))
    }
    .buttonStyle(.plain)
  }
}

private struct MoodarrFeedbackButton: View {
  let title: String
  let systemImage: String
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 4) {
        Image(systemName: systemImage)
          .font(.body.weight(.bold))
        Text(title)
          .font(.caption2.weight(.bold))
      }
      .foregroundStyle(tint)
      .frame(maxWidth: .infinity, minHeight: 48)
      .background(tint.opacity(0.11), in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).stroke(tint.opacity(0.2)))
    }
    .buttonStyle(.plain)
  }
}

private struct MoodarrMetricPill: View {
  let label: String
  let value: String

  var body: some View {
    HStack(spacing: 6) {
      Text(label)
        .foregroundStyle(Color.moodarrInk)
      Text(value)
        .foregroundStyle(Color.moodarrMuted)
    }
    .font(.caption.weight(.bold))
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(Color.moodarrPanelSoft, in: Capsule())
    .overlay(Capsule().stroke(Color.moodarrLine))
  }
}

private struct MoodarrTinyStatus: View {
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
  }
}

private struct MoodarrMetaCapsule: View {
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

private struct MoodarrAvatar: View {
  let text: String

  var body: some View {
    Text(String(text.prefix(1)).uppercased())
      .font(.headline.weight(.bold))
      .foregroundStyle(Color.moodarrInk)
      .frame(width: 42, height: 42)
      .background(Color.moodarrPaper, in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.moodarrLineStrong))
  }
}

private struct MoodarrLogoMark: View {
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
  }
}

private struct TicketShape: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path(roundedRect: rect, cornerRadius: rect.height * 0.14)
    let notchRadius = rect.height * 0.13
    let leftNotch = Path(ellipseIn: CGRect(x: rect.minX - notchRadius, y: rect.midY - notchRadius, width: notchRadius * 2, height: notchRadius * 2))
    let rightNotch = Path(ellipseIn: CGRect(x: rect.maxX - notchRadius, y: rect.midY - notchRadius, width: notchRadius * 2, height: notchRadius * 2))
    path.addPath(leftNotch)
    path.addPath(rightNotch)
    return path
  }
}

private struct MoodarrBackdrop: View {
  var body: some View {
    ZStack {
      LinearGradient(
        colors: [.moodarrBackground, .moodarrPanelSoft],
        startPoint: .top,
        endPoint: .bottom
      )
      MoodarrGrid()
        .opacity(0.55)
      LinearGradient(
        colors: [Color.moodarrAccentSoft.opacity(0.55), .clear],
        startPoint: .topLeading,
        endPoint: .center
      )
    }
    .ignoresSafeArea()
  }
}

private struct MoodarrGrid: View {
  var body: some View {
    Canvas { context, size in
      let spacing: CGFloat = 44
      var x: CGFloat = 0
      while x <= size.width {
        var path = Path()
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: size.height))
        context.stroke(path, with: .color(Color.moodarrAccent.opacity(0.09)), lineWidth: 1)
        x += spacing
      }
      var y: CGFloat = 0
      while y <= size.height {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: y))
        path.addLine(to: CGPoint(x: size.width, y: y))
        context.stroke(path, with: .color(Color.moodarrAccent.opacity(0.07)), lineWidth: 1)
        y += spacing
      }
    }
    .allowsHitTesting(false)
  }
}

private struct MoodarrStatusToast: View {
  @ObservedObject var model: MoodarrAppViewModel

  var body: some View {
    if model.isLoading {
      EmptyView()
    } else if let error = model.errorMessage {
      toast(error, color: .moodarrWarn, image: "exclamationmark.triangle.fill")
    }
  }

  private func toast(_ text: String, color: Color, image: String) -> some View {
    HStack(spacing: 8) {
      Image(systemName: image)
      Text(text)
        .lineLimit(2)
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(color)
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(color.opacity(0.25)))
  }
}

private struct MoodarrLoadingView: View {
  var body: some View {
    VStack(spacing: 10) {
      ProgressView()
      Text("Working")
        .font(.caption.weight(.bold))
        .foregroundStyle(Color.moodarrMuted)
    }
    .padding(16)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.moodarrLine))
  }
}

private extension View {
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

private extension MoodarrAvailabilityGroup {
  var label: String {
    switch self {
    case .availableInPlex:
      return "Available in Plex"
    case .notInPlexRequestable:
      return "Requestable"
    case .alreadyRequested:
      return "Already requested"
    case .partiallyAvailable:
      return "Partially available"
    case .unavailable:
      return "Unavailable"
    }
  }

  var tint: Color {
    switch self {
    case .availableInPlex:
      return .moodarrAccent
    case .notInPlexRequestable:
      return .moodarrPlex
    case .alreadyRequested:
      return .moodarrWarn
    case .partiallyAvailable:
      return .moodarrAccentStrong
    case .unavailable:
      return .moodarrFaint
    }
  }
}

private extension MoodarrItemSummary {
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

  var upActionTitle: String {
    isAvailableToWatch ? "Watch" : "Request"
  }

  func primaryActionTitle(for mode: MoodarrPrimaryActionMode) -> String {
    mode == .watchlist ? (isAvailableToWatch ? "Watchlist" : "Request") : upActionTitle
  }

  func primaryActionIcon(for mode: MoodarrPrimaryActionMode) -> String {
    mode == .watchlist ? (isAvailableToWatch ? "bookmark.fill" : "paperplane.fill") : (isAvailableToWatch ? "play.fill" : "paperplane.fill")
  }

  var upActionTint: Color {
    isAvailableToWatch ? .moodarrAccentStrong : .moodarrWarn
  }
}

private extension MoodarrWatchContext {
  var systemImage: String {
    switch self {
    case .solo:
      return "person.fill"
    case .group:
      return "person.2.fill"
    }
  }
}

private extension MoodarrSavedResultFilter {
  var title: String {
    switch self {
    case .candidates:
      return "New"
    case .yes:
      return "Yes"
    case .maybe:
      return "Maybe"
    }
  }

  var systemImage: String {
    switch self {
    case .candidates:
      return "sparkles"
    case .yes:
      return "hand.thumbsup.fill"
    case .maybe:
      return "bookmark.fill"
    }
  }

  var emptyTitle: String {
    switch self {
    case .candidates:
      return "No new candidates"
    case .yes:
      return "No yes picks"
    case .maybe:
      return "No maybe picks"
    }
  }

  var emptyMessage: String {
    switch self {
    case .candidates:
      return "Update the search to rerank around your latest choices."
    case .yes:
      return "Swipe or tag titles as yes, then come back here to choose one."
    case .maybe:
      return "Swipe or tag titles as maybe, then review them here."
    }
  }
}

private extension MoodarrSwipeCue.Kind {
  var title: String {
    switch self {
    case .yes:
      return "YES"
    case .no:
      return "NO"
    case .maybe:
      return "MAYBE"
    case .watch:
      return "WATCH"
    case .request:
      return "REQUEST"
    }
  }

  var systemImage: String {
    switch self {
    case .yes:
      return "hand.thumbsup.fill"
    case .no:
      return "xmark"
    case .maybe:
      return "bookmark.fill"
    case .watch:
      return "play.fill"
    case .request:
      return "paperplane.fill"
    }
  }

  var tint: Color {
    switch self {
    case .yes:
      return .moodarrAccentStrong
    case .no:
      return .moodarrWarn
    case .maybe:
      return .moodarrFaint
    case .watch:
      return .moodarrAccentStrong
    case .request:
      return .moodarrWarn
    }
  }
}

private extension String {
  var firstMoodTerm: String? {
    split(separator: " ")
      .map { $0.trimmingCharacters(in: .punctuationCharacters).lowercased() }
      .first { $0.count > 2 }
  }
}

private extension Color {
  static let moodarrBackground = Color(red: 251 / 255, green: 246 / 255, blue: 238 / 255)
  static let moodarrPanel = Color(red: 255 / 255, green: 253 / 255, blue: 248 / 255)
  static let moodarrPanelSoft = Color(red: 244 / 255, green: 238 / 255, blue: 230 / 255)
  static let moodarrPaper = Color(red: 247 / 255, green: 223 / 255, blue: 189 / 255)
  static let moodarrInk = Color(red: 47 / 255, green: 61 / 255, blue: 58 / 255)
  static let moodarrMuted = Color(red: 105 / 255, green: 122 / 255, blue: 117 / 255)
  static let moodarrFaint = Color(red: 139 / 255, green: 154 / 255, blue: 149 / 255)
  static let moodarrLine = Color(red: 234 / 255, green: 223 / 255, blue: 209 / 255)
  static let moodarrLineStrong = Color(red: 215 / 255, green: 199 / 255, blue: 182 / 255)
  static let moodarrAccent = Color(red: 95 / 255, green: 151 / 255, blue: 139 / 255)
  static let moodarrAccentStrong = Color(red: 74 / 255, green: 125 / 255, blue: 117 / 255)
  static let moodarrAccentSoft = Color(red: 228 / 255, green: 241 / 255, blue: 237 / 255)
  static let moodarrControl = Color(red: 80 / 255, green: 106 / 255, blue: 100 / 255)
  static let moodarrWarn = Color(red: 191 / 255, green: 127 / 255, blue: 112 / 255)
  static let moodarrPlex = Color(red: 229 / 255, green: 160 / 255, blue: 13 / 255)
}
