// ShareIt Web Clone - frontend prototype
const socket = io();
let sessionId = null;
let isInitiator = false;
let pc = null;
let dc = null;
const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const chunkSize = 64 * 1024; // 64KB
const transfers = new Map(); // fileId -> transfer meta (sender/receiver)

const ui = {
  createBtn: document.getElementById('createBtn'),
  joinBtn: document.getElementById('joinBtn'),
  sessionInput: document.getElementById('sessionInput'),
  sessionArea: document.getElementById('sessionArea'),
  sessionIdSpan: document.getElementById('sessionId'),
  qrcodeDiv: document.getElementById('qrcode'),
  status: document.getElementById('status'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  transferList: document.getElementById('transferList'),
  toggleTheme: document.getElementById('toggleTheme'),
};

ui.toggleTheme.addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
});

function logStatus(msg) {
  ui.status.textContent = msg;
  console.log(msg);
}

// Session / Pairing
ui.createBtn.addEventListener('click', () => {
  sessionId = generateId();
  isInitiator = true;
  joinSession(sessionId);
  showSession(sessionId);
});

ui.joinBtn.addEventListener('click', () => {
  const id = ui.sessionInput.value.trim();
  if (!id) {
    alert('Masukkan session id untuk join atau scan QR dari device lain.');
    return;
  }
  sessionId = id;
  isInitiator = false;
  joinSession(sessionId);
  showSession(sessionId);
});

function showSession(id) {
  ui.sessionArea.classList.remove('hidden');
  ui.sessionIdSpan.textContent = id;
  ui.qrcodeDiv.innerHTML = '';
  new QRCode(ui.qrcodeDiv, { text: id, width: 140, height: 140 });
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

// Socket.io signaling
socket.on('connect', () => {
  logStatus('Socket connected: ' + socket.id);
});

socket.on('peer-joined', () => {
  logStatus('Peer joined session.');
  // If creator, start offer
  if (isInitiator) {
    ensurePeerConnection(true);
  }
});

socket.on('signal', async ({ from, signal }) => {
  if (!pc) {
    ensurePeerConnection(false);
  }
  if (!signal) return;
  if (signal.type === 'sdp') {
    const desc = signal.description;
    if (desc.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { sessionId, signal: { type: 'sdp', description: pc.localDescription } });
    } else if (desc.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
    }
  } else if (signal.type === 'ice') {
    try {
      await pc.addIceCandidate(signal.candidate);
    } catch (err) {
      console.warn('Error adding ICE candidate', err);
    }
  }
});

// Relay fallback
socket.on('relay-chunk', (payload) => {
  // payload is { fileId, header, chunkBase64 }
  // receiver will handle as if chunk arrived
  handleRelayedChunk(payload);
});

socket.on('resume-request', ({ from }) => {
  // other peer asking for resume state
  // reply with current state
  const state = {};
  transfers.forEach((meta, id) => {
    if (meta.role === 'receiver') {
      state[id] = { received: meta.receivedChunks ? meta.receivedChunks.length : 0, lastIndex: meta.lastReceivedIndex || -1 };
    }
  });
  socket.emit('resume-state', { sessionId, state });
});

socket.on('resume-state', (state) => {
  // On sender side: resume sending based on state
  for (const [fileId, s] of Object.entries(state)) {
    const meta = transfers.get(fileId);
    if (meta && meta.role === 'sender') {
      const resumeFrom = (s.lastIndex || -1) + 1;
      logStatus('Resume request received. File ' + meta.name + ' resume from chunk ' + resumeFrom);
      sendFileChunks(meta, resumeFrom);
    }
  }
});

// Peer connection setup
function ensurePeerConnection(initiator) {
  pc = new RTCPeerConnection(pcConfig);
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { sessionId, signal: { type: 'ice', candidate: e.candidate } });
    }
  };
  pc.onconnectionstatechange = () => {
    logStatus('Connection state: ' + pc.connectionState);
    if (pc.connectionState === 'connected') {
      logStatus('P2P connected');
    }
  };
  if (initiator) {
    dc = pc.createDataChannel('file');
    setupDataChannel(dc);
    pc.createOffer().then((offer) => {
      pc.setLocalDescription(offer);
      socket.emit('signal', { sessionId, signal: { type: 'sdp', description: pc.localDescription } });
    });
  } else {
    pc.ondatachannel = (e) => {
      dc = e.channel;
      setupDataChannel(dc);
    };
  }
}

