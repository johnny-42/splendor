/* 스플렌더 클라이언트 */

// ---------- 연결 계층 ----------
// 온라인 방(방 만들기/입장)은 서버 소켓, 혼자 하기/같이 하기는 로컬 엔진을 쓴다.
// 서버가 없어도(오프라인/앱 설치 후) 혼자 하기·같이 하기는 항상 동작한다.
const netSocket = typeof io !== 'undefined' ? io() : null;
const localSocket = new LocalSocket();
let socket = netSocket || localSocket;

function useLocal() { socket = localSocket; }
function useNet() {
  if (!netSocket) return false;
  socket = netSocket;
  return true;
}
// 서버/로컬 양쪽 이벤트를 같은 핸들러로 받는다
function onSocket(ev, fn) {
  if (netSocket) netSocket.on(ev, fn);
  localSocket.on(ev, fn);
}

// PWA: 서비스 워커 등록 (오프라인 캐시)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const COLORS = ['w', 'u', 'g', 'r', 'k'];
const COLOR_NAMES = { w: '다이아몬드', u: '사파이어', g: '에메랄드', r: '루비', k: '줄마노', gold: '황금' };

let myId = null;
let roomCode = null;
let game = null;       // 서버에서 받은 게임 상태
let lobbyInfo = null;  // 마지막 대기실 상태 (hostId 확인용)
let takeSel = [];      // 선택 중인 은행 토큰
let discardSel = null; // 버릴 토큰 선택 {color:count}
let forcedModal = false; // 반납/귀족/종료 등 강제 모달 표시 여부

const $ = (id) => document.getElementById(id);

// ---------- 화면 전환 / 알림 ----------

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  $('screen-' + name).classList.add('active');
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openModal(html) {
  $('modal-body').innerHTML = html;
  $('modal').style.display = 'flex';
}
function closeModal() {
  $('modal').style.display = 'none';
  forcedModal = false;
}
$('modal').addEventListener('click', (e) => {
  // 강제 선택 단계(discard/noble/종료)에서는 바깥 클릭으로 닫지 않음
  if (e.target === $('modal') && game && game.phase === 'play') closeModal();
});

// ---------- 홈 / 대기실 ----------

$('btn-create').onclick = () => {
  if (!useNet() || !netSocket.connected)
    return ($('home-error').textContent = '서버에 연결할 수 없습니다. 혼자 하기·같이 하기는 오프라인에서도 가능해요.');
  socket.emit('createRoom', { name: $('input-name').value }, (res) => {
    if (res.error) return ($('home-error').textContent = res.error);
    myId = res.myId;
    roomCode = res.code;
    showScreen('lobby');
  });
};

// 혼자 하기: 로컬 엔진으로 방을 만들고 봇 1개를 자동 추가 (서버 불필요, 오프라인 가능)
$('btn-solo').onclick = () => {
  useLocal();
  socket.emit('createRoom', { name: $('input-name').value }, (res) => {
    if (res.error) return ($('home-error').textContent = res.error);
    myId = res.myId;
    roomCode = res.code;
    socket.emit('addBot', () => {});
    showScreen('lobby');
  });
};

// 같이 하기(한 기기): 로컬 엔진으로 방을 만들고 함께 할 사람 이름을 추가한다 (오프라인 가능)
$('btn-hotseat').onclick = () => {
  useLocal();
  socket.emit('createRoom', { name: $('input-name').value, hotseat: true }, (res) => {
    if (res.error) return ($('home-error').textContent = res.error);
    myId = res.myId;
    roomCode = res.code;
    showScreen('lobby');
    $('input-local-name').focus();
  });
};

$('btn-addlocal').onclick = () => {
  const nameEl = $('input-local-name');
  socket.emit('addLocalPlayer', { name: nameEl.value }, (res) => {
    if (res.error) return ($('lobby-error').textContent = res.error);
    $('lobby-error').textContent = '';
    nameEl.value = '';
    nameEl.focus();
  });
};
$('input-local-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-addlocal').click();
});

// ---------- 초대 링크 ----------

