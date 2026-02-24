// Game constants
export const CANVAS_W = 1400;
export const CANVAS_H = 900;
export const BASE_SPEED = 2.5;
export const SPEED_INCREMENT = 0.5;
export const SPEED_INTERVAL = 10;
export const MAX_SPEED = 8;
export const TURN_SPEED = 0.045;
export const TRAIL_MAX = 600;
export const COLLISION_RADIUS = 4;
export const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;
export const COLLISION_SKIP_OWN = 20;
export const MAX_LIVES = 6;

// Spatial grid constants - cell size should be >= COLLISION_RADIUS * 2
const GRID_CELL_SIZE = 16;
const GRID_COLS = Math.ceil(CANVAS_W / GRID_CELL_SIZE);
const GRID_ROWS = Math.ceil(CANVAS_H / GRID_CELL_SIZE);
const GRID_TOTAL = GRID_COLS * GRID_ROWS;

// Spawn positions for up to 8 players
export const spawnConfigs = [
  { x: 250, y: 200, angle: Math.PI * 0.25 },
  { x: 1150, y: 200, angle: Math.PI * 0.75 },
  { x: 1150, y: 700, angle: Math.PI * 1.25 },
  { x: 250, y: 700, angle: Math.PI * 1.75 },
  { x: 700, y: 100, angle: Math.PI * 0.5 },
  { x: 700, y: 800, angle: Math.PI * 1.5 },
  { x: 100, y: 450, angle: 0 },
  { x: 1300, y: 450, angle: Math.PI },
];

export const COLORS = ["#ff8c00", "#00bfff", "#ff2e63", "#39ff14", "#e040fb", "#ffeb3b", "#00e5ff", "#ff6e40"];

// ─── Spatial Grid ────────────────────────────────────────────
// OPTIMIZATION: Use a flat Uint8Array bitfield instead of array-per-cell
// Each cell stores a single byte: 0 = empty, 1+ = occupied (player index + 1)
// This gives O(1) collision check and bounded memory
let spatialBitfield = null;
let gridDirty = true;

// For detailed collision checking, we still need point data
// But we use a capped pool to prevent unbounded growth
const MAX_GRID_ENTRIES = 8 * TRAIL_MAX; // 8 players × 600 points max
let gridPointsX = new Float32Array(MAX_GRID_ENTRIES);
let gridPointsY = new Float32Array(MAX_GRID_ENTRIES);
let gridPointsPlayer = new Uint8Array(MAX_GRID_ENTRIES); // player index
let gridPointsTrailPos = new Uint16Array(MAX_GRID_ENTRIES); // trail position
let gridPointCount = 0;

// Cell-to-points mapping: each cell stores start index and count in the points arrays
// Format: [startIdx, count] pairs, but we use a simpler approach with the bitfield
let cellToBitfield = null;

function createBitfield() {
  return new Uint8Array(GRID_TOTAL);
}

function clearBitfield() {
  if (spatialBitfield) {
    spatialBitfield.fill(0);
  }
  gridPointCount = 0;
}

function getCellIndex(x, y) {
  const col = (x / GRID_CELL_SIZE) | 0;
  const row = (y / GRID_CELL_SIZE) | 0;
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return -1;
  return row * GRID_COLS + col;
}

// Rebuild spatial grid from all player trails
export function rebuildSpatialGrid(players) {
  if (!spatialBitfield) spatialBitfield = createBitfield();
  clearBitfield();

  let playerIdx = 0;
  for (const id in players) {
    const p = players[id];
    playerIdx++;
    if (!p.alive) continue;

    const len = p.trailLen;
    for (let i = 0; i < len; i++) {
      const idx = (p.trailStart + i) % TRAIL_MAX;
      const cellIdx = getCellIndex(p.trailX[idx], p.trailY[idx]);
      if (cellIdx >= 0) {
        // Mark cell as occupied by this player
        spatialBitfield[cellIdx] = playerIdx;
        
        // Store point data if we have room (for precise collision)
        if (gridPointCount < MAX_GRID_ENTRIES) {
          gridPointsX[gridPointCount] = p.trailX[idx];
          gridPointsY[gridPointCount] = p.trailY[idx];
          gridPointsPlayer[gridPointCount] = playerIdx;
          gridPointsTrailPos[gridPointCount] = i;
          gridPointCount++;
        }
      }
    }
  }
  gridDirty = false;
}