// DataChannel helpers
function setupDataChannel(channel) {
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    logStatus('DataChannel open');
  };
  channel.onclose = () => {
    logStatus('DataChannel closed');
  };
  channel.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const obj = JSON.parse(ev.data);
        handleControlMessage(obj);
      } catch (err) {
        console.log('Text message', ev.data);
      }
    } else {
      // binary chunk (packed)
      handleBinaryMessage(ev.data);
    }
  };
}

function handleControlMessage(obj) {
  if (!obj || !obj.type) return;
  if (obj.type === 'file-meta') {
    // metadata from sender
    const meta = {
      role: 'receiver',
      fileId: obj.fileId,
      name: obj.name,
      size: obj.size,
      totalChunks: obj.totalChunks,
      chunksReceived: 0,
      receivedBuffers: [],
      lastReceivedIndex: -1,
      checksum: obj.checksum
    };
    transfers.set(obj.fileId, meta);
    addTransferUI(meta);
  } else if (obj.type === 'ack') {
    const { fileId, chunkIndex } = obj;
    const meta = transfers.get(fileId);
    if (meta && meta.role === 'sender' && meta.ackResolvers && meta.ackResolvers[chunkIndex]) {
      meta.ackResolvers[chunkIndex]();
      delete meta.ackResolvers[chunkIndex];
      updateTransferUI(meta);
    }
  } else if (obj.type === 'request-resume') {
    socket.emit('resume-request', { sessionId });
  } else if (obj.type === 'resume-state') {
    // handle if needed
  }
}

// Binary message format: 4 bytes headerLen (big-endian) | header(JSON utf8) | chunk bytes
function packMessage(headerObj, chunkArrayBuffer) {
  const encoder = new TextEncoder();
  const headerStr = JSON.stringify(headerObj);
  const headerBytes = encoder.encode(headerStr);
  const headerLen = headerBytes.length;
  const chunkBytes = new Uint8Array(chunkArrayBuffer);
  const buffer = new Uint8Array(4 + headerLen + chunkBytes.length);
  // headerLen big-endian
  buffer[0] = (headerLen >> 24) & 0xff;
  buffer[1] = (headerLen >> 16) & 0xff;
  buffer[2] = (headerLen >> 8) & 0xff;
  buffer[3] = (headerLen) & 0xff;
  buffer.set(headerBytes, 4);
  buffer.set(chunkBytes, 4 + headerLen);
  return buffer.buffer;
}

function unpackMessage(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);
  const headerLen = (view[0]<<24) | (view[1]<<16) | (view[2]<<8) | (view[3]);
  const headerBytes = view.slice(4, 4 + headerLen);
  const decoder = new TextDecoder();
  const headerStr = decoder.decode(headerBytes);
  const header = JSON.parse(headerStr);
  const chunk = view.slice(4 + headerLen);
  return { header, chunk: chunk.buffer };
}

// Handle incoming binary chunk
function handleBinaryMessage(arrayBuffer) {
  const { header, chunk } = unpackMessage(arrayBuffer);
  if (header.type === 'file-chunk') {
    const fileId = header.fileId;
    const chunkIndex = header.chunkIndex;
    const meta = transfers.get(fileId);
    if (!meta) {
      console.warn('No meta for fileId', fileId);
      return;
    }
    // store chunk
    meta.receivedBuffers[chunkIndex] = new Uint8Array(chunk);
    meta.chunksReceived = (meta.chunksReceived || 0) + 1;
    meta.lastReceivedIndex = Math.max(meta.lastReceivedIndex, chunkIndex);
    // send ack
    const ack = { type: 'ack', fileId, chunkIndex };
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(ack));
    } else {
      // fallback via socket relay
      socket.emit('relay-chunk', { sessionId, payload: { control: JSON.stringify(ack) } });
    }
    updateTransferUI(meta);

    // check completion
    if (meta.chunksReceived >= meta.totalChunks) {
      assembleFile(meta);
    }
  }
}

function handleRelayedChunk(payload) {
  // support minimal relay: if payload has control ack or chunkBase64
  try {
    if (payload.control) {
      // ack forwarded
      const obj = JSON.parse(payload.control);
      handleControlMessage(obj);
    } else if (payload.fileId && payload.chunkBase64) {
      // convert base64 to arraybuffer
      const bytes = base64ToArrayBuffer(payload.chunkBase64);
      // simulate unpacked header and chunk using header info
      const header = { type: 'file-chunk', fileId: payload.fileId, chunkIndex: payload.chunkIndex };
      const chunk = bytes;
      // apply
      const meta = transfers.get(payload.fileId);
      if (meta) {
        meta.receivedBuffers[payload.chunkIndex] = new Uint8Array(chunk);
        meta.chunksReceived = (meta.chunksReceived || 0) + 1;
        updateTransferUI(meta);
        if (meta.chunksReceived >= meta.totalChunks) assembleFile(meta);
      }
    }
  } catch (err) {
    console.warn('Error handling relayed chunk', err);
  }
}