// 초대 링크: 접속 주소가 localhost면 친구가 쓸 수 없으므로 서버가 알려준 LAN 주소를 사용
// (서브패스 배포에서도 동작하도록 현재 경로 기준으로 만든다)
function inviteUrl() {
  let base = location.origin + location.pathname.replace(/index\.html$/, '');
  if (
    ['localhost', '127.0.0.1'].includes(location.hostname) &&
    lobbyInfo && lobbyInfo.urls && lobbyInfo.urls.length
  ) {
    base = lobbyInfo.urls[0] + '/';
  }
  return `${base}?room=${roomCode}`;
}

function copyText(text) {
  // 비보안 컨텍스트(LAN IP 접속)나 클립보드 권한 거부 시 폴백
  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } finally { ta.remove(); }
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  };
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(legacy);
  }
  return legacy();
}

$('btn-copy-url').onclick = () => {
  if (!roomCode) return;
  const url = inviteUrl();
  copyText(url).then(
    () => toast(`초대 링크 복사됨: ${url}`),
    () => toast(`복사 실패 — 이 주소를 직접 알려주세요: ${url}`)
  );
};

// 초대 링크(?room=XXXX)로 들어온 경우: 방 코드를 미리 채워준다
{
  const r = new URLSearchParams(location.search).get('room');
  if (r) {
    $('input-code').value = r.toUpperCase();
    $('input-name').focus();
  }
}

$('btn-join').onclick = () => {
  if (!useNet() || !netSocket.connected)
    return ($('home-error').textContent = '서버에 연결할 수 없습니다. 혼자 하기·같이 하기는 오프라인에서도 가능해요.');
  socket.emit('joinRoom', { code: $('input-code').value, name: $('input-name').value }, (res) => {
    if (res.error) return ($('home-error').textContent = res.error);
    myId = res.myId;
    roomCode = res.code;
    showScreen(res.rejoined ? 'game' : 'lobby');
  });
};

$('btn-start').onclick = () => {
  socket.emit('startGame', (res) => {
    if (res.error) $('lobby-error').textContent = res.error;
  });
};

onSocket('lobby', (lobby) => {
  lobbyInfo = lobby;
  roomCode = lobby.code;
  const isHost = lobby.hostId === myId;
  const hs = !!lobby.hotseat;
  $('lobby-code').textContent = lobby.code;
  // 같이 하기 모드는 한 기기에서 하므로 초대 관련 UI를 숨긴다
  $('lobby-code').style.display = hs ? 'none' : '';
  $('btn-copy-url').style.display = hs ? 'none' : '';
  document.querySelector('#screen-lobby .subtitle').textContent = hs
    ? '한 기기에서 번갈아 플레이합니다. 함께 할 사람을 추가하세요.'
    : '친구에게 방 코드를 알려주세요';
  $('lobby-url').textContent =
    !hs && lobby.urls && lobby.urls.length ? `휴대폰·다른 PC 접속: ${lobby.urls.join(' 또는 ')}` : '';
  $('lobby-players').innerHTML = lobby.players
    .map(
      (p) =>
        `<li>${p.bot ? '🤖 ' : p.local ? '👤 ' : ''}${esc(p.name)}` +
        (p.id === lobby.hostId ? '<span class="host-tag">👑 호스트</span>' : '') +
        (p.connected ? '' : '<span class="off">연결 끊김</span>') +
        ((p.bot || p.local) && isHost && !lobby.started
          ? `<button class="bot-remove" data-kind="${p.bot ? 'bot' : 'local'}" data-rid="${esc(p.id)}" title="제거">✕</button>`
          : '') +
        `</li>`
    )
    .join('');
  $('lobby-players').querySelectorAll('.bot-remove').forEach((el) => {
    el.onclick = () =>
      socket.emit(
        el.dataset.kind === 'bot' ? 'removeBot' : 'removeLocalPlayer',
        { id: el.dataset.rid },
        (res) => { if (res.error) $('lobby-error').textContent = res.error; }
      );
  });
  syncOptions(lobby);
  $('local-add').style.display = hs && isHost && !lobby.started && lobby.players.length < 4 ? 'flex' : 'none';
  $('btn-addbot').style.display = isHost && !lobby.started && lobby.players.length < 4 ? 'block' : 'none';
  $('btn-start').style.display = isHost && !lobby.started ? 'block' : 'none';
  $('btn-start').disabled = lobby.players.length < 2;
  $('lobby-hint').textContent = isHost
    ? lobby.players.length < 2
      ? hs ? '함께 할 사람을 1명 이상 추가하면 시작할 수 있습니다.' : '봇을 추가하거나 2명 이상 모이면 시작할 수 있습니다.'
      : ''
    : '호스트가 시작하기를 기다리는 중...';
});

