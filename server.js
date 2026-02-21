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
  maxHttpBufferSize: 50 * 1024 * 1024
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
  cb(null, allowed.includes(ext));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// ── Room link: /room/:roomName serves the same index.html ──
app.get('/room/:roomName', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload endpoint
app.post('/upload', upload.single('music'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded or invalid file type' });
  res.json({
    success: true,
    file: {
      id: uuidv4(),
      originalName: req.file.originalname,
      filename: req.file.filename,
      url: `/uploads/${req.file.filename}`,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    }
  });
});

// List uploaded files
app.get('/api/files', (req, res) => {
  const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.webm'];
  const files = fs.readdirSync(uploadsDir)
    .filter(f => allowed.includes(path.extname(f).toLowerCase()))
    .map(f => {
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

// List active rooms
app.get('/api/rooms', (req, res) => {
  const list = [];
  rooms.forEach((room, id) => {
    list.push({
      id,
      userCount: room.users.size,
      nowPlaying: room.state.name || null,
      type: room.state.type
    });
  });
  res.json(list);
});

// ══════════════════════════════════════════════
// SOCKET.IO — Room, Sync & Playlist Engine
// ══════════════════════════════════════════════

const rooms = new Map();

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
      queue: [],       // playlist queue: [{ id, type, src, name, addedBy }]
      queueIndex: -1,  // current track index in queue
      state: {
        type: null,
        src: null,
        name: null,
        playing: false,
        currentTime: 0,
        playStartedAt: null,
        pausedAt: 0
      }
    });
  }
  return rooms.get(roomId);
}

function computeCurrentTime(state) {
  if (!state.playing || !state.playStartedAt) return state.pausedAt || 0;
  return (Date.now() - state.playStartedAt) / 1000;
}

function userList(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({ id, ...u }));
}

function playTrackFromQueue(roomId, index) {
  const room = rooms.get(roomId);
  if (!room || index < 0 || index >= room.queue.length) return;

  room.queueIndex = index;
  const track = room.queue[index];

  room.state = {
    type: track.type,
    src: track.src,
    name: track.name,
    playing: true,
    currentTime: 0,
    playStartedAt: Date.now(),
    pausedAt: 0
  };

  io.to(roomId).emit('track-changed', {
    ...room.state,
    currentTime: 0,
    serverTime: Date.now(),
    queueIndex: index
  });

  io.to(roomId).emit('queue-updated', { queue: room.queue, queueIndex: room.queueIndex });
}

