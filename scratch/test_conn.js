// test_conn.js
const WebSocket = require('ws');

const room = 'sourcery-test';
const socketUrl = `ws://127.0.0.1:5173/stream?room=${room}&role=client`;

console.log('Connecting to:', socketUrl);
const ws = new WebSocket(socketUrl);

ws.on('open', () => {
  console.log('SUCCESS: Connected successfully!');
  ws.close();
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('FAILED: Connection error:', err.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason.toString());
});
