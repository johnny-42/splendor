// 봇 AI — 서버에서 봇 차례에 행동을 결정한다. 난이도 3단계.
// 쉬움: 무작위 위주(살 수 있으면 아무거나 구매, 토큰도 무작위)
// 보통: 살 수 있는 최고점 카드 구매 → 목표 카드(부족 토큰 최소)용 토큰 수집 → 예약으로 황금 확보
// 어려움: 보통 + 효율 중심 목표 선정(점수/부족토큰 비율), 귀족 즉시 달성 가중치, 더 이른 예약
const COLORS = ['w', 'u', 'g', 'r', 'k'];

function tokenTotal(t) {
  return Object.values(t).reduce((a, b) => a + b, 0);
}

// 카드 구매에 부족한 황금(조커) 개수
function goldNeeded(p, card) {
  let gold = 0;
  for (const c of COLORS) {
    const need = Math.max(0, card.cost[c] - p.bonuses[c]);
    gold += Math.max(0, need - p.tokens[c]);
  }
  return gold;
}

function canAfford(p, card) {
  return goldNeeded(p, card) <= p.tokens.gold;
}

// 황금 없이 토큰만으로 계산했을 때 색깔별 부족분
function missingTokens(p, card) {
  const miss = {};
  let total = 0;
  for (const c of COLORS) {
    const need = Math.max(0, card.cost[c] - p.bonuses[c] - p.tokens[c]);
    if (need > 0) { miss[c] = need; total += need; }
  }
  return { miss, total };
}

// 구매 후보: 내 예약 카드 + 공개 카드
function candidates(game, p) {
  const out = [];
  for (const c of p.reserved) out.push({ source: 'reserved', card: c });
  for (const l of [1, 2, 3]) for (const c of game.board[l]) if (c) out.push({ source: 'board', card: c });
  return out;
}

// 이 카드의 보너스가 남은 귀족 조건에 도움이 되는가
function helpsNoble(game, p, card) {
  return game.nobles.some((nb) => nb.req[card.bonus] && p.bonuses[card.bonus] < nb.req[card.bonus]) ? 1 : 0;
}

// 이 카드를 사면 귀족 방문 조건이 "즉시" 완성되는가
function completesNoble(game, p, card) {
  return game.nobles.some((nb) =>
    Object.entries(nb.req).every(
      ([c, n]) => p.bonuses[c] + (c === card.bonus ? 1 : 0) >= n
    )
  ) ? 1 : 0;
}

function maxReservedOf(game) {
  return Number.isFinite(game.maxReserved) ? game.maxReserved : 3;
}

function chooseAction(game, idx, level = 'normal') {
  const p = game.players[idx];

  if (game.phase === 'noble') {
    return { type: 'noble', nobleId: game.pendingNobles[0] };
  }
  if (game.phase === 'discard') {
    return chooseDiscard(game, p);
  }
  if (level === 'easy') return chooseEasyPlay(game, p);
  return choosePlay(game, p, level === 'hard');
}

// ---------- 쉬움: 무작위 위주 ----------

function chooseEasyPlay(game, p) {
  const cands = candidates(game, p);
  const affordable = cands.filter((x) => canAfford(p, x.card));

  // 70% 확률로 아무 카드나 구매 (최적 선택 안 함)
  if (affordable.length && Math.random() < 0.7) {
    const pick = affordable[Math.floor(Math.random() * affordable.length)];
    return { type: 'buy', source: pick.source, cardId: pick.card.id };
  }

  // 무작위 색 토큰 가져오기 (목표 없음)
  const avail = COLORS.filter((c) => game.bank[c] > 0).sort(() => Math.random() - 0.5);
  if (avail.length && tokenTotal(p.tokens) < 10) {
    return { type: 'take', gems: avail.slice(0, 3) };
  }
  if (affordable.length) {
    const pick = affordable[Math.floor(Math.random() * affordable.length)];
    return { type: 'buy', source: pick.source, cardId: pick.card.id };
  }
  if (p.reserved.length < maxReservedOf(game)) {
    const r = pickReserve(game, null);
    if (r) return r;
  }
  // 남은 경우는 보통 로직의 안전장치에 맡긴다
  return choosePlay(game, p, false);
}

// ---------- 보통 / 어려움 ----------

function buyScore(game, p, x, hard) {
  if (hard) {
    return (
      x.card.points * 12 +
      completesNoble(game, p, x.card) * 15 +
      helpsNoble(game, p, x.card) * 4 +
      x.card.level * 2 -
      goldNeeded(p, x.card) * 2
    );
  }
  return x.card.points * 10 + helpsNoble(game, p, x.card) * 4 + x.card.level - goldNeeded(p, x.card);
}

// 목표 카드 선정
function pickTarget(game, p, hard) {
  const targets = candidates(game, p).map((x) => ({ ...x, m: missingTokens(p, x.card) }));
  if (!targets.length) return null;
  if (hard) {
    // 가까운 카드 우선하되 점수·귀족 기여만큼 거리를 할인 (달성 가능한 고효율)
    const key = (x) =>
      x.m.total - x.card.points * 0.8 - helpsNoble(game, p, x.card) * 0.5 - completesNoble(game, p, x.card);
    targets.sort((a, b) => key(a) - key(b) || b.card.points - a.card.points);
  } else {
    targets.sort((a, b) => a.m.total - b.m.total || b.card.points - a.card.points);
  }
  return targets[0];
}

