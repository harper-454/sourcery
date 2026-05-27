// mac-app/main.swift
// Sourcery – 1-Click Live Deploy macOS Status Bar App
// Autonomously orchestrates Node relay + SSH tunnel + CoreAudio streaming.

import Cocoa
import SwiftUI
import CoreImage
import AVFoundation
import CoreAudio

// MARK: - Native Application Lifecycle Manager
class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    let services = ServicesManager()
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        let popover = NSPopover()
        popover.contentSize = NSSize(width: 350, height: 520)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: ContentView(services: services))
        self.popover = popover
        
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🎙️"
            button.action = #selector(togglePopover(_:))
            button.target = self
        }
        
        // Services are started manually via the Deploy button in the UI
        // Safely select default audio device after AppKit event loop is fully running:
        services.streamer.refreshDevices(setDefault: true)
        
        // Auto-deploy on startup so the streaming server is immediately active:
        services.startAll()
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        // Graceful teardown: kill all child processes cleanly
        services.terminateAll()
    }
    
    @objc func togglePopover(_ sender: AnyObject?) {
        if let button = statusItem.button {
            if popover.isShown {
                popover.performClose(sender)
            } else {
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                popover.contentViewController?.view.window?.makeKey()
            }
        }
    }
}

// MARK: - App Entry Point
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate

// Trap SIGTERM/SIGINT so child processes are cleaned up even if killed externally
let signalHandler: @convention(c) (Int32) -> Void = { _ in
    delegate.services.terminateAll()
    exit(0)
}
signal(SIGTERM, signalHandler)
signal(SIGINT, signalHandler)

app.run()
