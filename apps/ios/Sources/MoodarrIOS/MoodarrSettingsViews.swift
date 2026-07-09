import SwiftUI

struct MoodarrSettingsView: View {
  @ObservedObject var model: MoodarrAppViewModel
  @Binding var isPresented: Bool

  var body: some View {
    NavigationStack {
      ZStack {
        MoodarrBackdrop()
        ScrollView {
          VStack(spacing: 16) {
            MoodarrConnectionPanel(model: model)
            MoodarrAccessPanel(model: model)
            MoodarrPrimaryActionPanel(model: model)
          }
          .padding(.horizontal, 16)
          .padding(.top, 18)
          .padding(.bottom, 28)
        }
      }
      .navigationTitle("Settings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", action: dismiss)
            .accessibilityHint("Closes Moodarr settings")
        }
      }
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
    }
  }

  private func dismiss() {
    isPresented = false
  }
}

private struct MoodarrConnectionPanel: View {
  @ObservedObject var model: MoodarrAppViewModel

  var body: some View {
    MoodarrPanel(eyebrow: "LAN / VPN", title: "Server") {
      VStack(alignment: .leading, spacing: 12) {
        serverField

        HStack(spacing: 10) {
          MoodarrActionButton(title: "Check", systemImage: "waveform.path.ecg", action: connect)
            .disabled(!canConnect)
            .accessibilityHint("Checks the Moodarr server and integration status")
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

  @ViewBuilder
  private var serverField: some View {
    #if os(iOS)
    TextField("http://moodarr.local:4401", text: $model.serverURLText)
      .textInputAutocapitalization(.never)
      .keyboardType(.URL)
      .autocorrectionDisabled()
      .moodarrTextField()
      .accessibilityLabel("Moodarr server address")
    #else
    TextField("http://moodarr.local:4401", text: $model.serverURLText)
      .moodarrTextField()
      .accessibilityLabel("Moodarr server address")
    #endif
  }

  private var canConnect: Bool {
    !model.serverURLText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isLoading
  }

  private func connect() {
    Task { await model.connect() }
  }
}

private struct MoodarrAccessPanel: View {
  @ObservedObject var model: MoodarrAppViewModel

  var body: some View {
    MoodarrPanel(eyebrow: "Plex session", title: "Access") {
      VStack(alignment: .leading, spacing: 12) {
        if let user = model.authSession?.user, model.authSession?.authenticated == true {
          signedInRow(user: user)
        } else {
          signInControls
        }
      }
    }
  }

  private func signedInRow(user: MoodarrAuthUser) -> some View {
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
      Button(role: .destructive, action: signOut) {
        Image(systemName: "rectangle.portrait.and.arrow.right")
          .font(.body.weight(.semibold))
          .frame(width: 44, height: 44)
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Sign out \(user.label)")
      .accessibilityHint("Removes the saved Plex session from this device")
    }
  }

  private var signInControls: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        MoodarrActionButton(title: "Plex", systemImage: "person.crop.circle.badge.checkmark", action: startSignIn)
          .disabled(model.health == nil || model.config?.auth.plexAuthEnabled != true || model.isLoading)
          .accessibilityHint("Starts Plex sign in")
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
              .accessibilityLabel("Plex code \(start.code)")
            Spacer()
            if let url = URL(string: start.authUrl) {
              Link(destination: url) {
                Label("Open", systemImage: "safari")
              }
              .font(.callout.weight(.semibold))
              .foregroundStyle(Color.moodarrAccentText)
              .accessibilityHint("Opens Plex to approve this device")
            }
          }
          MoodarrActionButton(title: "Complete", systemImage: "checkmark.circle", action: completeSignIn)
            .disabled(model.isLoading)
            .accessibilityHint("Checks whether Plex approval is complete")
        }
      }
    }
  }

  private func startSignIn() {
    Task { await model.startPlexSignIn() }
  }

  private func completeSignIn() {
    Task { await model.completePlexSignIn() }
  }

  private func signOut() {
    Task { await model.logout() }
  }
}

private struct MoodarrPrimaryActionPanel: View {
  @ObservedObject var model: MoodarrAppViewModel

  var body: some View {
    MoodarrPanel(eyebrow: "User preference", title: "Primary action") {
      VStack(alignment: .leading, spacing: 10) {
        Picker("Primary action", selection: $model.primaryActionMode) {
          Label("Watch", systemImage: "play.fill").tag(MoodarrPrimaryActionMode.watch)
          Label("Watchlist", systemImage: "bookmark.fill").tag(MoodarrPrimaryActionMode.watchlist)
        }
        .pickerStyle(.segmented)

        Text(actionDescription)
          .font(.caption.weight(.medium))
          .foregroundStyle(Color.moodarrMuted)
      }
    }
  }

  private var actionDescription: String {
    model.primaryActionMode == .watch
      ? "Open available titles in Plex. Unavailable titles always require a request preview and confirmation."
      : "Save available Plex titles to Watchlist. Unavailable titles always require a request preview and confirmation."
  }
}
