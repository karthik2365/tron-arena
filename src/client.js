import Network from './network.js';
import { CANVAS_W, CANVAS_H, getGameSpeed, applyGameState, serializeGameState, MAX_LIVES, TRAIL_MAX } from './game.js';

// DOM Elements
const nameInput = document.getElementById("playerName");
const hostBtn = document.getElementById("hostBtn");
const openJoin = document.getElementById("openJoin");
const joinArea = document.getElementById("joinArea");
const joinBtn = document.getElementById("joinBtn");
const lobby = document.getElementById("lobby");
const startBtn = document.getElementById("startGame");
const roomCodeText = document.getElementById("roomCodeDisplay");
const scoreBoard = document.getElementById("scoreBoard");
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const menuEl = document.getElementById("menu");
const gameArea = document.getElementById("gameArea");
const countdownEl = document.getElementById("countdown");
const winnerOverlay = document.getElementById("winnerOverlay");
const winnerNameEl = document.getElementById("winnerName");
const playerListEl = document.getElementById("playerList");
const waitingText = document.getElementById("waitingText");
const errorToast = document.getElementById("errorToast");
const controlsHelp = document.getElementById("controlsHelp");
const speedHud = document.getElementById("speedHud");
const speedValueEl = document.getElementById("speedValue");
const speedBar = document.getElementById("speedBar");
const timerValueEl = document.getElementById("timerValue");
const leaderboard = document.getElementById("leaderboard");
const leaderboardEntries = document.getElementById("leaderboardEntries");
const restartBtn = document.getElementById("restartBtn");
const quitBtn = document.getElementById("quitBtn");

// Game state
const network = new Network();
let myId = null;
let isGameActive = false;
let lastCountdown = -1;
let currentWinner = null;
let lastScoreHtml = "";

// Static grid canvas
const gridCanvas = document.createElement('canvas');
gridCanvas.width = CANVAS_W;
gridCanvas.height = CANVAS_H;
const gridCtx = gridCanvas.getContext('2d');

// Trail canvas array for offscreen buffer (improves performance heavily)
const trailCanvas = document.createElement('canvas');
trailCanvas.width = CANVAS_W;
trailCanvas.height = CANVAS_H;
const trailCtx = trailCanvas.getContext('2d');

// Glow cache
const glowCache = {};

function showError(msg) {
    errorToast.textContent = msg;
    errorToast.classList.add('show');
    setTimeout(() => errorToast.classList.remove('show'), 3000);
}

function getGlowImage(color) {
    if (glowCache[color]) return glowCache[color];

    const size = 48;
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = size;
    glowCanvas.height = size;
    const gCtx = glowCanvas.getContext('2d');

    const gradient = gCtx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.4, color + '88');
    gradient.addColorStop(1, 'transparent');

    gCtx.fillStyle = gradient;
    gCtx.fillRect(0, 0, size, size);

    glowCache[color] = glowCanvas;
    return glowCanvas;
}

// Render static grid once
function renderStaticGrid() {
    gridCtx.strokeStyle = 'rgba(255, 140, 0, 0.03)';
    gridCtx.lineWidth = 1;

    for (let x = 0; x <= CANVAS_W; x += 50) {
        gridCtx.beginPath();
        gridCtx.moveTo(x, 0);
        gridCtx.lineTo(x, CANVAS_H);
        gridCtx.stroke();
    }

    for (let y = 0; y <= CANVAS_H; y += 50) {
        gridCtx.beginPath();
        gridCtx.moveTo(0, y);
        gridCtx.lineTo(CANVAS_W, y);
        gridCtx.stroke();
    }
}

