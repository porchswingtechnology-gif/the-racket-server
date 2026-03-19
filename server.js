const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ---- HTTP SERVER (serves the game HTML) ----
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading game');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ---- WEBSOCKET SERVER ----
const wss = new WebSocket.Server({ server: httpServer });

// ---- GAME STATE ----
const rooms = new Map();

function createRoom(id) {
  return {
    id,
    players: new Map(),
    enemies: [],
    wave: 0,
    enemyIdCounter: 0,
    state: 'lobby', // 'lobby' | 'playing' | 'shop'
    enemiesToSpawn: 0,
    spawnTimer: 0,
    bossSpawned: false,
  };
}

// Generate a short room code
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Broadcast to all players in a room
function broadcast(room, msg, excludeWs) {
  const data = JSON.stringify(msg);
  for (const [ws, player] of room.players) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// Broadcast to all players in a room (including sender)
function broadcastAll(room, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, player] of room.players) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---- ENEMY SPAWNING (server-authoritative) ----
function spawnEnemy(room) {
  const wave = room.wave;
  const type = Math.random() < 0.3 + wave * 0.04 ? 'fast' : 'normal';
  const hp = type === 'fast'
    ? 1 + Math.floor(wave / 3) + (wave > 10 ? Math.floor((wave - 10) * 0.5) : 0)
    : 3 + Math.floor(wave / 2) + (wave > 10 ? Math.floor((wave - 10) * 0.8) : 0);
  const speed = type === 'fast'
    ? Math.min(0.12, 0.065 + wave * 0.003)
    : Math.min(0.07, 0.03 + wave * 0.002);

  const id = room.enemyIdCounter++;
  const enemy = { id, type, hp, maxHp: hp, speed, alive: true };

  room.enemies.push(enemy);
  broadcastAll(room, { type: 'enemySpawn', enemy });
}

function spawnBoss(room) {
  const wave = room.wave;
  const hp = 30 + wave * 6 + Math.floor(wave * wave * 0.3);
  const id = room.enemyIdCounter++;
  const boss = {
    id, type: 'boss', hp, maxHp: hp,
    speed: Math.min(0.045, 0.02 + wave * 0.001),
    alive: true, isBoss: true
  };
  room.enemies.push(boss);
  room.bossSpawned = true;
  broadcastAll(room, { type: 'enemySpawn', enemy: boss });
}

function startWave(room) {
  room.wave++;
  room.state = 'playing';
  room.enemiesToSpawn = 3 + room.wave * 2 + (room.wave > 8 ? Math.floor((room.wave - 8) * 0.5) : 0);
  room.spawnTimer = 0;
  room.bossSpawned = false;
  room.enemies = room.enemies.filter(e => e.alive);

  broadcastAll(room, { type: 'waveStart', wave: room.wave });

  // Boss every 5 waves — delayed
  if (room.wave % 5 === 0) {
    setTimeout(() => {
      if (room.state === 'playing') spawnBoss(room);
    }, 2500);
  }
}

// ---- GAME TICK (server runs at 20hz for spawning & wave management) ----
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.state !== 'playing') continue;
    if (room.players.size === 0) {
      rooms.delete(roomId);
      continue;
    }

    // Spawn enemies
    if (room.enemiesToSpawn > 0) {
      room.spawnTimer++;
      if (room.spawnTimer >= 7) { // ~350ms at 20hz (similar to 35 frames at 60fps)
        spawnEnemy(room);
        room.enemiesToSpawn--;
        room.spawnTimer = 0;
      }
    }

    // Check if wave is complete
    const aliveCount = room.enemies.filter(e => e.alive).length;
    if (room.enemiesToSpawn <= 0 && aliveCount <= 0 && room.state === 'playing') {
      room.state = 'shop';
      broadcastAll(room, { type: 'shopPhase' });
    }
  }
}, 50);