// Insert a single new trail point into the grid (incremental update)
function gridInsertPoint(playerId, bufferIdx, trailPosition, x, y, playerIndex) {
  if (!spatialBitfield) return;
  const cellIdx = getCellIndex(x, y);
  if (cellIdx >= 0) {
    spatialBitfield[cellIdx] = playerIndex || 1;
    
    // Store detailed point if we have room
    if (gridPointCount < MAX_GRID_ENTRIES) {
      gridPointsX[gridPointCount] = x;
      gridPointsY[gridPointCount] = y;
      gridPointsPlayer[gridPointCount] = playerIndex || 1;
      gridPointsTrailPos[gridPointCount] = trailPosition;
      gridPointCount++;
    }
  }
}

// Create a new player
export function createPlayer(id, index, name) {
  return {
    id,
    name: typeof name === "string" && name.trim().length > 0 ? name.trim() : "Player",
    x: CANVAS_W / 2,
    y: CANVAS_H / 2,
    angle: 0,
    turning: 0,
    trailX: new Float32Array(TRAIL_MAX),
    trailY: new Float32Array(TRAIL_MAX),
    trailLen: 0,
    trailStart: 0,
    trailSentCount: 0,
    alive: true,
    score: 0,
    lives: MAX_LIVES,
    color: COLORS[index % COLORS.length],
    spawnIndex: index,
  };
}

// Calculate current game speed based on time
export function getGameSpeed(roundStartTime) {
  if (!roundStartTime) return BASE_SPEED;
  const elapsed = (Date.now() - roundStartTime) / 1000;
  const boosts = (elapsed / SPEED_INTERVAL) | 0;
  return Math.min(BASE_SPEED + boosts * SPEED_INCREMENT, MAX_SPEED);
}

// Trail helpers (circular buffer)
export function trailPush(p, x, y) {
  if (p.trailLen < TRAIL_MAX) {
    const idx = (p.trailStart + p.trailLen) % TRAIL_MAX;
    p.trailX[idx] = x;
    p.trailY[idx] = y;
    p.trailLen++;
    gridInsertPoint(p.id, idx, p.trailLen - 1, x, y, p.spawnIndex + 1);
  } else {
    p.trailX[p.trailStart] = x;
    p.trailY[p.trailStart] = y;
    // When wrapping, we need a full grid rebuild since we're overwriting old points
    gridDirty = true;
    p.trailStart = (p.trailStart + 1) % TRAIL_MAX;
    if (p.trailSentCount > 0) p.trailSentCount--;
  }
}

export function trailGetIndex(p, i) {
  return (p.trailStart + i) % TRAIL_MAX;
}

// Move player
export function movePlayer(p, speed) {
  p.angle += p.turning * TURN_SPEED;
  p.x += Math.cos(p.angle) * speed;
  p.y += Math.sin(p.angle) * speed;

  trailPush(p, p.x, p.y);

  if (p.x < 0 || p.x > CANVAS_W || p.y < 0 || p.y > CANVAS_H) {
    p.alive = false;
  }
}

