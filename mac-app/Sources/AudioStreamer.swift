import Cocoa
import SwiftUI
import CoreImage
import AVFoundation
import CoreAudio

// MARK: - Hardware Input Device Helper
struct AudioDevice: Identifiable, Hashable {
    let id: AudioDeviceID
    let name: String
}

class AudioDeviceManager {
    static func getInputDevices() -> [AudioDevice] {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var dataSize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &propertyAddress, 0, nil, &dataSize)
        guard status == noErr else { return [] }
        
        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)
        status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &propertyAddress, 0, nil, &dataSize, &deviceIDs)
        guard status == noErr else { return [] }
        
        var inputDevices: [AudioDevice] = []
        
        for id in deviceIDs {
            var streamAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreams,
                mScope: kAudioDevicePropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain
            )
            var streamSize: UInt32 = 0
            AudioObjectGetPropertyDataSize(id, &streamAddress, 0, nil, &streamSize)
            
            if streamSize > 0 {
                var nameAddress = AudioObjectPropertyAddress(
                    mSelector: kAudioDevicePropertyDeviceNameCFString,
                    mScope: kAudioObjectPropertyScopeInput,
                    mElement: kAudioObjectPropertyElementMain
                )
                var nameString: CFString? = nil
                var nameSize = UInt32(MemoryLayout<CFString?>.size)
                status = AudioObjectGetPropertyData(id, &nameAddress, 0, nil, &nameSize, &nameString)
                
                if status == noErr, let name = nameString as String? {
                    inputDevices.append(AudioDevice(id: id, name: name))
                }
            }
        }
        
        if inputDevices.isEmpty {
            inputDevices.append(AudioDevice(id: 0, name: "System Default Microphone"))
        }
        return inputDevices
    }
}

// MARK: - Audio Streaming Engine & Watchdog Connection Manager
class AudioStreamer: NSObject, ObservableObject, URLSessionWebSocketDelegate {
    @Published var connectionState: String = "Idle"
    @Published var isStreaming: Bool = false
    @Published var volumeLevel: Float = 0.0
    @Published var packetsSent: Int = 0
    @Published var sampleRate: Double = 0.0
    @Published var activeListeners: Int = 0   // live count of connected clients
    
    @Published var availableDevices: [AudioDevice] = []
    @Published var selectedDevice: AudioDevice? = nil {
        didSet {
            if let device = selectedDevice {
                switchInputDevice(device)
            }
        }
    }

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private let audioEngine = AVAudioEngine()
    private var isConnected = false
    private var shouldReconnect = false
    private var reconnectTimer: Timer?
    private var pingTimer: Timer?
    // Heartbeat watchdog: if no heartbeat within 15s after all clients leave, stop mic tap
    private var heartbeatWatchdog: Timer?
    private var lastHeartbeatTime: Date = Date.distantPast
    private var knownClients: Set<String> = []   // tracks joined client IDs
    
    var relayUrlString: String = "ws://localhost:5173/stream"
    var room: String = "demo-room"
    
    var logger: ((String) -> Void)?

    override init() {
        super.init()
        refreshDevices(setDefault: false)
        // NOTE: No auto-connect. ServicesManager triggers connect() when relay is online.
    }
    
    func refreshDevices(setDefault: Bool = false) {
        let devices = AudioDeviceManager.getInputDevices()
        self.availableDevices = devices
        if setDefault, self.selectedDevice == nil, let currentDefault = devices.first {
            self.selectedDevice = currentDefault
        }
    }
    
