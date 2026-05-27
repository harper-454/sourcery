import Cocoa
import SwiftUI
import CoreImage
import AVFoundation
import CoreAudio

// MARK: - Background Services Orchestrator
class ServicesManager: ObservableObject {
    
    enum ServiceState: String {
        case offline = "Offline"
        case starting = "Starting…"
        case waiting = "Waiting…"
        case online = "Online"
        case failed = "Failed"
    }
    
    @Published var nodeState: ServiceState = .offline
    @Published var tunnelState: ServiceState = .offline
    @Published var shareUrl: String = ""
    @Published var tunnelHostname: String = ""
    @Published var roomCode: String
    @Published var linkCopied: Bool = false
    @Published var isDeployed: Bool = false
    @Published var logs: [String] = []
    
    var streamer = AudioStreamer()
    
    private var nodeProcess: Process?
    private var sshProcess: Process?
    private var sshOutputBuffer: String = ""
    private var tunnelParsed: Bool = false
    private let serverJsPath: String
    
    init() {
        // Persistent room code — generated once and stored forever in UserDefaults
        let udKey = "sourcery_room_code"
        if let saved = UserDefaults.standard.string(forKey: udKey), saved.hasPrefix("sourcery-") {
            roomCode = saved
        } else {
            let chars = "abcdefghijklmnopqrstuvwxyz0123456789"
            let newCode = "sourcery-" + (0..<8).map { _ in String(chars.randomElement()!) }.joined()
            UserDefaults.standard.set(newCode, forKey: udKey)
            roomCode = newCode
        }
        
        // Resolve server.js path relative to the app bundle location:
        //   Sourcery.app is in mac-app/, server.js is in the parent (mic-streamer/)
        let bundlePath = Bundle.main.bundlePath
        let appDir = (bundlePath as NSString).deletingLastPathComponent
        let projectDir = (appDir as NSString).deletingLastPathComponent
        serverJsPath = (projectDir as NSString).appendingPathComponent("server.js")
        
        appendLog("Session room: \(roomCode)")
        
        streamer.logger = { [weak self] msg in
            self?.appendLog(msg)
        }
    }
    
