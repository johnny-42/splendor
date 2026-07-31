// 스플렌더 웹 게임 서버 — 방 생성/입장 + 게임 진행 (Socket.IO) + 봇(1인용)
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game } = require('./game/game');
const { chooseAction } = require('./game/ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
// 게임 로직을 브라우저(오프라인 모드)에서도 쓸 수 있게 제공
app.use('/game', express.static(path.join(__dirname, 'game')));

const PORT = process.env.PORT || Number(process.argv[2]) || 3000;
const BOT_DELAY = 1000; // 봇 행동 간격(ms)
const BOT_NAMES = ['봇 마르코', '봇 이자벨', '봇 앙리'];

// 시작 전 정할 수 있는 규칙과 허용 범위
const DEFAULT_OPTIONS = {
  timeLimit: 30,       // 턴 제한시간 10~60초
  targetScore: 15,     // 목표 점수 10~20
  first: 'order',      // 선: order(차례대로) | random
  botLevel: 'normal',  // 봇 난이도: easy | normal | hard
  maxReserved: 3,      // 예약 한도 0(금지)~5장
  nobleCount: 'auto',  // 귀족 타일: auto(인원+1) | 0~5개
};
function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
function sanitizeOptions(opts) {
  const o = { ...DEFAULT_OPTIONS, ...(opts || {}) };
  // 0 = 제한시간 없음 (같이 하기 모드 기본값)
  o.timeLimit = Number(o.timeLimit) === 0 ? 0 : clampInt(o.timeLimit, 10, 60, 30);
  o.targetScore = clampInt(o.targetScore, 10, 20, 15);
  o.first = o.first === 'random' ? 'random' : 'order';
  o.botLevel = ['easy', 'normal', 'hard'].includes(o.botLevel) ? o.botLevel : 'normal';
  o.maxReserved = clampInt(o.maxReserved, 0, 5, 3);
  o.nobleCount = o.nobleCount === 'auto' ? 'auto' : clampInt(o.nobleCount, 0, 5, 3);
  return o;
}

function shufflePlayers(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// rooms: code -> { code, hostId, players: [{ id, name, connected, bot }], game, botSeq, botTimer }
const rooms = new Map();

// 같은 네트워크(휴대폰 등)에서 접속할 수 있는 LAN 주소 목록
function lanUrls() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      // 링크-로컬(169.254.x.x) 주소는 접속에 쓸 수 없으므로 제외
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
        out.push(`http://${i.address}:${PORT}`);
    }
  }
  return out;
}
const LAN_URLS = lanUrls();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function lobbyState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: !!room.game,
    hotseat: !!room.hotseat,
    urls: LAN_URLS,
    options: room.options,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, connected: p.connected, bot: !!p.bot, local: !!p.local,
    })),
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby', lobbyState(room));
}

function broadcastGame(room) {
  const turnEndsIn = room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : null;
  // 같이 하기 모드: 현재 차례가 로컬 플레이어면 호스트 화면을 그 사람 시점으로 보낸다
  //(자기 차례에는 자신이 더미에서 예약한 카드를 볼 수 있어야 하므로)
  const cur = room.game.players[room.game.current];
  const curSeat = cur && room.players.find((s) => s.id === cur.id);
  for (const p of room.players) {
    if (p.connected && !p.bot && !p.local) {
      const viewer =
        room.hotseat && p.id === room.hostId && curSeat && curSeat.local ? cur.id : p.id;
      io.to(p.id).emit('game', { ...room.game.stateFor(viewer), turnEndsIn });
    }
  }
}

function destroyRoom(room) {
  clearTimeout(room.botTimer);
  clearTimeout(room.turnTimer);
  rooms.delete(room.code);
}