$('btn-addbot').onclick = () => {
  socket.emit('addBot', (res) => {
    if (res.error) $('lobby-error').textContent = res.error;
  });
};

// ---------- 게임 규칙 설정 ----------

const optTime = $('opt-time');
const optScore = $('opt-score');
const optFirst = $('opt-first');
const optBot = $('opt-bot');
const optReserve = $('opt-reserve');
const optNoble = $('opt-noble');
const OPT_ELS = [optTime, optScore, optFirst, optBot, optReserve, optNoble];

optTime.add(new Option('없음', 0));
[10, 15, 20, 30, 45, 60].forEach((v) => optTime.add(new Option(v + '초', v)));
for (let v = 10; v <= 20; v++) optScore.add(new Option(v + '점', v));
optReserve.add(new Option('금지', 0));
for (let v = 1; v <= 5; v++) optReserve.add(new Option(v + '장', v));
optNoble.add(new Option('기본 (인원+1)', 'auto'));
optNoble.add(new Option('없음', 0));
for (let v = 1; v <= 5; v++) optNoble.add(new Option(v + '개', v));
optTime.value = '30';
optScore.value = '15';
optReserve.value = '3';
optNoble.value = 'auto';

function sendOptions() {
  socket.emit(
    'setOptions',
    {
      timeLimit: +optTime.value,
      targetScore: +optScore.value,
      first: optFirst.value,
      botLevel: optBot.value,
      maxReserved: +optReserve.value,
      nobleCount: optNoble.value === 'auto' ? 'auto' : +optNoble.value,
    },
    (res) => { if (res && res.error) toast(res.error); }
  );
}
OPT_ELS.forEach((el) => (el.onchange = sendOptions));

function syncOptions(lobby) {
  if (lobby.options) {
    const o = lobby.options;
    optTime.value = String(o.timeLimit);
    optScore.value = String(o.targetScore);
    optFirst.value = o.first;
    optBot.value = o.botLevel;
    optReserve.value = String(o.maxReserved);
    optNoble.value = String(o.nobleCount);
  }
  const editable = lobby.hostId === myId && !lobby.started;
  OPT_ELS.forEach((el) => (el.disabled = !editable));
}

onSocket('notice', (msg) => toast(msg));

// ---------- 카드 스킨 (개인 설정: 서버와 무관, 내 화면에만 적용) ----------

const SKINS = [
  { id: 'gem', name: '보석 세공' },
  { id: 'royal', name: '로열 오너먼트' },
  { id: 'plain', name: '미니멀' },
];
const skinSel = $('opt-skin');
SKINS.forEach((s) => skinSel.add(new Option(s.name, s.id)));

function applySkin(id) {
  if (!SKINS.some((s) => s.id === id)) id = 'gem';
  document.body.dataset.skin = id;
  try { localStorage.setItem('splendor.skin', id); } catch {}
  if (skinSel.value !== id) skinSel.value = id;
}
skinSel.onchange = () => applySkin(skinSel.value);

$('btn-skin').onclick = () => {
  const cur = document.body.dataset.skin || 'gem';
  const next = SKINS[(SKINS.findIndex((s) => s.id === cur) + 1) % SKINS.length];
  applySkin(next.id);
  toast(`카드 스킨: ${next.name}`);
};

applySkin((() => { try { return localStorage.getItem('splendor.skin'); } catch { return null; } })() || 'gem');

let turnDeadline = null; // 로컬 기준 턴 마감 시각

let lastCurrent = null; // 같이 하기 모드 차례 알림용