// Check collisions using spatial bitfield — O(1) cell lookup + local point check
export function checkCollisions(players) {
  // Rebuild grid if dirty (happens when any trail wraps around)
  if (gridDirty || !spatialBitfield) {
    rebuildSpatialGrid(players);
  }

  const playerIds = Object.keys(players);
  const aliveList = [];
  const playerIndexMap = {}; // id -> index (1-based)
  
  let idx = 0;
  for (let k = 0; k < playerIds.length; k++) {
    const p = players[playerIds[k]];
    idx++;
    playerIndexMap[p.id] = idx;
    if (p.alive) aliveList.push(p);
  }

  for (let a = 0; a < aliveList.length; a++) {
    const p = aliveList[a];
    const px = p.x;
    const py = p.y;
    const myIndex = playerIndexMap[p.id];

    // Check the cell the player is in and its 8 neighbors
    const col = (px / GRID_CELL_SIZE) | 0;
    const row = (py / GRID_CELL_SIZE) | 0;
    let hit = false;

    for (let dr = -1; dr <= 1 && !hit; dr++) {
      for (let dc = -1; dc <= 1 && !hit; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;

        const cellIdx = nr * GRID_COLS + nc;
        
        // Quick check: is anyone in this cell?
        if (spatialBitfield[cellIdx] === 0) continue;

        // Someone is here - do precise collision check against all points
        // We iterate through the stored points looking for ones in this neighborhood
        for (let j = 0; j < gridPointCount && !hit; j++) {
          const ptX = gridPointsX[j];
          const ptY = gridPointsY[j];
          
          // Quick cell check
          const ptCellIdx = getCellIndex(ptX, ptY);
          if (ptCellIdx !== cellIdx) continue;
          
          const ptPlayerIdx = gridPointsPlayer[j];
          const trailPos = gridPointsTrailPos[j];
          const isSelf = ptPlayerIdx === myIndex;

          // Skip own recent trail points
          if (isSelf) {
            if (trailPos >= p.trailLen - COLLISION_SKIP_OWN) continue;
          } else {
            // Find the other player and check if this point is recent
            if (trailPos >= 598) continue; // Skip very recent points
          }

          const dx = px - ptX;
          const dy = py - ptY;
          
          // Fast AABB reject
          if (dx > COLLISION_RADIUS || dx < -COLLISION_RADIUS ||
              dy > COLLISION_RADIUS || dy < -COLLISION_RADIUS) continue;

          if (dx * dx + dy * dy < COLLISION_RADIUS_SQ) {
            hit = true;
            break;
          }
        }
      }
    }

    if (hit) p.alive = false;
  }
}

