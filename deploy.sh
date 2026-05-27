#!/bin/bash
# deploy.sh
# Production Cloudflare Pages Deployment Automation for Sourcery

set -e

# ANSI Color Utilities
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}=================================================="
echo -e "       🚀 SOURCERY PRODUCTION DEPLOYMENT 🚀"
echo -e "==================================================${NC}"

# Step 1: Check Cloudflare authentication status
echo -e "${BLUE}[Step 1/3] Checking Cloudflare Authentication...${NC}"
echo -e "${YELLOW}Opening Cloudflare authentication login in your browser...${NC}"
echo -e "${YELLOW}Please log in and authorize Wrangler in the browser window.${NC}"
npx wrangler login

# Step 2: Compile the production bundle
echo -e "${BLUE}[Step 2/3] Compiling optimized React bundle...${NC}"
cd web-app
npm run build
cd ..

# Step 3: Deploy to Cloudflare Pages
echo -e "${BLUE}[Step 3/3] Deploying to Cloudflare Pages...${NC}"
cd web-app
npx wrangler pages deploy ./dist --project-name sourcery
cd ..

echo -e "${CYAN}=================================================="
echo -e "🎉 DEPLOYMENT REQUEST COMPLETE!"
echo -e "🌐 Visit the live URL output above to try it live!"
echo -e "==================================================${NC}"