    private func switchInputDevice(_ device: AudioDevice) {
        guard device.id != 0 else { return }
        let inputNode = audioEngine.inputNode
        guard let inputUnit = inputNode.audioUnit else {
            print("Sourcery: Could not access input node AudioUnit")
            return
        }
        var deviceID = device.id
        let status = AudioUnitSetProperty(
            inputUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        if status == noErr {
            print("Sourcery: Natively switched audio input device to: \(device.name)")
            if isStreaming { restartStreamingTap() }
        } else {
            print("Sourcery: Failed to switch input device, error status: \(status)")
        }
    }

    func connect() {
        shouldReconnect = true
        reconnectTimer?.invalidate()
        
        guard let baseUrl = URL(string: relayUrlString) else {
            self.connectionState = "Invalid URL"
            return
        }
        
        var wsUrlString = baseUrl.absoluteString
        if wsUrlString.contains("?") {
            wsUrlString += "&room=\(room)&role=host"
        } else {
            wsUrlString += "?room=\(room)&role=host"
        }
        guard let finalUrl = URL(string: wsUrlString) else {
            self.connectionState = "Invalid URL"
            return
        }
        var request = URLRequest(url: finalUrl)
        request.timeoutInterval = 10.0
        // Set an Origin header to masquerade as a browser, which some broker firewalls require.
        request.setValue("https://sourcery-dbl.pages.dev", forHTTPHeaderField: "Origin")
        
        self.connectionState = "Connecting..."
        
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10.0 
        
        session = URLSession(configuration: config, delegate: self, delegateQueue: OperationQueue.main)
        webSocketTask = session?.webSocketTask(with: request)
        webSocketTask?.resume()
        listenForMessages()
    }
    
    private func listenForMessages() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    // Parse incoming JSON control messages
                    if let data = text.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        let msgType = json["type"] as? String ?? ""
                        DispatchQueue.main.async {
                            if msgType == "client_connected" {
                                let clientId = json["clientId"] as? String ?? "unknown-\(Int.random(in: 1000...9999))"
                                self.knownClients.insert(clientId)
                                self.activeListeners = self.knownClients.count
                                self.lastHeartbeatTime = Date()
                                self.logger?("🤝 Client joined: \(clientId). Active listeners: \(self.knownClients.count)")
                                // Start mic only when first client arrives
                                if !self.isStreaming {
                                    self.logger?("🎙️ First listener — activating mic tap.")
                                    self.startStreaming()
                                } else {
                                    self.sendConfigPayload()
                                }
                                self.resetHeartbeatWatchdog()
                            } else if msgType == "client_heartbeat" {
                                self.lastHeartbeatTime = Date()
                                self.resetHeartbeatWatchdog()
                            } else if msgType == "client_disconnected" {
                                let clientId = json["clientId"] as? String ?? ""
                                self.knownClients.remove(clientId)
                                self.activeListeners = self.knownClients.count
                                self.logger?("👋 Client left: \(clientId). Active listeners: \(self.knownClients.count)")
                                if self.knownClients.isEmpty {
                                    self.scheduleIdleShutdown()
                                }
                            } else if msgType == "host_announce" {
                                // Ignore self
                            } else if msgType == "ping" {
                                // Ignore ping
                            } else {
                                self.logger?("📥 Unknown msg type: \(msgType)")
                            }
                        }
                    } else if text.contains("client_connected") {
                        // Fallback: plain-text relay notification
                        DispatchQueue.main.async {
                            self.lastHeartbeatTime = Date()
                            self.logger?("🤝 Relay notified client joined. Activating mic...")
                            if !self.isStreaming { self.startStreaming() }
                            else { self.sendConfigPayload() }
                            self.resetHeartbeatWatchdog()
                        }
                    }
                default:
                    break
                }
                DispatchQueue.main.async { self.listenForMessages() }
            case .failure(let error):
                self.logger?("❌ Socket disconnect/error: \(error.localizedDescription)")
                DispatchQueue.main.async { self.handleConnectionFailure() }
            }
        }
    }

    
    // Resets the 15-second idle watchdog. Called on every heartbeat.
    private func resetHeartbeatWatchdog() {
        heartbeatWatchdog?.invalidate()
        heartbeatWatchdog = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            // If no heartbeat in 15s and no known clients, stop the mic tap
            if self.knownClients.isEmpty {
                self.logger?("🤫 No listeners for 15s — releasing mic tap.")
                DispatchQueue.main.async { self.stopStreaming() }
            }
        }
    }
    
    // Schedules idle shutdown when a client explicitly disconnects
    private func scheduleIdleShutdown() {
        heartbeatWatchdog?.invalidate()
        heartbeatWatchdog = Timer.scheduledTimer(withTimeInterval: 8.0, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            if self.knownClients.isEmpty && self.isStreaming {
                self.logger?("🤫 Room empty for 8s — releasing mic tap.")
                DispatchQueue.main.async { self.stopStreaming() }
            }
        }
    }



    private func handleConnectionFailure() {
        stopStreaming()
        webSocketTask = nil
        session = nil
        isConnected = false
        isStreaming = false
        pingTimer?.invalidate()
        pingTimer = nil
        heartbeatWatchdog?.invalidate()
        heartbeatWatchdog = nil
        knownClients.removeAll()
        activeListeners = 0
        
        if shouldReconnect {
            self.connectionState = "Reconnecting..."
            reconnectTimer?.invalidate()
            reconnectTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { [weak self] _ in
                guard let self = self, self.shouldReconnect else { return }
                print("Sourcery Auto-Pilot: Attempting reconnection to relay...")
                self.connect()
            }
        } else {
            self.connectionState = "Disconnected"
        }
    }

    // MARK: - WebSocket Delegates
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        DispatchQueue.main.async {
            self.reconnectTimer?.invalidate()
            self.isConnected = true
            self.knownClients.removeAll()
            self.activeListeners = 0
            self.connectionState = "Waiting for Listeners…"
            self.logger?("🌐 Connected to Broker. Waiting for listeners...")
            
            // Announce ourselves as the host so any waiting clients know to start
            let announcePayload: [String: Any] = ["type": "host_announce", "room": self.room]
            if let jsonData = try? JSONSerialization.data(withJSONObject: announcePayload, options: []),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                self.webSocketTask?.send(.string(jsonString)) { _ in }
            }

            
            // Start robust keep-alive ping timer (every 10 seconds)
            self.pingTimer?.invalidate()
            self.pingTimer = Timer.scheduledTimer(withTimeInterval: 10.0, repeats: true) { [weak self] _ in
                guard let self = self, self.isConnected else { return }
                let pingPayload: [String: Any] = ["type": "ping"]
                if let jsonData = try? JSONSerialization.data(withJSONObject: pingPayload, options: []),
                   let jsonString = String(data: jsonData, encoding: .utf8) {
                    self.webSocketTask?.send(.string(jsonString)) { error in
                        if let error = error { print("Host keep-alive ping failed: \(error)") }
                    }
                }
            }
            // NOTE: startStreaming() is NOT called here — mic fires lazily on client_connected
        }
    }
    
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        DispatchQueue.main.async { self.handleConnectionFailure() }
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let err = error {
            print("Connection error: \(err.localizedDescription)")
            DispatchQueue.main.async { self.handleConnectionFailure() }
        }
    }

    func sendConfigPayload() {
        guard sampleRate > 0 else { return }
        let configPayload: [String: Any] = ["type": "config", "sampleRate": sampleRate]
        if let jsonData = try? JSONSerialization.data(withJSONObject: configPayload, options: []),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            webSocketTask?.send(.string(jsonString)) { error in
                if let error = error { print("Config payload sending failed: \(error)") }
            }
        }
    }

    func disconnect() {
        shouldReconnect = false
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        pingTimer?.invalidate()
        pingTimer = nil
        heartbeatWatchdog?.invalidate()
        heartbeatWatchdog = nil
        knownClients.removeAll()
        activeListeners = 0
        stopStreaming()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        session = nil
        isConnected = false
        isStreaming = false
        connectionState = "Disconnected"
    }

    // MARK: - Audio Streaming & Capture
    private func startStreaming() {
        let inputNode = audioEngine.inputNode
        
        if #available(macOS 12.0, *) {
            do {
                try inputNode.setVoiceProcessingEnabled(true)
                print("Sourcery: CoreAudio ML Voice Processing engaged successfully.")
            } catch {
                print("Sourcery: System Voice Processing API failed: \(error.localizedDescription)")
            }
        }
        
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            self.connectionState = "Mic Error"
            return
        }
        
        self.sampleRate = inputFormat.sampleRate
        self.packetsSent = 0
        
        let configPayload: [String: Any] = ["type": "config", "sampleRate": inputFormat.sampleRate]
        if let jsonData = try? JSONSerialization.data(withJSONObject: configPayload, options: []),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            webSocketTask?.send(.string(jsonString)) { error in
                if let error = error { print("Config payload sending failed: \(error)") }
            }
        }
        
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] (buffer, time) in
            guard let self = self else { return }
            guard let channelData = buffer.floatChannelData else { return }
            let frameLength = Int(buffer.frameLength)
            
            let rawBuffer = channelData[0]
            let byteCount = frameLength * MemoryLayout<Float>.size
            let data = Data(bytes: rawBuffer, count: byteCount)
            
            var peak: Float = 0.0
            for i in 0..<frameLength {
                let sample = abs(rawBuffer[i])
                if sample > peak { peak = sample }
            }
            
            if self.isConnected {
                self.webSocketTask?.send(.data(data)) { error in
                    if let error = error {
                        print("Failed to dispatch audio packet: \(error)")
                    } else {
                        DispatchQueue.main.async { self.packetsSent += 1 }
                    }
                }
            }
            DispatchQueue.main.async { self.volumeLevel = peak }
        }
        
        do {
            try audioEngine.start()
            self.isStreaming = true
            self.connectionState = "Streaming"
        } catch {
            print("AVAudioEngine failed to start: \(error.localizedDescription)")
            self.connectionState = "Audio Error"
            self.handleConnectionFailure()
        }
    }
    
    private func restartStreamingTap() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        startStreaming()
    }
    
    private func stopStreaming() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        self.isStreaming = false
        self.volumeLevel = 0.0
    }
    
    func checkMicPermission(completion: @escaping (Bool) -> Void) {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        DispatchQueue.main.async { completion(status == .authorized) }
    }

    func requestMicPermission(completion: @escaping (Bool) -> Void) {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        if status == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        } else {
            completion(status == .authorized)
        }
    }
}