function base64ToArrayBuffer(base64) {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

// Assemble received file
async function assembleFile(meta) {
  const buffers = meta.receivedBuffers.map(b => new Uint8Array(b));
  const totalLen = buffers.reduce((s, b) => s + b.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of buffers) {
    merged.set(b, offset);
    offset += b.length;
  }
  const blob = new Blob([merged], { type: 'application/octet-stream' });
  // verify checksum
  const ab = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', ab);
  const hex = bufferToHex(hash);
  if (meta.checksum && meta.checksum !== hex) {
    alert('Checksum mismatch for ' + meta.name);
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    a.textContent = 'Download ' + meta.name;
    a.className = 'text-indigo-600';
    const li = document.getElementById('transfer-' + meta.fileId);
    if (li) {
      li.appendChild(document.createElement('br'));
      li.appendChild(a);
    }
    logStatus('File received: ' + meta.name);
  }
}

function bufferToHex(buffer) {
  const b = new Uint8Array(buffer);
  return Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');
}

// UI - when adding transfer
function addTransferUI(meta) {
  const li = document.createElement('li');
  li.id = 'transfer-' + meta.fileId;
  li.className = 'p-3 border rounded bg-gray-50 dark:bg-gray-800';
  li.innerHTML = `<div class="flex justify-between"><div>
    <div class="font-medium">${escapeHtml(meta.name)}</div>
    <div class="text-sm text-gray-500">${meta.size} bytes</div>
  </div>
  <div><div class="text-sm" id="progress-${meta.fileId}">0%</div></div></div>
  <div class="w-full bg-gray-200 h-2 rounded mt-2 overflow-hidden"><div id="bar-${meta.fileId}" class="h-2 bg-indigo-500 w-0"></div></div>`;
  ui.transferList.prepend(li);
}

function updateTransferUI(meta) {
  const progressEl = document.getElementById('progress-' + meta.fileId);
  const bar = document.getElementById('bar-' + meta.fileId);
  if (progressEl && bar) {
    const received = meta.role === 'receiver' ? (meta.chunksReceived || 0) : (meta.ackCount || 0);
    const total = meta.totalChunks || Math.ceil(meta.size / chunkSize);
    const pct = Math.floor((received / total) * 100);
    progressEl.textContent = pct + '%';
    bar.style.width = pct + '%';
  }
}

function escapeHtml(s){ return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

// File selection / drop
ui.dropzone.addEventListener('click', () => ui.fileInput.click());
ui.dropzone.addEventListener('dragover', (e)=>{ e.preventDefault(); ui.dropzone.classList.add('border-indigo-500'); });
ui.dropzone.addEventListener('dragleave', ()=> ui.dropzone.classList.remove('border-indigo-500'));
ui.dropzone.addEventListener('drop', (e)=>{ e.preventDefault(); ui.dropzone.classList.remove('border-indigo-500'); const files = Array.from(e.dataTransfer.files); handleFiles(files); });
ui.fileInput.addEventListener('change', (e)=> handleFiles(Array.from(e.target.files)));

function handleFiles(fileList) {
  if (!sessionId) {
    alert('Buat atau join session terlebih dahulu.');
    return;
  }
  // if no DataChannel yet, request peer to create pc
  if (!pc) ensurePeerConnection(isInitiator);
  for (const file of fileList) {
    const fileId = generateId();
    const meta = {
      role: 'sender',
      fileId,
      name: file.name,
      size: file.size,
      file,
      totalChunks: Math.ceil(file.size / chunkSize),
      ackCount: 0,
      ackResolvers: {}
    };
    transfers.set(fileId, meta);
    addTransferUI(meta);
    prepareAndSendFile(meta);
  }
}

// Compute checksum and start sending meta + chunks
async function prepareAndSendFile(meta) {
  logStatus('Preparing ' + meta.name);
  // compute checksum
  const ab = await meta.file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', ab);
  const hex = bufferToHex(hash);
  meta.checksum = hex;

  // send metadata via control channel (JSON)
  const metaMsg = {
    type: 'file-meta',
    fileId: meta.fileId,
    name: meta.name,
    size: meta.size,
    totalChunks: meta.totalChunks,
    checksum: meta.checksum
  };
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(metaMsg));
    // start sending chunks
    sendFileChunks(meta, 0);
  } else {
    // fallback: send metadata via socket then relay chunks
    socket.emit('signal', { sessionId, signal: { type: 'meta', meta: metaMsg } });
    sendChunksViaRelay(meta);
  }
}