onSocket('game', (state) => {
  const prevCurrent = game && game.phase !== 'ended' ? lastCurrent : null;
  game = state;
  if (game.phase !== 'discard') discardSel = null;
  turnDeadline = state.turnEndsIn != null ? Date.now() + state.turnEndsIn : null;
  showScreen('game');
  // 같이 하기 모드: 차례가 바뀌면 기기를 넘기라고 알려준다
  if (isHotseat() && game.phase !== 'ended' && game.current !== prevCurrent) {
    const cur = game.players[game.current];
    if (cur && prevCurrent !== null) toast(`👉 ${cur.name}님 차례입니다. 기기를 넘겨주세요!`);
    takeSel = []; // 이전 사람이 고르던 토큰 선택 초기화
  }
  lastCurrent = game.current;
  $('topbar-code').textContent =
    (roomCode || '') + (game.targetScore ? ` · 목표 ${game.targetScore}점` : '');
  $('btn-restart').style.display = lobbyInfo && lobbyInfo.hostId === myId ? 'inline-block' : 'none';
  render();
});

// 턴 제한시간 카운트다운
setInterval(() => {
  const el = $('turn-timer');
  if (!game || game.phase === 'ended') {
    el.textContent = '';
    return;
  }
  const cur = game.players[game.current];
  if (!turnDeadline) {
    // 제한시간 없음: 현재 차례만 표시
    el.textContent = cur ? `👉 ${cur.name} 차례` : '';
    el.classList.remove('urgent');
    return;
  }
  const s = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
  el.textContent = `⏱ ${cur ? cur.name : ''} ${s}초`;
  el.classList.toggle('urgent', s <= 5);
}, 250);

// 다시하기: 현재 게임을 버리고 같은 멤버로 처음부터 (호스트 전용)
$('btn-restart').onclick = () => {
  if (!confirm('현재 게임을 버리고 처음부터 다시 시작할까요?')) return;
  socket.emit('rematch', (res) => {
    if (res.error) toast(res.error);
  });
};

$('btn-exit').onclick = () => {
  if (game && game.phase !== 'ended' && !confirm('게임에서 나갈까요?')) return;
  location.reload();
};

// ---------- 렌더링 ----------

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function isHotseat() {
  return !!(lobbyInfo && lobbyInfo.hotseat);
}
// 같이 하기 모드에서는 "나" = 현재 차례인 플레이어 (기기를 넘겨가며 플레이)
function me() {
  if (isHotseat()) return game.players[game.current];
  return game.players.find((p) => p.id === myId);
}
function isMyTurn() {
  if (isHotseat()) return true;
  return game.players[game.current] && game.players[game.current].id === myId;
}

function miniToken(color, n, square) {
  return `<span class="mini ${square ? 'sq' : ''} gem-${color}">${n}</span>`;
}

// 토큰(위)·카드 보너스(아래)를 색깔별 같은 열에 정렬한 그리드
function tokenCardGrid(p) {
  const cols = COLORS.map(
    (c) => `<div class="tc-col">
      <span class="mini gem-${c} ${p.tokens[c] ? '' : 'zero'}">${p.tokens[c]}</span>
      <span class="mini sq gem-${c} ${p.bonuses[c] ? '' : 'zero'}">${p.bonuses[c]}</span>
    </div>`
  ).join('');
  const gold = `<div class="tc-col">
    <span class="mini gem-gold ${p.tokens.gold ? '' : 'zero'}">${p.tokens.gold}</span>
    <span class="tc-empty"></span>
  </div>`;
  return `<div class="tc-grid">
    <div class="tc-labels"><span>토큰</span><span>카드</span></div>
    ${cols}${gold}
  </div>`;
}

function cardHTML(card, extraClass = '') {
  if (!card) return `<div class="card empty ${extraClass}"></div>`;
  if (card.hidden) return `<div class="card hiddenc ${extraClass}" title="비공개 예약 카드">?</div>`;
  const cost = COLORS.filter((c) => card.cost[c] > 0)
    .map((c) => miniToken(c, card.cost[c]))
    .join('');
  return `<div class="card tint-${card.bonus} lv${card.level} ${extraClass}" data-card="${card.id}">
    <div class="top">
      <span class="pts">${card.points || ''}</span>
      ${miniToken(card.bonus, '', true).replace('></span>', '>&#9670;</span>')}
    </div>
    <div class="cost">${cost}</div>
  </div>`;
}

function nobleHTML(noble, clickable = false) {
  const req = Object.entries(noble.req)
    .map(([c, n]) => miniToken(c, n, true))
    .join('');
  return `<div class="noble" data-noble="${noble.id}" ${clickable ? 'data-click="1"' : ''}>
    <span class="npts">3점</span>
    <div class="nname">${esc(noble.name)}</div>
    <div class="nreq">${req}</div>
  </div>`;
}

