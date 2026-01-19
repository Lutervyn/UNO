
// --- Game Constants & Assets ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const cdWidth = 240;
const cdHeight = 360;
const cards = new Image();
const back = new Image();
const tableImg = new Image();

// --- Global State ---
function logToScreen(msg) {
  const consoleEl = document.getElementById('debug-console');
  if (consoleEl) {
    const div = document.createElement('div');
    div.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  console.log(msg);
}

let peer;
let myPeerId = null;
let isHost = false;
let hostConn = null; // For client: connection to host
let connections = []; // For host: list of connections to clients

// Game State (Client Side)
let roomCode = '';
let playerName = '';
let hand = [];
let opponents = [];
let turn = false; // Is it my turn?
let currentTurnPlayerId = null;
let currentCardOnBoard = null;
let colorPickerActive = false;
let waitingForColorSelection = false;
let currentActiveColor = null;
let currentDialogText = null;
let toastMessage = null;
let toastTimeout = null;

// Animation State
let animations = []; // { type: 'move', card, x, y, tx, ty, startTime, duration }
let prevHand = [];
let hasActed = false;
let hasPlayed = false;
let lastPlayedNumber = null;

// --- Host Game Logic (Server Port) ---
class GameServer {
  constructor(maxPlayers) {
    this.maxPlayers = maxPlayers;
    this.players = []; // { id, name, hand: [] }
    this.deck = [];
    this.cardOnBoard = null;
    this.turnIndex = 0;
    this.direction = 1; // 1 or -1 (for reverse)
    this.pendingTurn = null;
    this.hasActed = false; // Kept for legacy check, but we'll use specific flags
    this.hasPlayed = false;
    this.hasDrawn = false;
    this.stackDraw = 0;
    this.activeColor = null;
    this.lastPlayedNumber = null;
    this.gameStarted = false;
    this.countdownInterval = null;
    this.countdownSeconds = 3;

    this.initDeck();
  }

  initDeck() {
    this.deck = [];
    for (let i = 0; i < 112; i++) {
      this.deck.push(i);
    }
    // Remove the second set of 0s (indices 56, 70, 84, 98 in original 0-111)
    // We remove them from highest to lowest to keep indices stable
    this.deck.splice(98, 1);
    this.deck.splice(84, 1);
    this.deck.splice(70, 1);
    this.deck.splice(56, 1);
    this.shuffle(this.deck);
  }

  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  }

  addPlayer(id, name) {
    if (this.players.length >= this.maxPlayers) return false;
    this.players.push({ id, name, hand: [] });

    // Broadcast updated lobby info
    this.broadcastGameInfo();

    // Start countdown if enough players
    if (this.players.length >= 2 && !this.gameStarted && !this.countdownInterval) {
      this.startCountdown();
    }
    return true;
  }

  removePlayer(id) {
    this.players = this.players.filter(p => p.id !== id);
    if (this.gameStarted) {
      // Handle disconnect during game (simplified: just end or ignore for now)
      // Ideally we'd return cards to deck or something
    } else {
      if (this.players.length < 2 && this.countdownInterval) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
        this.countdownSeconds = 3;
        this.broadcast('countDown', 0); // Cancel countdown
      }
      this.broadcastGameInfo();
    }
  }

  startCountdown() {
    this.countdownSeconds = 3;
    this.countdownInterval = setInterval(() => {
      this.broadcast('countDown', this.countdownSeconds);
      this.countdownSeconds--;
      if (this.countdownSeconds < 0) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
        this.startGame();
      }
    }, 1000);
  }

  startGame() {
    this.gameStarted = true;
    this.broadcast('countDown', 0); // Clear countdown UI

    // Shuffle fresh deck
    this.initDeck();

    // Deal 7 cards to each
    this.players.forEach(p => {
      p.hand = [];
      for (let i = 0; i < 7; i++) {
        p.hand.push(this.drawFromDeck());
      }
    });

    // Initial card on board
    do {
      this.cardOnBoard = this.drawFromDeck();
      if (this.cardColor(this.cardOnBoard) === 'black') {
        this.deck.push(this.cardOnBoard); // Put back and reshuffle/redraw
        this.shuffle(this.deck);
      } else {
        break;
      }
    } while (true);

    // Initial State
    this.turnIndex = 0; // Host starts or random? Let's say Player 0
    this.direction = 1;
    this.stackDraw = 0;
    this.hasActed = false;
    this.hasPlayed = false;
    this.lastPlayedNumber = null;

    // Check initial card effect
    const type = this.cardType(this.cardOnBoard);
    if (type === 'Draw2') {
      // First player draws 2 and turn passes? Or just draws?
      // Standard rules: Player 0 draws 2 and turn passes to Player 1
      const p0 = this.players[this.turnIndex];
      p0.hand.push(this.drawFromDeck());
      p0.hand.push(this.drawFromDeck());
      this.turnIndex = 1 % this.players.length;
    } else if (type === 'Reverse') {
      this.direction = -1;
      this.turnIndex = this.players.length - 1;
    } else if (type === 'Skip') {
      this.turnIndex = 1 % this.players.length;
    }

    // Send initial state
    this.players.forEach(p => {
      this.sendTo(p.id, 'haveCard', p.hand);
    });
    this.broadcast('sendCard', this.cardOnBoard);
    this.broadcast('turnPlayer', this.players[this.turnIndex].id);
    this.broadcastGameInfo();
  }

  drawFromDeck() {
    if (this.deck.length === 0) {
      // Reshuffle discard pile (not tracked here for simplicity, just new deck)
      // In a real game we'd reshuffle played cards.
      // For now, just generate a new deck excluding current hands
      this.initDeck();
      // This is a simplification.
    }
    return this.deck.shift();
  }

  handleAction(playerId, action, data) {
    if (!this.gameStarted) return;

    const pIndex = this.players.findIndex(p => p.id === playerId);
    if (pIndex !== this.turnIndex) return; // Not their turn

    const player = this.players[pIndex];

    if (action === 'drawCard') {
      if (this.hasPlayed) {
        this.sendTo(playerId, 'error', 'You already played! Click End Turn.');
        return;
      }

      const card = this.drawFromDeck();
      player.hand.push(card);
      // hasActed = true; // Removed: Drawing doesn't allow passing

      this.sendTo(playerId, 'haveCard', player.hand);
      this.broadcastGameInfo();

    } else if (action === 'endTurn') {
      if (!this.hasActed) return;

      // Block if Wild is played but no color picked
      if (this.cardColor(this.cardOnBoard) === 'black' && !this.activeColor) {
        this.sendTo(playerId, 'error', 'You must pick a color first!');
        return;
      }

      this.advanceTurn();

    } else if (action === 'playCard') {
      const card = Number(data);
      if (!player.hand.includes(card)) {
        this.sendTo(playerId, 'error', 'Error: Card not in hand');
        return;
      }

      if (this.hasPlayed) {
        // Multi-play rule: must match the number of the card just played
        if (card % 14 !== this.lastPlayedNumber) {
          this.sendTo(playerId, 'error', 'Multi-play: Must match the same number!');
          return;
        }
      } else {
        // First play of the turn: standard match rule
        if (!this.isValidPlay(card)) return;
      }

      // Remove from hand
      player.hand = player.hand.filter(c => c !== card);
      this.cardOnBoard = card;
      this.lastPlayedNumber = card % 14;
      this.hasActed = true;
      this.hasPlayed = true;

      // Handle Effects
      const type = this.cardType(card);
      let skip = 0;

      if (type === 'Skip') skip = 1;
      if (type === 'Reverse') this.direction *= -1;
      if (type === 'Draw2') this.stackDraw += 2;
      if (type === 'Draw4') this.stackDraw += 4;
      if (type === 'Wild' || type === 'Draw4') {
        this.activeColor = null; // Will be set by selectWildColor
        // But we need to wait for color selection?
        // For simplicity, we broadcast the card play now.
        // The client will see it's a wild and prompt for color.
      } else {
        this.activeColor = null;
      }

      this.broadcast('sendCard', this.cardOnBoard);
      this.sendTo(playerId, 'haveCard', player.hand);
      this.broadcastGameInfo();

      // Calculate next turn but don't advance yet (wait for Done or Color)
      // Actually, if it's a Wild, we wait for color.
      // If it's not wild, we can wait for "Done" or auto-advance?
      // Original game had "Done" button.

      // If it's a number card, we could auto-advance, but let's stick to "Done" button for consistency
      // EXCEPT for Wilds, where we need color input.
    } else if (action === 'selectWildColor') {
      const color = data;
      this.activeColor = color;
      // Broadcast to everyone so their border updates
      this.broadcast('wildColorSelected', color);
    }
  }

  isValidPlay(card) {
    const c = Number(card);
    const cob = Number(this.cardOnBoard);

    const playedColor = this.cardColor(c);
    const playedNumber = c % 14;

    const boardColor = this.activeColor || this.cardColor(cob);
    const boardNumber = cob % 14;

    console.log(`Checking Play: Card=${c} (${playedColor} ${playedNumber}) vs Board=${cob} (${boardColor} ${boardNumber})`);

    if (playedColor === 'black') return true; // Wilds always playable
    if (playedColor === boardColor) return true;
    if (playedNumber === boardNumber) return true;

    console.log('Play Rejected');
    this.sendTo(this.players[this.turnIndex].id, 'error', `Invalid: ${playedColor} ${playedNumber} vs ${boardColor} ${boardNumber}`);
    return false;
  }

  advanceTurn() {
    let advance = 1;
    const type = this.cardType(this.cardOnBoard);
    // Only apply skip/draw effects if they were just played? 
    // The original logic applied them on play.
    // Here we just need to move to next player.
    // But wait, if Draw2 was played, next player gets cards.

    // Simplified turn logic based on original server.js:
    // It calculated 'pendingTurn' during playCard.
    // Let's re-evaluate here.

    let nextIndex = this.turnIndex + this.direction;
    if (type === 'Skip' && this.hasActed) { // If just played skip
      // We need to track if the effect was "consumed". 
      // For simplicity, let's assume effects apply immediately on 'endTurn' if a card was played.
      // But 'hasActed' is true for Draw too.
      // Let's rely on the fact that if cardOnBoard changed this turn, we apply effects.
    }

    // Actually, let's just use the simple logic:
    // If stackDraw > 0, next player draws and turn passes.

    // Calculate next index
    let steps = 1;
    if (this.cardType(this.cardOnBoard) === 'Skip' && this.didPlayCardThisTurn()) steps = 2;

    let next = (this.turnIndex + (this.direction * steps)) % this.players.length;
    if (next < 0) next += this.players.length;

    // Apply stack draw
    if (this.stackDraw > 0) {
      const victim = this.players[next];
      for (let i = 0; i < this.stackDraw; i++) victim.hand.push(this.drawFromDeck());
      this.sendTo(victim.id, 'haveCard', victim.hand);
      this.stackDraw = 0;
      // If you draw from stack, do you lose turn? Yes usually.
      // So turn passes to next after victim.
      // But original code might differ. Original code: "Turn passed to player index nextIndex".
      // It seems the victim BECOMES the turn player, sees they have cards, and plays?
      // No, usually Draw2 skips the victim's turn.
      // Original server.js: 
      // if (cardType === 'Draw2') { ... push cards ... data['turn'] = (dealer + 2) ... }
      // It skips the victim.

      // Let's implement skip-on-draw-penalty
      next = (next + this.direction) % this.players.length;
      if (next < 0) next += this.players.length;
    }

    this.turnIndex = next;
    this.hasActed = false;
    this.hasPlayed = false;
    this.hasDrawn = false;
    this.lastPlayedNumber = null;
    this.broadcast('turnPlayer', this.players[this.turnIndex].id);
    this.broadcastGameInfo();
  }

  didPlayCardThisTurn() {
    return this.hasPlayed;
  }

  broadcast(type, data) {
    this.players.forEach(p => this.sendTo(p.id, type, data));
  }

  sendTo(playerId, type, data) {
    if (playerId === myPeerId) {
      handleClientEvent(type, data);
    } else {
      const conn = connections.find(c => c.peer === playerId);
      if (conn) conn.send({ type, data });
    }
  }

  broadcastGameInfo() {
    const info = this.players.map(p => ({
      name: p.name,
      id: p.id,
      handSize: p.hand.length
    }));
    this.broadcast('updateGameInfo', {
      players: info,
      activeColor: this.activeColor
    });
  }

  // Helpers
  cardColor(num) {
    if (num % 14 === 13) return 'black';
    const type = Math.floor(num / 14);
    if (type === 0 || type === 4) return 'red';
    if (type === 1 || type === 5) return 'yellow';
    if (type === 2 || type === 6) return 'green';
    if (type === 3 || type === 7) return 'blue';
  }

  cardType(num) {
    const n = num % 14;
    if (n === 10) return 'Skip';
    if (n === 11) return 'Reverse';
    if (n === 12) return 'Draw2';
    if (n === 13) return Math.floor(num / 14) >= 4 ? 'Draw4' : 'Wild';
    return 'Number ' + n;
  }
}

