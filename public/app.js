/* ═══════════════════════════════════════════
   Multi Music Listener — Client Application
   ═══════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── DOM References ───────────────────
  const joinScreen = document.getElementById('join-screen');
  const appScreen = document.getElementById('app-screen');
  const roomInput = document.getElementById('room-input');
  const nameInput = document.getElementById('name-input');
  const joinBtn = document.getElementById('join-btn');
  const roomNameDisplay = document.getElementById('room-name-display');
  const userCountEl = document.getElementById('user-count');
  const leaveBtn = document.getElementById('leave-btn');

  // YouTube
  const ytUrlInput = document.getElementById('yt-url-input');
  const ytPlayBtn = document.getElementById('yt-play-btn');
  const ytContainer = document.getElementById('yt-container');

  // Upload
  const uploadArea = document.getElementById('upload-area');
  const fileInput = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');
  const uploadProgress = document.getElementById('upload-progress');
  const progressFill = document.getElementById('progress-fill');
  const uploadStatus = document.getElementById('upload-status');

  // File list
  const fileListEl = document.getElementById('file-list');

  // Player
  const audioPlayer = document.getElementById('audio-player');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const npTitle = document.getElementById('np-title');
  const npSource = document.getElementById('np-source');
  const npVisualizer = document.getElementById('np-visualizer');
  const seekBar = document.getElementById('seek-bar');
  const seekFill = document.getElementById('seek-fill');
  const seekThumb = document.getElementById('seek-thumb');
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');
  const volumeSlider = document.getElementById('volume-slider');

  // Users & Chat
  const userListEl = document.getElementById('user-list');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');

  // ─── State ────────────────────────────
  let socket = null;
  let currentRoom = null;
  let userName = null;
  let isHost = false;
  let musicFiles = [];
  let currentFileIndex = -1;
  let currentType = null; // 'file' or 'youtube'
  let ytPlayer = null;
  let ytReady = false;
  let isSeeking = false;
  let ignoreTransport = false; // prevent echo

  // ─── Utility ──────────────────────────
  function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function extractYouTubeId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  const avatarColors = [
    '#a855f7', '#06b6d4', '#f43f5e', '#10b981', '#f59e0b',
    '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444'
  ];

  function getAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return avatarColors[Math.abs(hash) % avatarColors.length];
  }

  // ─── Join Room ────────────────────────
  joinBtn.addEventListener('click', joinRoom);
  roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

  function joinRoom() {
    const room = roomInput.value.trim();
    const name = nameInput.value.trim();
    if (!room || !name) {
      alert('Please enter both a room name and your name.');
      return;
    }

    currentRoom = room;
    userName = name;

    socket = io();

    socket.on('connect', () => {
      socket.emit('join-room', { roomId: room, userName: name });
    });

    socket.on('room-joined', handleRoomJoined);
    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('promoted-to-host', () => {
      isHost = true;
      addSystemChat('You are now the host!');
    });
    socket.on('track-changed', handleTrackChanged);
    socket.on('transport', handleTransport);
    socket.on('sync-state', handleSyncState);
    socket.on('chat-message', handleChatMessage);

    joinScreen.classList.remove('active');
    appScreen.classList.add('active');
    roomNameDisplay.textContent = room;

    loadFileList();
  }

  leaveBtn.addEventListener('click', () => {
    if (socket) socket.disconnect();
    appScreen.classList.remove('active');
    joinScreen.classList.add('active');
    audioPlayer.pause();
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    ytContainer.classList.add('hidden');
    resetNowPlaying();
  });

  // ─── Room Events ──────────────────────
  function handleRoomJoined(data) {
    isHost = data.isHost;
    updateUserList(data.users);
    if (data.state && data.state.src) {
      handleTrackChanged(data.state);
    }
    addSystemChat(`You joined room "${data.roomId}"${data.isHost ? ' as host' : ''}`);
  }

  function handleUserJoined(data) {
    updateUserList(data.users);
    addSystemChat(`${data.name} joined the room`);
  }

  function handleUserLeft(data) {
    updateUserList(data.users);
    addSystemChat(`${data.name} left the room`);
  }

  function updateUserList(users) {
    userCountEl.textContent = users.length;
    userListEl.innerHTML = '';
    users.forEach(u => {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="user-avatar" style="background:${getAvatarColor(u.name)}">${u.name[0].toUpperCase()}</div>
        <span class="user-name">${u.name}</span>
        ${u.isHost ? '<span class="user-badge">Host</span>' : ''}
      `;
      userListEl.appendChild(li);
    });
  }

  // ─── Track Changed ────────────────────
  function handleTrackChanged(state) {
    currentType = state.type;

    if (state.type === 'file') {
      // Stop YouTube if playing
      if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
      ytContainer.classList.add('hidden');

      audioPlayer.src = state.src;
      npTitle.textContent = state.name || 'Uploaded Track';
      npSource.textContent = 'Local File';

      if (state.playing) {
        audioPlayer.play().catch(() => {});
        setPlayingUI(true);
      }

      // Highlight in file list
      highlightFile(state.src);

    } else if (state.type === 'youtube') {
      audioPlayer.pause();
      audioPlayer.src = '';

      npTitle.textContent = state.name || 'YouTube Video';
      npSource.textContent = 'YouTube';

      ytContainer.classList.remove('hidden');
      loadYouTubeVideo(state.src, state.playing, state.currentTime || 0);
      setPlayingUI(state.playing);
    }
  }

  function handleTransport({ action, currentTime }) {
    ignoreTransport = true;

    if (currentType === 'file') {
      if (action === 'play') { audioPlayer.play().catch(() => {}); setPlayingUI(true); }
      if (action === 'pause') { audioPlayer.pause(); setPlayingUI(false); }
      if (action === 'seek' && currentTime !== undefined) audioPlayer.currentTime = currentTime;
    } else if (currentType === 'youtube' && ytPlayer && ytReady) {
      if (action === 'play') { ytPlayer.playVideo(); setPlayingUI(true); }
      if (action === 'pause') { ytPlayer.pauseVideo(); setPlayingUI(false); }
      if (action === 'seek' && currentTime !== undefined) ytPlayer.seekTo(currentTime, true);
    }

    setTimeout(() => { ignoreTransport = false; }, 300);
  }

  function handleSyncState(state) {
    if (state && state.src) {
      handleTrackChanged(state);
    }
  }

  // ─── Player Controls ─────────────────
  playPauseBtn.addEventListener('click', () => {
    if (currentType === 'file') {
      if (audioPlayer.paused) {
        audioPlayer.play().catch(() => {});
        socket.emit('transport', { action: 'play' });
        setPlayingUI(true);
      } else {
        audioPlayer.pause();
        socket.emit('transport', { action: 'pause' });
        setPlayingUI(false);
      }
    } else if (currentType === 'youtube' && ytPlayer && ytReady) {
      const state = ytPlayer.getPlayerState();
      if (state === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
        socket.emit('transport', { action: 'pause' });
        setPlayingUI(false);
      } else {
        ytPlayer.playVideo();
        socket.emit('transport', { action: 'play' });
        setPlayingUI(true);
      }
    }
  });

  prevBtn.addEventListener('click', () => {
    if (currentType === 'file' && musicFiles.length > 0) {
      currentFileIndex = (currentFileIndex - 1 + musicFiles.length) % musicFiles.length;
      const file = musicFiles[currentFileIndex];
      socket.emit('play-file', { url: file.url, name: file.originalName || file.filename });
    }
  });

  nextBtn.addEventListener('click', () => {
    if (currentType === 'file' && musicFiles.length > 0) {
      currentFileIndex = (currentFileIndex + 1) % musicFiles.length;
      const file = musicFiles[currentFileIndex];
      socket.emit('play-file', { url: file.url, name: file.originalName || file.filename });
    }
  });

  function setPlayingUI(playing) {
    playPauseBtn.textContent = playing ? '⏸' : '▶';
    if (playing) {
      npVisualizer.classList.add('playing');
    } else {
      npVisualizer.classList.remove('playing');
    }
  }

  function resetNowPlaying() {
    npTitle.textContent = 'Nothing playing';
    npSource.textContent = '—';
    setPlayingUI(false);
    seekFill.style.width = '0%';
    seekThumb.style.left = '0%';
    timeCurrent.textContent = '0:00';
    timeTotal.textContent = '0:00';
  }

  // ─── Audio Progress ───────────────────
  audioPlayer.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100 || 0;
    seekFill.style.width = pct + '%';
    seekThumb.style.left = pct + '%';
    timeCurrent.textContent = formatTime(audioPlayer.currentTime);
    timeTotal.textContent = formatTime(audioPlayer.duration);
  });

  audioPlayer.addEventListener('ended', () => {
    // Auto play next
    if (musicFiles.length > 1) {
      currentFileIndex = (currentFileIndex + 1) % musicFiles.length;
      const file = musicFiles[currentFileIndex];
      socket.emit('play-file', { url: file.url, name: file.originalName || file.filename });
    } else {
      setPlayingUI(false);
    }
  });

  // Seek bar interaction
  seekBar.addEventListener('mousedown', startSeek);
  seekBar.addEventListener('touchstart', startSeek, { passive: true });

  function startSeek(e) {
    isSeeking = true;
    updateSeek(e);
    document.addEventListener('mousemove', updateSeek);
    document.addEventListener('mouseup', endSeek);
    document.addEventListener('touchmove', updateSeek, { passive: true });
    document.addEventListener('touchend', endSeek);
  }

  function updateSeek(e) {
    const rect = seekBar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    seekFill.style.width = pct + '%';
    seekThumb.style.left = pct + '%';
  }

  function endSeek(e) {
    isSeeking = false;
    document.removeEventListener('mousemove', updateSeek);
    document.removeEventListener('mouseup', endSeek);
    document.removeEventListener('touchmove', updateSeek);
    document.removeEventListener('touchend', endSeek);

    const rect = seekBar.getBoundingClientRect();
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    let pct = ((clientX - rect.left) / rect.width);
    pct = Math.max(0, Math.min(1, pct));

    if (currentType === 'file' && audioPlayer.duration) {
      const t = pct * audioPlayer.duration;
      audioPlayer.currentTime = t;
      socket.emit('transport', { action: 'seek', currentTime: t });
    } else if (currentType === 'youtube' && ytPlayer && ytReady) {
      const dur = ytPlayer.getDuration();
      const t = pct * dur;
      ytPlayer.seekTo(t, true);
      socket.emit('transport', { action: 'seek', currentTime: t });
    }
  }

  // Volume
  volumeSlider.addEventListener('input', () => {
    audioPlayer.volume = volumeSlider.value / 100;
    if (ytPlayer && ytReady) ytPlayer.setVolume(volumeSlider.value);
  });
  audioPlayer.volume = 0.8;

  // ─── YouTube ──────────────────────────
  // Load YT IFrame API
  const ytScript = document.createElement('script');
  ytScript.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(ytScript);

  window.onYouTubeIframeAPIReady = function () {
    // API ready, player created on demand
  };

  function loadYouTubeVideo(videoId, autoplay, startTime) {
    if (ytPlayer) {
      ytPlayer.loadVideoById({ videoId, startSeconds: startTime || 0 });
      if (!autoplay) {
        setTimeout(() => { if (ytPlayer.pauseVideo) ytPlayer.pauseVideo(); }, 500);
      }
    } else {
      ytPlayer = new YT.Player('yt-player', {
        videoId: videoId,
        playerVars: {
          autoplay: autoplay ? 1 : 0,
          start: Math.floor(startTime || 0),
          controls: 0,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: () => {
            ytReady = true;
            ytPlayer.setVolume(volumeSlider.value);
            if (!autoplay) ytPlayer.pauseVideo();
            startYTProgress();
          },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) setPlayingUI(true);
            if (e.data === YT.PlayerState.PAUSED) setPlayingUI(false);
            if (e.data === YT.PlayerState.ENDED) setPlayingUI(false);
          }
        }
      });
    }
  }

  let ytProgressInterval = null;
  function startYTProgress() {
    if (ytProgressInterval) clearInterval(ytProgressInterval);
    ytProgressInterval = setInterval(() => {
      if (!ytPlayer || !ytReady || isSeeking) return;
      const cur = ytPlayer.getCurrentTime() || 0;
      const dur = ytPlayer.getDuration() || 1;
      const pct = (cur / dur) * 100;
      seekFill.style.width = pct + '%';
      seekThumb.style.left = pct + '%';
      timeCurrent.textContent = formatTime(cur);
      timeTotal.textContent = formatTime(dur);
    }, 500);
  }

  ytPlayBtn.addEventListener('click', () => {
    const url = ytUrlInput.value.trim();
    if (!url) return;
    const videoId = extractYouTubeId(url);
    if (!videoId) {
      alert('Invalid YouTube URL');
      return;
    }
    socket.emit('play-youtube', { videoId, title: 'YouTube Video' });
    ytUrlInput.value = '';
  });

  ytUrlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') ytPlayBtn.click();
  });

  // ─── File Upload ──────────────────────
  browseBtn.addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.click();
  });

  uploadArea.addEventListener('click', (e) => {
    if (e.target !== browseBtn) fileInput.click();
  });

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      uploadFile(fileInput.files[0]);
      fileInput.value = '';
    }
  });

  function uploadFile(file) {
    const formData = new FormData();
    formData.append('music', file);

    uploadProgress.classList.remove('hidden');
    progressFill.style.width = '0%';
    uploadStatus.textContent = `Uploading ${file.name}…`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 100;
        progressFill.style.width = pct + '%';
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        const resp = JSON.parse(xhr.responseText);
        uploadStatus.textContent = `Uploaded: ${resp.file.originalName}`;
        progressFill.style.width = '100%';
        setTimeout(() => { uploadProgress.classList.add('hidden'); }, 2000);
        loadFileList();
      } else {
        uploadStatus.textContent = 'Upload failed!';
        progressFill.style.width = '0%';
      }
    });

    xhr.addEventListener('error', () => {
      uploadStatus.textContent = 'Upload error!';
    });

    xhr.send(formData);
  }

  // ─── File List ────────────────────────
  function loadFileList() {
    fetch('/api/files')
      .then(r => r.json())
      .then(files => {
        musicFiles = files;
        renderFileList();
      });
  }

  function renderFileList() {
    fileListEl.innerHTML = '';
    if (musicFiles.length === 0) {
      fileListEl.innerHTML = '<li class="empty-state">No files uploaded yet</li>';
      return;
    }
    musicFiles.forEach((f, i) => {
      const li = document.createElement('li');
      li.className = 'file-item';
      li.dataset.url = f.url;
      li.innerHTML = `
        <div class="file-icon">🎵</div>
        <div class="file-info">
          <div class="file-name">${f.originalName || f.filename}</div>
          <div class="file-size">${formatFileSize(f.size)}</div>
        </div>
        <span class="file-play-icon">▶</span>
      `;
      li.addEventListener('click', () => {
        currentFileIndex = i;
        socket.emit('play-file', { url: f.url, name: f.originalName || f.filename });
      });
      fileListEl.appendChild(li);
    });
  }

  function highlightFile(url) {
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    const match = document.querySelector(`.file-item[data-url="${url}"]`);
    if (match) match.classList.add('active');
    // Update index
    currentFileIndex = musicFiles.findIndex(f => f.url === url);
  }

  // ─── Chat ─────────────────────────────
  chatSendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  function sendChat() {
    const msg = chatInput.value.trim();
    if (!msg || !socket) return;
    socket.emit('chat-message', { message: msg });
    chatInput.value = '';
  }

  function handleChatMessage({ from, message }) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<span class="chat-author">${from}</span><span class="chat-text">${escapeHtml(message)}</span>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addSystemChat(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

})();
