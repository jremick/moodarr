import SwiftUI

struct MoodarrRequestConfirmationView: View {
  @ObservedObject var model: MoodarrAppViewModel
  @Binding var isPresented: Bool

  var body: some View {
    NavigationStack {
      ZStack {
        MoodarrBackdrop()
        ScrollView {
          MoodarrPanel(eyebrow: "Seerr", title: "Confirm request") {
            confirmationContent
          }
          .padding(16)
        }
      }
      .navigationTitle("Request preview")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: cancel)
        }
      }
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
    }
  }

  @ViewBuilder
  private var confirmationContent: some View {
    if let preview = model.requestPreview {
      VStack(alignment: .leading, spacing: 14) {
        Text(preview.request.title)
          .font(.title3.weight(.bold))
          .foregroundStyle(Color.moodarrInk)

        Label(
          preview.canRequest ? "Ready to request" : (preview.blockedReason ?? "Request blocked"),
          systemImage: preview.canRequest ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"
        )
        .font(.callout.weight(.semibold))
        .foregroundStyle(preview.canRequest ? Color.moodarrAccentText : Color.moodarrWarnText)

        Text(preview.item.availabilityExplanation)
          .font(.callout)
          .foregroundStyle(Color.moodarrMuted)

        if preview.requiresConfirmation {
          Text("Type **\(preview.confirmationPhrase)** to confirm this Seerr request.")
            .font(.callout)
            .foregroundStyle(Color.moodarrInk)
          confirmationField(placeholder: preview.confirmationPhrase)
        }

        MoodarrActionButton(title: "Request in Seerr", systemImage: "paperplane.fill", action: createRequest)
          .disabled(!canCreate)
          .accessibilityHint("Creates this request after confirmation")
      }
    } else {
      ContentUnavailableView(
        "No request selected",
        systemImage: "tray",
        description: Text("Choose a requestable title to preview it first.")
      )
    }
  }

  private var canCreate: Bool {
    guard let preview = model.requestPreview, preview.canRequest, !model.isLoading else { return false }
    return !preview.requiresConfirmation || model.confirmationText == preview.confirmationPhrase
  }

  @ViewBuilder
  private func confirmationField(placeholder: String) -> some View {
    #if os(iOS)
    TextField(placeholder, text: $model.confirmationText)
      .textInputAutocapitalization(.characters)
      .autocorrectionDisabled()
      .moodarrTextField()
      .accessibilityLabel("Request confirmation phrase")
    #else
    TextField(placeholder, text: $model.confirmationText)
      .moodarrTextField()
      .accessibilityLabel("Request confirmation phrase")
    #endif
  }

  private func cancel() {
    model.requestPreview = nil
    model.confirmationText = ""
    isPresented = false
  }

  private func createRequest() {
    Task {
      await model.createRequest()
      if model.requestPreview == nil, model.errorMessage == nil {
        isPresented = false
      }
    }
  }
}