let gameServer = null;

// --- Initialization ---

function init() {
  // Security Check: PeerJS does not work well with file:// protocol
  if (window.location.protocol === 'file:') {
    alert("CRITICAL ERROR: You are running the game by double-clicking the file. PeerJS (the multiplayer engine) REQUIRES a web server to work.\n\nPlease use VS Code 'Live Server' or upload these files to a host like GitHub Pages.");
    const statusEl = document.getElementById('peer-status');
    if (statusEl) {
      statusEl.innerText = "ERROR: Use a Web Server (http://)";
      statusEl.style.color = "#e74c3c";
    }
    return;
  }

  ctx.font = "16px 'Segoe UI', sans-serif";
  canvas.style.backgroundColor = '#5d4037';

  cards.src = 'images/deck.svg';
  back.src = 'images/uno.svg';
  tableImg.src = 'images/table.png';

  document.addEventListener('touchstart', onMouseClick, false);
  document.addEventListener('click', onMouseClick, false);

  playerName = localStorage.getItem('playerName') || 'Player' + Math.floor(Math.random() * 1000);

  setupMenu();
  window.addEventListener('resize', resizeCanvas, false);
  document.addEventListener('fullscreenchange', resizeCanvas, false);
  resizeCanvas();

  // Initialize Peer
  initPeer();
}