// Draw all trails correctly from start to end points
function drawAllTrails() {
    trailCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const players = network.players;

    for (const id in players) {
        const p = players[id];
        if (!p || p.trailLen < 2) continue;
        if (p.lives !== undefined && p.lives <= 0) continue;

        const alphaBase = p.alive ? 1 : 0.12;

        // Draw outer glow
        trailCtx.strokeStyle = p.color;
        trailCtx.lineWidth = 3;
        trailCtx.globalAlpha = 0.6 * alphaBase;
        trailCtx.lineCap = 'round';
        trailCtx.lineJoin = 'round';
        trailCtx.beginPath();

        let idx = p.trailStart % TRAIL_MAX;
        trailCtx.moveTo(p.trailX[idx], p.trailY[idx]);

        for (let i = 1; i < p.trailLen; i++) {
            idx = (p.trailStart + i) % TRAIL_MAX;
            trailCtx.lineTo(p.trailX[idx], p.trailY[idx]);
        }
        trailCtx.stroke();

        // Draw white core on same path
        trailCtx.strokeStyle = '#ffffff';
        trailCtx.lineWidth = 1.5;
        trailCtx.globalAlpha = 0.85 * alphaBase;
        trailCtx.stroke();
    }
    trailCtx.globalAlpha = 1;
}

// Main draw function - 60fps (rendering only, no physics)
function draw() {
    const players = network.players;

    // Clear
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Static grid
    ctx.drawImage(gridCanvas, 0, 0);

    // Rebuild trails entirely every frame (safely handles the trailing snake length and wraps)
    drawAllTrails();

    // Stamp cached trails
    ctx.drawImage(trailCanvas, 0, 0);

    // Draw player heads — skip eliminated players
    for (const id in players) {
        const p = players[id];
        if (p.lives !== undefined && p.lives <= 0) continue;

        if (p.alive) {
            const angle = p.angle || 0;
            const hx = p.x;
            const hy = p.y;
            const size = 7;

            // Glow
            const glow = getGlowImage(p.color);
            ctx.drawImage(glow, hx - 24, hy - 24);

            // Triangle head
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.moveTo(hx + Math.cos(angle) * size, hy + Math.sin(angle) * size);
            ctx.lineTo(hx + Math.cos(angle + 2.4) * size * 0.6, hy + Math.sin(angle + 2.4) * size * 0.6);
            ctx.lineTo(hx + Math.cos(angle - 2.4) * size * 0.6, hy + Math.sin(angle - 2.4) * size * 0.6);
            ctx.closePath();
            ctx.fill();

            // Center dot
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(hx, hy, 2, 0, Math.PI * 2);
            ctx.fill();

            // Name label
            ctx.fillStyle = p.color;
            ctx.font = "bold 11px 'Chakra Petch', sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(id === myId ? "YOU" : p.name, hx, hy - 16);
        } else if (p.lives === undefined || p.lives > 0) {
            // Death X marker - only show for players still in the match
            ctx.globalAlpha = 0.4;
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p.x - 5, p.y - 5);
            ctx.lineTo(p.x + 5, p.y + 5);
            ctx.moveTo(p.x + 5, p.y - 5);
            ctx.lineTo(p.x - 5, p.y + 5);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }

    // Border
    ctx.strokeStyle = "rgba(255, 140, 0, 0.15)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, CANVAS_W, CANVAS_H);

    requestAnimationFrame(draw);
}

// Update scoreboard - show lives as X/6
function updateScore() {
    const players = network.players;
    let html = "";
    const sorted = Object.values(players).sort((a, b) => b.lives - a.lives);

    for (const p of sorted) {
        const isMe = p.id === myId;
        const lives = p.lives !== undefined ? p.lives : MAX_LIVES;
        const eliminated = lives <= 0;
        const opacity = eliminated ? 'opacity:0.3;' : '';
        html += `<div class="score-entry ${isMe ? "score-you" : ""}" style="${opacity}">
            <span class="score-name" style="color:${p.color}">${isMe ? "YOU" : p.name}</span>
            <span class="score-value" style="color:${p.color}">${lives}/${MAX_LIVES}</span>
            <span class="score-dot" style="background:${p.color};${p.alive ? "" : "opacity:0.2"}"></span>
        </div>`;
    }

    if (html !== lastScoreHtml) {
        lastScoreHtml = html;
        scoreBoard.innerHTML = html;
    }
}