// Send chunks sequentially with simple ack-wait
async function sendFileChunks(meta, fromChunk=0) {
  const total = meta.totalChunks;
  for (let i = fromChunk; i < total; i++) {
    const start = i * chunkSize;
    const end = Math.min(meta.size, start + chunkSize);
    const blob = meta.file.slice(start, end);
    const chunkBuf = await blob.arrayBuffer();
    const header = { type: 'file-chunk', fileId: meta.fileId, chunkIndex: i };
    const packed = packMessage(header, chunkBuf);
    // send
    if (dc && dc.readyState === 'open') {
      // set up ack promise
      const ackPromise = new Promise((resolve) => {
        meta.ackResolvers[i] = resolve;
      });
      dc.send(packed);
      // wait for ack or timeout
      await Promise.race([ackPromise, timeoutPromise(10000)]);
      meta.ackCount = (meta.ackCount || 0) + 1;
      updateTransferUI(meta);
    } else {
      // fallback relay via socket (base64)
      const b64 = arrayBufferToBase64(chunkBuf);
      socket.emit('relay-chunk', { sessionId, payload: { fileId: meta.fileId, chunkIndex: i, chunkBase64: b64 } });
      meta.ackCount = (meta.ackCount || 0) + 1;
      updateTransferUI(meta);
      await sleep(20);
    }
  }
  logStatus('Selesai mengirim ' + meta.name);
}

// Fallback relay chunk sender
function sendChunksViaRelay(meta) {
  const total = meta.totalChunks;
  let i = 0;
  const interval = setInterval(async () => {
    if (i >= total) { clearInterval(interval); return; }
    const start = i * chunkSize;
    const end = Math.min(meta.size, start + chunkSize);
    const blob = meta.file.slice(start, end);
    const buf = await blob.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    socket.emit('relay-chunk', { sessionId, payload: { fileId: meta.fileId, chunkIndex: i, chunkBase64: b64 } });
    meta.ackCount = (meta.ackCount || 0) + 1;
    updateTransferUI(meta);
    i++;
  }, 30);
}

// Utils
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}
function timeoutPromise(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Resume helpers (very simple)
function requestResume() {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify({ type: 'request-resume' }));
  } else {
    socket.emit('resume-request', { sessionId });
  }
}

// Simple security: sanitize filename for UI (already used escapeHtml)
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9-_. ]/g, '_').slice(0, 200);
}

// helper to convert ArrayBuffer to hex (used earlier)
function bufferToHex(buffer) {
  const b = new Uint8Array(buffer);
  return Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');
}

// handle control ack from relay
function handleControlMessage(obj) {
  if (!obj || !obj.type) return;
  if (obj.type === 'file-meta') {
    const meta = {
      role: 'receiver',
      fileId: obj.fileId,
      name: obj.name,
      size: obj.size,
      totalChunks: obj.totalChunks,
      chunksReceived: 0,
      receivedBuffers: [],
      lastReceivedIndex: -1,
      checksum: obj.checksum
    };
    transfers.set(obj.fileId, meta);
    addTransferUI(meta);
  } else if (obj.type === 'ack') {
    const { fileId, chunkIndex } = obj;
    const meta = transfers.get(fileId);
    if (meta && meta.role === 'sender' && meta.ackResolvers && meta.ackResolvers[chunkIndex]) {
      meta.ackResolvers[chunkIndex]();
      delete meta.ackResolvers[chunkIndex];
      meta.ackCount = (meta.ackCount || 0) + 1;
      updateTransferUI(meta);
    }
  } else if (obj.type === 'request-resume') {
    socket.emit('resume-request', { sessionId });
  }
}

// Because we redefined handleControlMessage above, make sure binary handler still calls correct one
// (already the same name)

// Initialize UI state
logStatus('Siap. Buat session atau join session untuk mulai.');

// Expose some utilities to window for debugging
window._shareit = { transfers, socket, requestResume };