// 턴 제한시간 타이머: 만료되면 자동 처리 (일반 턴=패스, 반납/귀족=자동 선택)
function setTurnTimer(room) {
  clearTimeout(room.turnTimer);
  const g = room.game;
  if (!g || g.phase === 'ended' || !room.options.timeLimit) {
    room.turnDeadline = null;
    return;
  }
  room.turnDeadline = Date.now() + room.options.timeLimit * 1000;
  room.turnTimer = setTimeout(() => {
    if (!rooms.has(room.code) || room.game !== g || g.phase === 'ended') return;
    try {
      if (g.phase === 'play') {
        g.handleAction(g.current, { type: 'pass', reason: 'timeout' });
      } else {
        // 반납/귀족 선택 단계는 봇 로직으로 자동 처리
        g.handleAction(g.current, chooseAction(g, g.current));
      }
    } catch (e) {
      console.error('시간 초과 처리 오류:', e.message);
    }
    setTurnTimer(room);
    broadcastGame(room);
    scheduleBotTurn(room);
  }, room.options.timeLimit * 1000);
}

// 봇 차례면 잠시 후 행동 실행 (반납/귀족 선택 등 연속 행동도 재귀적으로 처리)
function scheduleBotTurn(room) {
  clearTimeout(room.botTimer);
  const g = room.game;
  if (!g || g.phase === 'ended') return;
  const cur = g.players[g.current];
  const seat = room.players.find((p) => p.id === cur.id);
  if (!seat || !seat.bot) return;
  room.botTimer = setTimeout(() => {
    // 다시하기 등으로 game 객체가 교체되었으면 이전 게임의 타이머는 무시
    if (!rooms.has(room.code) || room.game !== g || g.phase === 'ended') return;
    try {
      g.handleAction(g.current, chooseAction(g, g.current, room.options.botLevel));
    } catch (e) {
      console.error(`봇 행동 오류(${seat.name}):`, e.message);
      try { g.handleAction(g.current, { type: 'pass' }); } catch (_) { /* 무시 */ }
    }
    setTurnTimer(room);
    broadcastGame(room);
    scheduleBotTurn(room);
  }, BOT_DELAY);
}

function startRoomGame(room) {
  if (room.options.first === 'random') shufflePlayers(room.players);
  room.game = new Game(
    room.players.map((p) => ({ id: p.id, name: p.name })),
    {
      targetScore: room.options.targetScore,
      maxReserved: room.options.maxReserved,
      nobleCount: room.options.nobleCount,
    }
  );
  setTurnTimer(room);
  broadcastLobby(room);
  broadcastGame(room);
  scheduleBotTurn(room);
}