// ---- CONNECTION HANDLING ----
wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ---- LOBBY ----
      case 'createRoom': {
        const code = genRoomCode();
        const room = createRoom(code);
        rooms.set(code, room);
        playerId = 'P1';
        room.players.set(ws, { id: playerId, name: msg.name || 'Player 1', ready: false });
        playerRoom = room;
        send(ws, { type: 'roomCreated', roomCode: code, playerId });
        console.log(`Room ${code} created by ${playerId}`);
        break;
      }

      case 'joinRoom': {
        const code = (msg.roomCode || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', message: 'Room not found' });
          break;
        }
        if (room.players.size >= 4) {
          send(ws, { type: 'error', message: 'Room is full' });
          break;
        }
        playerId = 'P' + (room.players.size + 1);
        room.players.set(ws, { id: playerId, name: msg.name || 'Player ' + (room.players.size + 1), ready: false });
        playerRoom = room;

        // Tell the joiner about the room
        const playerList = [];
        for (const [, p] of room.players) playerList.push({ id: p.id, name: p.name });
        send(ws, { type: 'roomJoined', roomCode: code, playerId, players: playerList });

        // Tell everyone else about the new player
        broadcast(room, { type: 'playerJoined', playerId, name: msg.name || playerId }, ws);
        console.log(`${playerId} joined room ${code}`);
        break;
      }

      case 'ready': {
        if (!playerRoom) break;
        const player = playerRoom.players.get(ws);
        if (player) player.ready = true;

        // Check if all players are ready
        let allReady = true;
        for (const [, p] of playerRoom.players) {
          if (!p.ready) { allReady = false; break; }
        }
        if (allReady && playerRoom.players.size >= 1 && playerRoom.state === 'lobby') {
          startWave(playerRoom);
        }
        broadcast(playerRoom, { type: 'playerReady', playerId }, ws);
        break;
      }

      // ---- IN-GAME UPDATES ----
      case 'playerState': {
        // Relay player position/rotation to other players
        if (!playerRoom) break;
        const playerData = playerRoom.players.get(ws);
        broadcast(playerRoom, {
          type: 'playerState',
          playerId,
          name: playerData ? playerData.name : playerId,
          x: msg.x, y: msg.y, z: msg.z,
          yaw: msg.yaw, pitch: msg.pitch,
          weapon: msg.weapon, health: msg.health
        }, ws);
        break;
      }

      case 'playerShoot': {
        // Relay shot visual/audio to others
        if (!playerRoom) break;
        broadcast(playerRoom, {
          type: 'playerShoot',
          playerId,
          weapon: msg.weapon
        }, ws);
        break;
      }

      case 'enemyHit': {
        // A player claims to have hit an enemy — server validates and broadcasts
        if (!playerRoom) break;
        const enemy = playerRoom.enemies.find(e => e.id === msg.enemyId && e.alive);
        if (!enemy) break;

        enemy.hp -= msg.damage;
        broadcastAll(playerRoom, {
          type: 'enemyDamaged',
          enemyId: msg.enemyId,
          hp: enemy.hp,
          maxHp: enemy.maxHp,
          damage: msg.damage,
          isHeadshot: msg.isHeadshot,
          killerId: playerId
        });

        if (enemy.hp <= 0 && enemy.alive) {
          enemy.alive = false;
          broadcastAll(playerRoom, {
            type: 'enemyKilled',
            enemyId: msg.enemyId,
            killerId: playerId,
            enemyType: enemy.type,
            isBoss: !!enemy.isBoss
          });
        }
        break;
      }

      case 'playerDied': {
        if (!playerRoom) break;
        broadcast(playerRoom, { type: 'playerDied', playerId }, ws);

        // Check if all players dead
        let anyAlive = false;
        for (const [otherWs, p] of playerRoom.players) {
          if (otherWs !== ws && p.alive !== false) anyAlive = true;
        }
        const player = playerRoom.players.get(ws);
        if (player) player.alive = false;
        if (!anyAlive) {
          broadcastAll(playerRoom, { type: 'gameOver' });
          playerRoom.state = 'lobby';
        }
        break;
      }

      case 'shopDone': {
        // Player finished shopping
        if (!playerRoom) break;
        const player = playerRoom.players.get(ws);
        if (player) player.shopDone = true;

        let allDone = true;
        for (const [, p] of playerRoom.players) {
          if (!p.shopDone) { allDone = false; break; }
        }
        if (allDone && playerRoom.state === 'shop') {
          // Reset shop flags
          for (const [, p] of playerRoom.players) p.shopDone = false;
          startWave(playerRoom);
        }
        break;
      }

      case 'grenadeThrown': {
        if (!playerRoom) break;
        broadcast(playerRoom, {
          type: 'grenadeThrown',
          playerId,
          x: msg.x, y: msg.y, z: msg.z,
          vx: msg.vx, vy: msg.vy, vz: msg.vz
        }, ws);
        break;
      }

      case 'skipPreRound': {
        if (!playerRoom) break;
        const player = playerRoom.players.get(ws);
        if (player) player.skipVote = true;
        let allSkip = true;
        for (const [, p] of playerRoom.players) {
          if (!p.skipVote) { allSkip = false; break; }
        }
        if (allSkip && playerRoom.state === 'lobby') {
          for (const [, p] of playerRoom.players) p.skipVote = false;
          startWave(playerRoom);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (playerRoom) {
      playerRoom.players.delete(ws);
      broadcast(playerRoom, { type: 'playerLeft', playerId });
      console.log(`${playerId} left room ${playerRoom.id}`);

      if (playerRoom.players.size === 0) {
        rooms.delete(playerRoom.id);
        console.log(`Room ${playerRoom.id} closed (empty)`);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`The Racket server running on port ${PORT}`);
});
