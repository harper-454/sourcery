#!/bin/bash
# mac-app/build.sh
set -e

echo "=== Sourcery Build System ==="
echo "Cleaning up old build artifacts..."
rm -rf Sourcery.app Sourcery

echo "Detecting macOS SDK path..."
SDK_PATH=$(xcrun --show-sdk-path --sdk macosx)
echo "SDK Path: $SDK_PATH"

echo "Compiling Swift sources..."
swiftc -O -sdk "$SDK_PATH" Sources/*.swift -o Sourcery

echo "Creating Sourcery.app bundle structure..."
mkdir -p Sourcery.app/Contents/MacOS

echo "Assembling files..."
mv Sourcery Sourcery.app/Contents/MacOS/Sourcery
cp Info.plist Sourcery.app/Contents/Info.plist

echo "Performing ad-hoc security codesigning..."
# Ad-hoc sign the inner binary and the outer bundle to satisfy macOS Gatekeeper
codesign --force --sign - Sourcery.app/Contents/MacOS/Sourcery
codesign --force --sign - Sourcery.app

echo "=== Build Successful! ==="
echo "You can now run the app with: open Sourcery.app"
echo "================================="