io.on('connection', (socket) => {
  let myRoom = null;

  socket.on('createRoom', ({ name, hotseat }, cb) => {
    name = String(name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '이름을 입력하세요.' });
    const room = {
      code: makeRoomCode(),
      hostId: socket.id,
      hotseat: !!hotseat,
      players: [{ id: socket.id, name, connected: true, bot: false }],
      game: null,
      botSeq: 0,
      localSeq: 0,
      botTimer: null,
      turnTimer: null,
      turnDeadline: null,
      // 같이 하기(한 기기) 모드는 기기를 넘겨가며 하므로 기본 제한시간 없음
      options: { ...DEFAULT_OPTIONS, ...(hotseat ? { timeLimit: 0 } : {}) },
    };
    rooms.set(room.code, room);
    myRoom = room;
    socket.join(room.code);
    cb({ ok: true, code: room.code, myId: socket.id });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '이름을 입력하세요.' });
    const room = rooms.get(code);
    if (!room) return cb({ error: '존재하지 않는 방 코드입니다.' });

    if (room.game) {
      // 게임 중인 방: 같은 이름의 접속 끊긴 자리에 재접속 허용
      const seat = room.players.find((p) => p.name === name && !p.connected && !p.bot);
      if (!seat) return cb({ error: '이미 게임이 시작된 방입니다.' });
      const oldId = seat.id;
      seat.id = socket.id;
      seat.connected = true;
      if (room.hostId === oldId) room.hostId = socket.id;
      const gp = room.game.players.find((p) => p.id === oldId);
      if (gp) gp.id = socket.id;
      myRoom = room;
      socket.join(room.code);
      cb({ ok: true, code: room.code, myId: socket.id, rejoined: true });
      broadcastLobby(room);
      broadcastGame(room);
      return;
    }

    if (room.players.length >= 4) return cb({ error: '방이 가득 찼습니다. (최대 4명)' });
    if (room.players.some((p) => p.name === name)) return cb({ error: '같은 이름의 플레이어가 이미 있습니다.' });
    room.players.push({ id: socket.id, name, connected: true, bot: false });
    myRoom = room;
    socket.join(room.code);
    cb({ ok: true, code: room.code, myId: socket.id });
    broadcastLobby(room);
  });

  // 게임 규칙 설정 (호스트, 대기실에서만)
  socket.on('setOptions', (opts, cb) => {
    const room = myRoom;
    if (!room) return cb({ error: '방에 있지 않습니다.' });
    if (room.hostId !== socket.id) return cb({ error: '호스트만 규칙을 바꿀 수 있습니다.' });
    if (room.game) return cb({ error: '게임 중에는 바꿀 수 없습니다.' });
    room.options = sanitizeOptions(opts);
    cb({ ok: true });
    broadcastLobby(room);
  });

  // 봇 추가/제거 (호스트, 대기실에서만)
  socket.on('addBot', (cb) => {
    const room = myRoom;
    if (!room) return cb({ error: '방에 있지 않습니다.' });
    if (room.hostId !== socket.id) return cb({ error: '호스트만 봇을 추가할 수 있습니다.' });
    if (room.game) return cb({ error: '게임 중에는 추가할 수 없습니다.' });
    if (room.players.length >= 4) return cb({ error: '방이 가득 찼습니다. (최대 4명)' });
    const name = BOT_NAMES[room.botSeq % BOT_NAMES.length];
    room.botSeq += 1;
    room.players.push({ id: `bot-${room.code}-${room.botSeq}`, name, connected: true, bot: true });
    cb({ ok: true });
    broadcastLobby(room);
  });

  // 로컬 플레이어(같은 기기에서 번갈아 플레이) 추가/제거 (호스트, 대기실에서만)
  socket.on('addLocalPlayer', ({ name }, cb) => {
    const room = myRoom;
    if (!room) return cb({ error: '방에 있지 않습니다.' });
    if (room.hostId !== socket.id) return cb({ error: '호스트만 플레이어를 추가할 수 있습니다.' });
    if (room.game) return cb({ error: '게임 중에는 추가할 수 없습니다.' });
    if (room.players.length >= 4) return cb({ error: '방이 가득 찼습니다. (최대 4명)' });
    name = String(name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '플레이어 이름을 입력하세요.' });
    if (room.players.some((p) => p.name === name)) return cb({ error: '같은 이름의 플레이어가 이미 있습니다.' });
    room.localSeq = (room.localSeq || 0) + 1;
    room.players.push({
      id: `local-${room.code}-${room.localSeq}`, name, connected: true, bot: false, local: true,
    });
    cb({ ok: true });
    broadcastLobby(room);
  });

  socket.on('removeLocalPlayer', ({ id }, cb) => {
    const room = myRoom;
    if (!room) return cb({ error: '방에 있지 않습니다.' });
    if (room.hostId !== socket.id) return cb({ error: '호스트만 플레이어를 제거할 수 있습니다.' });
    if (room.game) return cb({ error: '게임 중에는 제거할 수 없습니다.' });
    const before = room.players.length;
    room.players = room.players.filter((p) => !(p.local && p.id === id));
    if (room.players.length === before) return cb({ error: '해당 플레이어가 없습니다.' });
    cb({ ok: true });
    broadcastLobby(room);
  });

  socket.on('removeBot', ({ id }, cb) => {
    const room = myRoom;
    if (!room) return cb({ error: '방에 있지 않습니다.' });
    if (room.hostId !== socket.id) return cb({ error: '호스트만 봇을 제거할 수 있습니다.' });
    if (room.game) return cb({ error: '게임 중에는 제거할 수 없습니다.' });
    const before = room.players.length;
    room.players = room.players.filter((p) => !(p.bot && p.id === id));
    if (room.players.length === before) return cb({ error: '해당 봇이 없습니다.' });
    cb({ ok: true });
    broadcastLobby(room);
  });

  socket.on('startGame', (cb) => {
    const room = myRoom;
    if (!room) return cb({ error: '방에 있지 않습니다.' });
    if (room.hostId !== socket.id) return cb({ error: '호스트만 시작할 수 있습니다.' });
    if (room.game) return cb({ error: '이미 시작되었습니다.' });
    if (room.players.length < 2) return cb({ error: '봇을 추가하거나 최소 2명이 모여야 합니다.' });
    try {
      startRoomGame(room);
    } catch (e) {
      room.game = null;
      return cb({ error: e.message });
    }
    cb({ ok: true });
  });

  // 다시하기/재대결: 호스트가 같은 멤버로 새 게임 (게임 중에도 허용, 선 플레이어 로테이션)
  socket.on('rematch', (cb) => {
    const room = myRoom;
    if (!room || !room.game) return cb({ error: '진행한 게임이 없습니다.' });
    if (room.hostId !== socket.id) return cb({ error: '호스트만 다시 시작할 수 있습니다.' });
    const midGame = room.game.phase !== 'ended';
    room.players = room.players.filter((p) => p.connected);
    if (room.players.length < 2) return cb({ error: '남은 플레이어가 부족합니다. 봇을 추가하세요.' });
    // 선 정하기: 랜덤이면 startRoomGame에서 섞고, 차례대로면 한 칸 로테이션
    if (room.options.first !== 'random') room.players.push(room.players.shift());
    try {
      startRoomGame(room);
    } catch (e) {
      room.game = null;
      return cb({ error: e.message });
    }
    if (midGame) {
      const host = room.players.find((p) => p.id === socket.id);
      io.to(room.code).emit('notice', `${host ? host.name : '호스트'}가 게임을 처음부터 다시 시작했습니다.`);
    }
    cb({ ok: true });
  });

  socket.on('action', (action, cb) => {
    const room = myRoom;
    if (!room || !room.game) return cb({ error: '진행 중인 게임이 없습니다.' });
    let idx = room.game.players.findIndex((p) => p.id === socket.id);
    // 같이 하기 모드: 현재 차례가 로컬 플레이어면 호스트가 대신 조작한다
    const cur = room.game.players[room.game.current];
    const curSeat = cur && room.players.find((s) => s.id === cur.id);
    if (curSeat && curSeat.local && room.hostId === socket.id) idx = room.game.current;
    if (idx < 0) return cb({ error: '게임 참가자가 아닙니다.' });
    try {
      room.game.handleAction(idx, action);
    } catch (e) {
      return cb({ error: e.message });
    }
    cb({ ok: true });
    setTurnTimer(room);
    broadcastGame(room);
    scheduleBotTurn(room);
  });

  socket.on('leaveRoom', () => leave());
  socket.on('disconnect', () => leave());

  function leave() {
    const room = myRoom;
    if (!room) return;
    myRoom = null;
    const seat = room.players.find((p) => p.id === socket.id);
    if (!seat) return;

    if (room.game && room.game.phase !== 'ended') {
      seat.connected = false;
      // 접속 중인 사람(소켓)이 아무도 없으면 방 정리 (봇/로컬만 남은 방 방지)
      if (room.players.every((p) => p.bot || p.local || !p.connected)) return destroyRoom(room);
      broadcastLobby(room);
      io.to(room.code).emit('notice', `${seat.name}의 연결이 끊겼습니다. 같은 이름으로 다시 입장하면 이어서 할 수 있습니다.`);
    } else {
      room.players = room.players.filter((p) => p.id !== socket.id);
      if (room.players.every((p) => p.bot || p.local)) return destroyRoom(room);
      if (room.hostId === socket.id) {
        const nextHost = room.players.find((p) => !p.bot && !p.local);
        room.hostId = nextHost ? nextHost.id : null;
      }
      broadcastLobby(room);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Splendor 서버 실행 중: http://localhost:${PORT}`);
  for (const u of LAN_URLS) console.log(`  같은 네트워크(휴대폰 등)에서: ${u}`);
});
