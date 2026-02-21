# TRON Arena

A fast-paced, 8-player peer-to-peer multiplayer game built entirely in the browser using HTML5 Canvas and PeerJS. No dedicated game server required—one player hosts, everyone else joins via a 4-digit room code.

![TRON Arena Screenshot](Screenshot%202026-02-21%20at%208.29.32%E2%80%AFAM.png)

## How to Play

1. Open the game.
2. Enter a callsign.
3. Click **Host Game** to create a room, or **Join Game** and enter a 4-digit code.
4. If you're the host, wait for players to join and click **Launch Match**.
5. Survive. Don't hit the walls, don't hit other players' trails, and don't hit your own.

**Controls:**
- `Left Arrow` / `A` - Turn left
- `Right Arrow` / `D` - Turn right

## Tech Stack

- **Frontend**: Vanilla JS, HTML5 Canvas, CSS
- **Networking**: [PeerJS](https://peerjs.com/) (WebRTC)
- **Build Tool**: Vite

## Technical Details

Getting 8 players to stream their massive snake trails over WebRTC at 60fps without lagging the browser took some work. The codebase uses a few specific optimizations:
- **Spatial Grid Collision**: Instead of checking every player against every point of every trail on every frame (which brings the browser to its knees O(n*m)), the game uses a 16px spatial hash grid. Players only check for collisions in the 9 grid cells immediately around them.
- **Fixed-Timestep Physics**: The host runs the game simulation on a strict 60Hz loop decoupled from `requestAnimationFrame` so physics remain deterministic regardless of monitor refresh rates.
- **Delta-encoded Networking**: We don't send the entire trail every tick. We only send coordinates for *new* trail points since the last broadcast, integer-packed to save bandwidth.
- **Incremental Rendering**: The massive trail paths are cached via an offscreen canvas. We only draw the new delta segments each frame instead of clearing and redrawing everything.

## Running Locally

Clone the repo and run it via npm:

```bash
git clone https://github.com/karthik2365/tron-arena.git
cd tron-arena
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser.

## Deployment

The game is heavily optimized to be deployed as a static site. It works beautifully on Vercel out of the box.

```bash
npm run build
```

This will output the static bundle to `/dist`.
