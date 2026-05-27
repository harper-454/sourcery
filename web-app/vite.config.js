import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { WebSocketServer } from 'ws'
import os from 'os'

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function websocketRelayPlugin() {
  return {
    name: 'websocket-relay',
    configureServer(server) {
      if (!server.httpServer) return;
      
      const wss = new WebSocketServer({ noServer: true });
      
      server.httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '', 'http://localhost');
        if (url.pathname === '/stream') {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        }
      });

      const rooms = new Map();

      wss.on('connection', (ws, req) => {
        const url = new URL(req.url || '', 'http://localhost');
        const room = url.searchParams.get('room') || 'default';
        const role = url.searchParams.get('role'); // 'host' or 'client'

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
            try {
              roomData.host.close(1001, 'Another host connected');
            } catch (e) {}
          }
          roomData.host = ws;
          console.log(`[Vite WS] Host connected to room: ${room}`);

          ws.on('message', (message, isBinary) => {
            const currentRoom = rooms.get(room);
            if (currentRoom && currentRoom.clients.size > 0) {
              for (const client of currentRoom.clients) {
                if (client.readyState === 1) { // WebSocket.OPEN === 1
                  try {
                    client.send(message, { binary: isBinary });
                  } catch (err) {
                    console.error('[Vite WS] Failed to relay message to client:', err);
                  }
                }
              }
            }
          });

          const cleanup = () => {
            console.log(`[Vite WS] Host disconnected from room: ${room}`);
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
          console.log(`[Vite WS] Client connected to room: ${room}. Total clients: ${roomData.clients.size}`);

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
              }
            } catch (e) {}
          });

          const cleanup = () => {
            console.log(`[Vite WS] Client disconnected from room: ${room}`);
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
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), websocketRelayPlugin()],
  define: {
    __HOST_IP__: JSON.stringify(getLocalIp()),
  }
})