function render() {
  if (!game) return;
  renderPlayers();
  renderNobles();
  renderBoard();
  renderBank();
  renderMy();
  renderLog();
  renderPhaseModal();
}

function renderPlayers() {
  $('players-bar').innerHTML = game.players
    .map((p, i) => {
      return `<div class="pcard ${i === game.current ? 'turn' : ''} ${p.id === myId && !isHotseat() ? 'me' : ''}">
        <span class="pname">${esc(p.name)}</span>
        <span class="ppoints">${p.points}점</span>
        ${tokenCardGrid(p)}
        <div class="prow"><span class="label">예약 ${p.reserved.length} · 귀족 ${p.nobles.length}</span></div>
      </div>`;
    })
    .join('');
}

function renderNobles() {
  $('nobles-row').innerHTML = game.nobles.map((n) => nobleHTML(n)).join('');
}

function renderBoard() {
  let html = '';
  for (const level of [3, 2, 1]) {
    html += `<div class="deck-row">
      <div class="deck l${level}" data-deck="${level}">
        <span class="lvl">${'●'.repeat(level)}</span>
        <span class="lvl">${level}단계</span>
        <span class="cnt">${game.deckCounts[level]}장</span>
      </div>
      ${game.board[level].map((c) => cardHTML(c)).join('')}
    </div>`;
  }
  $('board').innerHTML = html;

  // 공개 카드 클릭 → 구매/예약 선택
  $('board').querySelectorAll('.card[data-card]').forEach((el) => {
    el.onclick = () => openCardModal(Number(el.dataset.card), 'board');
  });
  // 더미 클릭 → 비공개 예약
  $('board').querySelectorAll('.deck').forEach((el) => {
    el.onclick = () => openDeckModal(Number(el.dataset.deck));
  });
}

function renderBank() {
  $('bank').innerHTML = [...COLORS, 'gold']
    .map((c) => {
      const n = game.bank[c];
      const selCount = takeSel.filter((x) => x === c).length;
      return `<div class="token gem-${c} ${n === 0 ? 'zero' : ''} ${selCount ? 'selected' : ''}"
        data-color="${c}" title="${COLOR_NAMES[c]}">${n}</div>`;
    })
    .join('');

  $('bank').querySelectorAll('.token[data-color]').forEach((el) => {
    const c = el.dataset.color;
    if (c === 'gold') return; // 황금은 예약으로만 획득
    el.onclick = () => toggleTake(c);
  });

  $('take-sel').innerHTML = takeSel.map((c) => miniToken(c, '+1')).join('');
  $('btn-take').disabled = !(isMyTurn() && game.phase === 'play' && takeSel.length > 0);
}

function toggleTake(c) {
  if (!isMyTurn() || game.phase !== 'play') return toast('당신의 차례가 아닙니다.');
  const count = takeSel.filter((x) => x === c).length;
  if (count === 1 && takeSel.length === 1) {
    // 같은 색 한 번 더 클릭 → 2개 (은행 4개 이상 필요)
    if (game.bank[c] >= 4) takeSel = [c, c];
    else { toast('같은 색 2개는 은행에 4개 이상 있어야 합니다.'); }
  } else if (count >= 1) {
    takeSel = takeSel.filter((x) => x !== c);
  } else {
    if (takeSel.length >= 2 && new Set(takeSel).size === 1) takeSel = []; // 2개 선택 상태 초기화
    if (takeSel.length >= 3) return toast('토큰은 최대 3개까지 선택할 수 있습니다.');
    if (game.bank[c] < 1) return toast('은행에 해당 보석이 없습니다.');
    takeSel.push(c);
  }
  renderBank();
}

$('btn-take').onclick = () => {
  sendAction({ type: 'take', gems: takeSel }, () => { takeSel = []; });
};

