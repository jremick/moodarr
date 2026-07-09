import SwiftUI

struct MoodarrBackdrop: View {
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

struct MoodarrStatusToast: View {
  @ObservedObject var model: MoodarrAppViewModel

  var body: some View {
    Group {
      if !model.isLoading, let error = model.errorMessage {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(Color.moodarrWarnText)
          .lineLimit(2)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
          .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.moodarrWarn.opacity(0.25)))
          .accessibilityAddTraits(.isStaticText)
      }
    }
  }
}

struct MoodarrLoadingView: View {
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
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Working")
  }
}