// Show leaderboard
function showLeaderboard() {
    const players = network.players;
    const sorted = Object.values(players).sort((a, b) => b.lives - a.lives);

    let html = "";
    sorted.forEach((p, i) => {
        const lives = p.lives !== undefined ? p.lives : 0;
        const eliminated = lives <= 0;
        html += `<div class="leaderboard-entry" style="border-left-color: ${p.color};${eliminated ? 'opacity:0.4;' : ''}">
            <span class="leaderboard-rank">#${i + 1}</span>
            <span class="leaderboard-name" style="color: ${p.color}">${p.id === myId ? p.name + ' (YOU)' : p.name}</span>
            <span class="leaderboard-score" style="color: ${p.color}">${lives}/${MAX_LIVES}</span>
        </div>`;
    });

    leaderboardEntries.innerHTML = html;
    leaderboard.classList.add('show');
    // Hide regular scoreboard to avoid overlap
    scoreBoard.style.display = 'none';
}

// Update speed HUD
function updateSpeedHud() {
    if (!network.roundActive || !network.roundStartTime) {
        speedHud.style.display = 'none';
        return;
    }

    speedHud.style.display = 'block';
    const speed = getGameSpeed(network.roundStartTime);
    speedValueEl.textContent = speed.toFixed(1) + 'x';

    // Update speed bar (2.5 to 8)
    const percent = ((speed - 2.5) / (8 - 2.5)) * 100;
    speedBar.style.width = percent + '%';

    // Speed styling
    speedValueEl.classList.remove('fast', 'danger');
    if (speed >= 6) {
        speedValueEl.classList.add('danger');
    } else if (speed >= 4.5) {
        speedValueEl.classList.add('fast');
    }

    // Timer
    const elapsed = Math.floor((Date.now() - network.roundStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    timerValueEl.textContent = mins + ':' + secs;
}

// Update player list in lobby
function updatePlayerList() {
    const players = network.players;
    playerListEl.innerHTML = "";

    for (const id in players) {
        const p = players[id];
        const li = document.createElement("li");
        li.textContent = p.name + (id === myId ? " (YOU)" : "");
        li.style.borderLeftColor = p.color;
        li.style.color = p.color;
        playerListEl.appendChild(li);
    }
}

// Show/hide UI sections
function showMenu() {
    menuEl.style.display = 'block';
    gameArea.style.display = 'none';
    countdownEl.classList.remove('visible');
}

function showLobby() {
    menuEl.style.display = 'block';
    gameArea.style.display = 'none';
    lobby.style.display = 'block';
    joinArea.style.display = 'none';
    roomCodeText.textContent = network.roomCode;
    updatePlayerList();
    countdownEl.classList.remove('visible');

    // Show start button only for host
    if (network.isHost && Object.keys(network.players).length >= 2) {
        startBtn.style.display = 'inline-block';
    } else {
        startBtn.style.display = 'none';
    }
}

function showGame() {
    menuEl.style.display = 'none';
    gameArea.style.display = 'block';
    winnerOverlay.classList.remove('show');
    leaderboard.classList.remove('show');
    scoreBoard.style.display = '';
    isGameActive = true;
    lastCountdown = -1;
    currentWinner = null;
}

// Network callbacks
network.on('init', (data) => {
    myId = data.playerId;
    console.log('Initialized with ID:', myId);
    showLobby();
});

network.on('roomCreated', (data) => {
    console.log('Room created:', data.code);
    roomCodeText.textContent = data.code;
    showLobby();
});

network.on('playerJoined', (data) => {
    console.log('Player joined:', data.name);
    updatePlayerList();
    // Show start button if host and 2+ players
    if (network.isHost && Object.keys(network.players).length >= 2) {
        startBtn.style.display = 'inline-block';
    }
});

network.on('playerLeft', (data) => {
    console.log('Player left:', data.playerId);
    updatePlayerList();
});

network.on('gameStart', () => {
    // Show game area and ensure countdown is visible
    showGame();
    // Force initial render to show any pending countdown
    if (network.countdown > 0) {
        countdownEl.textContent = network.countdown;
        countdownEl.classList.add('visible');
    }
});

network.on('error', (data) => {
    showError(data.message);
});

network.on('disconnected', () => {
    showError('DISCONNECTED FROM SERVER');
    setTimeout(() => {
        showMenu();
        lobby.style.display = 'none';
    }, 2000);
});

// State update handler - apply game state from host
network.on('stateUpdate', (data) => {
    const state = data.state;

    // Apply the game state to local players ONLY if we are a client.
    // The host already has the authoritative physics state.
    if (!network.isHost) {
        applyGameState(network.players, state);
    }

    // Support both compact and old format
    const countdown = state.cd !== undefined ? state.cd : state.countdown;
    const matchWinner = state.mw !== undefined ? state.mw : state.matchWinner;
    const roundActive = state.ra !== undefined ? state.ra : state.roundActive;
    const roundStartTime = state.rst !== undefined ? state.rst : state.roundStartTime;

    // Update countdown - show when game starts countdown
    if (countdown !== lastCountdown) {
        lastCountdown = countdown;
        if (countdown > 0) {
            countdownEl.textContent = countdown;
            countdownEl.classList.add('visible');
        } else {
            countdownEl.classList.remove('visible');
        }
    }

    // Update winner
    if (matchWinner && matchWinner !== currentWinner) {
        currentWinner = matchWinner;
        const winner = network.players[currentWinner];
        if (winner) {
            winnerNameEl.textContent = winner.name;
            winnerOverlay.classList.add('show');

            // Reset button animation so it replays
            const actions = winnerOverlay.querySelector('.match-end-actions');
            if (actions) {
                actions.style.animation = 'none';
                actions.offsetHeight; // trigger reflow
                actions.style.animation = '';
            }

            // Show leaderboard after winner
            setTimeout(showLeaderboard, 2000);
        }
    } else if (!matchWinner && currentWinner) {
        // New match started, clear winner
        currentWinner = null;
        winnerOverlay.classList.remove('show');
    }

    // Update local state
    network.roundActive = roundActive;
    network.roundStartTime = roundStartTime;
    network.countdown = countdown;

    updateScore();
    updateSpeedHud();
    // Don't force full trail redraw on every state update — incremental rendering handles it
});

// Button handlers
hostBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) { showError("ENTER YOUR CALLSIGN"); nameInput.focus(); return; }
    network.createRoom(name);
};

joinBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) { showError("ENTER YOUR CALLSIGN"); nameInput.focus(); return; }
    const code = document.getElementById("joinCode").value.trim();
    if (!code) { showError("ENTER ROOM CODE"); return; }
    network.joinRoom(code, name);
};

openJoin.onclick = () => {
    joinArea.style.display = joinArea.style.display === "block" ? "none" : "block";
};

startBtn.onclick = () => {
    network.startGame();
};

restartBtn.onclick = () => {
    if (network.isHost) {
        // Host restarts the match
        winnerOverlay.classList.remove('show');
        leaderboard.classList.remove('show');
        currentWinner = null;
        network.startGame();
    } else {
        // Client sends restart request to host
        network.sendRestart();
    }
};

quitBtn.onclick = () => {
    // Disconnect and go back to menu
    network.disconnect();
    isGameActive = false;
    currentWinner = null;
    lastCountdown = -1;
    lastScoreHtml = "";
    winnerOverlay.classList.remove('show');
    leaderboard.classList.remove('show');
    showMenu();
    lobby.style.display = 'none';
};

// Keyboard controls
const keysDown = new Set();

function updateTurnDirection() {
    if (!isGameActive) return;
    const left = keysDown.has("ArrowLeft") || keysDown.has("a") || keysDown.has("A");
    const right = keysDown.has("ArrowRight") || keysDown.has("d") || keysDown.has("D");
    let dir = 0;
    if (left && !right) dir = -1;
    if (right && !left) dir = 1;
    network.sendInput(dir);
}

document.addEventListener("keydown", (e) => {
    if (!isGameActive) return;
    if (["ArrowLeft", "ArrowRight", "a", "A", "d", "D"].includes(e.key)) {
        e.preventDefault();
        if (!keysDown.has(e.key)) {
            keysDown.add(e.key);
            updateTurnDirection();
        }
    }
});

document.addEventListener("keyup", (e) => {
    if (keysDown.has(e.key)) {
        keysDown.delete(e.key);
        updateTurnDirection();
    }
});

// Initialize
renderStaticGrid();
draw();
showMenu();