function renderMy() {
  const p = me();
  if (!p) return;
  $('my-title').textContent = isHotseat()
    ? `${p.name}의 보유 (${p.points}점)`
    : `내 보유 — ${p.name} (${p.points}점)`;
  const total = Object.values(p.tokens).reduce((a, b) => a + b, 0);
  $('my-tokens').innerHTML =
    `<span class="label">토큰 ${total}/10 · 카드 보너스</span>` + tokenCardGrid(p);
  $('my-bonuses').innerHTML = '';
  $('my-reserved').innerHTML =
    p.reserved.map((c) => cardHTML(c)).join('') || '<span class="hint">없음</span>';
  $('my-reserved').querySelectorAll('.card[data-card]').forEach((el) => {
    el.onclick = () => openCardModal(Number(el.dataset.card), 'reserved');
  });
}

function renderLog() {
  $('log').innerHTML = game.log.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('');
}

// ---------- 카드 구매/예약 모달 ----------

function findCard(cardId, source) {
  if (source === 'board') {
    for (const l of [1, 2, 3]) for (const c of game.board[l]) if (c && c.id === cardId) return c;
  } else {
    return me().reserved.find((c) => c.id === cardId);
  }
}

function canAfford(card) {
  const p = me();
  let goldNeeded = 0;
  for (const c of COLORS) {
    const need = Math.max(0, card.cost[c] - p.bonuses[c]);
    goldNeeded += Math.max(0, need - p.tokens[c]);
  }
  return goldNeeded <= p.tokens.gold;
}

function openCardModal(cardId, source) {
  const card = findCard(cardId, source);
  if (!card || card.hidden) return;
  const mine = isMyTurn() && game.phase === 'play';
  const affordable = canAfford(card);
  const maxRes = game.maxReserved ?? 3;
  const canReserve = source === 'board' && maxRes > 0 && me().reserved.length < maxRes;
  openModal(`
    <h2>${card.level}단계 ${COLOR_NAMES[card.bonus]} 카드</h2>
    ${cardHTML(card)}
    <div class="btn-row">
      <button id="m-buy" class="primary" ${mine && affordable ? '' : 'disabled'}>구매</button>
      ${source === 'board' ? `<button id="m-reserve" ${mine && canReserve ? '' : 'disabled'}>예약 (+황금)</button>` : ''}
      <button id="m-cancel">닫기</button>
    </div>
    ${!mine ? '<p class="hint" style="margin-top:10px">당신의 차례가 아닙니다.</p>'
      : !affordable ? '<p class="hint" style="margin-top:10px">보석이 부족합니다.</p>' : ''}
  `);
  $('m-buy').onclick = () => sendAction({ type: 'buy', source, cardId }, closeModal);
  const r = $('m-reserve');
  if (r) {
    // 공개 카드 예약: 보드에서 위치 찾기
    r.onclick = () => {
      for (const l of [1, 2, 3]) {
        const i = game.board[l].findIndex((c) => c && c.id === cardId);
        if (i >= 0) return sendAction({ type: 'reserve', level: l, index: i }, closeModal);
      }
    };
  }
  $('m-cancel').onclick = closeModal;
}

function openDeckModal(level) {
  const mine = isMyTurn() && game.phase === 'play';
  const maxRes = game.maxReserved ?? 3;
  const ok = mine && maxRes > 0 && me().reserved.length < maxRes && game.deckCounts[level] > 0;
  openModal(`
    <h2>${level}단계 더미에서 예약</h2>
    <p class="hint">카드를 보지 않고 더미 맨 위 카드를 예약(킵)하고 황금 토큰 1개를 받습니다.</p>
    <div class="btn-row">
      <button id="m-deck" class="primary" ${ok ? '' : 'disabled'}>예약하기</button>
      <button id="m-cancel">닫기</button>
    </div>
  `);
  $('m-deck').onclick = () => sendAction({ type: 'reserve', level, index: null }, closeModal);
  $('m-cancel').onclick = closeModal;
}

// ---------- 강제 단계 모달 (버리기 / 귀족 / 종료) ----------

function renderPhaseModal() {
  if (game.phase === 'ended') return openGameOver();
  if (game.phase === 'play') {
    // 재대결 시작 등으로 강제 모달이 남아있으면 닫는다
    if (forcedModal || !isMyTurn()) closeModal();
    return;
  }
  if (!isMyTurn()) return;
  if (game.phase === 'discard') return openDiscard();
  if (game.phase === 'noble') return openNobleChoice();
}

