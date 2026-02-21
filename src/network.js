import Peer from 'peerjs';
import { serializeGameState, applyGameState, applyPlayerUpdate, getPlayerUpdate, startRound, movePlayer, checkCollisions, getGameSpeed, createPlayer, MAX_LIVES, rebuildSpatialGrid, resetStaticSent } from './game.js';

// Physics runs at fixed 60Hz, broadcast at ~15fps (every 4th tick)
const PHYSICS_INTERVAL = 1000 / 60; // ~16.67ms
const BROADCAST_EVERY = 4;

class Network {
  constructor() {
    this.peer = null;
    this.connections = new Map(); // peerId -> connection
    this.hostId = null;
    this.isHost = false;
    this.myId = null;
    this.players = {};
    this.roomCode = null;
    this.roundActive = false;
    this.countdown = 0;
    this.roundStartTime = null;
    this.matchWinner = null;
    this.gameStarted = false;
    this.tickCounter = 0;
    this.callbacks = {};
    this.physicsInterval = null; // Fixed-timestep physics timer
  }

  on(event, callback) {
    this.callbacks[event] = callback;
  }

  emit(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event](data);
    }
  }

  // Create a new room (host)
  async createRoom(playerName) {
    this.isHost = true;
    this.roomCode = this.generateRoomCode();

    // Connect to signaling server and get our peer ID
    this.peer = new Peer(this.roomCode, {
      debug: 1
    });

    return new Promise((resolve, reject) => {
      this.peer.on('open', (id) => {
        console.log('Host created with room code:', id);
        this.myId = id;
        this.hostId = id;
        this.players[this.myId] = createPlayer(this.myId, 0, playerName);
        this.emit('roomCreated', { code: id });
        resolve(id);
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        reject(err);
      });

      this.peer.on('connection', (conn) => {
        this.handleConnection(conn);
      });
    });
  }

  // Join an existing room
  async joinRoom(roomCode, playerName) {
    this.isHost = false;
    this.hostId = roomCode;
    this.roomCode = roomCode;

    this.peer = new Peer({
      debug: 1
    });

    return new Promise((resolve, reject) => {
      this.peer.on('open', (id) => {
        this.myId = id;
        console.log('Connected to signaling server, my ID:', id);

        // Connect to host
        const conn = this.peer.connect(roomCode, { reliable: true });

        conn.on('open', () => {
          console.log('Connected to host:', roomCode);
          this.connections.set(roomCode, conn);

          // Send join request
          conn.send({
            type: 'join',
            playerId: this.myId,
            name: playerName
          });

          resolve();
        });

        conn.on('data', (data) => {
          this.handleMessage(conn, data);
        });

        conn.on('close', () => {
          this.emit('disconnected', {});
        });

        conn.on('error', (err) => {
          console.error('Connection error:', err);
          reject(err);
        });
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        reject(err);
      });
    });
  }

  handleConnection(conn) {
    console.log('Incoming connection from:', conn.peer);
    this.connections.set(conn.peer, conn);

    conn.on('data', (data) => {
      this.handleMessage(conn, data);
    });

    conn.on('close', () => {
      console.log('Connection closed:', conn.peer);
      this.connections.delete(conn.peer);

      // Remove player from game
      delete this.players[conn.peer];
      this.emit('playerLeft', { playerId: conn.peer });
    });
  }

  handleMessage(conn, data) {
    switch (data.type) {
      case 'join':
        // Host handles new player
        if (this.isHost) {
          const playerCount = Object.keys(this.players).length;
          this.players[data.playerId] = createPlayer(data.playerId, playerCount, data.name);

          // Reset static-sent tracking so new player gets full state
          resetStaticSent();

          // Send current game state to new player
          conn.send({
            type: 'init',
            playerId: data.playerId,
            state: serializeGameState(this.players, this.roundActive, this.countdown, this.roundStartTime, this.matchWinner)
          });

          // If game already started, new player joins as dead
          if (this.gameStarted) {
            this.players[data.playerId].alive = false;
          }

          this.emit('playerJoined', { playerId: data.playerId, name: data.name });
          this.broadcastPlayerList();

          // Send immediate state update to new player
          resetStaticSent();
          conn.send({
            type: 'state',
            state: serializeGameState(this.players, this.roundActive, this.countdown, this.roundStartTime, this.matchWinner)
          });
        }
        break;

      case 'init':
        // Client receives initial state
        this.myId = data.playerId;
        applyGameState(this.players, data.state);
        this.roundActive = data.state.ra !== undefined ? data.state.ra : data.state.roundActive;
        this.countdown = data.state.cd !== undefined ? data.state.cd : data.state.countdown;
        this.roundStartTime = data.state.rst !== undefined ? data.state.rst : data.state.roundStartTime;
        this.matchWinner = data.state.mw !== undefined ? data.state.mw : data.state.matchWinner;
        this.emit('init', { playerId: data.playerId });
        this.emit('stateUpdate', { state: data.state });
        break;

      case 'state':
        // Client receives game state update
        applyGameState(this.players, data.state);
        this.roundActive = data.state.ra !== undefined ? data.state.ra : data.state.roundActive;
        this.countdown = data.state.cd !== undefined ? data.state.cd : data.state.countdown;
        this.roundStartTime = data.state.rst !== undefined ? data.state.rst : data.state.roundStartTime;
        this.matchWinner = data.state.mw !== undefined ? data.state.mw : data.state.matchWinner;
        this.emit('stateUpdate', { state: data.state });
        break;

      case 'gameStart':
        // Client receives game start signal
        if (!this.isHost) {
          this.gameStarted = true;
          this.emit('gameStart', {});
        }
        break;

      case 'input':
        // Host receives player input from client
        if (this.isHost && data.update) {
          applyPlayerUpdate(this.players, data.update);
        }
        break;

      case 'playerList':
        // Client receives updated player list
        if (!this.isHost && data.players) {
          for (const id in data.players) {
            const ps = data.players[id];
            if (this.players[id]) {
              this.players[id].score = ps.score;
              this.players[id].lives = ps.lives !== undefined ? ps.lives : this.players[id].lives;
              this.players[id].alive = ps.alive;
            } else {
              this.players[id] = createPlayer(id, Object.keys(this.players).length, ps.name);
              this.players[id].color = ps.color;
              this.players[id].score = ps.score;
              this.players[id].lives = ps.lives !== undefined ? ps.lives : MAX_LIVES;
              this.players[id].alive = ps.alive;
            }
          }
          this.emit('playerList', { players: data.players });
        }
        break;

      case 'restart':
        // Host receives restart request from client
        if (this.isHost && this.matchWinner) {
          this.startGame();
        }
        break;
    }
  }

  // Host: broadcast state to all clients
  broadcastState() {
    if (!this.isHost) return;

    const state = serializeGameState(
      this.players,
      this.roundActive,
      this.countdown,
      this.roundStartTime,
      this.matchWinner
    );

    const msg = { type: 'state', state };
    for (const [peerId, conn] of this.connections) {
      if (conn.open) {
        conn.send(msg);
      }
    }

    this.emit('stateUpdate', { state });
  }

  // Host: broadcast player list
  broadcastPlayerList() {
    if (!this.isHost) return;

    const list = {};
    for (const id in this.players) {
      list[id] = {
        id: this.players[id].id,
        name: this.players[id].name,
        score: this.players[id].score,
        lives: this.players[id].lives,
        color: this.players[id].color,
        alive: this.players[id].alive
      };
    }

    const msg = { type: 'playerList', players: list };
    for (const [peerId, conn] of this.connections) {
      if (conn.open) {
        conn.send(msg);
      }
    }

    this.emit('playerList', { players: list });
  }

  // Send input to host (client)
  sendInput(turning) {
    if (this.isHost) {
      // Apply directly if host
      const p = this.players[this.myId];
      if (p) p.turning = turning;
    } else {
      // Send to host
      const conn = this.connections.get(this.hostId);
      if (conn && conn.open) {
        conn.send({
          type: 'input',
          update: { id: this.myId, turning }
        });
      }
    }
  }

  // Send restart request to host (client)
  sendRestart() {
    if (!this.isHost) {
      const conn = this.connections.get(this.hostId);
      if (conn && conn.open) {
        conn.send({ type: 'restart' });
      }
    }
  }

  // Start game (host)
  startGame() {
    if (!this.isHost) return;
    if (Object.keys(this.players).length < 2) {
      this.emit('error', { message: 'Need at least 2 players!' });
      return;
    }

    this.gameStarted = true;
    this.roundActive = false;
    this.countdown = 3;
    this.matchWinner = null;

    // Reset all player lives for new match
    for (const id in this.players) {
      this.players[id].lives = MAX_LIVES;
      this.players[id].score = 0;
    }

    // Reset network serialization state
    resetStaticSent();

    // Notify all clients - include initial countdown state
    for (const [peerId, conn] of this.connections) {
      if (conn.open) {
        conn.send({ type: 'gameStart' });
      }
    }

    // Broadcast initial countdown immediately so clients see "3"
    this.broadcastState();

    this.emit('gameStart', {});

    // Start countdown
    this.runCountdown();
  }

  // Run countdown then start round
  runCountdown() {
    if (!this.isHost) return;

    const interval = setInterval(() => {
      this.countdown--;

      // Broadcast countdown to all clients during countdown phase
      resetStaticSent(); // Ensure new state is fully sent
      this.broadcastState();

      if (this.countdown <= 0) {
        clearInterval(interval);
        this.startRound();
      }
    }, 1000);
  }

  // Start round
  startRound() {
    if (!this.isHost) return;

    startRound(this.players);
    this.roundActive = true;
    this.roundStartTime = Date.now();
    this.matchWinner = null;

    // Start fixed-timestep physics loop
    this.startPhysicsLoop();
  }

  // Start the fixed-timestep physics loop (decoupled from rendering)
  startPhysicsLoop() {
    // Clean up any existing interval
    this.stopPhysicsLoop();

    this.tickCounter = 0;
    this.physicsInterval = setInterval(() => {
      this.physicsTick();
    }, PHYSICS_INTERVAL);
  }

  stopPhysicsLoop() {
    if (this.physicsInterval) {
      clearInterval(this.physicsInterval);
      this.physicsInterval = null;
    }
  }

  // Single physics tick — runs at fixed 60Hz
  physicsTick() {
    if (!this.isHost || !this.roundActive) {
      this.stopPhysicsLoop();
      return;
    }

    const speed = getGameSpeed(this.roundStartTime);

    // Track who is alive before this tick
    const wasAlive = {};
    for (const id in this.players) {
      wasAlive[id] = this.players[id].alive;
    }

    // Move all alive players
    for (const id in this.players) {
      const p = this.players[id];
      if (p.alive) {
        movePlayer(p, speed);
      }
    }

    // Check collisions (uses spatial grid internally)
    checkCollisions(this.players);

    // Decrement lives for players who just died this tick
    for (const id in this.players) {
      if (wasAlive[id] && !this.players[id].alive) {
        this.players[id].lives = Math.max(0, this.players[id].lives - 1);
      }
    }

    // Check round end: count players still alive
    let aliveCount = 0;
    for (const id in this.players) {
      if (this.players[id].alive) aliveCount++;
    }

    if (aliveCount <= 1) {
      this.roundActive = false;
      this.stopPhysicsLoop();

      // Check match end: count players with lives remaining
      let withLivesCount = 0;
      let lastWithLivesId = null;
      for (const id in this.players) {
        if (this.players[id].lives > 0) {
          withLivesCount++;
          lastWithLivesId = id;
        }
      }

      if (withLivesCount <= 1) {
        // Match over - we have a winner
        if (withLivesCount === 1) {
          this.matchWinner = lastWithLivesId;
        }
        resetStaticSent();
        this.broadcastPlayerList();
        this.broadcastState();
      } else {
        // More rounds to play
        resetStaticSent();
        this.broadcastPlayerList();
        this.broadcastState();

        // Auto-restart after 3 seconds
        setTimeout(() => {
          if (this.gameStarted) {
            this.countdown = 3;
            resetStaticSent();
            this.broadcastState();
            this.runCountdown();
          }
        }, 3000);
      }
    }

    // Broadcast at ~15fps
    this.tickCounter++;
    if (this.tickCounter >= BROADCAST_EVERY) {
      this.tickCounter = 0;
      this.broadcastState();
    }
  }

  // Host game loop - now a no-op since physics runs on its own timer
  gameLoop() {
    // Physics is now handled by the fixed-timestep interval in physicsTick()
    // This method is kept for backwards compatibility but does nothing
  }

  // Generate a simple room code
  generateRoomCode() {
    let code;
    do {
      code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (code.length < 4);
    return code;
  }

  // Get current player
  getMyPlayer() {
    return this.players[this.myId];
  }

  // Disconnect
  disconnect() {
    this.stopPhysicsLoop();
    if (this.peer) {
      this.peer.destroy();
    }
    this.connections.clear();
    this.players = {};
  }
}

export default Network;
