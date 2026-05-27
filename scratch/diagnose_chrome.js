// scratch/diagnose_chrome.js
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// 1. Get the list of pages or open a new one
function getPage() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          const page = list.find(t => t.type === 'page');
          if (!page) reject(new Error('No page target found'));
          resolve(page);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  // Parse sourcery.log to get the active tunnel hostname and roomCode
  const logPath = '/Users/alexharper/.gemini/antigravity/scratch/mic-streamer/sourcery.log';
  let hostname = '';
  let roomCode = 'demo-room';
  
  if (fs.existsSync(logPath)) {
    const logContent = fs.readFileSync(logPath, 'utf8');
    const lines = logContent.split('\n');
    
    // Find last active tunnel log entry
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('Tunnel active:')) {
        const parts = lines[i].split('Tunnel active:');
        if (parts.length > 1) {
          hostname = parts[1].trim();
          break;
        }
      }
    }
    
    // Find last room code log entry
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('Session room:')) {
        const parts = lines[i].split('Session room:');
        if (parts.length > 1) {
          roomCode = parts[1].trim();
          break;
        }
      }
    }
  }
  
  if (!hostname) {
    console.error('No active tunnel hostname found in sourcery.log!');
    process.exit(1);
  }
  
  console.log(`Parsed Active Tunnel: ${hostname}`);
  console.log(`Parsed Room Code: ${roomCode}`);

  const page = await getPage();
  console.log('Opened debug page:', page.id);
  console.log('CDP WS Endpoint:', page.webSocketDebuggerUrl);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  ws.on('open', async () => {
    console.log('Connected to CDP!');

    // Listen to console events - registered FIRST to capture method response events!
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Runtime.consoleAPICalled') {
        const type = msg.params.type;
        const text = msg.params.args.map(arg => arg.value !== undefined ? arg.value : JSON.stringify(arg)).join(' ');
        console.log(`[Browser Console ${type}]:`, text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.error('[Browser Exception]:', msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception.description);
      } else if (msg.method === 'Network.webSocketCreated') {
        console.log('[Browser Network] WebSocket Created:', msg.params.url);
      } else if (msg.method === 'Network.webSocketFrameReceived') {
        // Only log text frames or headers to prevent binary clutter
        const payload = msg.params.response.payloadData;
        if (payload && !payload.startsWith('//') && payload.length < 500) {
          console.log('[Browser Network] WS Frame Received:', payload);
        }
      } else if (msg.method === 'Network.webSocketClosed') {
        console.log('[Browser Network] WS Closed');
      } else if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.result);
      }
    });
    
    // Enable domains
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    console.log('Page/Runtime/Network enabled!');

    // Navigate to the direct compiled link
    const targetUrl = `https://sourcery-dbl.pages.dev/?relay=${hostname}&room=${roomCode}`;
    console.log('Navigating to:', targetUrl);
    await send('Page.navigate', { url: targetUrl });

    // Wait 6 seconds for page load and redirections
    console.log('Waiting 6 seconds for page to load and redirect...');
    await new Promise(r => setTimeout(r, 6000));

    // Get current URL to verify redirection
    const evalUrl = await send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true });
    console.log('Current Browser URL:', evalUrl.result.value);

    // Take screenshot or inspect DOM structure
    const checkOverlay = await send('Runtime.evaluate', { 
      expression: '!!document.querySelector(".tap-overlay")', 
      returnByValue: true 
    });
    console.log('Has Gesture Overlay:', checkOverlay.result.value);

    if (checkOverlay.result.value) {
      console.log('Clicking the gesture overlay to start stream...');
      await send('Runtime.evaluate', { 
        expression: 'document.querySelector(".tap-overlay").click()', 
        returnByValue: true 
      });
    } else {
      console.log('No overlay found, trying to click standard connect button...');
      await send('Runtime.evaluate', { 
        expression: 'const btn = document.querySelector(".btn-primary"); if (btn) btn.click();', 
        returnByValue: true 
      });
    }

    // Wait 6 seconds for WebSocket connection and streaming to start
    console.log('Waiting 6 seconds to observe WebSocket behavior and playback...');
    await new Promise(r => setTimeout(r, 6000));

    // Inspect final connection state and body contents
    const inspectDom = await send('Runtime.evaluate', {
      expression: `
        (() => {
          const overlay = !!document.querySelector(".tap-overlay");
          const playBtn = document.querySelector(".btn-primary")?.innerText || "";
          const stopBtn = document.querySelector(".btn-success")?.innerText || "";
          const diagList = Array.from(document.querySelectorAll(".stat-item")).map(el => el.innerText).join(" | ");
          return JSON.stringify({ overlay, playBtn, stopBtn, diagList });
        })()
      `,
      returnByValue: true
    });
    
    console.log('DOM Inspection Result:', JSON.parse(inspectDom.result.value));

    console.log('Diagnostics complete, shutting down...');
    process.exit(0);
  });
}

run().catch(console.error);
