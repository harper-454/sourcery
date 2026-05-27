import Cocoa
import SwiftUI
import CoreImage
import AVFoundation
import CoreAudio

// MARK: - SwiftUI Popover Interface
struct ContentView: View {
    @ObservedObject var services: ServicesManager
    @State var hasPermission: Bool = true
    @State var showLogs: Bool = false
    
    var body: some View {
        VStack(spacing: 0) {
            // ─── Header ───
            headerSection
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 10)
            
            Divider()
                .padding(.horizontal, 12)
            
            if !hasPermission {
                micPermissionView
                    .padding(16)
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 12) {
                        // ─── Microphone (always accessible) ───
                        microphoneCard
                        
                        // ─── Level Meter ───
                        levelMeterCard
                        
                        if services.isDeployed {
                            // ─── Service Status ───
                            serviceStatusCard
                            
                            // ─── Share Link Card (always shown once deployed; QR updates live) ───
                            shareLinkCard
                        }
                        
                        // ─── Logs Toggle ───
                        if showLogs {
                            logsCard
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                }
                
                Divider()
                    .padding(.horizontal, 12)
                
                // ─── Action Bar ───
                actionBar
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
        }
        .frame(width: 350, height: 520)
        .onAppear {
            services.streamer.requestMicPermission { granted in
                self.hasPermission = granted
            }
        }
    }
    
