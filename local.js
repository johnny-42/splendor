// 오프라인 로컬 게임 엔진 — 혼자 하기(AI)·같이 하기(한 기기) 모드를
// 서버 없이 기기 안에서 실행한다. server.js의 소켓 프로토콜을 그대로 흉내낸다.
(function () {
  const BOT_DELAY = 1000;
  const BOT_NAMES = ['봇 마르코', '봇 이자벨', '봇 앙리'];

  const DEFAULT_OPTIONS = {
    timeLimit: 30,
    targetScore: 15,
    first: 'order',
    botLevel: 'normal',
    maxReserved: 3,
    nobleCount: 'auto',
  };

  function clampInt(v, min, max, dflt) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  }
  function sanitizeOptions(opts) {
    const o = { ...DEFAULT_OPTIONS, ...(opts || {}) };
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

  class LocalSocket {
    constructor() {
      this.id = 'local-me';
      this.handlers = {};
      this.room = null;
    }

    on(ev, fn) {
      (this.handlers[ev] = this.handlers[ev] || []).push(fn);
    }
    _fire(ev, data) {
      for (const f of this.handlers[ev] || []) f(data);
    }

    emit(ev, payload, cb) {
      if (typeof payload === 'function') { cb = payload; payload = undefined; }
      cb = cb || (() => {});
      const fn = this['ev_' + ev];
      if (!fn) return cb({ error: '오프라인 모드에서 지원하지 않는 기능입니다.' });
      // 비동기 소켓처럼 다음 틱에 처리 (핸들러 등록 순서 문제 방지)
      setTimeout(() => fn.call(this, payload || {}, cb), 0);
    }

    // ---------- 대기실 ----------

    ev_createRoom({ name, hotseat }, cb) {
      name = String(name || '').trim().slice(0, 12);
      if (!name) return cb({ error: '이름을 입력하세요.' });
      this._clearTimers();
      this.room = {
        code: 'LOCAL',
        hostId: this.id,
        hotseat: !!hotseat,
        players: [{ id: this.id, name, connected: true, bot: false, local: false }],
        game: null,
        botSeq: 0,
        localSeq: 0,
        botTimer: null,
        turnTimer: null,
        turnDeadline: null,
        options: { ...DEFAULT_OPTIONS, ...(hotseat ? { timeLimit: 0 } : {}) },
      };
      cb({ ok: true, code: this.room.code, myId: this.id });
      this._lobby();
    }

    ev_setOptions(opts, cb) {
      const room = this.room;
      if (!room) return cb({ error: '방에 있지 않습니다.' });
      if (room.game) return cb({ error: '게임 중에는 바꿀 수 없습니다.' });
      room.options = sanitizeOptions(opts);
      cb({ ok: true });
      this._lobby();
    }

    ev_addBot(_p, cb) {
      const room = this.room;
      if (!room) return cb({ error: '방에 있지 않습니다.' });
      if (room.game) return cb({ error: '게임 중에는 추가할 수 없습니다.' });
      if (room.players.length >= 4) return cb({ error: '방이 가득 찼습니다. (최대 4명)' });
      const name = BOT_NAMES[room.botSeq % BOT_NAMES.length];
      room.botSeq += 1;
      room.players.push({ id: `bot-${room.botSeq}`, name, connected: true, bot: true, local: false });
      cb({ ok: true });
      this._lobby();
    }

    ev_removeBot({ id }, cb) {
      const room = this.room;
      if (!room) return cb({ error: '방에 있지 않습니다.' });
      if (room.game) return cb({ error: '게임 중에는 제거할 수 없습니다.' });
      const before = room.players.length;
      room.players = room.players.filter((p) => !(p.bot && p.id === id));
      if (room.players.length === before) return cb({ error: '해당 봇이 없습니다.' });
      cb({ ok: true });
      this._lobby();
    }

    ev_addLocalPlayer({ name }, cb) {
      const room = this.room;
      if (!room) return cb({ error: '방에 있지 않습니다.' });
      if (room.game) return cb({ error: '게임 중에는 추가할 수 없습니다.' });
      if (room.players.length >= 4) return cb({ error: '방이 가득 찼습니다. (최대 4명)' });
      name = String(name || '').trim().slice(0, 12);
      if (!name) return cb({ error: '플레이어 이름을 입력하세요.' });
      if (room.players.some((p) => p.name === name)) return cb({ error: '같은 이름의 플레이어가 이미 있습니다.' });
      room.localSeq += 1;
      room.players.push({ id: `local-${room.localSeq}`, name, connected: true, bot: false, local: true });
      cb({ ok: true });
      this._lobby();
    }

    ev_removeLocalPlayer({ id }, cb) {
      const room = this.room;
      if (!room) return cb({ error: '방에 있지 않습니다.' });
      if (room.game) return cb({ error: '게임 중에는 제거할 수 없습니다.' });
      const before = room.players.length;
      room.players = room.players.filter((p) => !(p.local && p.id === id));
      if (room.players.length === before) return cb({ error: '해당 플레이어가 없습니다.' });
      cb({ ok: true });
      this._lobby();
    }

    // ---------- 게임 진행 ----------

    ev_startGame(_p, cb) {
      const room = this.room;
      if (!room) return cb({ error: '방에 있지 않습니다.' });
      if (room.game) return cb({ error: '이미 시작되었습니다.' });
      if (room.players.length < 2) return cb({ error: '봇이나 플레이어를 추가해 2명 이상이어야 합니다.' });
      try {
        this._startGame();
      } catch (e) {
        room.game = null;
        return cb({ error: e.message });
      }
      cb({ ok: true });
    }

    ev_rematch(_p, cb) {
      const room = this.room;
      if (!room || !room.game) return cb({ error: '진행한 게임이 없습니다.' });
      const midGame = room.game.phase !== 'ended';
      if (room.options.first !== 'random') room.players.push(room.players.shift());
      try {
        this._startGame();
      } catch (e) {
        room.game = null;
        return cb({ error: e.message });
      }
      if (midGame) this._fire('notice', '게임을 처음부터 다시 시작했습니다.');
      cb({ ok: true });
    }

    ev_action(action, cb) {
      const room = this.room;
      if (!room || !room.game) return cb({ error: '진행 중인 게임이 없습니다.' });
      // 로컬 모드에서는 이 기기가 봇이 아닌 현재 플레이어를 모두 조작한다
      const cur = room.game.players[room.game.current];
      const seat = room.players.find((s) => s.id === cur.id);
      if (seat && seat.bot) return cb({ error: '봇 차례입니다.' });
      try {
        room.game.handleAction(room.game.current, action);
      } catch (e) {
        return cb({ error: e.message });
      }
      cb({ ok: true });
      this._setTurnTimer();
      this._game();
      this._scheduleBot();
    }

    ev_leaveRoom(_p, cb) {
      this._clearTimers();
      this.room = null;
      if (cb) cb({ ok: true });
    }

    // ---------- 내부 ----------

    _startGame() {
      const room = this.room;
      const { Game } = window.SplendorGame;
      if (room.options.first === 'random') shufflePlayers(room.players);
      room.game = new Game(
        room.players.map((p) => ({ id: p.id, name: p.name })),
        {
          targetScore: room.options.targetScore,
          maxReserved: room.options.maxReserved,
          nobleCount: room.options.nobleCount,
        }
      );
      this._setTurnTimer();
      this._lobby();
      this._game();
      this._scheduleBot();
    }

    _lobby() {
      const room = this.room;
      if (!room) return;
      this._fire('lobby', {
        code: room.code,
        hostId: room.hostId,
        started: !!room.game,
        hotseat: !!room.hotseat,
        urls: [],
        options: room.options,
        players: room.players.map((p) => ({
          id: p.id, name: p.name, connected: true, bot: !!p.bot, local: !!p.local,
        })),
      });
    }

    _game() {
      const room = this.room;
      if (!room || !room.game) return;
      const turnEndsIn = room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : null;
      // 현재 차례가 사람이면 그 사람 시점으로 상태 전송 (예약 카드 비공개 처리)
      const cur = room.game.players[room.game.current];
      const seat = cur && room.players.find((s) => s.id === cur.id);
      const viewer = seat && !seat.bot ? cur.id : this.id;
      this._fire('game', { ...room.game.stateFor(viewer), turnEndsIn });
    }

    _clearTimers() {
      if (this.room) {
        clearTimeout(this.room.botTimer);
        clearTimeout(this.room.turnTimer);
      }
    }

    _setTurnTimer() {
      const room = this.room;
      clearTimeout(room.turnTimer);
      const g = room.game;
      if (!g || g.phase === 'ended' || !room.options.timeLimit) {
        room.turnDeadline = null;
        return;
      }
      const { chooseAction } = window.SplendorAI;
      room.turnDeadline = Date.now() + room.options.timeLimit * 1000;
      room.turnTimer = setTimeout(() => {
        if (this.room !== room || room.game !== g || g.phase === 'ended') return;
        try {
          if (g.phase === 'play') g.handleAction(g.current, { type: 'pass', reason: 'timeout' });
          else g.handleAction(g.current, chooseAction(g, g.current));
        } catch (e) { /* 무시 */ }
        this._setTurnTimer();
        this._game();
        this._scheduleBot();
      }, room.options.timeLimit * 1000);
    }

    _scheduleBot() {
      const room = this.room;
      clearTimeout(room.botTimer);
      const g = room.game;
      if (!g || g.phase === 'ended') return;
      const cur = g.players[g.current];
      const seat = room.players.find((p) => p.id === cur.id);
      if (!seat || !seat.bot) return;
      const { chooseAction } = window.SplendorAI;
      room.botTimer = setTimeout(() => {
        if (this.room !== room || room.game !== g || g.phase === 'ended') return;
        try {
          g.handleAction(g.current, chooseAction(g, g.current, room.options.botLevel));
        } catch (e) {
          try { g.handleAction(g.current, { type: 'pass' }); } catch (_) { /* 무시 */ }
        }
        this._setTurnTimer();
        this._game();
        this._scheduleBot();
      }, BOT_DELAY);
    }
  }

  window.LocalSocket = LocalSocket;
})();