function choosePlay(game, p, hard) {
  const cands = candidates(game, p);
  const maxRes = maxReservedOf(game);

  // 1) 살 수 있으면 점수 기준 최고 카드 구매
  const affordable = cands.filter((x) => canAfford(p, x.card));
  if (affordable.length) {
    affordable.sort((a, b) => buyScore(game, p, b, hard) - buyScore(game, p, a, hard));
    const best = affordable[0];
    return { type: 'buy', source: best.source, cardId: best.card.id };
  }

  const target = pickTarget(game, p, hard);
  const myTotal = tokenTotal(p.tokens);

  // 2) 토큰이 한도에 가까우면 예약으로 황금 확보 (어려움은 더 일찍)
  const reserveAt = hard ? 8 : 9;
  if (myTotal >= reserveAt && p.reserved.length < maxRes && game.bank.gold > 0) {
    const r = pickReserve(game, target);
    if (r) return r;
  }

  // 3) 목표 카드에 필요한 색 위주로 토큰 가져오기
  if (target) {
    const needColors = Object.keys(target.m.miss).filter((c) => game.bank[c] > 0);
    if (needColors.length === 1 && target.m.miss[needColors[0]] >= 2 && game.bank[needColors[0]] >= 4) {
      return { type: 'take', gems: [needColors[0], needColors[0]] };
    }
    if (needColors.length >= 1) {
      let gems = needColors.slice(0, 3);
      for (const c of COLORS) {
        if (gems.length >= 3) break;
        if (!gems.includes(c) && game.bank[c] > 0) gems.push(c);
      }
      const room = 10 - myTotal;
      if (room >= 1 && room < gems.length) gems = gems.slice(0, room); // 반납이 안 생기게 조절
      if (gems.length) return { type: 'take', gems };
    }
  }

  // 4) 필요한 색이 은행에 없으면: 아무 색이나 (한도 여유가 있을 때만)
  const avail = COLORS.filter((c) => game.bank[c] > 0);
  if (avail.length && myTotal < 10) {
    let gems = avail.slice(0, 3);
    const room = 10 - myTotal;
    if (room < gems.length) gems = gems.slice(0, room);
    if (gems.length) return { type: 'take', gems };
  }

  // 5) 예약(황금이 없어도 카드 확보는 됨)
  if (p.reserved.length < maxRes) {
    const r = pickReserve(game, target);
    if (r) return r;
  }

  // 6) 정말 할 게 없으면 패스
  return { type: 'pass' };
}

// 예약 대상 선택: 목표 카드가 공개돼 있으면 그것, 아니면 최고점 공개 카드, 없으면 더미
function pickReserve(game, target) {
  if (target && target.source === 'board') {
    for (const l of [1, 2, 3]) {
      const i = game.board[l].findIndex((c) => c && c.id === target.card.id);
      if (i >= 0) return { type: 'reserve', level: l, index: i };
    }
  }
  let best = null;
  for (const l of [3, 2, 1]) {
    for (let i = 0; i < game.board[l].length; i++) {
      const c = game.board[l][i];
      if (c && (!best || c.points > best.card.points)) best = { card: c, level: l, index: i };
    }
  }
  if (best) return { type: 'reserve', level: best.level, index: best.index };
  for (const l of [1, 2, 3]) {
    if (game.decks[l].length > 0) return { type: 'reserve', level: l, index: null };
  }
  return null;
}

// 한도 초과 반납: 목표 카드에 필요한 색은 지키고, 남는 색부터 버린다. 황금은 최후.
function chooseDiscard(game, p) {
  const excess = tokenTotal(p.tokens) - 10;
  const cands = candidates(game, p)
    .map((x) => ({ x, m: missingTokens(p, x.card) }))
    .sort((a, b) => a.m.total - b.m.total);
  const need = { w: 0, u: 0, g: 0, r: 0, k: 0 };
  if (cands[0]) {
    for (const c of COLORS) need[c] = Math.max(0, cands[0].x.card.cost[c] - p.bonuses[c]);
  }
  const d = { w: 0, u: 0, g: 0, r: 0, k: 0, gold: 0 };
  let left = excess;
  const order = [...COLORS].sort((a, b) => (p.tokens[b] - need[b]) - (p.tokens[a] - need[a]));
  for (const c of order) {
    if (!left) break;
    const surplus = Math.max(0, p.tokens[c] - need[c]);
    const t = Math.min(left, surplus);
    d[c] += t; left -= t;
  }
  for (const c of order) {
    if (!left) break;
    const t = Math.min(left, p.tokens[c] - d[c]);
    d[c] += t; left -= t;
  }
  if (left) {
    const t = Math.min(left, p.tokens.gold);
    d.gold += t; left -= t;
  }
  return { type: 'discard', tokens: d };
}

module.exports = { chooseAction };
