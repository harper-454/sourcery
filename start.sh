#!/bin/bash
# start.sh
# The Ultimate 1-Click Startup Automation for Sourcery

set -e

# ANSI Color Utilities
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}=================================================="
echo -e "         🧙‍♂️ SOURCERY AUTOMATED STARTUP 🧙‍♂️"
echo -e "==================================================${NC}"

# Step 1: Clear ports to prevent socket address in use failures
echo -e "${BLUE}[Step 1/5] Scanning and clearing active ports...${NC}"
STALE_WRANGLER=$(lsof -t -i :8788 || true)
STALE_VITE=$(lsof -t -i :5173 || true)

if [ ! -z "$STALE_WRANGLER" ]; then
    echo -e "${YELLOW}Killing stale server on port 8788 (Process ID: $STALE_WRANGLER)...${NC}"
    kill -9 $STALE_WRANGLER 2>/dev/null || true
fi

if [ ! -z "$STALE_VITE" ]; then
    echo -e "${YELLOW}Killing stale server on port 5173 (Process ID: $STALE_VITE)...${NC}"
    kill -9 $STALE_VITE 2>/dev/null || true
fi

# Stop any running instances of the Sourcery GUI app to prevent macOS focus trapping
echo -e "${YELLOW}Stopping any stale running instances of Sourcery...${NC}"
killall Sourcery 2>/dev/null || true

# Stop any running instances of the secure tunnels to prevent socket conflicts
echo -e "${YELLOW}Stopping any stale secure tunnels (Pinggy & Cloudflare)...${NC}"
STALE_SSH=$(ps aux | grep "a.pinggy.io" | grep -v grep | awk '{print $2}' || true)
if [ ! -z "$STALE_SSH" ]; then
    echo -e "${YELLOW}Killing stale SSH tunnel (Process ID: $STALE_SSH)...${NC}"
    kill -9 $STALE_SSH 2>/dev/null || true
fi
STALE_CLOUDFLARED=$(ps aux | grep "cloudflared" | grep -v grep | awk '{print $2}' || true)
if [ ! -z "$STALE_CLOUDFLARED" ]; then
    echo -e "${YELLOW}Killing stale Cloudflare tunnel (Process ID: $STALE_CLOUDFLARED)...${NC}"
    kill -9 $STALE_CLOUDFLARED 2>/dev/null || true
fi

echo -e "${GREEN}Environment is clean!${NC}"

# Step 2: Compile the native macOS Status Bar App
echo -e "${BLUE}[Step 2/5] Compiling native Sourcery macOS App...${NC}"
cd mac-app
chmod +x build.sh
./build.sh
cd ..
echo -e "${GREEN}macOS App compiled and signed successfully!${NC}"

# Step 2.5: Spin up secure Cloudflare quick tunnel in background
echo -e "${BLUE}[Step 2.5/5] Establishing secure public Cloudflare tunnel...${NC}"
rm -f cloudflared.log
./cloudflared tunnel --url http://localhost:5173 > cloudflared.log 2>&1 &
TUNNEL_PID=$!

# Wait up to 10 seconds for Cloudflare to allocate the URL
echo -ne "${YELLOW}Waiting for public secure URL allocation...${NC}"
for i in {1..20}; do
    if grep -q "trycloudflare.com" cloudflared.log 2>/dev/null; then
        break
    fi
    echo -n "."
    sleep 0.5
done
echo ""

# Parse URL
TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' cloudflared.log 2>/dev/null | head -n 1 | sed 's|https://||')

if [ ! -z "$TUNNEL_URL" ]; then
    echo -e "${GREEN}Secure public tunnel established successfully!${NC}"
    echo -e "🔗 Public Hostname: ${CYAN}$TUNNEL_URL${NC}"
    # Write to web-app/.env.local so Vite automatically compiles it as VITE_TUNNEL_URL
    echo "VITE_TUNNEL_URL=$TUNNEL_URL" > web-app/.env.local
else
    echo -e "${RED}Warning: Secure tunnel allocation timed out. Live sharing will require manual configurations.${NC}"
    rm -f web-app/.env.local
fi

# Step 3: Boot the Vite Web Server & WebSocket Relay in the background
echo -e "${BLUE}[Step 3/5] Launching Vite Web Server & WebSocket Relay...${NC}"
cd web-app
# Start Vite and redirect output to a log file
npm run dev > ../server.log 2>&1 &
SERVER_PID=$!
cd ..

echo -e "${YELLOW}Waiting for Vite dev server to initialize (2 seconds)...${NC}"
sleep 2
echo -e "${GREEN}Vite server is active (PID: $SERVER_PID)! Log available at server.log${NC}"

# Step 4: Open your browser to the Web Player
echo -e "${BLUE}[Step 4/5] Launching Web Player in browser...${NC}"
open "http://localhost:5173"
echo -e "${GREEN}Browser opened to http://localhost:5173!${NC}"

# Step 5: Launch the macOS Menu Bar App
echo -e "${BLUE}[Step 5/5] Launching Sourcery macOS Status Bar App...${NC}"
open mac-app/Sourcery.app
echo -e "${GREEN}Sourcery.app is now running!${NC}"

echo -e "${CYAN}=================================================="
echo -e "🎉 SOURCERY LAUNCHED SUCCESSFULLY!"
echo -e "🎙️ Click the status bar icon in your macOS menu bar"
echo -e "   and select your preferred microphone to begin!"
echo -e "==================================================${NC}"