function generateShortId() {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < 4; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function initPeer() {
  logToScreen('PeerJS: Initializing...');
  if (window.Peer) {
    logToScreen('PeerJS Version: ' + Peer.prototype.version || '1.5.x');
  }
  if (!navigator.onLine) {
    alert("Warning: You seem to be offline. PeerJS requires an internet connection to establish the initial connection.");
  }

  const id = generateShortId();
  const fullId = 'UNO-' + id;
  console.log('PeerJS: Initializing with ID:', fullId);

  const statusEl = document.getElementById('peer-status');
  if (statusEl) statusEl.innerText = "Connecting to network...";

  peer = new Peer(fullId, {
    debug: 2,
    config: {
      'iceServers': [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
        { urls: 'stun:stun.xten.com' }
      ],
      'iceCandidatePoolSize': 10
    }
  });

  peer.on('open', (id) => {
    myPeerId = id;
    logToScreen('PeerJS: Connected with ID ' + id);
    const statusEl = document.getElementById('peer-status');
    if (statusEl) {
      statusEl.innerText = "Connected to network";
      statusEl.style.color = "#2ecc71";
    }
    // Strip the prefix for display
    const displayId = id.replace('UNO-', '');
    if (document.getElementById('lobby-room-code')) {
      document.getElementById('lobby-room-code').innerText = displayId;
    }
  });

  peer.on('connection', (conn) => {
    logToScreen('Incoming connection from ' + conn.peer);

    if (!isHost) {
      conn.close();
      return;
    }

    // Aggressive Handshake: Setup listeners immediately
    const setupHostConn = (c) => {
      c.on('data', (data) => {
        logToScreen('Data received from ' + c.peer + ': ' + data.type);
        handleServerAction(c.peer, data.type, data.data);
      });

      c.on('close', () => {
        logToScreen('Connection closed by ' + c.peer);
        connections = connections.filter(connObj => connObj !== c);
        if (gameServer) gameServer.removePlayer(c.peer);
      });

      c.on('error', (err) => {
        logToScreen('Conn Error with ' + c.peer + ': ' + err.type);
      });

      if (!connections.includes(c)) {
        connections.push(c);
        logToScreen('Connection active with ' + c.peer);
      }
    };

    if (conn.open) {
      setupHostConn(conn);
    } else {
      conn.on('open', () => setupHostConn(conn));
    }
  });

  peer.on('error', (err) => {
    logToScreen('PeerJS Error: ' + err.type);
    const statusEl = document.getElementById('peer-status');
    if (statusEl) {
      statusEl.innerText = "Connection Error: " + err.type;
      statusEl.style.color = "#e74c3c";
    }
    if (err.type === 'unavailable-id') {
      peer.destroy();
      setTimeout(initPeer, 500);
    } else if (err.type === 'peer-unavailable') {
      showToast("Error: Room not found!");
    }
  });
}

function connectToHost(hostId) {
  const cleanId = hostId.trim().toUpperCase();
  const fullHostId = cleanId.startsWith('UNO-') ? cleanId : 'UNO-' + cleanId;

  logToScreen('Connecting to ' + fullHostId);
  showToast("Connecting...");

  // Force JSON serialization for cross-device compatibility
  hostConn = peer.connect(fullHostId, {
    serialization: 'json'
  });

  // Add a timeout for the connection
  const connectionTimeout = setTimeout(() => {
    if (hostConn && !hostConn.open) {
      logToScreen('Stuck? Trying Force Connect...');
      hostConn.close();
      // Try again but with a fresh connection object
      hostConn = peer.connect(fullHostId, {
        reliable: false, // Try unreliable mode as a fallback
        metadata: { retry: true }
      });
      setupConnectionListeners(hostConn, cleanId);
    }
  }, 7000);

  setupConnectionListeners(hostConn, cleanId, connectionTimeout);
}

function setupConnectionListeners(conn, cleanId, timeout) {
  conn.on('open', () => {
    if (timeout) clearTimeout(timeout);
    logToScreen('PeerJS: Connection established!');
    showToast("Joined Room!");
    conn.send({ type: 'joinRoom', data: { playerName } });

    document.getElementById('join-room-form').style.display = 'none';
    document.getElementById('lobby-view').style.display = 'block';
    document.getElementById('lobby-room-code').innerText = cleanId;
  });

  conn.on('data', (msg) => {
    handleClientEvent(msg.type, msg.data);
  });

  conn.on('close', () => {
    logToScreen('Connection closed');
    location.reload();
  });

  conn.on('error', (err) => {
    logToScreen('Conn Error: ' + err.type);
  });
}

// --- Event Handlers (Client) ---

function handleClientEvent(type, data) {
  console.log('Client Event:', type, data);

  if (type === 'updateGameInfo') {
    opponents = data.players;
    currentActiveColor = data.activeColor; // Always sync color state
    updateLobbyUI(data.players);
  } else if (type === 'roomJoined') {
    // data is room code
  } else if (type === 'countDown') {
    if (data > 0) {
      currentDialogText = "Starting in " + data;
      document.getElementById('lobby-status').innerText = "Starting in " + data + "...";
    } else {
      currentDialogText = null;
      document.getElementById('menu-overlay').style.display = 'none';
    }
  } else if (type === 'haveCard') {
    // Detect drawn cards for animation
    if (hand.length < data.length) {
      // Cards added (Draw)
      // hasActed = true; // Removed: Drawing doesn't allow passing
      showToast("Taken from Bank!");
      for (let i = hand.length; i < data.length; i++) {
        startAnimation('draw', data[i], canvas.width - 100, canvas.height / 2, 0, 0, 500);
      }
    }
    hand = data;
  } else if (type === 'sendCard') {
    // Animate Play
    let startX, startY;

    if (currentTurnPlayerId === myPeerId) {
      // My turn: find card in hand
      const idx = hand.indexOf(data);
      if (idx !== -1) {
        const pos = getCardPosInHand(idx, hand.length);
        startX = pos.x;
        startY = pos.y;
      } else {
        startX = canvas.width / 2;
        startY = canvas.height - 100;
      }
      hasActed = true;
      hasPlayed = true; // I played
    } else {
      // Opponent turn: from top
      startX = canvas.width / 2;
      startY = 50;
    }

    startAnimation('play', data, startX, startY, canvas.width / 2 - (cdWidth * 0.3375) / 2, canvas.height / 2 - (cdHeight * 0.3375) / 2, 400);

    currentCardOnBoard = data;
    currentActiveColor = null; // Reset on new card

    // Check for Wild/Draw4 to prep color selection
    if ((data % 14) === 13) {
      if (currentTurnPlayerId === myPeerId) {
        colorPickerActive = true;
      }
    }
  } else if (type === 'turnPlayer') {
    currentTurnPlayerId = data;
    turn = (data === myPeerId);
    if (turn) {
      console.log("It's my turn!");
      hasActed = false;
      hasPlayed = false; // Reset action state
      // Removed waitingForColorSelection logic as it's now immediate
    } else {
      colorPickerActive = false;
    }
  } else if (type === 'wildColorSelected') {
    colorPickerActive = false;
    currentActiveColor = data;
    showToast("Color changed to " + data.toUpperCase() + "!");
  }
}

function startAnimation(type, card, sx, sy, tx, ty, duration) {
  animations.push({
    type: type,
    card: card,
    sx: sx, sy: sy,
    tx: tx, ty: ty,
    startTime: Date.now(),
    duration: duration
  });
}

function getScales() {
  const isMobile = canvas.width < 1024;
  return {
    hand: isMobile ? 0.3 : 0.45,
    opponent: isMobile ? 0.2 : 0.3,
    center: isMobile ? 0.25 : 0.3375,
    pile: isMobile ? 0.25 : 0.3375,
    spacing: isMobile ? 40 : 60
  };
}

function getCardPosInHand(index, total) {
  const scales = getScales();
  const cardScale = scales.hand;
  const cardW = cdWidth * cardScale;
  const cardH = cdHeight * cardScale;
  const maxTotalWidth = canvas.width - 100;
  let spacing = scales.spacing;
  let totalWidth = (total - 1) * spacing + cardW;
  if (totalWidth > maxTotalWidth) {
    spacing = (maxTotalWidth - cardW) / (total - 1);
    totalWidth = maxTotalWidth;
  }
  let startX = (canvas.width - totalWidth) / 2;
  const y = canvas.height - cardH - 20;
  return { x: startX + index * spacing, y: y };
}

function sendAction(type, data) {
  if (isHost) {
    if (gameServer) gameServer.handleAction(myPeerId, type, data);
  } else if (hostConn) {
    hostConn.send({ type, data });
  }
}

// --- Event Handlers (Host) ---

function handleServerAction(playerId, type, data) {
  if (!gameServer) return;

  if (type === 'joinRoom') {
    gameServer.addPlayer(playerId, data.playerName);
  } else {
    gameServer.handleAction(playerId, type, data);
  }
}

// --- UI & Input ---

function setupMenu() {
  const mainMenu = document.getElementById('main-menu');
  const createForm = document.getElementById('create-room-form');
  const joinForm = document.getElementById('join-room-form');
  const nameInput = document.getElementById('player-name-input');

  if (nameInput) nameInput.value = playerName;

  document.getElementById('btn-create-menu').onclick = () => {
    mainMenu.style.display = 'none';
    createForm.style.display = 'block';
  };

  document.getElementById('btn-join-menu').onclick = () => {
    mainMenu.style.display = 'none';
    joinForm.style.display = 'block';
  };

  document.querySelectorAll('.btn-back').forEach(btn => {
    btn.onclick = () => {
      createForm.style.display = 'none';
      joinForm.style.display = 'none';
      mainMenu.style.display = 'block';
    };
  });

  document.getElementById('btn-create-submit').onclick = () => {
    if (!myPeerId) {
      alert("Still connecting to the network. Please wait a moment and try again.");
      return;
    }
    playerName = nameInput.value.trim() || playerName;
    localStorage.setItem('playerName', playerName);
    const maxPlayers = parseInt(document.getElementById('max-players-input').value);

    isHost = true;
    gameServer = new GameServer(maxPlayers);
    gameServer.addPlayer(myPeerId, playerName); // Add self

    createForm.style.display = 'none';
    document.getElementById('lobby-view').style.display = 'block';
    const displayId = myPeerId.replace('UNO-', '');
    document.getElementById('lobby-room-code').innerText = displayId;
    roomCode = displayId;

    toggleFullscreen();
  };

  document.getElementById('btn-join-submit').onclick = () => {
    if (!myPeerId) {
      alert("Still connecting to the network. Please wait a moment.");
      return;
    }
    playerName = nameInput.value.trim() || playerName;
    localStorage.setItem('playerName', playerName);
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (code) {
      connectToHost(code);
      toggleFullscreen();
    }
  };

  // Copy button logic
  document.getElementById('btn-copy-room-code').onclick = () => {
    const code = document.getElementById('lobby-room-code').innerText;
    navigator.clipboard.writeText(code).then(() => alert('Copied!'));
  };
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(err => {
          console.log("Orientation lock failed:", err);
        });
      }
    }).catch(err => {
      console.log("Fullscreen request failed:", err);
    });
  }
}

