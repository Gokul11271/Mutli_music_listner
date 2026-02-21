/* ═══════════════════════════════════════════
   Multi Music Listener — Client Application
   v2: Queue, Keyboard Shortcuts, Room Sharing
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
  const shareBtn = document.getElementById('share-btn');
  const syncIndicator = document.getElementById('sync-indicator');
  const copyToast = document.getElementById('copy-toast');
  const shortcutsTip = document.getElementById('shortcuts-tip');

  const ytUrlInput = document.getElementById('yt-url-input');
  const ytPlayBtn = document.getElementById('yt-play-btn');
  const ytContainer = document.getElementById('yt-container');

  const uploadArea = document.getElementById('upload-area');
  const fileInput = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');
  const uploadProgress = document.getElementById('upload-progress');
  const progressFill = document.getElementById('progress-fill');
  const uploadStatus = document.getElementById('upload-status');
  const fileListEl = document.getElementById('file-list');

  const queueListEl = document.getElementById('queue-list');
  const queueCountEl = document.getElementById('queue-count');

  const audioPlayer = document.getElementById('audio-player');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const npTitle = document.getElementById('np-title');
  const npSource = document.getElementById('np-source');
  const npVisualizer = document.getElementById('np-visualizer');
  const npThumb = document.getElementById('np-thumb');
  const seekBar = document.getElementById('seek-bar');
  const seekFill = document.getElementById('seek-fill');
  const seekThumb = document.getElementById('seek-thumb');
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');
  const volumeSlider = document.getElementById('volume-slider');

  const userListEl = document.getElementById('user-list');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');

  const activeRoomsDiv = document.getElementById('active-rooms');
  const roomsListEl = document.getElementById('rooms-list');

  // ─── State ────────────────────────────
  let socket = null;
  let currentRoom = null;
  let userName = null;
  let isHost = false;
  let musicFiles = [];
  let currentType = null;
  let ytPlayer = null;
  let ytReady = false;
  let isSeeking = false;
  let suppressTransport = false;
  let queue = [];
  let queueIndex = -1;
  let prevVolume = 80;

  const SYNC_TOLERANCE = 0.8;
  const HEARTBEAT_INTERVAL = 3000;
  let heartbeatTimer = null;

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

  function getYouTubeThumbnail(videoId) {
    return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  }

  const avatarColors = [
    '#1db954', '#1ed760', '#f43f5e', '#10b981', '#f59e0b',
    '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444'
  ];

  function getAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return avatarColors[Math.abs(hash) % avatarColors.length];
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Room link auto-fill from URL ─────
  (function checkUrl() {
    const match = window.location.pathname.match(/^\/room\/(.+)$/);
    if (match) {
      roomInput.value = decodeURIComponent(match[1]);
      nameInput.focus();
    }
  })();

  // ─── Load active rooms on join screen ──
  (function loadActiveRooms() {
    fetch('/api/rooms')
      .then(r => r.json())
      .then(rooms => {
        if (rooms.length === 0) { activeRoomsDiv.style.display = 'none'; return; }
        activeRoomsDiv.style.display = 'block';
        roomsListEl.innerHTML = '';
        rooms.forEach(r => {
          const div = document.createElement('div');
          div.className = 'room-card';
          div.innerHTML = `
            <span class="room-card-name">${escapeHtml(r.id)}</span>
            <span class="room-card-info">${r.userCount} listener${r.userCount !== 1 ? 's' : ''}${r.nowPlaying ? ' · ' + escapeHtml(r.nowPlaying) : ''}</span>
          `;
          div.addEventListener('click', () => { roomInput.value = r.id; nameInput.focus(); });
          roomsListEl.appendChild(div);
        });
      })
      .catch(() => {});
  })();

  // ─── Join Room ────────────────────────
  joinBtn.addEventListener('click', joinRoom);
  roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.focus(); });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

  function joinRoom() {
    const room = roomInput.value.trim();
    const name = nameInput.value.trim();
    if (!room || !name) { alert('Please enter both a room name and your name.'); return; }

    currentRoom = room;
    userName = name;

    // Update URL to shareable room link
    window.history.replaceState(null, '', `/room/${encodeURIComponent(room)}`);

    socket = io();

    socket.on('connect', () => { socket.emit('join-room', { roomId: room, userName: name }); });
    socket.on('room-joined', handleRoomJoined);
    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('promoted-to-host', () => { isHost = true; addSystemChat('You are now the host!'); });
    socket.on('track-changed', handleTrackChanged);
    socket.on('sync-state', handleSyncState);
    socket.on('heartbeat-ack', handleHeartbeat);
    socket.on('chat-message', handleChatMessage);
    socket.on('queue-updated', handleQueueUpdated);

    joinScreen.classList.remove('active');
    appScreen.classList.add('active');
    roomNameDisplay.textContent = room;

    loadFileList();
    startHeartbeat();
  }

  leaveBtn.addEventListener('click', () => {
    stopHeartbeat();
    if (socket) socket.disconnect();
    appScreen.classList.remove('active');
    joinScreen.classList.add('active');
    audioPlayer.pause();
    audioPlayer.src = '';
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    ytContainer.classList.add('hidden');
    resetNowPlaying();
    currentType = null;
    queue = [];
    queueIndex = -1;
    window.history.replaceState(null, '', '/');
  });

  // ─── Share Room Link ──────────────────
  shareBtn.addEventListener('click', () => {
    const url = window.location.origin + '/room/' + encodeURIComponent(currentRoom);
    navigator.clipboard.writeText(url).then(() => {
      copyToast.classList.add('show');
      setTimeout(() => copyToast.classList.remove('show'), 2500);
    }).catch(() => {
      prompt('Copy this room link:', url);
    });
  });

  // ─── Heartbeat ────────────────────────
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket && socket.connected) socket.emit('heartbeat');
    }, HEARTBEAT_INTERVAL);
  }
  function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

  function handleHeartbeat({ currentTime }) {
    if (!currentType || isSeeking) return;
    correctDrift(currentTime);
  }

  function correctDrift(serverCurrentTime) {
    if (isSeeking || suppressTransport) return;
    let localTime = 0;
    if (currentType === 'file') localTime = audioPlayer.currentTime || 0;
    else if (currentType === 'youtube' && ytPlayer && ytReady) localTime = ytPlayer.getCurrentTime() || 0;
    else return;

    const drift = Math.abs(localTime - serverCurrentTime);
    if (drift > SYNC_TOLERANCE) {
      suppressTransport = true;
      if (currentType === 'file') audioPlayer.currentTime = serverCurrentTime;
      else if (currentType === 'youtube' && ytPlayer && ytReady) ytPlayer.seekTo(serverCurrentTime, true);
      setTimeout(() => { suppressTransport = false; }, 500);
      showSyncIndicator();
    }
  }

  function showSyncIndicator() {
    syncIndicator.style.display = 'flex';
    clearTimeout(syncIndicator._t);
    syncIndicator._t = setTimeout(() => { syncIndicator.style.display = 'none'; }, 3000);
  }

  // ─── Room Events ──────────────────────
  function handleRoomJoined(data) {
    isHost = data.isHost;
    updateUserList(data.users);
    if (data.queue) { queue = data.queue; queueIndex = data.queueIndex; renderQueue(); }
    if (data.state && data.state.src) handleTrackChanged(data.state);
    addSystemChat(`You joined room "${data.roomId}"${data.isHost ? ' as host' : ''}`);
  }

  function handleUserJoined(data) { updateUserList(data.users); addSystemChat(`${data.name} joined`); }
  function handleUserLeft(data) { updateUserList(data.users); addSystemChat(`${data.name} left`); }

  function updateUserList(users) {
    userCountEl.textContent = users.length;
    userListEl.innerHTML = '';
    users.forEach(u => {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="user-avatar" style="background:${getAvatarColor(u.name)}">${u.name[0].toUpperCase()}</div>
        <span class="user-name">${escapeHtml(u.name)}</span>
        ${u.isHost ? '<span class="user-badge">Host</span>' : ''}
      `;
      userListEl.appendChild(li);
    });
  }

  // ─── Queue ────────────────────────────
  function handleQueueUpdated({ queue: q, queueIndex: qi }) {
    queue = q;
    queueIndex = qi;
    renderQueue();
  }

  function renderQueue() {
    queueCountEl.textContent = queue.length;
    queueListEl.innerHTML = '';
    if (queue.length === 0) {
      queueListEl.innerHTML = '<li class="empty-state">Queue is empty</li>';
      return;
    }
    queue.forEach((track, i) => {
      const li = document.createElement('li');
      li.className = 'queue-item' + (i === queueIndex ? ' active' : '');
      li.innerHTML = `
        <span class="q-num">${i + 1}</span>
        <span class="q-icon">${track.type === 'youtube' ? '▶' : '🎵'}</span>
        <div class="q-info">
          <div class="q-name">${escapeHtml(track.name)}</div>
          <div class="q-added">by ${escapeHtml(track.addedBy)}</div>
        </div>
        <button class="q-remove" data-id="${track.id}" title="Remove">✕</button>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('q-remove')) return;
        socket.emit('queue-play', { index: i });
      });
      li.querySelector('.q-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('queue-remove', { trackId: track.id });
      });
      queueListEl.appendChild(li);
    });
  }

  // ─── Track Changed ────────────────────
  function handleTrackChanged(state) {
    currentType = state.type;
    suppressTransport = true;

    // Update thumbnail
    const existingImg = npThumb.querySelector('img');
    if (existingImg) existingImg.remove();

    if (state.type === 'file') {
      if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
      ytContainer.classList.add('hidden');

      audioPlayer.src = state.src;
      npTitle.textContent = state.name || 'Uploaded Track';
      npSource.textContent = '📁 Local File';

      audioPlayer.addEventListener('canplay', function onCanPlay() {
        audioPlayer.removeEventListener('canplay', onCanPlay);
        audioPlayer.currentTime = state.currentTime || 0;
        if (state.playing) { audioPlayer.play().catch(() => {}); setPlayingUI(true); }
        setTimeout(() => { suppressTransport = false; }, 500);
      });

      highlightFile(state.src);

    } else if (state.type === 'youtube') {
      audioPlayer.pause();
      audioPlayer.src = '';

      npTitle.textContent = state.name || 'YouTube Video';
      npSource.textContent = '▶ YouTube';

      // YouTube thumbnail
      const img = document.createElement('img');
      img.src = getYouTubeThumbnail(state.src);
      img.alt = 'thumbnail';
      npThumb.appendChild(img);

      ytContainer.classList.remove('hidden');
      loadYouTubeVideo(state.src, state.playing, state.currentTime || 0);
      setPlayingUI(state.playing);
      setTimeout(() => { suppressTransport = false; }, 1000);
    }

    if (state.queueIndex !== undefined) {
      queueIndex = state.queueIndex;
      renderQueue();
    }
    showSyncIndicator();
  }

  function handleSyncState(state) {
    if (!state || !state.src) return;
    if (state.src !== getCurrentSrc()) { handleTrackChanged(state); return; }

    suppressTransport = true;
    if (state.playing) {
      if (currentType === 'file' && audioPlayer.paused) audioPlayer.play().catch(() => {});
      else if (currentType === 'youtube' && ytPlayer && ytReady && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) ytPlayer.playVideo();
      setPlayingUI(true);
    } else {
      if (currentType === 'file' && !audioPlayer.paused) audioPlayer.pause();
      else if (currentType === 'youtube' && ytPlayer && ytReady) ytPlayer.pauseVideo();
      setPlayingUI(false);
    }
    correctDrift(state.currentTime);
    setTimeout(() => { suppressTransport = false; }, 500);
  }

  function getCurrentSrc() {
    if (currentType === 'file') return audioPlayer.src ? new URL(audioPlayer.src).pathname : null;
    if (currentType === 'youtube') return ytPlayer ? ytPlayer.getVideoData?.()?.video_id : null;
    return null;
  }

  // ─── Player Controls ─────────────────
  playPauseBtn.addEventListener('click', togglePlayPause);

  function togglePlayPause() {
    if (currentType === 'file') {
      if (audioPlayer.paused) {
        audioPlayer.play().catch(() => {});
        socket.emit('transport', { action: 'play', currentTime: audioPlayer.currentTime });
        setPlayingUI(true);
      } else {
        audioPlayer.pause();
        socket.emit('transport', { action: 'pause', currentTime: audioPlayer.currentTime });
        setPlayingUI(false);
      }
    } else if (currentType === 'youtube' && ytPlayer && ytReady) {
      if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
        socket.emit('transport', { action: 'pause', currentTime: ytPlayer.getCurrentTime() });
        setPlayingUI(false);
      } else {
        ytPlayer.playVideo();
        socket.emit('transport', { action: 'play', currentTime: ytPlayer.getCurrentTime() });
        setPlayingUI(true);
      }
    }
  }

  prevBtn.addEventListener('click', () => { if (socket) socket.emit('queue-prev'); });
  nextBtn.addEventListener('click', () => { if (socket) socket.emit('queue-next'); });

  function setPlayingUI(playing) {
    playPauseBtn.textContent = playing ? '⏸' : '▶';
    npVisualizer.classList.toggle('playing', playing);
  }

  function resetNowPlaying() {
    npTitle.textContent = 'Nothing playing';
    npSource.textContent = '—';
    setPlayingUI(false);
    seekFill.style.width = '0%';
    seekThumb.style.left = '0%';
    timeCurrent.textContent = '0:00';
    timeTotal.textContent = '0:00';
    const img = npThumb.querySelector('img');
    if (img) img.remove();
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
    if (socket) socket.emit('track-ended');
  });

  // Seek bar
  seekBar.addEventListener('mousedown', startSeek);
  seekBar.addEventListener('touchstart', startSeek, { passive: true });

  function startSeek(e) {
    isSeeking = true;
    updateSeekUI(e);
    document.addEventListener('mousemove', updateSeekUI);
    document.addEventListener('mouseup', endSeek);
    document.addEventListener('touchmove', updateSeekUI, { passive: true });
    document.addEventListener('touchend', endSeek);
  }

  function updateSeekUI(e) {
    const rect = seekBar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    seekFill.style.width = pct + '%';
    seekThumb.style.left = pct + '%';
  }

  function endSeek(e) {
    isSeeking = false;
    document.removeEventListener('mousemove', updateSeekUI);
    document.removeEventListener('mouseup', endSeek);
    document.removeEventListener('touchmove', updateSeekUI);
    document.removeEventListener('touchend', endSeek);

    const rect = seekBar.getBoundingClientRect();
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    let pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

    if (currentType === 'file' && audioPlayer.duration) {
      const t = pct * audioPlayer.duration;
      audioPlayer.currentTime = t;
      socket.emit('transport', { action: 'seek', currentTime: t });
    } else if (currentType === 'youtube' && ytPlayer && ytReady) {
      const t = pct * ytPlayer.getDuration();
      ytPlayer.seekTo(t, true);
      socket.emit('transport', { action: 'seek', currentTime: t });
    }
  }

  // Volume
  volumeSlider.addEventListener('input', () => {
    const vol = volumeSlider.value / 100;
    audioPlayer.volume = vol;
    if (ytPlayer && ytReady) ytPlayer.setVolume(volumeSlider.value);
    prevVolume = volumeSlider.value;
  });
  audioPlayer.volume = 0.8;

  // ─── YouTube ──────────────────────────
  const ytScript = document.createElement('script');
  ytScript.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(ytScript);
  window.onYouTubeIframeAPIReady = function () {};

  function loadYouTubeVideo(videoId, autoplay, startTime) {
    if (ytPlayer && ytPlayer.loadVideoById) {
      ytPlayer.loadVideoById({ videoId, startSeconds: startTime || 0 });
      if (!autoplay) setTimeout(() => { if (ytPlayer.pauseVideo) ytPlayer.pauseVideo(); }, 800);
    } else {
      ytPlayer = new YT.Player('yt-player', {
        videoId,
        playerVars: { autoplay: autoplay ? 1 : 0, start: Math.floor(startTime || 0), controls: 0, modestbranding: 1, rel: 0 },
        events: {
          onReady: () => { ytReady = true; ytPlayer.setVolume(volumeSlider.value); if (!autoplay) ytPlayer.pauseVideo(); startYTProgress(); },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) setPlayingUI(true);
            if (e.data === YT.PlayerState.PAUSED) setPlayingUI(false);
            if (e.data === YT.PlayerState.ENDED) { setPlayingUI(false); if (socket) socket.emit('track-ended'); }
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
      seekFill.style.width = ((cur / dur) * 100) + '%';
      seekThumb.style.left = ((cur / dur) * 100) + '%';
      timeCurrent.textContent = formatTime(cur);
      timeTotal.textContent = formatTime(dur);
    }, 400);
  }

  ytPlayBtn.addEventListener('click', () => {
    const url = ytUrlInput.value.trim();
    if (!url) return;
    const videoId = extractYouTubeId(url);
    if (!videoId) { alert('Invalid YouTube URL'); return; }
    socket.emit('play-youtube', { videoId, title: 'YouTube Video' });
    ytUrlInput.value = '';
  });
  ytUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') ytPlayBtn.click(); });

  // ─── File Upload ──────────────────────
  browseBtn.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });
  uploadArea.addEventListener('click', (e) => { if (e.target !== browseBtn) fileInput.click(); });
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => { uploadArea.classList.remove('dragover'); });
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault(); uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) { uploadFile(fileInput.files[0]); fileInput.value = ''; }
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
      if (e.lengthComputable) progressFill.style.width = ((e.loaded / e.total) * 100) + '%';
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        const resp = JSON.parse(xhr.responseText);
        uploadStatus.textContent = `✓ ${resp.file.originalName}`;
        progressFill.style.width = '100%';
        setTimeout(() => uploadProgress.classList.add('hidden'), 2000);
        loadFileList();
      } else { uploadStatus.textContent = 'Upload failed!'; }
    });
    xhr.addEventListener('error', () => { uploadStatus.textContent = 'Upload error!'; });
    xhr.send(formData);
  }

  // ─── File List ────────────────────────
  function loadFileList() {
    fetch('/api/files').then(r => r.json()).then(files => { musicFiles = files; renderFileList(); });
  }

  function renderFileList() {
    fileListEl.innerHTML = '';
    if (musicFiles.length === 0) { fileListEl.innerHTML = '<li class="empty-state">No files uploaded yet</li>'; return; }
    musicFiles.forEach((f) => {
      const li = document.createElement('li');
      li.className = 'file-item';
      li.dataset.url = f.url;
      li.innerHTML = `
        <div class="file-icon">🎵</div>
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.originalName || f.filename)}</div>
          <div class="file-size">${formatFileSize(f.size)}</div>
        </div>
        <span class="file-play-icon">▶</span>
      `;
      li.addEventListener('click', () => {
        socket.emit('play-file', { url: f.url, name: f.originalName || f.filename });
      });
      fileListEl.appendChild(li);
    });
  }

  function highlightFile(url) {
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    const match = document.querySelector(`.file-item[data-url="${url}"]`);
    if (match) match.classList.add('active');
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
    div.innerHTML = `<span class="chat-author">${escapeHtml(from)}</span><span class="chat-text">${escapeHtml(message)}</span>`;
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

  // ─── Keyboard Shortcuts ───────────────
  let shortcutsVisible = false;

  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (!appScreen.classList.contains('active')) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlayPause();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) {
          if (socket) socket.emit('queue-next');
        } else {
          // Seek forward 5s
          if (currentType === 'file') {
            const t = Math.min(audioPlayer.currentTime + 5, audioPlayer.duration || 0);
            audioPlayer.currentTime = t;
            socket.emit('transport', { action: 'seek', currentTime: t });
          } else if (currentType === 'youtube' && ytPlayer && ytReady) {
            const t = Math.min(ytPlayer.getCurrentTime() + 5, ytPlayer.getDuration());
            ytPlayer.seekTo(t, true);
            socket.emit('transport', { action: 'seek', currentTime: t });
          }
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) {
          if (socket) socket.emit('queue-prev');
        } else {
          // Seek back 5s
          if (currentType === 'file') {
            const t = Math.max(audioPlayer.currentTime - 5, 0);
            audioPlayer.currentTime = t;
            socket.emit('transport', { action: 'seek', currentTime: t });
          } else if (currentType === 'youtube' && ytPlayer && ytReady) {
            const t = Math.max(ytPlayer.getCurrentTime() - 5, 0);
            ytPlayer.seekTo(t, true);
            socket.emit('transport', { action: 'seek', currentTime: t });
          }
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        volumeSlider.value = Math.min(parseInt(volumeSlider.value) + 5, 100);
        volumeSlider.dispatchEvent(new Event('input'));
        break;
      case 'ArrowDown':
        e.preventDefault();
        volumeSlider.value = Math.max(parseInt(volumeSlider.value) - 5, 0);
        volumeSlider.dispatchEvent(new Event('input'));
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        if (parseInt(volumeSlider.value) > 0) {
          prevVolume = volumeSlider.value;
          volumeSlider.value = 0;
        } else {
          volumeSlider.value = prevVolume || 80;
        }
        volumeSlider.dispatchEvent(new Event('input'));
        break;
      case '?':
        e.preventDefault();
        shortcutsVisible = !shortcutsVisible;
        shortcutsTip.style.display = shortcutsVisible ? 'block' : 'none';
        break;
    }
  });

})();
