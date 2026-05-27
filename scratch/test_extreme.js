// scratch/test_extreme.js
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

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
  const logPath = '/Users/alexharper/.gemini/antigravity/scratch/mic-streamer/sourcery.log';
  let hostname = '';
  let roomCode = '';
  
  if (fs.existsSync(logPath)) {
    const logContent = fs.readFileSync(logPath, 'utf8');
    const lines = logContent.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('Tunnel active:')) {
        hostname = lines[i].split('Tunnel active:')[1].trim();
        break;
      }
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('Session room:')) {
        roomCode = lines[i].split('Session room:')[1].trim();
        break;
      }
    }
  }
  
  if (!hostname || !roomCode) {
    console.error('Active tunnel details not found in sourcery.log!');
    process.exit(1);
  }
  
  console.log(`Testing Tunnel: ${hostname}`);
  console.log(`Testing Room Code: ${roomCode}`);

  const page = await getPage();
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
    console.log('Connected to CDP debugger.');

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map(arg => arg.value !== undefined ? arg.value : JSON.stringify(arg)).join(' ');
        console.log(`[Browser Console]:`, text);
      } else if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.result);
      }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    const targetUrl = `https://sourcery-dbl.pages.dev/?relay=${hostname}&room=${roomCode}`;
    console.log('Navigating to:', targetUrl);
    await send('Page.navigate', { url: targetUrl });
    await new Promise(r => setTimeout(r, 5000));

    // Click gesture overlay
    console.log('Clicking gesture overlay to start Web Audio...');
    await send('Runtime.evaluate', { 
      expression: `
        const overlay = document.querySelector(".tap-overlay");
        if (overlay) overlay.click();
        else {
          const btn = document.querySelector(".btn-primary");
          if (btn) btn.click();
        }
      `
    });
    await new Promise(r => setTimeout(r, 3000));

    // Disable autopilot to lock manual vocal profiles
    console.log('Disabling AI Autopilot for manual DSP testing...');
    await send('Runtime.evaluate', {
      expression: `
        const cb = document.querySelector("input[type='checkbox']");
        if (cb && cb.checked) cb.click(); // disable autopilot
      `
    });

    const profiles = ['STUDIO', 'WHISPER', 'EXTREME', 'SECURITY'];
    for (const profile of profiles) {
      console.log(`\n=========================================`);
      console.log(`ROUND: Testing Vocal Profile [${profile}]`);
      console.log(`=========================================`);

      // Switch vocal profile selection in dropdown or button click
      await send('Runtime.evaluate', {
        expression: `
          const selects = Array.from(document.querySelectorAll("select"));
          // Look for profile select or click matching profile buttons
          const profileBtn = Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("${profile}") || b.innerText.toLowerCase().includes("${profile.toLowerCase()}"));
          if (profileBtn) {
            profileBtn.click();
          } else {
            const selectEl = document.querySelector("select");
            if (selectEl) {
              selectEl.value = "${profile}";
              selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        `
      });

      await new Promise(r => setTimeout(r, 4000)); // wait 4 seconds to accumulate packets

      const telemetry = await send('Runtime.evaluate', {
        expression: `
          (() => {
            const items = Array.from(document.querySelectorAll(".stat-item")).map(el => el.innerText);
            const logs = Array.from(document.querySelectorAll(".diagnostics p, .log-line")).map(el => el.innerText).slice(-3);
            return JSON.stringify({ items, logs });
          })()
        `,
        returnByValue: true
      });

      const res = JSON.parse(telemetry.result.value);
      console.log(`Telemetry items:`, res.items.join(' | '));
      console.log(`Recent logs:`, res.logs);
    }

    console.log('\nAll test rounds complete. Exiting.');
    process.exit(0);
  });
}

run().catch(console.error);