function updateLobbyUI(players) {
  const list = document.getElementById('lobby-player-list');
  if (list) {
    list.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      li.innerText = p.name + (p.id === myPeerId ? ' (You)' : '');
      list.appendChild(li);
    });
  }
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  drawScene();
}

function onMouseClick(e) {
  const rect = canvas.getBoundingClientRect();
  let clientX = e.clientX;
  let clientY = e.clientY;

  if (e.type === 'touchstart') {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  }

  const X = clientX - rect.left;
  const Y = clientY - rect.top;

  // Color Picker
  if (colorPickerActive) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = cdHeight / 4;
    const colors = ['red', 'blue', 'green', 'gold'];
    const dx = X - cx;
    const dy = Y - cy;
    if (Math.sqrt(dx * dx + dy * dy) <= r) {
      // Explicit Quadrant Detection
      let selectedColor = '';
      if (dx > 0 && dy > 0) selectedColor = 'red';    // Bottom Right
      else if (dx < 0 && dy > 0) selectedColor = 'blue';  // Bottom Left
      else if (dx < 0 && dy < 0) selectedColor = 'green'; // Top Left
      else if (dx > 0 && dy < 0) selectedColor = 'gold';  // Top Right

      if (selectedColor) {
        sendAction('selectWildColor', selectedColor);
        colorPickerActive = false;
      }
      return;
    }
  }

  // Done Button
  // Left Side
  const btnRadius = 30;
  const btnX = 100;
  const btnY = canvas.height / 2;

  const dx = X - btnX;
  const dy = Y - btnY;
  if (turn && hasPlayed && dx * dx + dy * dy <= btnRadius * btnRadius) {
    sendAction('endTurn', null);
    return;
  }

  // Draw Pile
  const pileScale = 0.3375;
  const pileW = cdWidth * pileScale;
  const pileH = cdHeight * pileScale;
  const pileX = canvas.width - pileW - 40;
  const pileY = canvas.height / 2 - pileH / 2;

  if (X >= pileX && X <= pileX + pileW && Y >= pileY && Y <= pileY + pileH) {
    if (turn) {
      sendAction('drawCard', null);
      // hasActed = true; // Removed optimistic update, wait for server
    }
    return;
  }

  // Hand
  if (hand.length > 0) {
    const scales = getScales();
    const cardScale = scales.hand;
    const cardW = cdWidth * cardScale;
    const cardH = cdHeight * cardScale;
    const maxTotalWidth = canvas.width - 100;
    let spacing = scales.spacing;
    let totalWidth = (hand.length - 1) * spacing + cardW;
    if (totalWidth > maxTotalWidth) {
      spacing = (maxTotalWidth - cardW) / (hand.length - 1);
      totalWidth = maxTotalWidth;
    }
    let startX = (canvas.width - totalWidth) / 2;
    const y = canvas.height - cardH - 20;

    if (Y >= y && Y <= y + cardH) {
      for (let i = hand.length - 1; i >= 0; i--) {
        let x = startX + i * spacing;
        if (X >= x && X <= x + cardW) {
          if (turn) sendAction('playCard', hand[i]);
          return;
        }
      }
    }
  }
}