// Start a new round - only players with lives > 0 participate
export function startRound(players) {
  let i = 0;
  for (const id in players) {
    const p = players[id];
    if (p.lives <= 0) {
      p.alive = false;
      p.trailLen = 0;
      p.trailStart = 0;
      p.trailSentCount = 0;
      continue;
    }
    const spawn = spawnConfigs[i % spawnConfigs.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.angle = spawn.angle;
    p.turning = 0;
    p.trailLen = 0;
    p.trailStart = 0;
    p.trailSentCount = 0;
    p.alive = true;
    i++;
  }

  // Reset spatial grid for new round
  gridDirty = true;
  if (spatialBitfield) clearBitfield();
}

// Track whether we've sent static info for each player (name, color, spawnIndex)
const staticSentTo = new Set();

// Pre-allocated buffer for trail serialization (avoids GC pressure)
// Max 8 players × 600 trail points × 2 coords = 9600 integers max per full sync
// But delta updates are much smaller (typically <100 points total)
const TRAIL_BUFFER_SIZE = 1200; // Should handle most delta updates
const trailSerializeBuffer = new Int16Array(TRAIL_BUFFER_SIZE);

export function resetStaticSent() {
  staticSentTo.clear();
}

// Serialize game state for network transmission - with delta trail encoding
// Uses pre-allocated buffers to avoid GC pressure
export function serializeGameState(players, roundActive, countdown, roundStartTime, matchWinner) {
  const state = {
    p: {},  // players (shortened key)
    ra: roundActive,
    cd: countdown,
    rst: roundStartTime,
    mw: matchWinner,
    t: Date.now()
  };

  const sendStatic = !staticSentTo.has('_broadcast');

  for (const id in players) {
    const p = players[id];

    // Only send new trail points since last broadcast (delta encoding)
    const newCount = p.trailLen - p.trailSentCount;
    let trailData = null;
    
    if (newCount > 0) {
      // Use pre-allocated buffer if it fits, otherwise fall back to new array
      const dataLen = newCount * 2;
      if (dataLen <= TRAIL_BUFFER_SIZE) {
        // Fast path: reuse buffer, then slice (creates small typed array view)
        for (let i = 0; i < newCount; i++) {
          const trailIdx = p.trailSentCount + i;
          const idx = (p.trailStart + trailIdx) % TRAIL_MAX;
          trailSerializeBuffer[i * 2] = (p.trailX[idx] * 10 + 0.5) | 0;
          trailSerializeBuffer[i * 2 + 1] = (p.trailY[idx] * 10 + 0.5) | 0;
        }
        // Create a regular array for JSON compatibility (typed arrays don't serialize well)
        trailData = Array.from(trailSerializeBuffer.subarray(0, dataLen));
      } else {
        // Fallback for large updates (rare)
        trailData = new Array(dataLen);
        for (let i = 0; i < newCount; i++) {
          const trailIdx = p.trailSentCount + i;
          const idx = (p.trailStart + trailIdx) % TRAIL_MAX;
          trailData[i * 2] = (p.trailX[idx] * 10 + 0.5) | 0;
          trailData[i * 2 + 1] = (p.trailY[idx] * 10 + 0.5) | 0;
        }
      }
    }

    // Mark these points as sent
    p.trailSentCount = p.trailLen;

    const pd = {
      x: (p.x * 10 + 0.5) | 0,   // 1 decimal precision, integer encoded
      y: (p.y * 10 + 0.5) | 0,
      a: (p.angle * 1000 + 0.5) | 0,  // 3 decimal precision
      tu: p.turning,
      tl: p.trailLen,
      ts: p.trailStart,
      tc: p.trailSentCount,
      al: p.alive,
      s: p.score,
      l: p.lives,
    };

    // Only include trail data if there are new points
    if (trailData) pd.tr = trailData;

    // Include static fields on first broadcast or if not yet sent
    if (sendStatic) {
      pd.id = p.id;
      pd.n = p.name;
      pd.c = p.color;
      pd.si = p.spawnIndex;
    }

    state.p[id] = pd;
  }

  if (sendStatic) staticSentTo.add('_broadcast');

  return state;
}

// Apply received game state (for clients) - handles compact format
export function applyGameState(players, state) {
  // Support both old format (state.players) and new compact format (state.p)
  const statePlayers = state.p || state.players;
  if (!statePlayers) return;

  // Detect compact format by checking if state uses compact keys (state.p exists)
  const isCompact = state.p !== undefined;

  for (const id in statePlayers) {
    const ps = statePlayers[id];
    let p = players[id];

    if (!p) {
      p = createPlayer(id, ps.si !== undefined ? ps.si : ps.spawnIndex || 0, ps.n || ps.name || 'Player');
      p.color = ps.c || ps.color || COLORS[0];
      players[id] = p;
    }

    // Apply delta trail data (handle both compact encoded and raw formats)
    const trail = ps.tr || ps.trail;
    if (trail && trail.length > 0) {
      const newPoints = trail.length / 2;
      for (let i = 0; i < newPoints; i++) {
        const idx = (p.trailStart + p.trailLen) % TRAIL_MAX;
        p.trailX[idx] = isCompact ? trail[i * 2] / 10 : trail[i * 2];
        p.trailY[idx] = isCompact ? trail[i * 2 + 1] / 10 : trail[i * 2 + 1];
        p.trailLen++;
        if (p.trailLen > TRAIL_MAX) {
          p.trailStart = (p.trailStart + 1) % TRAIL_MAX;
          p.trailLen = TRAIL_MAX;
        }
      }
      p.trailSentCount = ps.tc !== undefined ? ps.tc : (ps.trailSentCount || 0);
    }

    // If round reset, sync trail state
    const trailLen = ps.tl !== undefined ? ps.tl : ps.trailLen;
    if (trailLen === 0) {
      p.trailLen = 0;
      p.trailStart = 0;
      p.trailSentCount = 0;
    }

    // Decode positions: compact format has integer-encoded values (×10 for xy, ×1000 for angle)
    if (isCompact) {
      if (ps.x !== undefined) p.x = ps.x / 10;
      if (ps.y !== undefined) p.y = ps.y / 10;
      if (ps.a !== undefined) p.angle = ps.a / 1000;
      p.alive = ps.al !== undefined ? ps.al : p.alive;
      p.score = ps.s !== undefined ? ps.s : p.score;
      const lives = ps.l;
      if (lives !== undefined) p.lives = lives;
    } else {
      // Old format: raw values
      if (ps.x !== undefined) p.x = ps.x;
      if (ps.y !== undefined) p.y = ps.y;
      if (ps.angle !== undefined) p.angle = ps.angle;
      if (ps.alive !== undefined) p.alive = ps.alive;
      if (ps.score !== undefined) p.score = ps.score;
      if (ps.lives !== undefined) p.lives = ps.lives;
    }

    // Update static fields if provided
    if (ps.n) p.name = ps.n;
    if (ps.c) p.color = ps.c;
  }
}

// Get minimal player update (for input synchronization)
export function getPlayerUpdate(p) {
  return {
    id: p.id,
    turning: p.turning
  };
}

// Apply player update
export function applyPlayerUpdate(players, update) {
  const p = players[update.id];
  if (p) {
    p.turning = update.turning;
  }
}
