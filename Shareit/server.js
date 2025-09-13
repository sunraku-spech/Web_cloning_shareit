const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join', (sessionId) => {
    console.log(socket.id, 'join', sessionId);
    socket.join(sessionId);
    // notify others in the room that a peer joined
    socket.to(sessionId).emit('peer-joined', { socketId: socket.id });
  });

  // Generic signaling relay within a session room
  socket.on('signal', ({ sessionId, signal }) => {
    socket.to(sessionId).emit('signal', { from: socket.id, signal });
  });

  // Fallback relay for chunks if DataChannel unavailable
  socket.on('relay-chunk', ({ sessionId, payload }) => {
    socket.to(sessionId).emit('relay-chunk', payload);
  });

  // Resume request/response (simple)
  socket.on('resume-request', ({ sessionId }) => {
    socket.to(sessionId).emit('resume-request', { from: socket.id });
  });

  socket.on('resume-state', ({ sessionId, state }) => {
    socket.to(sessionId).emit('resume-state', state);
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port', PORT));