io.on('connection', (socket) => {
  console.log(`✓ Connected: ${socket.id}`);

  // ── JOIN ────────────────────────────────
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    const room = getRoomState(roomId);
    const isHost = room.users.size === 0;
    room.users.set(socket.id, { name: userName, isHost });
    socket.roomId = roomId;
    socket.userName = userName;

    const st = { ...room.state, currentTime: computeCurrentTime(room.state), serverTime: Date.now() };

    socket.emit('room-joined', {
      roomId, isHost,
      users: userList(room),
      state: st,
      queue: room.queue,
      queueIndex: room.queueIndex
    });

    socket.to(roomId).emit('user-joined', {
      id: socket.id, name: userName, isHost,
      users: userList(room)
    });

    console.log(`  → ${userName} joined "${roomId}" (${isHost ? 'HOST' : 'guest'})`);
  });

  // ── ADD TO QUEUE ───────────────────────
  socket.on('queue-add', ({ type, src, name }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    const track = {
      id: uuidv4().slice(0, 8),
      type,
      src,
      name,
      addedBy: socket.userName
    };
    room.queue.push(track);

    io.to(socket.roomId).emit('queue-updated', { queue: room.queue, queueIndex: room.queueIndex });

    // If nothing is playing, auto-play first track
    if (room.queueIndex === -1 || !room.state.src) {
      playTrackFromQueue(socket.roomId, room.queue.length - 1);
    }
  });

  // ── REMOVE FROM QUEUE ─────────────────
  socket.on('queue-remove', ({ trackId }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    const idx = room.queue.findIndex(t => t.id === trackId);
    if (idx === -1) return;

    room.queue.splice(idx, 1);

    // Adjust current index
    if (idx < room.queueIndex) {
      room.queueIndex--;
    } else if (idx === room.queueIndex) {
      // Current track removed, play next or stop
      if (room.queue.length > 0) {
        const newIdx = Math.min(room.queueIndex, room.queue.length - 1);
        playTrackFromQueue(socket.roomId, newIdx);
      } else {
        room.queueIndex = -1;
        room.state = { type: null, src: null, name: null, playing: false, currentTime: 0, playStartedAt: null, pausedAt: 0 };
        io.to(socket.roomId).emit('track-changed', { ...room.state, serverTime: Date.now() });
      }
    }

    io.to(socket.roomId).emit('queue-updated', { queue: room.queue, queueIndex: room.queueIndex });
  });

  // ── PLAY SPECIFIC QUEUE INDEX ──────────
  socket.on('queue-play', ({ index }) => {
    playTrackFromQueue(socket.roomId, index);
  });

  // ── PLAY FILE (also adds to queue) ─────
  socket.on('play-file', ({ url, name }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    // Check if already in queue
    let idx = room.queue.findIndex(t => t.src === url);
    if (idx === -1) {
      room.queue.push({ id: uuidv4().slice(0, 8), type: 'file', src: url, name, addedBy: socket.userName });
      idx = room.queue.length - 1;
    }

    playTrackFromQueue(socket.roomId, idx);
  });

  // ── PLAY YOUTUBE (also adds to queue) ──
  socket.on('play-youtube', ({ videoId, title }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    let idx = room.queue.findIndex(t => t.src === videoId);
    if (idx === -1) {
      room.queue.push({ id: uuidv4().slice(0, 8), type: 'youtube', src: videoId, name: title || 'YouTube Video', addedBy: socket.userName });
      idx = room.queue.length - 1;
    }

    playTrackFromQueue(socket.roomId, idx);
  });

  // ── NEXT / PREVIOUS ───────────────────
  socket.on('queue-next', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.queue.length === 0) return;
    const next = (room.queueIndex + 1) % room.queue.length;
    playTrackFromQueue(socket.roomId, next);
  });

  socket.on('queue-prev', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.queue.length === 0) return;
    const prev = (room.queueIndex - 1 + room.queue.length) % room.queue.length;
    playTrackFromQueue(socket.roomId, prev);
  });

  // ── TRANSPORT (play/pause/seek) ────────
  socket.on('transport', ({ action, currentTime }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const st = room.state;

    if (action === 'play') {
      st.playing = true;
      st.playStartedAt = Date.now() - (st.pausedAt * 1000);
      st.currentTime = st.pausedAt;
    }

    if (action === 'pause') {
      st.playing = false;
      st.pausedAt = computeCurrentTime(st);
      st.currentTime = st.pausedAt;
      st.playStartedAt = null;
    }

    if (action === 'seek' && currentTime !== undefined) {
      st.pausedAt = currentTime;
      st.currentTime = currentTime;
      if (st.playing) {
        st.playStartedAt = Date.now() - (currentTime * 1000);
      }
    }

    io.to(socket.roomId).emit('sync-state', {
      ...st,
      currentTime: computeCurrentTime(st),
      serverTime: Date.now()
    });
  });

  // ── SYNC REQUEST ───────────────────────
  socket.on('sync-request', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    socket.emit('sync-state', {
      ...room.state,
      currentTime: computeCurrentTime(room.state),
      serverTime: Date.now()
    });
  });

  // ── HEARTBEAT ──────────────────────────
  socket.on('heartbeat', () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.state.playing) return;
    socket.emit('heartbeat-ack', {
      currentTime: computeCurrentTime(room.state),
      serverTime: Date.now()
    });
  });

  // ── TRACK ENDED (auto-next) ────────────
  socket.on('track-ended', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.queue.length === 0) return;
    // Only the first user to report ended triggers next
    const next = room.queueIndex + 1;
    if (next < room.queue.length) {
      playTrackFromQueue(socket.roomId, next);
    } else {
      // End of queue
      room.state.playing = false;
      room.state.pausedAt = 0;
      room.state.playStartedAt = null;
      io.to(socket.roomId).emit('sync-state', { ...room.state, currentTime: 0, serverTime: Date.now() });
    }
  });

  // ── CHAT ────────────────────────────────
  socket.on('chat-message', ({ message }) => {
    io.to(socket.roomId).emit('chat-message', {
      from: socket.userName,
      message,
      time: new Date().toISOString()
    });
  });

  // ── DISCONNECT ──────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.users.delete(socket.id);
      if (room.users.size === 0) {
        rooms.delete(roomId);
        console.log(`  ✗ Room "${roomId}" deleted (empty)`);
      } else {
        if (!Array.from(room.users.values()).some(u => u.isHost)) {
          const first = room.users.entries().next().value;
          if (first) {
            first[1].isHost = true;
            io.to(first[0]).emit('promoted-to-host');
          }
        }
        io.to(roomId).emit('user-left', {
          id: socket.id, name: socket.userName,
          users: userList(room)
        });
      }
    }
    console.log(`✗ Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎵 Multi Music Listener running at http://localhost:${PORT}\n`);
});
