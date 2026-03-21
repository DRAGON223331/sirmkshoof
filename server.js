/**
 * SPY VOICE GAME — Server
 * Node.js + Socket.IO backend
 *
 * Responsibilities:
 *  - Room creation & management
 *  - Player join/leave handling
 *  - Game state machine (lobby → playing → voting → ended)
 *  - Spy & word assignment
 *  - Round pair selection (shuffled queue for fair rotation)
 *  - Voting resolution
 *  - WebRTC signaling relay (server never sees media)
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  ROUND_DURATION_SEC : 30,   // seconds each voice pair gets
  VOTE_DURATION_SEC  : 45,   // seconds for the vote phase
  SPY_GUESS_SEC      : 20,   // seconds spy has to guess after being caught
  INTER_ROUND_MS     : 3000, // pause between rounds (ms)
  ROLE_REVEAL_MS     : 4000, // time to read role card before first round
  MIN_PLAYERS        : 3,
  MAX_PLAYERS        : 8,
  DEFAULT_ROUNDS     : 5,
};

// ─── Word Bank ────────────────────────────────────────────────────────────────

const WORD_BANK = [
  // Places
  'Airport', 'Bank', 'Beach', 'Casino', 'Cathedral', 'Circus',
  'Cruise Ship', 'Embassy', 'Hospital', 'Hotel', 'Library', 'Market',
  'Movie Set', 'Museum', 'Office', 'Police Station', 'Prison',
  'Restaurant', 'School', 'Space Station', 'Stadium', 'Submarine',
  'Theater', 'Train Station', 'University', 'Vineyard', 'Zoo',
  // Things
  'Briefcase', 'Camera', 'Compass', 'Disguise', 'Microfilm',
  'Password', 'Safe House', 'Secret Code',
];

// ─── Room Class ───────────────────────────────────────────────────────────────

class Room {
  constructor(code, hostId) {
    this.code         = code;
    this.hostId       = hostId;
    this.players      = new Map(); // socketId → { id, username, isSpy }
    this.state        = 'lobby';   // lobby | playing | voting | ended
    this.word         = null;
    this.spyId        = null;
    this.totalRounds  = CONFIG.DEFAULT_ROUNDS;
    this.roundDuration = CONFIG.ROUND_DURATION_SEC;
    this.currentRound = 0;
    this.rounds       = [];        // history of { player1, player2 }
    this.votes        = new Map(); // voterId → votedId
    this.pairQueue    = [];        // shuffled queue for fair pair rotation
    this.roundTimer   = null;
    this.voteTimer    = null;
    this.guessTimer   = null;
  }

  /** Add a player to the room */
  addPlayer(socketId, username) {
    this.players.set(socketId, { id: socketId, username, isSpy: false });
  }

  /** Remove a player; re-elect host if needed */
  removePlayer(socketId) {
    this.players.delete(socketId);
    if (socketId === this.hostId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value;
    }
  }

  /** Serialisable player list (no internal flags) */
  getPlayerList() {
    return Array.from(this.players.values()).map(p => ({
      id       : p.id,
      username : p.username,
      isHost   : p.id === this.hostId,
    }));
  }

  /** Randomly assign one spy and pick a word */
  assignRoles() {
    const ids    = Array.from(this.players.keys());
    this.spyId   = ids[Math.floor(Math.random() * ids.length)];
    this.word    = WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)];
    this.players.get(this.spyId).isSpy = true;
  }

  /**
   * Returns the next pair of player IDs using a shuffled-queue strategy.
   * All players appear once before anyone repeats, preventing lopsided rounds.
   */
  getNextPair() {
    while (this.pairQueue.length < 2) {
      const ids = Array.from(this.players.keys());
      // Fisher-Yates shuffle
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      // Avoid placing the same person back-to-back across refills
      if (this.pairQueue.length === 1 && ids.length > 1 && ids[0] === this.pairQueue[0]) {
        [ids[0], ids[1]] = [ids[1], ids[0]];
      }
      this.pairQueue.push(...ids);
    }
    return [this.pairQueue.shift(), this.pairQueue.shift()];
  }

  /** Clear all pending timers */
  clearTimers() {
    clearTimeout(this.roundTimer);
    clearTimeout(this.voteTimer);
    clearTimeout(this.guessTimer);
  }
}

// ─── Room Store ───────────────────────────────────────────────────────────────

const rooms = new Map(); // code → Room

function generateCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let roomCode = null; // track which room this socket is in

  console.log(`[+] ${socket.id} connected`);

  // ── Create Room ──────────────────────────────────────────────────────────
  socket.on('room:create', ({ username }) => {
    if (!username || username.trim().length < 1) {
      return socket.emit('error', { message: 'Please enter a username.' });
    }

    const code = generateCode();
    const room = new Room(code, socket.id);
    room.addPlayer(socket.id, username.trim());
    rooms.set(code, room);

    roomCode = code;
    socket.join(code);

    socket.emit('room:created', {
      roomCode : code,
      players  : room.getPlayerList(),
      isHost   : true,
    });

    console.log(`[R] Room ${code} created by "${username}"`);
  });

  // ── Join Room ────────────────────────────────────────────────────────────
  socket.on('room:join', ({ roomCode: code, username }) => {
    if (!username || username.trim().length < 1) {
      return socket.emit('error', { message: 'Please enter a username.' });
    }
    code = code.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room)                    return socket.emit('error', { message: 'Room not found. Check the code and try again.' });
    if (room.state !== 'lobby')   return socket.emit('error', { message: 'Game already in progress.' });
    if (room.players.size >= CONFIG.MAX_PLAYERS)
                                  return socket.emit('error', { message: 'Room is full (max 8 players).' });

    const usernameTaken = Array.from(room.players.values())
      .some(p => p.username.toLowerCase() === username.trim().toLowerCase());
    if (usernameTaken)            return socket.emit('error', { message: 'That codename is already taken.' });

    room.addPlayer(socket.id, username.trim());
    roomCode = code;
    socket.join(code);

    // Tell the new player about the room
    socket.emit('room:joined', {
      roomCode : code,
      players  : room.getPlayerList(),
      isHost   : false,
    });

    // Tell existing players to initiate WebRTC offers to the new player
    socket.to(code).emit('room:playerJoined', {
      player  : { id: socket.id, username: username.trim(), isHost: false },
      players : room.getPlayerList(),
      newPeerId: socket.id,  // existing players should open a connection to this ID
    });

    console.log(`[R] "${username}" joined room ${code} (${room.players.size} players)`);
  });

  // ── Start Game ────────────────────────────────────────────────────────────
  socket.on('game:start', ({ rounds, roundDuration } = {}) => {
    const room = rooms.get(roomCode);
    if (!room)                             return;
    if (socket.id !== room.hostId)         return socket.emit('error', { message: 'Only the host can start.' });
    if (room.players.size < CONFIG.MIN_PLAYERS)
                                           return socket.emit('error', { message: `Need at least ${CONFIG.MIN_PLAYERS} players to start.` });
    if (room.state !== 'lobby')            return;

    // Apply host settings
    if (rounds && rounds >= 3 && rounds <= 10)           room.totalRounds      = rounds;
    if (roundDuration && roundDuration >= 20 && roundDuration <= 60) room.roundDuration = roundDuration;

    room.state = 'playing';
    room.assignRoles();

    // Send each player their secret role
    room.players.forEach((player, id) => {
      io.to(id).emit('game:started', {
        role        : player.isSpy ? 'spy' : 'player',
        word        : player.isSpy ? null  : room.word,
        totalRounds : room.totalRounds,
        players     : room.getPlayerList(),
      });
    });

    // Wait for clients to display role card before starting round 1
    setTimeout(() => startRound(room), CONFIG.ROLE_REVEAL_MS);
    console.log(`[G] Game started in ${room.code} | Word: "${room.word}" | Spy: "${room.players.get(room.spyId)?.username}"`);
  });

  // ── WebRTC Signaling Relay ────────────────────────────────────────────────
  // Server simply forwards signaling messages — never accesses media

  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // ── Vote Cast ─────────────────────────────────────────────────────────────
  socket.on('vote:cast', ({ votedId }) => {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'voting') return;
    if (!room.players.has(votedId))       return;

    room.votes.set(socket.id, votedId);

    // Broadcast anonymised vote counts
    const counts = {};
    room.votes.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
    io.to(roomCode).emit('vote:update', { voteCounts: counts, totalVotes: room.votes.size, totalPlayers: room.players.size });

    // If everyone voted, resolve immediately
    if (room.votes.size >= room.players.size) resolveVoting(room);
  });

  // ── Spy Guess (only valid if spy was voted out) ───────────────────────────
  socket.on('spy:guess', ({ word }) => {
    const room = rooms.get(roomCode);
    if (!room)                          return;
    if (socket.id !== room.spyId)       return;
    if (room.state !== 'voting')        return;

    clearTimeout(room.guessTimer);
    const correct = word.trim().toLowerCase() === room.word.toLowerCase();

    io.to(roomCode).emit('game:result', {
      winner   : correct ? 'spy' : 'players',
      spyId    : room.spyId,
      spyName  : room.players.get(room.spyId)?.username,
      word     : room.word,
      spyGuess : word.trim(),
      correct,
      reason   : correct ? 'The spy guessed the word!' : 'The spy guessed wrong!',
    });

    room.state = 'ended';
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    room.removePlayer(socket.id);

    if (room.players.size === 0) {
      room.clearTimers();
      rooms.delete(roomCode);
      console.log(`[R] Room ${roomCode} deleted (empty)`);
      return;
    }

    io.to(roomCode).emit('room:playerLeft', {
      playerId   : socket.id,
      players    : room.getPlayerList(),
      newHostId  : room.hostId,
    });

    // If game is in progress and we drop below minimum, end gracefully
    if (room.state === 'playing' && room.players.size < 2) {
      room.clearTimers();
      io.to(roomCode).emit('game:aborted', { reason: 'Not enough players to continue.' });
      room.state = 'ended';
    }
  });
});