    // MARK: - Header
    var headerSection: some View {
        HStack {
            Text("🎙️")
                .font(.system(size: 28))
            VStack(alignment: .leading, spacing: 1) {
                Text("Sourcery")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                Text("1-Click Live Deploy")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.secondary)
            }
            Spacer()
            
            // Streaming status pill
            HStack(spacing: 5) {
                Circle()
                    .fill(streamerStatusColor)
                    .frame(width: 8, height: 8)
                Text(services.streamer.connectionState)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color.secondary.opacity(0.08))
            .cornerRadius(8)
        }
    }
    
    // MARK: - Service Status Card
    var serviceStatusCard: some View {
        VStack(spacing: 8) {
            HStack {
                Text("INFRASTRUCTURE")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundColor(.secondary)
                Spacer()
            }
            
            serviceRow(emoji: "📡", label: "Local Relay", state: services.nodeState)
            serviceRow(emoji: "🔐", label: "Secure Tunnel", state: services.tunnelState)
            serviceRow(emoji: "🎤", label: "Audio Stream", state: audioServiceState)
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05))
        .cornerRadius(10)
    }
    
    func serviceRow(emoji: String, label: String, state: ServicesManager.ServiceState) -> some View {
        HStack(spacing: 8) {
            Text(emoji)
                .font(.system(size: 13))
            Text(label)
                .font(.system(size: 12, weight: .medium))
            Spacer()
            HStack(spacing: 4) {
                Circle()
                    .fill(stateColor(state))
                    .frame(width: 7, height: 7)
                Text(state.rawValue)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(stateColor(state))
            }
        }
    }
    
    var audioServiceState: ServicesManager.ServiceState {
        switch services.streamer.connectionState {
        case "Streaming": return .online
        case "Connecting...", "Reconnecting...", "Connected": return .starting
        case "Waiting for Listeners…": return .waiting
        case "Idle", "Disconnected": return .offline
        default: return .failed
        }
    }
    
    // MARK: - Share Link Card
    var shareLinkCard: some View {
        VStack(spacing: 8) {
            // Header row — title + live listener badge
            HStack {
                Text("🔗")
                    .font(.system(size: 14))
                VStack(alignment: .leading, spacing: 1) {
                    Text("PERMANENT LISTENER LINK")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundColor(.green)
                    Text("Room: \(services.roomCode)")
                        .font(.system(size: 8, design: .monospaced))
                        .foregroundColor(.secondary)
                }
                Spacer()
                // Live listener pill
                let listenerCount = services.streamer.activeListeners
                HStack(spacing: 4) {
                    Circle()
                        .fill(listenerCount > 0 ? Color.green : Color.gray.opacity(0.5))
                        .frame(width: 6, height: 6)
                    Text(listenerCount > 0 ? "\(listenerCount) listening" : "No listeners")
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .foregroundColor(listenerCount > 0 ? .green : .secondary)
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(Color.black.opacity(0.2))
                .cornerRadius(8)
            }
            
            // QR Code — .id() forces SwiftUI to recreate the Image node whenever shareUrl changes
            if services.shareUrl.isEmpty {
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(white: 0.92))
                        .frame(width: 140, height: 140)
                    VStack(spacing: 8) {
                        ProgressIndicator()
                            .frame(width: 18, height: 18)
                        Text("Generating…")
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
            } else {
                qrCodeImage(for: services.shareUrl)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 140, height: 140)
                    .padding(8)
                    .background(Color.white)
                    .cornerRadius(8)
                    .frame(maxWidth: .infinity)
                    // This .id() is the critical fix: destroys/recreates the Image view
                    // any time the URL string changes, guaranteeing the QR is always current.
                    .id(services.shareUrl)
            }
            
            // Share URL (prominent) or loading indicator
            if !services.shareUrl.isEmpty {
                Text(services.shareUrl)
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundColor(.primary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(8)
                    .background(Color.black.opacity(0.15))
                    .cornerRadius(6)
            } else {
                HStack(spacing: 6) {
                    ProgressIndicator()
                        .frame(width: 12, height: 12)
                    Text("Establishing tunnel…")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(8)
                .background(Color.black.opacity(0.1))
                .cornerRadius(6)
            }
            
            // Copy button
            Button(action: {
                services.copyShareLink()
            }) {
                copyButtonLabel
            }
            .buttonStyle(PlainButtonStyle())
            
            Text("Scan QR or open link on any device!")
                .font(.system(size: 9))
                .foregroundColor(.secondary)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.green.opacity(0.06))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Color.green.opacity(0.2), lineWidth: 1)
                )
        )
    }
    
    // MARK: - QR Code Generator (CoreImage)
    func qrCodeImage(for string: String) -> Image {
        guard let data = string.data(using: .ascii),
              let filter = CIFilter(name: "CIQRCodeGenerator") else {
            return Image(systemName: "qrcode")
        }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        
        guard let ciImage = filter.outputImage else {
            return Image(systemName: "qrcode")
        }
        
        let transform = CGAffineTransform(scaleX: 10, y: 10)
        let scaled = ciImage.transformed(by: transform)
        
        let rep = NSCIImageRep(ciImage: scaled)
        let nsImage = NSImage(size: rep.size)
        nsImage.addRepresentation(rep)
        
        return Image(nsImage: nsImage)
    }
    
    // MARK: - Copy Button Label (extracted to help Swift type-checker)
    @ViewBuilder
    var copyButtonLabel: some View {
        let isCopied = services.linkCopied
        let emoji: String = isCopied ? "✅" : "📋"
        let label: String = isCopied ? "Copied!" : "Copy Live Listener Link"
        let bgColor: Color = isCopied ? Color.green : Color.blue
        
        HStack(spacing: 6) {
            Text(emoji)
                .font(.system(size: 13))
            Text(label)
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.white)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(bgColor)
        .cornerRadius(8)
    }
    
    // MARK: - Tunnel Spinner Card
    var tunnelSpinnerCard: some View {
        HStack(spacing: 10) {
            ProgressIndicator()
                .frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text("Allocating secure public tunnel…")
                    .font(.system(size: 11, weight: .medium))
                Text("This usually takes 2–5 seconds")
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
        .padding(12)
        .background(Color.orange.opacity(0.06))
        .cornerRadius(10)
    }
    
    // MARK: - Microphone Card
    var microphoneCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Active Microphone Input")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(.secondary)
                Spacer()
                Button(action: { services.streamer.refreshDevices() }) {
                    Text("🔄")
                        .font(.system(size: 10))
                }
                .buttonStyle(PlainButtonStyle())
            }
            
            // Explicit binding to work around nested ObservableObject limitation
            let deviceBinding = Binding<AudioDevice?>(
                get: { services.streamer.selectedDevice },
                set: { newDevice in
                    services.streamer.selectedDevice = newDevice
                    services.objectWillChange.send()
                }
            )
            
            Picker("", selection: deviceBinding) {
                ForEach(services.streamer.availableDevices, id: \.self) { device in
                    Text(device.name).tag(device as AudioDevice?)
                }
            }
        }
    }
    
    // MARK: - Level Meter Card
    var levelMeterCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Live Mic Level")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(.secondary)
                Spacer()
                if services.streamer.isStreaming {
                    Text(String(format: "%d pckts • %.1f kHz", services.streamer.packetsSent, services.streamer.sampleRate / 1000))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundColor(.secondary)
                }
            }
            
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.secondary.opacity(0.12))
                        .frame(height: 6)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(
                            LinearGradient(
                                gradient: Gradient(colors: [.green, .yellow, .red]),
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: geo.size.width * CGFloat(services.streamer.volumeLevel), height: 6)
                        .animation(.easeOut(duration: 0.08), value: services.streamer.volumeLevel)
                }
            }
            .frame(height: 6)
        }
    }
    
    // MARK: - Logs Card
    var logsCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("SYSTEM LOG")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundColor(.secondary)
                Spacer()
            }
            
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(services.logs.enumerated()), id: \.offset) { _, log in
                        Text(log)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundColor(.primary.opacity(0.7))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(height: 80)
            .padding(6)
            .background(Color.black.opacity(0.1))
            .cornerRadius(6)
        }
    }
    
    // MARK: - Action Bar
    var actionBar: some View {
        VStack(spacing: 8) {
            // Primary action: Deploy or Stop
            if services.isDeployed {
                Button(action: {
                    services.terminateAll()
                }) {
                    HStack(spacing: 6) {
                        Text("⏹")
                        Text("Stop Live Deploy")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Color.red)
                    .cornerRadius(8)
                }
                .buttonStyle(PlainButtonStyle())
            } else {
                Button(action: {
                    services.streamer.requestMicPermission { granted in
                        self.hasPermission = granted
                        if granted {
                            services.startAll()
                        }
                    }
                }) {
                    HStack(spacing: 6) {
                        Text("🚀")
                        Text("Deploy Live")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(
                        LinearGradient(
                            gradient: Gradient(colors: [Color.blue, Color.purple]),
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .cornerRadius(8)
                }
                .buttonStyle(PlainButtonStyle())
            }
            
            // Secondary row
            HStack(spacing: 10) {
                Button(action: {
                    services.terminateAll()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        NSApplication.shared.terminate(nil)
                    }
                }) {
                    Text("Quit")
                        .foregroundColor(.red)
                        .font(.system(size: 11, weight: .medium))
                        .padding(.vertical, 5)
                        .padding(.horizontal, 14)
                        .background(Color.red.opacity(0.08))
                        .cornerRadius(6)
                }
                .buttonStyle(PlainButtonStyle())
                
                Button(action: { showLogs.toggle() }) {
                    Text(showLogs ? "Hide Logs" : "Logs")
                        .foregroundColor(.secondary)
                        .font(.system(size: 11, weight: .medium))
                        .padding(.vertical, 5)
                        .padding(.horizontal, 12)
                        .background(Color.secondary.opacity(0.08))
                        .cornerRadius(6)
                }
                .buttonStyle(PlainButtonStyle())
                
                Spacer()
            }
        }
    }
    
    // MARK: - Mic Permission View
    var micPermissionView: some View {
        VStack(spacing: 12) {
            Text("Microphone Blocked")
                .font(.headline)
                .foregroundColor(.red)
            Text("macOS has blocked microphone access for Sourcery. Enable it below.")
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
            
            Spacer()
            
            Button(action: {
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                    NSWorkspace.shared.open(url)
                }
            }) {
                Text("Open Microphone Settings")
                    .foregroundColor(.white)
                    .fontWeight(.bold)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                    .background(Color.blue)
                    .cornerRadius(8)
            }
            .buttonStyle(PlainButtonStyle())
            
            Button(action: { NSApplication.shared.terminate(nil) }) {
                Text("Quit App")
                    .foregroundColor(.red.opacity(0.8))
                    .font(.caption)
            }
            .buttonStyle(PlainButtonStyle())
        }
    }
    
    // MARK: - Color Helpers
    var streamerStatusColor: Color {
        switch services.streamer.connectionState {
        case "Streaming": return .green
        case "Connected": return .blue
        case "Connecting...", "Reconnecting...": return .orange
        case "Audio Error", "Mic Error", "Invalid URL": return .red
        default: return .secondary
        }
    }
    
    func stateColor(_ state: ServicesManager.ServiceState) -> Color {
        switch state {
        case .online: return .green
        case .starting: return .orange
        case .waiting: return .yellow
        case .offline: return .gray
        case .failed: return .red
        }
    }
}

// MARK: - Native NSProgressIndicator wrapper for SwiftUI
struct ProgressIndicator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSProgressIndicator {
        let indicator = NSProgressIndicator()
        indicator.style = .spinning
        indicator.controlSize = .small
        indicator.startAnimation(nil)
        return indicator
    }
    func updateNSView(_ nsView: NSProgressIndicator, context: Context) {}
}

