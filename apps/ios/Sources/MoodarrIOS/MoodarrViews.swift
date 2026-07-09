import SwiftUI

public struct MoodarrRootView: View {
  @StateObject private var model: MoodarrAppViewModel
  @State private var isSettingsPresented = false
  @State private var isRequestConfirmationPresented = false

  public init(model: MoodarrAppViewModel = MoodarrAppViewModel()) {
    _model = StateObject(wrappedValue: model)
  }

  public var body: some View {
    NavigationStack {
      ZStack {
        MoodarrBackdrop()
        VStack(spacing: 0) {
          MoodarrHeader(model: model, onSettings: presentSettings)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 8)
            .background(.ultraThinMaterial)
            .overlay(alignment: .bottom) {
              Rectangle()
                .fill(Color.moodarrLine)
                .frame(height: 1)
            }

          MoodarrResultsPanel(
            model: model,
            onNeedsRequestConfirmation: presentRequestConfirmation
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      #if os(iOS)
      .toolbar(.hidden, for: .navigationBar)
      #endif
      .safeAreaInset(edge: .bottom, spacing: 0) {
        MoodarrFinderBar(model: model)
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
          .background(.ultraThinMaterial)
      }
      .sheet(isPresented: $isSettingsPresented) {
        MoodarrSettingsView(model: model, isPresented: $isSettingsPresented)
      }
      .sheet(isPresented: $isRequestConfirmationPresented) {
        MoodarrRequestConfirmationView(
          model: model,
          isPresented: $isRequestConfirmationPresented
        )
        .presentationDetents([.medium, .large])
      }
      .onOpenURL { url in
        Task { await model.handleOpenURL(url) }
      }
      .task {
        await model.restoreSession()
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

  private func presentSettings() {
    isSettingsPresented = true
  }

  private func presentRequestConfirmation() {
    guard model.requestPreview != nil else { return }
    isRequestConfirmationPresented = true
  }
}

struct MoodarrResultsPanel: View {
  @ObservedObject var model: MoodarrAppViewModel
  let onNeedsRequestConfirmation: () -> Void

  var body: some View {
    Group {
      if !model.visibleResults.isEmpty {
        results
      } else if model.searchResponse != nil {
        MoodarrEmptyResultsView(filter: model.savedResultFilter)
          .padding(.horizontal, 16)
      }
    }
  }

  @ViewBuilder
  private var results: some View {
    switch model.searchDisplayMode {
    case .swipe:
      MoodarrSwipeDeck(
        model: model,
        results: model.visibleResults,
        moodTerm: model.searchQuery.firstMoodTerm,
        onNeedsRequestConfirmation: onNeedsRequestConfirmation
      )
      .id(resultsIdentity)
      .padding(.horizontal, 16)
      .padding(.top, 12)
    case .grid:
      MoodarrGridResultsView(
        model: model,
        results: model.visibleResults,
        moodTerm: model.searchQuery.firstMoodTerm,
        onNeedsRequestConfirmation: onNeedsRequestConfirmation
      )
    }
  }

  private var resultsIdentity: String {
    let searchIdentity = model.searchResponse?.sessionId ?? model.searchResponse?.query ?? ""
    return "\(searchIdentity)-\(model.visibleResults.map(\.id).joined(separator: "|"))"
  }
}
