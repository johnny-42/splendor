// 스플렌더 게임 로직
const { COLORS, buildCards, buildNobles } = require('./cards');

const WIN_POINTS = 15;
const TOKEN_LIMIT = 10;
const MAX_RESERVED = 3;
// 인원수별 보석 토큰 개수 (황금은 항상 5개)
const TOKENS_BY_PLAYERS = { 2: 4, 3: 5, 4: 7 };

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function emptyTokens() {
  return { w: 0, u: 0, g: 0, r: 0, k: 0, gold: 0 };
}

function tokenTotal(tokens) {
  return Object.values(tokens).reduce((a, b) => a + b, 0);
}

class Game {
  // playerInfos: [{ id, name }], options: { targetScore, maxReserved, nobleCount }
  constructor(playerInfos, options = {}) {
    const n = playerInfos.length;
    if (n < 2 || n > 4) throw new Error('2~4명만 플레이할 수 있습니다.');
    this.targetScore = options.targetScore || WIN_POINTS;
    this.maxReserved = Number.isFinite(options.maxReserved) ? options.maxReserved : MAX_RESERVED;

    this.players = playerInfos.map((p) => ({
      id: p.id,
      name: p.name,
      tokens: emptyTokens(),
      cards: [],                 // 구매한 개발 카드
      bonuses: { w: 0, u: 0, g: 0, r: 0, k: 0 },
      reserved: [],              // 예약(킵) 카드 — fromDeck이면 다른 사람에게 비공개
      nobles: [],
      points: 0,
    }));

    const gemCount = TOKENS_BY_PLAYERS[n];
    this.bank = { w: gemCount, u: gemCount, g: gemCount, r: gemCount, k: gemCount, gold: 5 };

    this.decks = buildCards();
    for (const l of [1, 2, 3]) shuffle(this.decks[l]);
    this.board = { 1: [], 2: [], 3: [] };
    for (const l of [1, 2, 3]) {
      for (let i = 0; i < 4; i++) this.board[l].push(this.decks[l].pop());
    }

    // 귀족 타일: 기본은 인원+1, 옵션으로 0~5개 조정 가능
    const nobleCount =
      options.nobleCount === undefined || options.nobleCount === 'auto'
        ? n + 1
        : Math.min(10, Math.max(0, options.nobleCount));
    this.nobles = shuffle(buildNobles()).slice(0, nobleCount);

    this.current = 0;            // 현재 턴 플레이어 인덱스
    this.phase = 'play';         // play | discard | noble | ended
    this.pendingNobles = [];     // noble 페이즈에서 선택 가능한 귀족 id 목록
    this.lastRound = false;      // 누군가 15점 달성 → 마지막 라운드
    this.winner = null;
    this.ranking = null;
    this.log = [];
    this.addLog(`게임 시작! (${n}인전, 목표 ${this.targetScore}점, 선: ${this.players[0].name})`);
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 60) this.log.shift();
  }

  currentPlayer() {
    return this.players[this.current];
  }

  // ---------- 행동 처리 ----------

  handleAction(playerIdx, action) {
    if (this.phase === 'ended') throw new Error('게임이 이미 종료되었습니다.');
    if (playerIdx !== this.current) throw new Error('당신의 차례가 아닙니다.');

    switch (action.type) {
      case 'take':    return this.actTake(action.gems);
      case 'reserve': return this.actReserve(action.level, action.index);
      case 'buy':     return this.actBuy(action.source, action.cardId);
      case 'discard': return this.actDiscard(action.tokens);
      case 'noble':   return this.actChooseNoble(action.nobleId);
      case 'pass':    return this.actPass(action.reason);
      default: throw new Error('알 수 없는 행동입니다.');
    }
  }

  // 보석 토큰 가져오기: 서로 다른 3개(부족하면 1~2개 허용) 또는 같은 색 2개(은행에 4개 이상일 때)
  actTake(gems) {
    if (this.phase !== 'play') throw new Error('지금은 토큰을 가져올 수 없습니다.');
    if (!Array.isArray(gems) || gems.length < 1 || gems.length > 3)
      throw new Error('토큰은 1~3개 선택해야 합니다.');
    for (const c of gems) {
      if (!COLORS.includes(c)) throw new Error('황금 토큰은 직접 가져올 수 없습니다.');
    }

    const p = this.currentPlayer();
    const uniq = [...new Set(gems)];

    if (gems.length === 2 && uniq.length === 1) {
      // 같은 색 2개
      const c = gems[0];
      if (this.bank[c] < 4) throw new Error('같은 색 2개는 은행에 4개 이상 남아 있어야 가져올 수 있습니다.');
      this.bank[c] -= 2;
      p.tokens[c] += 2;
    } else {
      // 서로 다른 색 1~3개
      if (uniq.length !== gems.length) throw new Error('서로 다른 색이거나, 같은 색이면 정확히 2개여야 합니다.');
      for (const c of gems) {
        if (this.bank[c] < 1) throw new Error('은행에 해당 보석이 없습니다.');
      }
      for (const c of gems) {
        this.bank[c] -= 1;
        p.tokens[c] += 1;
      }
    }
    this.addLog(`${p.name}: 토큰 획득 (${gems.map(colorName).join(', ')})`);
    this.afterMainAction();
  }

  // 카드 예약(킵): 바닥 카드(level+index) 또는 더미 맨 위(index=null), 황금 토큰 1개
  actReserve(level, index) {
    if (this.phase !== 'play') throw new Error('지금은 예약할 수 없습니다.');
    const p = this.currentPlayer();
    if (this.maxReserved === 0) throw new Error('이 게임에서는 예약이 금지되어 있습니다.');
    if (p.reserved.length >= this.maxReserved)
      throw new Error(`예약(킵)은 최대 ${this.maxReserved}장까지입니다.`);
    if (![1, 2, 3].includes(level)) throw new Error('잘못된 카드 단계입니다.');

    let card;
    if (index === null || index === undefined) {
      // 더미에서 비공개로 가져오기
      if (this.decks[level].length === 0) throw new Error('해당 더미에 카드가 없습니다.');
      card = this.decks[level].pop();
      card.fromDeck = true;
      this.addLog(`${p.name}: ${level}단계 더미에서 카드 1장 예약`);
    } else {
      card = this.board[level][index];
      if (!card) throw new Error('해당 위치에 카드가 없습니다.');
      this.board[level][index] = this.decks[level].pop() || null;
      this.addLog(`${p.name}: ${level}단계 공개 카드 예약`);
    }
    p.reserved.push(card);

    if (this.bank.gold > 0) {
      this.bank.gold -= 1;
      p.tokens.gold += 1;
    }
    this.afterMainAction();
  }

  // 카드 구매: source = 'board' | 'reserved'
  actBuy(source, cardId) {
    if (this.phase !== 'play') throw new Error('지금은 구매할 수 없습니다.');
    const p = this.currentPlayer();

    let card, remove;
    if (source === 'board') {
      outer: for (const l of [1, 2, 3]) {
        for (let i = 0; i < this.board[l].length; i++) {
          if (this.board[l][i] && this.board[l][i].id === cardId) {
            card = this.board[l][i];
            remove = () => { this.board[l][i] = this.decks[l].pop() || null; };
            break outer;
          }
        }
      }
    } else if (source === 'reserved') {
      const idx = p.reserved.findIndex((c) => c.id === cardId);
      if (idx >= 0) {
        card = p.reserved[idx];
        remove = () => { p.reserved.splice(idx, 1); };
      }
    }
    if (!card) throw new Error('해당 카드를 찾을 수 없습니다.');

    // 지불 계산: 색깔별 (비용 - 보너스) 부족분, 모자란 만큼 황금으로
    const payment = emptyTokens();
    let goldNeeded = 0;
    for (const c of COLORS) {
      const need = Math.max(0, card.cost[c] - p.bonuses[c]);
      const payWithTokens = Math.min(need, p.tokens[c]);
      payment[c] = payWithTokens;
      goldNeeded += need - payWithTokens;
    }
    if (goldNeeded > p.tokens.gold) throw new Error('보석이 부족하여 구매할 수 없습니다.');
    payment.gold = goldNeeded;

    for (const c of Object.keys(payment)) {
      p.tokens[c] -= payment[c];
      this.bank[c] += payment[c];
    }
    remove();
    delete card.fromDeck;
    p.cards.push(card);
    p.bonuses[card.bonus] += 1;
    p.points += card.points;
    this.addLog(`${p.name}: ${card.level}단계 ${colorName(card.bonus)} 카드 구매 (+${card.points}점, 총 ${p.points}점)`);
    this.afterMainAction();
  }

  // 턴 넘기기: 시간 초과 자동 처리 또는 가능한 행동이 없을 때(봇 안전장치)
  actPass(reason) {
    if (this.phase !== 'play') throw new Error('지금은 패스할 수 없습니다.');
    this.addLog(
      reason === 'timeout'
        ? `${this.currentPlayer().name}: ⏱ 시간 초과로 턴이 넘어갑니다.`
        : `${this.currentPlayer().name}: 가능한 행동이 없어 턴을 넘깁니다.`
    );
    this.afterMainAction();
  }

  // 토큰 초과분 버리기
  actDiscard(tokens) {
    if (this.phase !== 'discard') throw new Error('지금은 토큰을 버릴 수 없습니다.');
    const p = this.currentPlayer();
    const excess = tokenTotal(p.tokens) - TOKEN_LIMIT;
    const discardCount = tokenTotal(tokens || {});
    if (discardCount !== excess) throw new Error(`정확히 ${excess}개를 버려야 합니다.`);
    for (const c of Object.keys(tokens)) {
      if (tokens[c] < 0 || (p.tokens[c] || 0) < tokens[c]) throw new Error('가지고 있지 않은 토큰입니다.');
    }
    for (const c of Object.keys(tokens)) {
      p.tokens[c] -= tokens[c];
      this.bank[c] += tokens[c];
    }
    this.addLog(`${p.name}: 토큰 ${excess}개 반납 (소지 한도 10개)`);
    this.phase = 'play';
    this.resolveNobles();
  }

  // 귀족 선택 (동시에 2명 이상 조건 충족 시)
  actChooseNoble(nobleId) {
    if (this.phase !== 'noble') throw new Error('지금은 귀족을 선택할 수 없습니다.');
    if (!this.pendingNobles.includes(nobleId)) throw new Error('선택할 수 없는 귀족입니다.');
    this.awardNoble(nobleId);
    this.pendingNobles = [];
    this.phase = 'play';
    this.endTurn();
  }

  // ---------- 턴 흐름 ----------

  afterMainAction() {
    const p = this.currentPlayer();
    if (tokenTotal(p.tokens) > TOKEN_LIMIT) {
      this.phase = 'discard';
      return;
    }
    this.resolveNobles();
  }

  // 턴 종료 시 귀족 방문 확인 (턴당 1명만)
  resolveNobles() {
    const p = this.currentPlayer();
    const eligible = this.nobles.filter((nb) =>
      Object.entries(nb.req).every(([c, n]) => p.bonuses[c] >= n)
    );
    if (eligible.length === 1) {
      this.awardNoble(eligible[0].id);
      this.endTurn();
    } else if (eligible.length > 1) {
      this.phase = 'noble';
      this.pendingNobles = eligible.map((nb) => nb.id);
    } else {
      this.endTurn();
    }
  }

  awardNoble(nobleId) {
    const idx = this.nobles.findIndex((nb) => nb.id === nobleId);
    const noble = this.nobles.splice(idx, 1)[0];
    const p = this.currentPlayer();
    p.nobles.push(noble);
    p.points += noble.points;
    this.addLog(`${p.name}: 귀족 「${noble.name}」 방문! (+3점, 총 ${p.points}점)`);
  }

  endTurn() {
    const p = this.currentPlayer();
    if (!this.lastRound && p.points >= this.targetScore) {
      this.lastRound = true;
      this.addLog(`${p.name}이(가) ${p.points}점 달성! 이번 라운드가 마지막입니다.`);
    }
    this.current = (this.current + 1) % this.players.length;
    if (this.lastRound && this.current === 0) {
      this.finishGame();
    } else {
      this.phase = 'play';
    }
  }

  // 승자 판정: 점수 → 개발 카드 적은 쪽 → 귀족 많은 쪽 → 남은 토큰 많은 쪽 → 후공
  finishGame() {
    this.phase = 'ended';
    const ranked = this.players
      .map((p, i) => ({ p, i }))
      .sort((a, b) =>
        b.p.points - a.p.points ||
        a.p.cards.length - b.p.cards.length ||
        b.p.nobles.length - a.p.nobles.length ||
        tokenTotal(b.p.tokens) - tokenTotal(a.p.tokens) ||
        b.i - a.i
      );
    this.winner = ranked[0].p.name;
    this.ranking = ranked.map(({ p }) => ({
      name: p.name,
      points: p.points,
      cards: p.cards.length,
      nobles: p.nobles.length,
      tokens: tokenTotal(p.tokens),
    }));
    this.addLog(`게임 종료! 승자: ${this.winner} (${ranked[0].p.points}점)`);
  }

  // ---------- 상태 직렬화 (플레이어별 뷰) ----------

  stateFor(viewerId) {
    return {
      targetScore: this.targetScore,
      maxReserved: this.maxReserved,
      bank: this.bank,
      board: this.board,
      deckCounts: { 1: this.decks[1].length, 2: this.decks[2].length, 3: this.decks[3].length },
      nobles: this.nobles,
      current: this.current,
      phase: this.phase,
      pendingNobles: this.pendingNobles,
      lastRound: this.lastRound,
      winner: this.winner,
      ranking: this.ranking,
      log: this.log,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        tokens: p.tokens,
        bonuses: p.bonuses,
        cardCount: p.cards.length,
        nobles: p.nobles,
        points: p.points,
        // 더미에서 예약한 카드는 본인에게만 공개
        reserved: p.reserved.map((c) =>
          p.id === viewerId || !c.fromDeck
            ? c
            : { id: c.id, level: c.level, hidden: true }
        ),
      })),
    };
  }
}

function colorName(c) {
  return { w: '다이아몬드', u: '사파이어', g: '에메랄드', r: '루비', k: '줄마노', gold: '황금' }[c] || c;
}

module.exports = { Game, TOKEN_LIMIT };
