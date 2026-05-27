// web-app/functions/stream.js

// Global in-memory map of active rooms.
// Since the Mac and the browser will be in the same location, they will hit the
// same Cloudflare edge data center and V8 isolate, allowing this stateless relay to work beautifully.
const activeRooms = new Map();

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const room = url.searchParams.get('room') || 'default';
  const role = url.searchParams.get('role'); // 'host' or 'client'

  if (!role || (role !== 'host' && role !== 'client')) {
    return new Response('Missing or invalid role parameter (must be "host" or "client")', { status: 400 });
  }

  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  // Set up the WebSocket pair
  const [clientSocket, serverSocket] = Object.values(new WebSocketPair());

  // Accept the server-side WebSocket
  serverSocket.accept();

  if (role === 'host') {
    handleHostConnection(serverSocket, room);
  } else {
    handleClientConnection(serverSocket, room);
  }

  // Return the client-side socket to upgrade the connection
  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
  });
}

function handleHostConnection(ws, room) {
  // Initialize or get the room
  let roomData = activeRooms.get(room);
  if (!roomData) {
    roomData = { host: null, clients: new Set() };
    activeRooms.set(room, roomData);
  }

  // If a host is already connected, close the previous one
  if (roomData.host) {
    try {
      roomData.host.close(1001, 'Another host connected');
    } catch (e) {}
  }

  roomData.host = ws;
  console.log(`Host connected to room: ${room}`);

  // Forward all binary and text messages from host to all clients
  ws.addEventListener('message', (event) => {
    const data = event.data;
    
    // Relay to all clients in the room
    const currentRoom = activeRooms.get(room);
    if (currentRoom && currentRoom.clients.size > 0) {
      for (const client of currentRoom.clients) {
        if (client.readyState === 1) { // WebSocket.OPEN === 1
          try {
            client.send(data);
          } catch (err) {
            console.error('Failed to send audio chunk to client:', err);
          }
        }
      }
    }
  });

  // Clean up on host disconnect
  const cleanup = () => {
    console.log(`Host disconnected from room: ${room}`);
    const currentRoom = activeRooms.get(room);
    if (currentRoom) {
      if (currentRoom.host === ws) {
        currentRoom.host = null;
        // Notify all clients that the host has stopped streaming
        for (const client of currentRoom.clients) {
          try {
            client.send(JSON.stringify({ type: 'status', event: 'stream_stopped' }));
          } catch (e) {}
        }
      }
      
      // If no clients and no host, delete the room
      if (!currentRoom.host && currentRoom.clients.size === 0) {
        activeRooms.delete(room);
      }
    }
  };

  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);
}

function handleClientConnection(ws, room) {
  let roomData = activeRooms.get(room);
  if (!roomData) {
    roomData = { host: null, clients: new Set() };
    activeRooms.set(room, roomData);
  }

  // Register client
  roomData.clients.add(ws);
  console.log(`Client connected to room: ${room}. Total clients: ${roomData.clients.size}`);

  // Send initial connection success message
  try {
    ws.send(JSON.stringify({
      type: 'status',
      event: 'connected',
      hostActive: roomData.host !== null,
    }));
  } catch (e) {}

  // Handle client messages (e.g. ping/pong, configuration)
  ws.addEventListener('message', (event) => {
    // If we ever need control messages from client to host
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      // Ignore binary or malformed JSON
    }
  });

  // Clean up on client disconnect
  const cleanup = () => {
    console.log(`Client disconnected from room: ${room}`);
    const currentRoom = activeRooms.get(room);
    if (currentRoom) {
      currentRoom.clients.delete(ws);
      if (!currentRoom.host && currentRoom.clients.size === 0) {
        activeRooms.delete(room);
      }
    }
  };

  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);
}