    private func appendLog(_ msg: String) {
        DispatchQueue.main.async {
            self.logs.append(msg)
            // Keep last 50 entries
            if self.logs.count > 50 { self.logs.removeFirst() }
        }
        print("[Sourcery] \(msg)")
        
        let logFileUrl = URL(fileURLWithPath: "/Users/alexharper/.gemini/antigravity/scratch/mic-streamer/sourcery.log")
        let timestamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        let logLine = "[\(timestamp)] \(msg)\n"
        
        if let data = logLine.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: logFileUrl.path) {
                if let fileHandle = try? FileHandle(forWritingTo: logFileUrl) {
                    fileHandle.seekToEndOfFile()
                    fileHandle.write(data)
                    fileHandle.closeFile()
                }
            } else {
                try? data.write(to: logFileUrl)
            }
        }
    }
    
    // MARK: - Full Autonomous Startup Sequence
    func startAll() {
        isDeployed = true
        appendLog("🚀 Starting — launching LAN turbo mode…")
        
        // ── STEP 1: Connect to Local Node Relay (so Mac is always connected locally) ──
        connectToLocalRelay()
        
        // ── STEP 2: Spin up local relay + Cloudflare for public discovery ──
        cleanStaleProcesses()
        spawnNodeRelay()
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.8) {
            self.spawnSSHTunnel()
        }
        
        // Timeout watchdog
        DispatchQueue.main.asyncAfter(deadline: .now() + 20.0) { [weak self] in
            guard let self = self else { return }
            if self.tunnelState != .online {
                self.appendLog("⚠️ Tunnel allocation is slow. Retrying…")
            }
        }
    }
    
    // ── Always-On Local connection (primary, persistent) ──
    private func connectToLocalRelay() {
        appendLog("🔗 Connecting to local Node relay…")
        streamer.room = roomCode
        streamer.relayUrlString = "ws://localhost:5173/stream"
        streamer.connect()
    }

    
    // MARK: - Clean Stale Processes
    private func cleanStaleProcesses() {
        appendLog("🧹 Cleaning stale port/tunnel processes…")
        let script = """
        lsof -t -i :5173 | xargs kill -9 2>/dev/null
        ps aux | grep -E 'a.pinggy.io|cloudflared' | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
        """
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-c", script]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
        appendLog("✅ Environment clean")
    }
    
    // MARK: - Spawn Node.js Relay
    private func spawnNodeRelay() {
        DispatchQueue.main.async { self.nodeState = .starting }
        appendLog("📡 Launching Node relay on port 5173…")
        
        guard FileManager.default.fileExists(atPath: serverJsPath) else {
            appendLog("❌ server.js not found at: \(serverJsPath)")
            DispatchQueue.main.async { self.nodeState = .failed }
            return
        }
        
        let nodePath = resolveNodePath()
        guard let resolvedNode = nodePath else {
            appendLog("❌ Node.js not found. Install Node to continue.")
            DispatchQueue.main.async { self.nodeState = .failed }
            return
        }
        
        appendLog("   node: \(resolvedNode)")
        
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: resolvedNode)
        proc.arguments = [serverJsPath]
        
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self = self else { return }
            if let text = String(data: data, encoding: .utf8) {
                // Detect the "Relay active" message from server.js
                if text.contains("Relay active") {
                    DispatchQueue.main.async {
                        self.nodeState = .online
                        self.appendLog("✅ Node relay online (LAN turbo mode ready on port 5173)")
                    }
                }
                // Print to stdout for debugging
                print("[Node] \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        }
        
        proc.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if self.nodeState != .failed {
                    self.nodeState = .failed
                    self.appendLog("⚠️ Node relay exited (code: \(process.terminationStatus))")
                }
            }
        }
        
        do {
            try proc.run()
            nodeProcess = proc
        } catch {
            appendLog("❌ Failed to launch Node: \(error.localizedDescription)")
            DispatchQueue.main.async { self.nodeState = .failed }
        }
    }
    
    // MARK: - Spawn Secure SSH/Cloudflare Tunnel
    private func spawnSSHTunnel() {
        DispatchQueue.main.async {
            self.tunnelState = .starting
            self.tunnelParsed = false
            self.sshOutputBuffer = ""
        }
        appendLog("🔐 Establishing secure public Cloudflare tunnel…")
        
        let bundlePath = Bundle.main.bundlePath
        let appDir = (bundlePath as NSString).deletingLastPathComponent
        let projectDir = (appDir as NSString).deletingLastPathComponent
        let cloudflaredPath = (projectDir as NSString).appendingPathComponent("cloudflared")
        
        guard FileManager.default.fileExists(atPath: cloudflaredPath) else {
            appendLog("❌ cloudflared binary not found at: \(cloudflaredPath)")
            DispatchQueue.main.async { self.tunnelState = .failed }
            return
        }
        
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: cloudflaredPath)
        proc.arguments = [
            "tunnel",
            "--url", "http://localhost:5173"
        ]
        
        // Capture both stdout and stderr for URL parsing
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe
        proc.standardInput = FileHandle.nullDevice
        
        let outputHandler: (FileHandle) -> Void = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self = self else { return }
            if let text = String(data: data, encoding: .utf8) {
                self.processSSHOutput(text)
            }
        }
        
        stdoutPipe.fileHandleForReading.readabilityHandler = outputHandler
        stderrPipe.fileHandleForReading.readabilityHandler = outputHandler
        
        proc.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if self.tunnelState != .failed {
                    self.tunnelState = .failed
                    self.appendLog("⚠️ Cloudflare tunnel exited (code: \(process.terminationStatus))")
                }
            }
        }
        
        do {
            try proc.run()
            sshProcess = proc
        } catch {
            appendLog("❌ Failed to launch Cloudflare Tunnel: \(error.localizedDescription)")
            DispatchQueue.main.async { self.tunnelState = .failed }
        }
    }
    
    // MARK: - Parse Tunnel URL from Output Stream (Thread-Safe)
    private func processSSHOutput(_ text: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            print("[Tunnel] \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
            
            // Guard: only parse once
            if self.tunnelParsed { return }
            
            self.sshOutputBuffer += text
            
            // Match the HTTPS public URL pattern allocated by Cloudflare Tunnel (trycloudflare.com)
            if let range = self.sshOutputBuffer.range(
                of: #"https://[a-zA-Z0-9.-]+\.trycloudflare\.com"#,
                options: .regularExpression
            ) {
                let fullUrl = String(self.sshOutputBuffer[range])
                let hostname = fullUrl.replacingOccurrences(of: "https://", with: "")
                self.tunnelParsed = true
                
                let compiledShareUrl = "https://fdb91493.sourcery-dbl.pages.dev/?room=\(self.roomCode)"
                let wssHostname = "wss://\(hostname)/stream"
                
                self.tunnelHostname = hostname
                self.tunnelState = .online
                self.shareUrl = compiledShareUrl
                self.appendLog("🟢 Tunnel active: \(hostname)")
                
                // Publish to discovery!
                self.publishTunnelToDiscovery(tunnelUrl: wssHostname)
            }
        }
    }
    
    // MARK: - Copy Share Link to Clipboard
    func copyShareLink() {
        guard !shareUrl.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(shareUrl, forType: .string)
        linkCopied = true
        appendLog("📋 Link copied to clipboard")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.linkCopied = false
        }
    }
    
    private func publishTunnelToDiscovery(tunnelUrl: String) {
        appendLog("📡 Publishing tunnel to Service Discovery (\(roomCode))…")
        guard let url = URL(string: "https://ntfy.sh/\(roomCode)") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = tunnelUrl.data(using: .utf8)
        
        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error {
                DispatchQueue.main.async {
                    self.appendLog("❌ Service Discovery failed: \(error.localizedDescription)")
                }
            } else {
                DispatchQueue.main.async {
                    self.appendLog("✅ Public Audio Link Ready!")
                }
            }
        }
        task.resume()
    }
    
    // MARK: - Resolve Node.js Path
    private func resolveNodePath() -> String? {
        let knownPaths = [
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/bin/node"
        ]
        for path in knownPaths {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        // Fallback: try to resolve via login shell
        let whichProc = Process()
        whichProc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        whichProc.arguments = ["-l", "-c", "which node"]
        let whichPipe = Pipe()
        whichProc.standardOutput = whichPipe
        whichProc.standardError = FileHandle.nullDevice
        do {
            try whichProc.run()
            whichProc.waitUntilExit()
            let data = whichPipe.fileHandleForReading.readDataToEndOfFile()
            if let resolved = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !resolved.isEmpty,
               FileManager.default.fileExists(atPath: resolved) {
                return resolved
            }
        } catch {}
        return nil
    }
    
    // MARK: - Graceful Teardown
    func terminateAll() {
        appendLog("🛑 Shutting down all services…")
        
        // Disconnect audio streamer first
        streamer.disconnect()
        
        // Terminate child processes
        if let proc = nodeProcess, proc.isRunning {
            proc.terminate()
            nodeProcess = nil
        }
        if let proc = sshProcess, proc.isRunning {
            proc.terminate()
            sshProcess = nil
        }
        
        // Belt-and-suspenders: kill by port/name in case Process handles are stale
        let cleanup = Process()
        cleanup.executableURL = URL(fileURLWithPath: "/bin/zsh")
        cleanup.arguments = ["-c", """
            lsof -t -i :5173 | xargs kill -9 2>/dev/null
            ps aux | grep -E 'a.pinggy.io|cloudflared' | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
        """]
        cleanup.standardOutput = FileHandle.nullDevice
        cleanup.standardError = FileHandle.nullDevice
        try? cleanup.run()
        cleanup.waitUntilExit()
        
        DispatchQueue.main.async {
            self.nodeState = .offline
            self.tunnelState = .offline
            self.shareUrl = ""
            self.tunnelHostname = ""
            self.isDeployed = false
        }
    }
}

