import Foundation
import Combine

#if os(iOS)
import AVFoundation
import Speech
#endif

@MainActor
public final class MoodarrVoiceInputController: ObservableObject {
  @Published public private(set) var isRecording = false
  @Published public private(set) var errorMessage: String?

  #if os(iOS)
  private let speechRecognizer = SFSpeechRecognizer()
  private let audioEngine = AVAudioEngine()
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var onTranscript: ((String) -> Void)?
  #endif

  public init() {}

  public func toggle(onTranscript: @escaping (String) -> Void) {
    #if os(iOS)
    if isRecording {
      stop()
    } else {
      self.onTranscript = onTranscript
      Task { await start() }
    }
    #else
    errorMessage = "Voice input is only available on iPhone."
    #endif
  }

  public func stop() {
    #if os(iOS)
    if audioEngine.isRunning {
      audioEngine.stop()
      audioEngine.inputNode.removeTap(onBus: 0)
    }
    recognitionRequest?.endAudio()
    recognitionTask?.cancel()
    recognitionRequest = nil
    recognitionTask = nil
    isRecording = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    #endif
  }

  #if os(iOS)
  private func start() async {
    errorMessage = nil
    let authorized = await requestSpeechAuthorization()
    guard authorized else {
      errorMessage = "Voice input is not authorized."
      return
    }
    guard speechRecognizer?.isAvailable == true else {
      errorMessage = "Voice input is not available."
      return
    }

    recognitionTask?.cancel()
    recognitionTask = nil

    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.setCategory(.record, mode: .measurement, options: [.duckOthers])
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      recognitionRequest = request

      let inputNode = audioEngine.inputNode
      inputNode.removeTap(onBus: 0)
      let format = inputNode.outputFormat(forBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
      }

      audioEngine.prepare()
      try audioEngine.start()
      isRecording = true

      recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
        Task { @MainActor in
          guard let self else { return }
          if let transcript = result?.bestTranscription.formattedString, !transcript.isEmpty {
            self.onTranscript?(transcript)
          }
          if error != nil || result?.isFinal == true {
            self.stop()
          }
        }
      }
    } catch {
      errorMessage = "Voice input could not start."
      stop()
    }
  }

  private func requestSpeechAuthorization() async -> Bool {
    let speechAllowed = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
    guard speechAllowed else { return false }

    return await withCheckedContinuation { continuation in
      AVAudioApplication.requestRecordPermission { allowed in
        continuation.resume(returning: allowed)
      }
    }
  }
  #endif
}
