const WebSocket = require('ws');
const ws = new WebSocket('wss://demo.piesocket.com/v3/sourcery-mmc2k7r4?api_key=VCXCEuvhGcBDP7XhiJJUDvR1e1D3eiVjgZ9VRiaV&notify_self=0&room=sourcery-mmc2k7r4&role=host');
ws.on('open', () => {
    console.log('Connected!');
    ws.send(JSON.stringify({ type: 'host_announce', room: 'sourcery-mmc2k7r4' }));
});
ws.on('message', (msg) => console.log('Message:', msg.toString()));
ws.on('error', (err) => console.log('Error:', err));
ws.on('close', (code, reason) => console.log('Closed', code, reason.toString()));
setTimeout(() => ws.close(), 3000);
