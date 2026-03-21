/**
 * سر مكشوف — Server v2
 * Categories · Scoring · Skip Round · Multiple-Choice Spy Guess
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const crypto   = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  VOTE_DURATION_SEC   : 30,
  SPY_GUESS_SEC       : 25,
  INTER_ROUND_MS      : 3000,
  ROLE_REVEAL_MS      : 4000,
  MIN_PLAYERS         : 3,
  MAX_PLAYERS         : 8,
  DEFAULT_ROUNDS      : 5,
  DEFAULT_ROUND_SEC   : 30,
  POINTS_CORRECT_VOTE : 2,
  POINTS_SPY_GUESS    : 3,
};

// ─── Word Categories ──────────────────────────────────────────────────────────
const CATEGORIES = {
  'أماكن': [
    'المطار','البنك','الشاطئ','الكنيسة','السيرك','مركب السياحة',
    'السفارة','المستشفى','الفندق','المكتبة','السوق','موقع التصوير',
    'المتحف','الشغل','قسم البوليس','السجن','المطعم','المدرسة',
    'محطة الفضاء','الملعب','الغواصة','المسرح','محطة القطار',
    'الجامعة','حديقة الحيوان','الجيم','المول','مدينة الملاهي',
    'الميناء','القلعة',
  ],
  'أكل': [
    'كشري','فول','طعمية','كباب','كفتة','شاورما','بيتزا','سوشي',
    'مكرونة','برجر','فراخ مشوية','سمك مقلي','ملوخية','مسقعة',
    'كنافة','بسبوسة','أيس كريم','عيش بلدي','شيبسي','حمص','تبولة',
    'وراق عنب','محشي','فتة','بط مشوي',
  ],
  'أماكن في مصر': [
    'الإسكندرية','الأهرامات','الأقصر','أسوان','شرم الشيخ','الغردقة',
    'سيناء','المعادي','الزمالك','مصر الجديدة','وسط البلد','الدقي',
    'المهندسين','التجمع الخامس','السيدة زينب','خان الخليلي',
    'كورنيش الإسكندرية','ستانلي','المنتزه','سيدي بشر',
    'الرحاب','مدينتي','العجوزة','عابدين',
  ],
  'بلاد': [
    'فرنسا','اليابان','البرازيل','الهند','إيطاليا','المكسيك',
    'أمريكا','إنجلترا','روسيا','الصين','كوريا','ألمانيا',
    'إسبانيا','تركيا','الإمارات','السعودية','المغرب','تونس',
    'أستراليا','كندا','الأرجنتين','هولندا','السويد','اليونان',
  ],
  'مواقف': [
    'فرح','حفلة موسيقية','ماتش كورة','اجتماع سري','حفلة تنكرية',
    'رحلة مدرسية','مظاهرة','عرض أزياء','عزاء','امتحان',
    'مقابلة شغل','عيد ميلاد','حفلة تخرج','رحلة بحرية',
    'مسابقة غنا','مباراة ملاكمة',
  ],
};

const ALL_WORDS = Object.values(CATEGORIES).flat();

function pickWord(category) {
  const pool = CATEGORIES[category] || ALL_WORDS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function getDecoys(word, count = 3) {
  const pool = ALL_WORDS.filter(w => w !== word);
  const used = new Set(), decoys = [];
  while (decoys.length < count && used.size < pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    if (!used.has(i)) { used.add(i); decoys.push(pool[i]); }
  }
  return decoys;
}

// ─── Room Class ───────────────────────────────────────────────────────────────
class Room {
  constructor(code, hostId) {
    this.code              = code;
    this.hostId            = hostId;
    this.players           = new Map();
    this.state             = 'lobby';
    this.word              = null;
    this.category          = 'عشوائي';
    this.spyId             = null;
    this.totalRounds       = CONFIG.DEFAULT_ROUNDS;
    this.roundDuration     = CONFIG.DEFAULT_ROUND_SEC;
    this.currentRound      = 0;
    this.rounds            = [];
    this.votes             = new Map();
    this.scores            = new Map();
    this.pairQueue         = [];
    this.currentActivePair = [];
    this.roundDoneSet      = new Set();
    this.roundTimer        = null;
    this.voteTimer         = null;
    this.guessTimer        = null;
  }

  addPlayer(id, username) {
    this.players.set(id, { id, username, isSpy: false });
    this.scores.set(id, 0);
  }

  removePlayer(id) {
    this.players.delete(id);
    this.scores.delete(id);
    if (id === this.hostId && this.players.size > 0)
      this.hostId = this.players.keys().next().value;
  }

  getPlayerList() {
    return Array.from(this.players.values()).map(p => ({
      id: p.id, username: p.username,
      isHost: p.id === this.hostId,
      score: this.scores.get(p.id) || 0,
    }));
  }

  getScores() {
    return Array.from(this.players.values()).map(p => ({
      id: p.id, username: p.username,
      score: this.scores.get(p.id) || 0,
      isSpy: p.id === this.spyId,
    })).sort((a, b) => b.score - a.score);
  }

  assignRoles() {
    const ids  = Array.from(this.players.keys());
    this.spyId = ids[Math.floor(Math.random() * ids.length)];
    this.word  = pickWord(this.category === 'عشوائي' ? null : this.category);
    this.players.get(this.spyId).isSpy = true;
  }

  getNextPair() {
    while (this.pairQueue.length < 2) {
      const ids = Array.from(this.players.keys());
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      if (this.pairQueue.length === 1 && ids.length > 1 && ids[0] === this.pairQueue[0])
        [ids[0], ids[1]] = [ids[1], ids[0]];
      this.pairQueue.push(...ids);
    }
    return [this.pairQueue.shift(), this.pairQueue.shift()];
  }

  clearTimers() {
    clearTimeout(this.roundTimer);
    clearTimeout(this.voteTimer);
    clearTimeout(this.guessTimer);
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────
const rooms = new Map();
function generateCode() {
  let c;
  do { c = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(c));
  return c;
}

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let roomCode = null;

  socket.on('room:create', ({ username }) => {
    if (!username?.trim()) return socket.emit('error', { message: 'أدخل اسمك.' });
    const code = generateCode();
    const room = new Room(code, socket.id);
    room.addPlayer(socket.id, username.trim());
    rooms.set(code, room);
    roomCode = code;
    socket.join(code);
    socket.emit('room:created', { roomCode: code, players: room.getPlayerList(), isHost: true });
  });

  socket.on('room:join', ({ roomCode: code, username }) => {
    if (!username?.trim()) return socket.emit('error', { message: 'أدخل اسمك.' });
    code = code.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room)                  return socket.emit('error', { message: 'الغرفة مش موجودة.' });
    if (room.state !== 'lobby') return socket.emit('error', { message: 'اللعبة بدأت خلاص.' });
    if (room.players.size >= CONFIG.MAX_PLAYERS) return socket.emit('error', { message: 'الغرفة ممتلئة.' });
    const taken = Array.from(room.players.values()).some(p => p.username.toLowerCase() === username.trim().toLowerCase());
    if (taken) return socket.emit('error', { message: 'الاسم ده اتأخد.' });
    room.addPlayer(socket.id, username.trim());
    roomCode = code;
    socket.join(code);
    socket.emit('room:joined', { roomCode: code, players: room.getPlayerList(), isHost: false });
    socket.to(code).emit('room:playerJoined', { players: room.getPlayerList(), newPeerId: socket.id });
  });

  socket.on('game:start', ({ rounds, roundDuration, category } = {}) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return socket.emit('error', { message: 'الهوست بس يقدر يبدأ.' });
    if (room.players.size < CONFIG.MIN_PLAYERS) return socket.emit('error', { message: `محتاج ${CONFIG.MIN_PLAYERS} لاعبين على الأقل.` });
    if (room.state !== 'lobby') return;
    if (rounds >= 3 && rounds <= 10)                room.totalRounds  = rounds;
    if (roundDuration >= 20 && roundDuration <= 60) room.roundDuration = roundDuration;
    if (category) room.category = category;
    room.state = 'playing';
    room.assignRoles();
    room.players.forEach((player, id) => {
      io.to(id).emit('game:started', {
        role: player.isSpy ? 'spy' : 'player',
        word: player.isSpy ? null : room.word,
        totalRounds: room.totalRounds,
        players: room.getPlayerList(),
        category: room.category,
      });
    });
    setTimeout(() => startRound(room), CONFIG.ROLE_REVEAL_MS);
    console.log(`[G] ${room.code} | cat:${room.category} | word:"${room.word}" | spy:${room.players.get(room.spyId)?.username}`);
  });

  // Both active speakers press "تم" → skip round early
  socket.on('round:done', () => {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;
    if (!room.currentActivePair.includes(socket.id)) return;
    room.roundDoneSet.add(socket.id);
    io.to(roomCode).emit('round:doneUpdate', { doneIds: Array.from(room.roundDoneSet) });
    if (room.currentActivePair.every(id => room.roundDoneSet.has(id))) {
      clearTimeout(room.roundTimer);
      io.to(room.code).emit('round:end', { roundNumber: room.currentRound });
      setTimeout(() => startRound(room), CONFIG.INTER_ROUND_MS);
    }
  });

  socket.on('webrtc:offer',  ({ to, offer })     => io.to(to).emit('webrtc:offer',  { from: socket.id, offer }));
  socket.on('webrtc:answer', ({ to, answer })    => io.to(to).emit('webrtc:answer', { from: socket.id, answer }));
  socket.on('webrtc:ice',    ({ to, candidate }) => io.to(to).emit('webrtc:ice',    { from: socket.id, candidate }));

  socket.on('vote:cast', ({ votedId }) => {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'voting') return;
    if (!room.players.has(votedId)) return;
    if (room.votes.has(socket.id)) return;
    room.votes.set(socket.id, votedId);
    const counts = {};
    room.votes.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
    io.to(roomCode).emit('vote:update', { voteCounts: counts, totalVotes: room.votes.size });
    if (room.votes.size >= room.players.size) resolveVoting(room);
  });

  socket.on('spy:guess', ({ word }) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.spyId || room.state !== 'voting') return;
    clearTimeout(room.guessTimer);
    const correct = word.trim() === room.word;
    if (correct) room.scores.set(room.spyId, (room.scores.get(room.spyId) || 0) + CONFIG.POINTS_SPY_GUESS);
    io.to(roomCode).emit('game:result', {
      winner  : correct ? 'spy' : 'players',
      spyId   : room.spyId,
      spyName : room.players.get(room.spyId)?.username,
      word    : room.word,
      spyGuess: word.trim(),
      correct,
      reason  : correct ? 'الجاسوس خمّن الكلمة وفاز!' : 'الجاسوس خمّن غلط!',
      scores  : room.getScores(),
    });
    room.state = 'ended';
  });

  socket.on('disconnect', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.removePlayer(socket.id);
    if (room.players.size === 0) { room.clearTimers(); rooms.delete(roomCode); return; }
    io.to(roomCode).emit('room:playerLeft', { playerId: socket.id, players: room.getPlayerList(), newHostId: room.hostId });
    if (room.state === 'playing' && room.players.size < 2) {
      room.clearTimers();
      io.to(roomCode).emit('game:aborted', { reason: 'مفيش لاعبين كفاية للكمال.' });
      room.state = 'ended';
    }
  });
});

// ─── Game Logic ───────────────────────────────────────────────────────────────
function startRound(room) {
  if (room.state !== 'playing') return;
  if (room.players.size < 2) return;
  room.currentRound++;
  if (room.currentRound > room.totalRounds) { startVoting(room); return; }
  let p1, p2, p1Id, p2Id, attempts = 0;
  do {
    [p1Id, p2Id] = room.getNextPair();
    p1 = room.players.get(p1Id); p2 = room.players.get(p2Id);
    if (++attempts > 20) { startVoting(room); return; }
  } while (!p1 || !p2);
  room.currentActivePair = [p1Id, p2Id];
  room.roundDoneSet.clear();
  const roundData = {
    roundNumber: room.currentRound, totalRounds: room.totalRounds,
    activePlayers: [{ id: p1Id, username: p1.username }, { id: p2Id, username: p2.username }],
    duration: room.roundDuration,
  };
  room.rounds.push(roundData);
  io.to(room.code).emit('round:start', roundData);
  room.roundTimer = setTimeout(() => {
    io.to(room.code).emit('round:end', { roundNumber: room.currentRound });
    setTimeout(() => startRound(room), CONFIG.INTER_ROUND_MS);
  }, room.roundDuration * 1000);
}

function startVoting(room) {
  room.state = 'voting';
  room.votes.clear();
  io.to(room.code).emit('vote:start', {
    players : room.getPlayerList(),
    duration: CONFIG.VOTE_DURATION_SEC,
    scores  : room.getScores(),
  });
  room.voteTimer = setTimeout(() => resolveVoting(room), CONFIG.VOTE_DURATION_SEC * 1000);
}

function resolveVoting(room) {
  clearTimeout(room.voteTimer);
  if (room.state !== 'voting') return;
  const counts = {};
  room.votes.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  let max = 0, mostVoted = null;
  Object.entries(counts).forEach(([id, n]) => {
    if (n > max || (n === max && Math.random() < 0.5)) { max = n; mostVoted = id; }
  });
  if (!mostVoted) {
    const ids = Array.from(room.players.keys());
    mostVoted = ids[Math.floor(Math.random() * ids.length)];
  }
  const isSpy = mostVoted === room.spyId;
  // Award points: correct voters get +2, spy gets nothing from votes
  if (isSpy) {
    room.votes.forEach((votedId, voterId) => {
      if (votedId === room.spyId && voterId !== room.spyId)
        room.scores.set(voterId, (room.scores.get(voterId) || 0) + CONFIG.POINTS_CORRECT_VOTE);
    });
  }
  io.to(room.code).emit('vote:result', {
    mostVotedId: mostVoted, mostVotedName: room.players.get(mostVoted)?.username ?? 'مجهول',
    isSpy, spyId: room.spyId, spyName: room.players.get(room.spyId)?.username,
    word: room.word, voteCounts: counts, scores: room.getScores(),
  });
  if (!isSpy) {
    setTimeout(() => {
      io.to(room.code).emit('game:result', {
        winner: 'spy', spyId: room.spyId, spyName: room.players.get(room.spyId)?.username,
        word: room.word, reason: 'صوّتوا على بريء! الجاسوس فاز!', scores: room.getScores(),
      });
      room.state = 'ended';
    }, 4000);
  } else {
    // Spy gets 4 multiple-choice options, only spy sees them
    const decoys  = getDecoys(room.word, 3);
    const options = [room.word, ...decoys].sort(() => Math.random() - 0.5);
    io.to(room.spyId).emit('spy:guessChance', {
      spyId: room.spyId, spyName: room.players.get(room.spyId)?.username, options,
    });
    room.players.forEach((_, id) => {
      if (id !== room.spyId)
        io.to(id).emit('spy:guessChance', { spyId: room.spyId, spyName: room.players.get(room.spyId)?.username });
    });
    room.guessTimer = setTimeout(() => {
      if (room.state !== 'voting') return;
      io.to(room.code).emit('game:result', {
        winner: 'players', spyId: room.spyId, spyName: room.players.get(room.spyId)?.username,
        word: room.word, reason: 'الجاسوس مخمّنش في الوقت!', scores: room.getScores(),
      });
      room.state = 'ended';
    }, CONFIG.SPY_GUESS_SEC * 1000);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🕵️  سر مكشوف →  http://localhost:${PORT}\n`));