function openDiscard() {
  const p = me();
  const total = Object.values(p.tokens).reduce((a, b) => a + b, 0);
  const excess = total - 10;
  if (!discardSel) discardSel = { w: 0, u: 0, g: 0, r: 0, k: 0, gold: 0 };
  const selCount = Object.values(discardSel).reduce((a, b) => a + b, 0);

  forcedModal = true;
  openModal(`
    <h2>토큰 한도 초과!</h2>
    <p class="hint">소지 한도는 10개입니다. ${excess}개를 골라 반납하세요. (${selCount}/${excess})</p>
    <div class="discard-tokens">
      ${[...COLORS, 'gold'].map((c) => `
        <div class="token gem-${c} ${discardSel[c] ? 'selected' : ''} ${p.tokens[c] - discardSel[c] <= 0 && !discardSel[c] ? 'zero' : ''}"
          data-d="${c}">${p.tokens[c] - discardSel[c]}${discardSel[c] ? ` (-${discardSel[c]})` : ''}</div>
      `).join('')}
    </div>
    <p class="hint">탭: 반납 +1 (최대에서 다시 탭하면 취소) · PC 우클릭: -1</p>
    <div class="btn-row">
      <button id="m-discard" class="primary" ${selCount === excess ? '' : 'disabled'}>반납</button>
    </div>
  `);

  document.querySelectorAll('[data-d]').forEach((el) => {
    const c = el.dataset.d;
    el.onclick = () => {
      const p2 = me();
      const cnt = Object.values(discardSel).reduce((a, b) => a + b, 0);
      // 탭: +1, 더 못 올리면(한도/보유량 도달) 0으로 되돌림 — 터치 기기에서 우클릭 없이 조작 가능
      if (cnt < excess && discardSel[c] < p2.tokens[c]) discardSel[c]++;
      else discardSel[c] = 0;
      openDiscard();
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (discardSel[c] > 0) discardSel[c]--;
      openDiscard();
    };
  });
  $('m-discard').onclick = () =>
    sendAction({ type: 'discard', tokens: discardSel }, () => { discardSel = null; closeModal(); });
}

function openNobleChoice() {
  const nobles = game.nobles.filter((n) => game.pendingNobles.includes(n.id));
  forcedModal = true;
  openModal(`
    <h2>귀족 방문! 한 명을 선택하세요</h2>
    <div class="modal-nobles">${nobles.map((n) => nobleHTML(n, true)).join('')}</div>
  `);
  document.querySelectorAll('.noble[data-click]').forEach((el) => {
    el.onclick = () => sendAction({ type: 'noble', nobleId: Number(el.dataset.noble) }, closeModal);
  });
}

function openGameOver() {
  const rows = game.ranking
    .map(
      (r, i) => `<tr class="${i === 0 ? 'win' : ''}">
        <td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.points}점</td>
        <td>${r.cards}장</td><td>${r.nobles}</td></tr>`
    )
    .join('');
  const isHost = lobbyInfo && lobbyInfo.hostId === myId;
  forcedModal = true;
  openModal(`
    <h2>🏆 게임 종료 — 승자: ${esc(game.winner)}</h2>
    <table class="rank-table">
      <tr><th>순위</th><th>이름</th><th>점수</th><th>카드</th><th>귀족</th></tr>
      ${rows}
    </table>
    <div class="btn-row">
      ${isHost ? '<button id="m-rematch" class="primary">재대결</button>' : ''}
      <button id="m-home">처음으로</button>
    </div>
    ${!isHost ? '<p class="hint" style="margin-top:10px">호스트가 재대결을 시작할 수 있습니다.</p>' : ''}
  `);
  const r = $('m-rematch');
  if (r) r.onclick = () => socket.emit('rematch', (res) => { if (res.error) toast(res.error); });
  $('m-home').onclick = () => location.reload();
}

// ---------- 공통 ----------

function sendAction(action, onOk) {
  socket.emit('action', action, (res) => {
    if (res.error) return toast(res.error);
    if (onOk) onOk();
  });
}

if (netSocket)
  netSocket.on('disconnect', () => {
    // 로컬(오프라인) 게임 중에는 서버 끊김이 영향 없다
    if (socket === netSocket) toast('서버와 연결이 끊겼습니다.');
  });
