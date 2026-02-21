const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024 // 50MB
});

const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.webm'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only audio files are allowed (.mp3, .wav, .ogg, .m4a, .flac, .aac, .webm)'));
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// Upload endpoint
app.post('/upload', upload.single('music'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded or invalid file type' });
  }
  const fileInfo = {
    id: uuidv4(),
    originalName: req.file.originalname,
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    uploadedAt: new Date().toISOString()
  };
  res.json({ success: true, file: fileInfo });
});

// List uploaded files
app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(uploadsDir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.webm'].includes(ext);
  }).map(f => {
    const stat = fs.statSync(path.join(uploadsDir, f));
    return {
      filename: f,
      originalName: f.replace(/^\d+-[a-f0-9]+-/, ''),
      url: `/uploads/${f}`,
      size: stat.size,
      uploadedAt: stat.mtime.toISOString()
    };
  });
  res.json(files);
});

// ── Socket.IO ──────────────────────────────────────────────
const rooms = new Map(); // roomId -> { users: Map<socketId, {name, isHost}>, state: {...} }

io.on('connection', (socket) => {
  console.log(`✓ Connected: ${socket.id}`);

  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        users: new Map(),
        state: {
          type: null, // 'file' or 'youtube'
          src: null,
          playing: false,
          currentTime: 0,
          lastUpdate: Date.now()
        }
      });
    }

    const room = rooms.get(roomId);
    const isHost = room.users.size === 0;
    room.users.set(socket.id, { name: userName, isHost });

    socket.roomId = roomId;
    socket.userName = userName;

    // Send current room state to the new user
    socket.emit('room-joined', {
      roomId,
      isHost,
      users: Array.from(room.users.entries()).map(([id, u]) => ({ id, ...u })),
      state: room.state
    });

    // Notify others
    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      name: userName,
      isHost,
      users: Array.from(room.users.entries()).map(([id, u]) => ({ id, ...u }))
    });

    console.log(`  → ${userName} joined room "${roomId}" (${isHost ? 'HOST' : 'guest'})`);
  });

  // Play a local file
  socket.on('play-file', ({ url, name }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.state = { type: 'file', src: url, name, playing: true, currentTime: 0, lastUpdate: Date.now() };
    io.to(socket.roomId).emit('track-changed', room.state);
  });

  // Play a YouTube URL
  socket.on('play-youtube', ({ videoId, title }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.state = { type: 'youtube', src: videoId, name: title || 'YouTube Video', playing: true, currentTime: 0, lastUpdate: Date.now() };
    io.to(socket.roomId).emit('track-changed', room.state);
  });

  // Transport controls
  socket.on('transport', ({ action, currentTime }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    if (action === 'play') room.state.playing = true;
    if (action === 'pause') room.state.playing = false;
    if (currentTime !== undefined) room.state.currentTime = currentTime;
    room.state.lastUpdate = Date.now();

    socket.to(socket.roomId).emit('transport', { action, currentTime, from: socket.userName });
  });

  // Sync request from late joiner
  socket.on('sync-request', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    socket.emit('sync-state', room.state);
  });

  // Chat message
  socket.on('chat-message', ({ message }) => {
    io.to(socket.roomId).emit('chat-message', {
      from: socket.userName,
      message,
      time: new Date().toISOString()
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.users.delete(socket.id);

      if (room.users.size === 0) {
        rooms.delete(roomId);
        console.log(`  ✗ Room "${roomId}" deleted (empty)`);
      } else {
        // If host left, assign new host
        const firstUser = room.users.entries().next().value;
        if (firstUser && !Array.from(room.users.values()).some(u => u.isHost)) {
          firstUser[1].isHost = true;
          io.to(firstUser[0]).emit('promoted-to-host');
        }
        io.to(roomId).emit('user-left', {
          id: socket.id,
          name: socket.userName,
          users: Array.from(room.users.entries()).map(([id, u]) => ({ id, ...u }))
        });
      }
    }
    console.log(`✗ Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎵 Multi Music Listener running at http://localhost:${PORT}\n`);
});