// --- Rendering ---

function drawScene() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  if (tableImg.complete) {
    ctx.drawImage(tableImg, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#5d4037';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Center Card
  if (currentCardOnBoard !== null) {
    const scales = getScales();
    const cardScale = scales.center;
    const cardW = cdWidth * cardScale;
    const cardH = cdHeight * cardScale;
    const sx = 1 + cdWidth * (currentCardOnBoard % 14);
    const sy = 1 + cdHeight * Math.floor(currentCardOnBoard / 14);
    const dx = canvas.width / 2 - cardW / 2;
    const dy = canvas.height / 2 - cardH / 2;
    ctx.drawImage(cards, sx, sy, cdWidth, cdHeight, dx, dy, cardW, cardH);

    // Active Color Indicator (for Wilds)
    if (currentActiveColor) {
      ctx.strokeStyle = currentActiveColor === 'gold' ? '#f1c40f' : currentActiveColor;
      ctx.lineWidth = 12; // Even thicker for visibility
      ctx.strokeRect(dx - 6, dy - 6, cardW + 12, cardH + 12);
    }
  }

  // Opponents
  drawOpponents();

  // Hand
  drawHand();

  // Draw Pile
  const scales = getScales();
  const pileScale = scales.pile;
  const pileW = cdWidth * pileScale;
  const pileH = cdHeight * pileScale;
  const pileX = canvas.width - pileW - 40;
  const pileY = canvas.height / 2 - pileH / 2;
  for (let i = 2; i >= 0; i--) {
    ctx.drawImage(back, pileX - i * 6, pileY - i * 3, pileW, pileH);
  }

  // Animations
  const now = Date.now();
  for (let i = animations.length - 1; i >= 0; i--) {
    const anim = animations[i];
    const elapsed = now - anim.startTime;
    if (elapsed >= anim.duration) {
      animations.splice(i, 1);
      continue;
    }

    const t = elapsed / anim.duration;
    // Ease out
    const ease = 1 - Math.pow(1 - t, 3);

    let curX = anim.sx + (anim.tx - anim.sx) * ease;
    let curY = anim.sy + (anim.ty - anim.sy) * ease;

    // If it's a draw animation, target might need update if hand changed? 
    // Simplified: just fly to center-bottom
    if (anim.type === 'draw') {
      // Fly to roughly hand position
      curX = anim.sx + (canvas.width / 2 - anim.sx) * ease;
      curY = anim.sy + (canvas.height - 100 - anim.sy) * ease;
    }

    const scales = getScales();
    const scale = scales.pile + (scales.hand - scales.pile) * (anim.type === 'draw' ? ease : 1 - ease);
    const w = cdWidth * scale;
    const h = cdHeight * scale;

    ctx.drawImage(cards,
      1 + cdWidth * (anim.card % 14),
      1 + cdHeight * Math.floor(anim.card / 14),
      cdWidth, cdHeight,
      curX, curY, w, h);
  }

  // Done Button
  if (turn) {
    const btnRadius = 30;
    // Move to Left Side
    const btnX = 100;
    const btnY = canvas.height / 2;

    // Dynamic Color/Text
    let btnText = 'Done';
    const isWild = currentCardOnBoard !== null && (currentCardOnBoard % 14) === 13;
    const needsColor = isWild && !currentActiveColor;

    if (hasPlayed && !needsColor) {
      ctx.fillStyle = '#2ecc71'; // Green
      btnText = 'End Turn';
    } else if (needsColor) {
      ctx.fillStyle = '#e74c3c'; // Red
      btnText = 'Pick Color';
    } else {
      ctx.fillStyle = '#e74c3c'; // Red
      btnText = 'Play/Draw';
    }

    ctx.beginPath();
    ctx.arc(btnX, btnY, btnRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = "bold 14px sans-serif";
    ctx.fillText(btnText, btnX, btnY);
  }

  // Color Picker
  if (colorPickerActive) {
    chooseColor();
  }

  // Dialog
  if (currentDialogText) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, canvas.height / 2 - 50, canvas.width, 100);
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.font = "30px sans-serif";
    ctx.fillText(currentDialogText, canvas.width / 2, canvas.height / 2 + 10);
  }

  // My Name
  ctx.fillStyle = 'white';
  ctx.textAlign = 'left';
  ctx.font = "20px sans-serif";
  ctx.fillText(playerName, 20, canvas.height - 20);

  // Turn Indicator for Self
  if (turn) {
    ctx.fillStyle = '#ffeb3b'; // Bright yellow
    ctx.textAlign = 'center';
    ctx.font = "bold 30px 'Segoe UI', sans-serif";
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 4;
    ctx.fillText("YOUR TURN", canvas.width / 2, canvas.height - 200);
    ctx.shadowBlur = 0; // Reset shadow
  }

  // Toast Notification
  if (toastMessage) {
    ctx.save();
    ctx.font = "bold 20px 'Segoe UI', sans-serif";
    const textW = ctx.measureText(toastMessage).width;
    const padding = 30;
    const h = 60;
    const w = Math.max(200, textW + padding * 2);
    const x = canvas.width / 2 - w / 2;
    const y = 50;

    // Shadow
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 5;

    ctx.fillStyle = 'rgba(33, 33, 33, 0.95)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 15);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(toastMessage, canvas.width / 2, y + h / 2);
    ctx.restore();
  }

  requestAnimationFrame(drawScene);
}

