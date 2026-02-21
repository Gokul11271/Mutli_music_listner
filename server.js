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

// ══════════════════════════════════════════════
// SOCKET.IO — Room & Sync Engine
// ══════════════════════════════════════════════

// Room state is the single source of truth.
// When music plays, we record the server timestamp of when
// playback "would have started from 0" (playStartedAt).
// This way any user can compute: currentTime = (now - playStartedAt) / 1000
// and seek to the correct position immediately.

const rooms = new Map();

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
      state: {
        type: null,       // 'file' or 'youtube'
        src: null,
        name: null,
        playing: false,
        currentTime: 0,
        // Server timestamp (ms) representing when the track
        // would have been at 0:00 if it played continuously.
        playStartedAt: null,
        pausedAt: 0        // the currentTime when paused
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

    // Send authoritative state with computed time
    const st = { ...room.state, currentTime: computeCurrentTime(room.state), serverTime: Date.now() };

    socket.emit('room-joined', {
      roomId, isHost,
      users: userList(room),
      state: st
    });

    socket.to(roomId).emit('user-joined', {
      id: socket.id, name: userName, isHost,
      users: userList(room)
    });

    console.log(`  → ${userName} joined "${roomId}" (${isHost ? 'HOST' : 'guest'})`);
  });

  // ── PLAY FILE ──────────────────────────
  socket.on('play-file', ({ url, name }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.state = {
      type: 'file', src: url, name,
      playing: true,
      currentTime: 0,
      playStartedAt: Date.now(),
      pausedAt: 0
    };
    io.to(socket.roomId).emit('track-changed', {
      ...room.state,
      currentTime: 0,
      serverTime: Date.now()
    });
  });

  // ── PLAY YOUTUBE ───────────────────────
  socket.on('play-youtube', ({ videoId, title }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.state = {
      type: 'youtube', src: videoId, name: title || 'YouTube Video',
      playing: true,
      currentTime: 0,
      playStartedAt: Date.now(),
      pausedAt: 0
    };
    io.to(socket.roomId).emit('track-changed', {
      ...room.state,
      currentTime: 0,
      serverTime: Date.now()
    });
  });

  // ── TRANSPORT (play/pause/seek) ────────
  socket.on('transport', ({ action, currentTime }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const st = room.state;

    if (action === 'play') {
      // Resume from wherever we paused
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

    // Broadcast full state so every client can hard-sync
    io.to(socket.roomId).emit('sync-state', {
      ...st,
      currentTime: computeCurrentTime(st),
      serverTime: Date.now()
    });
  });

  // ── SYNC REQUEST (late joiner / periodic) ──
  socket.on('sync-request', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    socket.emit('sync-state', {
      ...room.state,
      currentTime: computeCurrentTime(room.state),
      serverTime: Date.now()
    });
  });

  // ── HEARTBEAT — server pushes time to all in room ──
  socket.on('heartbeat', () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.state.playing) return;
    socket.emit('heartbeat-ack', {
      currentTime: computeCurrentTime(room.state),
      serverTime: Date.now()
    });
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
