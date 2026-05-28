// server.js
// Standalone Lightweight WebSocket Relay for Sourcery (Zero-Vite Dependency)

const { WebSocketServer } = require('ws');
const http = require('http');
const url = require('url');

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map();

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname === '/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const room = parsedUrl.query.room || 'default';
  const role = parsedUrl.query.role; // 'host' or 'client'

  if (!role || (role !== 'host' && role !== 'client')) {
    ws.close(4000, 'Invalid role');
    return;
  }

  let roomData = rooms.get(room);
  if (!roomData) {
    roomData = { host: null, clients: new Set() };
    rooms.set(room, roomData);
  }

  if (role === 'host') {
    if (roomData.host) {
      try { roomData.host.close(1001, 'Another host connected'); } catch (e) {}
    }
    roomData.host = ws;
    console.log(`[Standalone WS] Host connected to room: ${room}`);

    ws.on('message', (message, isBinary) => {
      const currentRoom = rooms.get(room);
      if (currentRoom && currentRoom.clients.size > 0) {
        for (const client of currentRoom.clients) {
          if (client.readyState === 1) { // WebSocket.OPEN === 1
            try {
              client.send(message, { binary: isBinary });
            } catch (err) {
              console.error('[Standalone WS] Failed to relay to client:', err);
            }
          }
        }
      }
    });

    const cleanup = () => {
      console.log(`[Standalone WS] Host disconnected from room: ${room}`);
      const currentRoom = rooms.get(room);
      if (currentRoom && currentRoom.host === ws) {
        currentRoom.host = null;
        for (const client of currentRoom.clients) {
          try {
            client.send(JSON.stringify({ type: 'status', event: 'stream_stopped' }));
          } catch (e) {}
        }
        if (currentRoom.clients.size === 0) {
          rooms.delete(room);
        }
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);

  } else {
    roomData.clients.add(ws);
    console.log(`[Standalone WS] Client connected to room: ${room}. Total clients: ${roomData.clients.size}`);

    try {
      ws.send(JSON.stringify({
        type: 'status',
        event: 'connected',
        hostActive: roomData.host !== null,
      }));
    } catch (e) {}

    // Notify the host that a client has joined so it can push the native config
    if (roomData.host && roomData.host.readyState === 1) { // WebSocket.OPEN === 1
      try {
        roomData.host.send(JSON.stringify({ type: 'status', event: 'client_connected' }));
      } catch (err) {}
    }

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        } else {
          // Relay messages from client back to the host (e.g. client_connected, heartbeats)
          const currentRoom = rooms.get(room);
          if (currentRoom && currentRoom.host && currentRoom.host.readyState === 1) {
            currentRoom.host.send(message.toString());
          }
        }
      } catch (e) {}
    });

    const cleanup = () => {
      console.log(`[Standalone WS] Client disconnected from room: ${room}`);
      const currentRoom = rooms.get(room);
      if (currentRoom) {
        currentRoom.clients.delete(ws);
        if (!currentRoom.host && currentRoom.clients.size === 0) {
          rooms.delete(room);
        }
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }
});

// Run standalone server on port 5173
server.listen(5173, '0.0.0.0', () => {
  console.log('[Standalone WS] Relay active on port 5173');
});