function showToast(msg) {
  toastMessage = msg;
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastMessage = null;
  }, 3000);
}

function drawOpponents() {
  const others = opponents.filter(p => p.id !== myPeerId);
  if (others.length === 0) return;

  // Simple top layout for 1 opponent
  const opponent = others[0];
  const scales = getScales();
  const cardScale = scales.opponent;
  const cardW = cdWidth * cardScale;
  const cardH = cdHeight * cardScale;
  const spacing = 20;
  const totalWidth = (opponent.handSize - 1) * spacing + cardW;
  const startX = (canvas.width - totalWidth) / 2;
  const topY = 20;

  ctx.fillStyle = 'white';
  ctx.textAlign = 'left';
  ctx.fillText(opponent.name, 20, 40);

  for (let i = 0; i < opponent.handSize; i++) {
    ctx.drawImage(back, startX + i * spacing, topY, cardW, cardH);
  }

  // Turn Indicator
  if (currentTurnPlayerId === opponent.id) {
    ctx.textAlign = 'center';
    ctx.fillText(opponent.name + "'s Turn", canvas.width / 2, topY + cardH + 30);
  }
}

function drawHand() {
  if (hand.length === 0) return;
  const scales = getScales();
  const cardScale = scales.hand;
  const cardW = cdWidth * cardScale;
  const cardH = cdHeight * cardScale;
  const maxTotalWidth = canvas.width - 100;
  let spacing = scales.spacing;
  let totalWidth = (hand.length - 1) * spacing + cardW;
  if (totalWidth > maxTotalWidth) {
    spacing = (maxTotalWidth - cardW) / (hand.length - 1);
    totalWidth = maxTotalWidth;
  }
  let startX = (canvas.width - totalWidth) / 2;
  const y = canvas.height - cardH - 20;

  for (let i = 0; i < hand.length; i++) {
    let x = startX + i * spacing;
    ctx.drawImage(cards,
      1 + cdWidth * (hand[i] % 14),
      1 + cdHeight * Math.floor(hand[i] / 14),
      cdWidth, cdHeight,
      x, y, cardW, cardH);
  }
}

function chooseColor() {
  let cx = canvas.width / 2;
  let cy = canvas.height / 2;
  let r = cdHeight / 4;
  let colors = ['red', 'blue', 'green', 'gold'];

  for (let i = 0; i < 4; i++) {
    let startAngle = i * Math.PI / 2;
    let endAngle = startAngle + Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = 'black';
  ctx.textAlign = 'center';
  ctx.fillText("Choose Color", cx, cy);
}



init();