// ─── Game Logic ───────────────────────────────────────────────────────────────

/** Start (or continue) the next round */
function startRound(room) {
  if (room.state !== 'playing')      return;
  if (room.players.size < 2)         return;

  room.currentRound++;

  if (room.currentRound > room.totalRounds) {
    startVoting(room);
    return;
  }

  // Pick a pair; skip if a player disconnected
  let p1, p2, p1Id, p2Id;
  let attempts = 0;
  do {
    [p1Id, p2Id] = room.getNextPair();
    p1 = room.players.get(p1Id);
    p2 = room.players.get(p2Id);
    attempts++;
    if (attempts > 20) { startVoting(room); return; }
  } while (!p1 || !p2);

  const roundData = {
    roundNumber   : room.currentRound,
    totalRounds   : room.totalRounds,
    activePlayers : [
      { id: p1Id, username: p1.username },
      { id: p2Id, username: p2.username },
    ],
    duration      : room.roundDuration,
  };

  room.rounds.push(roundData);
  io.to(room.code).emit('round:start', roundData);
  console.log(`[Round ${room.currentRound}/${room.totalRounds}] ${p1.username} ↔ ${p2.username}  (room ${room.code})`);

  room.roundTimer = setTimeout(() => {
    io.to(room.code).emit('round:end', { roundNumber: room.currentRound });
    setTimeout(() => startRound(room), CONFIG.INTER_ROUND_MS);
  }, room.roundDuration * 1000);
}

/** Move game into voting phase */
function startVoting(room) {
  room.state = 'voting';
  room.votes.clear();

  io.to(room.code).emit('vote:start', {
    players  : room.getPlayerList(),
    duration : CONFIG.VOTE_DURATION_SEC,
  });

  // Auto-resolve if time runs out
  room.voteTimer = setTimeout(() => resolveVoting(room), CONFIG.VOTE_DURATION_SEC * 1000);
  console.log(`[V] Voting opened in room ${room.code}`);
}

/** Tally votes and broadcast result */
function resolveVoting(room) {
  clearTimeout(room.voteTimer);
  if (room.state !== 'voting') return;

  // Count votes
  const counts = {};
  room.votes.forEach(id => { counts[id] = (counts[id] || 0) + 1; });

  // Find most-voted player (ties go to random of tied players)
  let max = 0;
  let mostVoted = null;
  Object.entries(counts).forEach(([id, n]) => {
    if (n > max || (n === max && Math.random() < 0.5)) { max = n; mostVoted = id; }
  });

  // Fallback: if nobody voted, pick a random non-spy (harsher)
  if (!mostVoted) {
    const ids = Array.from(room.players.keys());
    mostVoted = ids[Math.floor(Math.random() * ids.length)];
  }

  const isSpy = mostVoted === room.spyId;

  io.to(room.code).emit('vote:result', {
    mostVotedId   : mostVoted,
    mostVotedName : room.players.get(mostVoted)?.username ?? 'Unknown',
    isSpy,
    spyId         : room.spyId,
    spyName       : room.players.get(room.spyId)?.username,
    word          : room.word,
    voteCounts    : counts,
  });

  console.log(`[V] Voted out: "${room.players.get(mostVoted)?.username}" | isSpy=${isSpy} | room ${room.code}`);

  if (!isSpy) {
    // Wrong person voted out → spy wins immediately
    setTimeout(() => {
      io.to(room.code).emit('game:result', {
        winner  : 'spy',
        spyId   : room.spyId,
        spyName : room.players.get(room.spyId)?.username,
        word    : room.word,
        reason  : 'Players voted out an innocent agent!',
      });
      room.state = 'ended';
    }, 4000);
  } else {
    // Correct! Spy gets one chance to guess the word
    io.to(room.code).emit('spy:guessChance', {
      spyId   : room.spyId,
      spyName : room.players.get(room.spyId)?.username,
    });

    // If spy doesn't guess in time, players win
    room.guessTimer = setTimeout(() => {
      if (room.state !== 'voting') return;
      io.to(room.code).emit('game:result', {
        winner  : 'players',
        spyId   : room.spyId,
        spyName : room.players.get(room.spyId)?.username,
        word    : room.word,
        reason  : 'Spy ran out of time to guess!',
      });
      room.state = 'ended';
    }, CONFIG.SPY_GUESS_SEC * 1000);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🕵️  Spy Voice Game server →  http://localhost:${PORT}\n`);
});
