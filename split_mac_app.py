import re
import os

with open("mac-app/main.swift", "r") as f:
    content = f.read()

# Define patterns to extract the classes
audio_streamer_pattern = re.compile(r"(// MARK: - Hardware Input Device Helper.*?)// MARK: - Background Services Orchestrator", re.DOTALL)
services_manager_pattern = re.compile(r"(// MARK: - Background Services Orchestrator.*?)// MARK: - SwiftUI Popover Interface", re.DOTALL)
content_view_pattern = re.compile(r"(// MARK: - SwiftUI Popover Interface.*?)// MARK: - Native Application Lifecycle Manager", re.DOTALL)

# Extract
audio_streamer_match = audio_streamer_pattern.search(content)
services_manager_match = services_manager_pattern.search(content)
content_view_match = content_view_pattern.search(content)

imports = """import Cocoa
import SwiftUI
import CoreImage
import AVFoundation
import CoreAudio

"""

os.makedirs("mac-app/Sources", exist_ok=True)

if audio_streamer_match:
    with open("mac-app/Sources/AudioStreamer.swift", "w") as f:
        f.write(imports + audio_streamer_match.group(1))

if services_manager_match:
    with open("mac-app/Sources/ServicesManager.swift", "w") as f:
        f.write(imports + services_manager_match.group(1))

if content_view_match:
    with open("mac-app/Sources/ContentView.swift", "w") as f:
        f.write(imports + content_view_match.group(1))

# Write remaining main.swift
remaining = content
if audio_streamer_match: remaining = remaining.replace(audio_streamer_match.group(1), "")
if services_manager_match: remaining = remaining.replace(services_manager_match.group(1), "")
if content_view_match: remaining = remaining.replace(content_view_match.group(1), "")

with open("mac-app/Sources/main.swift", "w") as f:
    f.write(remaining)

print("Splitting complete.")
