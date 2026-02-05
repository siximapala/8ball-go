// /static/js/script.js
if (window.__8ball_script_loaded) {
  console.warn('8ball script already loaded');
} else {
  window.__8ball_script_loaded = true;

  // Константы и состояние
  let gameId = '';
  let canvas = null;
  let ctx = null;
  let gameState = null;
  let mouseAngle = -Math.PI / 2;
  let grabbed = false;
  let pullPos = { x: 0, y: 0 };
  let computedPower = 0;
  let localPlayerName = '';
  let localPlayerRole = 0;
  let myTurn = false;

  const TABLE_WIDTH = 1400;
  const TABLE_HEIGHT = 2800;

  const RAIL_SIZE = 80;
  const MAX_PULL_DIST = 500;
  const VISUAL_CUE_MAX_LEN = 800;
  const VISUAL_CUE_DEFAULT_LEN = 300;
  const VISUAL_CUE_MIN_LEN = 30;

  let dpr = 1;
  let lastRect = { width: 0, height: 0 };
  let totalGameWidth = TABLE_WIDTH + RAIL_SIZE * 2;
  let totalGameHeight = TABLE_HEIGHT + RAIL_SIZE * 2;
  let ballInHand = false;

  // ресурсы для отрисовки и связи с сервером храним для завершения
  let es = null;
  let rafId = null;
  let handlers = {};
  let debouncedResize = null;

  // дебаунс
  function debounce(fn, ms = 100) {
    let t;
    const wrapper = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
    wrapper.cancel = () => clearTimeout(t);
    return wrapper;
  }

  // Удаление игры и очистка ресурсов
  function teardownGame() {
    if (es) {
      try { es.close(); } catch (e) {}
      es = null;
    }

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (handlers.resize) window.removeEventListener('resize', handlers.resize);
    if (handlers.orientation) window.removeEventListener('orientationchange', handlers.orientation);

    if (handlers.mousemove) document.removeEventListener('mousemove', handlers.mousemove);
    if (handlers.mouseup) document.removeEventListener('mouseup', handlers.mouseup);

    if (handlers.touchmove) document.removeEventListener('touchmove', handlers.touchmove);
    if (handlers.touchend) document.removeEventListener('touchend', handlers.touchend);

    if (handlers.canvas_mousedown && canvas) canvas.removeEventListener('mousedown', handlers.canvas_mousedown);
    if (handlers.canvas_touchstart && canvas) canvas.removeEventListener('touchstart', handlers.canvas_touchstart);

    canvas = null;
    ctx = null;

    gameState = null;
    mouseAngle = -Math.PI / 2;
    grabbed = false;
    pullPos = { x: 0, y: 0 };
    computedPower = 0;
    localPlayerRole = 0;
    myTurn = false;
    ballInHand = false;

    handlers = {};
    if (debouncedResize && debouncedResize.cancel) debouncedResize.cancel();
    debouncedResize = null;
  }

  // Рисует индикатор игрока: none 0, solid 1, stripe 2.
  function renderTurnBall(el, setType, isActive) {
    if (!el) return;
    // очистим инлайн стили чтобы предыдущее не мешало
    el.style.background = '';
    el.style.backgroundClip = '';
    el.style.border = '2px solid rgba(0,0,0,0.12)';
    el.style.boxShadow = '';
    el.style.display = setType === 0 && !isActive ? 'none' : 'inline-block';

    // размеры
    el.style.width = el.classList.contains('legacy') ? '12px' : '14px';
    el.style.height = el.classList.contains('legacy') ? '12px' : '14px';
    el.style.borderRadius = '50%';
    el.style.verticalAlign = 'middle';

    const solidColor = '#d63031';
    const stripeColor = '#f9ca24';
    if (setType === 1) {
      // solid
      el.style.background = `radial-gradient(circle at 30% 30%, #fff 0 18%, ${solidColor} 20% 100%)`;
    } else if (setType === 2) {
      // stripe: white center with colored band
      el.style.background = `linear-gradient(90deg, white 25%, ${stripeColor} 25% 75%, white 75%)`;
      el.style.backgroundClip = 'padding-box';
    } else {
      // no set assigned yet, keep transparent until assigned or show glow when active
      el.style.background = 'transparent';
    }

    if (isActive) {
      // glow to indicate current turn
      el.style.boxShadow = '0 0 8px rgba(46,204,113,0.4)';
      // if no set assigned, fallback to green fill so there is an indicator
      if (setType === 0) {
        el.style.background = '#2ecc71';
      }
      el.style.display = 'inline-block';
    } else {
      // remove glow
      // ensure if there is set but not active, still visible
      if (setType === 0) {
        el.style.display = 'inline-block';
        el.style.background = 'transparent';
      }
    }
  }

  // Инициализируем игру
  function initGame(id, playerName) {
    teardownGame();

    gameId = id;
    localPlayerName = playerName || '';

    canvas = document.getElementById('billiardsTable');
    if (!canvas) throw new Error('Canvas #billiardsTable not found');
    ctx = canvas.getContext('2d');

    // resizeCanvas
    function resizeCanvas() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      lastRect.width = rect.width;
      lastRect.height = rect.height;
    }

    let resizeAttempts = 0;
    function ensureResize() {
      resizeCanvas();
      const rect = canvas.getBoundingClientRect();
      if ((rect.width === 0 || rect.height === 0) && resizeAttempts < 6) {
        resizeAttempts++;
        requestAnimationFrame(ensureResize);
      } else if (rect.width === 0 || rect.height === 0) {
        setTimeout(() => { resizeCanvas(); }, 100);
      }
    }

    handlers.resize = debounce(resizeCanvas, 120);
    handlers.orientation = debounce(resizeCanvas, 200);

    window.addEventListener('resize', handlers.resize);
    window.addEventListener('orientationchange', handlers.orientation);

    ensureResize();

    function loop() {
      gameLoop();
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);

    const controls = document.getElementById('controls');
    if (controls) controls.style.display = 'none';

    // SSE
    try {
      es = new EventSource(`/events?game_id=${encodeURIComponent(gameId)}`);
    } catch (err) {
      console.error('EventSource construct failed', err);
      es = null;
    }

    if (es) {
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          // сохраняем state полностью
          gameState = data;

          // normalize flags we may use
          ballInHand = !!(data.ball_in_hand || data.ballInHand);
          const p1 = data.player1 || '';
          const p2 = data.player2 || '';

          if (localPlayerName) {
            if (localPlayerName === p1) localPlayerRole = 1;
            else if (localPlayerName === p2) localPlayerRole = 2;
            else localPlayerRole = 0;
          }

          const bothPresent = !!(p1 && p2);
          myTurn = (localPlayerRole !== 0) && ((data.current_player || data.current) === localPlayerRole) && bothPresent;

          // call UI update with data
          updateUI(data);
        } catch (err) {
          // ignore malformed message
        }
      };
      es.onerror = (err) => {
        console.error('EventSource error', err);
      };
    }

    // Хэндлеры ввода
    handlers.canvas_mousedown = (e) => handleStart(e.clientX, e.clientY);
    handlers.mousemove = (e) => handleMove(e.clientX, e.clientY);
    handlers.mouseup = () => handleEnd();

    handlers.canvas_touchstart = (e) => {
      if (!e.touches || e.touches.length === 0) return;
      e.preventDefault();
      const t = e.touches[0];
      handleStart(t.clientX, t.clientY);
    };
    handlers.touchmove = (e) => {
      if (grabbed) e.preventDefault();
      if (!e.touches || e.touches.length === 0) return;
      const t = e.touches[0];
      handleMove(t.clientX, t.clientY);
    };
    handlers.touchend = () => handleEnd();

    canvas.addEventListener('mousedown', handlers.canvas_mousedown);
    document.addEventListener('mousemove', handlers.mousemove);
    document.addEventListener('mouseup', handlers.mouseup);

    canvas.addEventListener('touchstart', handlers.canvas_touchstart, { passive: false });
    document.addEventListener('touchmove', handlers.touchmove, { passive: false });
    document.addEventListener('touchend', handlers.touchend, { passive: false });

    // инициализация UI на случай, если данные уже есть в разметке
    const initialGameData = document.getElementById('gameData');
    if (initialGameData && initialGameData.dataset) {
      const initial = {
        player1: initialGameData.dataset.player1 || '',
        player2: initialGameData.dataset.player2 || '',
        current_player: 0,
      };
      updateUI(initial);
    }
  }

  function handleStart(clientX, clientY) {
    if (!gameState) return;
    const pos = screenToGame(clientX, clientY);

    // разрешение поставить биток только если сервер уже применил смену хода и игра не движется
    const canPlace = ballInHand && myTurn && gameState && !gameState.is_moving;
    if (canPlace) {
      placeCueAt(pos.x, pos.y);
      return;
    }

    // если сейчас режим ball in hand у кого-то, но это не твой ход, запрет на прицеливание
    if (gameState && (gameState.ball_in_hand || gameState.ballInHand)) return;

    if (gameState.is_moving) return;
    if (!myTurn) return;

    const cueBall = (gameState.balls || []).find(b => b.number === 0 && !b.pocketed);
    if (!cueBall) return;
    const dist = Math.hypot(pos.x - cueBall.x, pos.y - cueBall.y);
    if (dist < 250) {
      grabbed = true;
      pullPos = { x: pos.x, y: pos.y };
      updateAim(pos.x, pos.y, cueBall);
    }
  }

  function handleMove(clientX, clientY) {
    // если биток можно поставить, не трогаем прицеливание
    if (!myTurn) return;
    if (!gameState) return;

    // если сейчас у кого-то ball in hand, отключаем прицеливание
    if (gameState.ball_in_hand || gameState.ballInHand) return;

    const pos = screenToGame(clientX, clientY);
    const cueBall = (gameState.balls || []).find(b => b.number === 0 && !b.pocketed);
    if (!cueBall) return;
    if (grabbed) {
      updateAim(pos.x, pos.y, cueBall);
    } else {
      mouseAngle = Math.atan2(cueBall.y - pos.y, cueBall.x - pos.x);
    }
  }

  function handleEnd() {
    if (!grabbed) return;
    grabbed = false;
    if (computedPower > 0.05) {
      shoot(mouseAngle, computedPower);
    }
    computedPower = 0;
  }

  function updateAim(inputX, inputY, cueBall) {
    const dx = cueBall.x - inputX;
    const dy = cueBall.y - inputY;
    mouseAngle = Math.atan2(dy, dx);
    const dist = Math.hypot(dx, dy);
    computedPower = Math.min(1, dist / MAX_PULL_DIST);
  }

  function shoot(angle, power) {
    fetch('/game/shoot', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ game_id: gameId, angle: angle, power: power, player_name: localPlayerName })
    }).catch(console.error);
  }

  function placeCueAt(gameX, gameY) {
    fetch('/game/place', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        game_id: gameId,
        x: gameX,
        y: gameY,
        player_name: localPlayerName
      })
    }).then(res => {
      if (!res.ok) {
        res.text().then(t => console.warn('place failed:', t));
      }
    }).catch(console.error);
  }

  // UI обновление
  function updateUI(data) {
    try { window.gameState = data; } catch (e) {}

    // вытащим наборы игроков если сервер присылает
    const p1Set = (data.player1_set ?? data.player1Set ?? data.player1Set) || 0;
    const p2Set = (data.player2_set ?? data.player2Set ?? data.player2Set) || 0;

    function setHeader(id, name, isActive, setType) {
      let el = document.getElementById(id);
      if (!el) {
        const maybe = document.querySelector(`#gameHeader .player-info .${id}`) || null;
        if (maybe) el = maybe;
      }
      if (!el && id === 'headerPlayer1') el = document.getElementById('player1Info');
      if (!el && id === 'headerPlayer2') el = document.getElementById('player2Info');

      if (!el) {
        const container = document.querySelector('#gameHeader .player-info') || document.getElementById('gameHeader');
        if (!container) return;
        el = document.createElement('div');
        el.id = id;
        el.className = 'player-info-name';
        container.insertBefore(el, container.firstChild || null);
      }

      // ensure .turn-ball and .player-title and .player-set exist
      let ball = el.querySelector(':scope > .turn-ball');
      if (!ball) {
        ball = document.createElement('span');
        ball.className = 'turn-ball';
        el.insertBefore(ball, el.firstChild);
      }
      let title = el.querySelector(':scope > .player-title');
      if (!title) {
        title = document.createElement('span');
        title.className = 'player-title';
        el.appendChild(title);
      }
      let setEl = el.querySelector(':scope > .player-set');
      if (!setEl) {
        setEl = document.createElement('span');
        setEl.className = 'player-set';
        setEl.style.marginLeft = '8px';
        setEl.style.fontSize = '0.9em';
        setEl.style.color = '#666';
        el.appendChild(setEl);
      }

      title.textContent = name || '';
      let setText = '';
      if (setType === 1) setText = 'сплошные';
      else if (setType === 2) setText = 'полосатые';
      setEl.textContent = setText;

      // рендерим шарик в зависимости от набора и активности
      renderTurnBall(ball, setType || 0, !!isActive);

      el.classList.toggle('active', !!isActive);
      // визуальный акцент на имени
      title.classList.toggle('active', !!isActive);
    }

    // header
    setHeader('headerPlayer1', data.player1 || '', (data.current_player || data.current) === 1, p1Set);
    setHeader('headerPlayer2', data.player2 || '', (data.current_player || data.current) === 2, p2Set);

    // gutter (правый)
    const gutterP1 = document.getElementById('gutterPlayer1');
    if (gutterP1) {
      const nameSpan = gutterP1.querySelector('.player-name') || gutterP1;
      if (nameSpan) nameSpan.textContent = data.player1 || '';
      const indicator = gutterP1.querySelector('.turn-indicator');
      if (indicator) indicator.classList.toggle('active', (data.current_player || data.current) === 1);
    }
    const gutterP2 = document.getElementById('gutterPlayer2');
    if (gutterP2) {
      const nameSpan = gutterP2.querySelector('.player-name') || gutterP2;
      if (nameSpan) nameSpan.textContent = data.player2 || '';
      const indicator = gutterP2.querySelector('.turn-indicator');
      if (indicator) indicator.classList.toggle('active', (data.current_player || data.current) === 2);
    }

    // legacy spans
    const legacyP1 = document.getElementById('player1Info');
    if (legacyP1) {
      legacyP1.textContent = (legacyP1.getAttribute('data-prefix') || '') + (data.player1 || '-');
      legacyP1.classList.toggle('active', (data.current_player || data.current) === 1);
      let lb = legacyP1.querySelector('.turn-ball');
      if (!lb) {
        lb = document.createElement('span'); lb.className = 'turn-ball legacy';
        legacyP1.insertBefore(lb, legacyP1.firstChild);
      }
      renderTurnBall(lb, p1Set || 0, (data.current_player || data.current) === 1);
    }
    const legacyP2 = document.getElementById('player2Info');
    if (legacyP2) {
      legacyP2.textContent = (legacyP2.getAttribute('data-prefix') || '') + (data.player2 || '-');
      legacyP2.classList.toggle('active', (data.current_player || data.current) === 2);
      let lb = legacyP2.querySelector('.turn-ball');
      if (!lb) {
        lb = document.createElement('span'); lb.className = 'turn-ball legacy';
        legacyP2.insertBefore(lb, legacyP2.firstChild);
      }
      renderTurnBall(lb, p2Set || 0, (data.current_player || data.current) === 2);
    }
  }

  function gameLoop() {
    if (!ctx || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width !== lastRect.width || rect.height !== lastRect.height) {
      const immediateRect = canvas.getBoundingClientRect();
      if (immediateRect.width && immediateRect.height) {
        dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(immediateRect.width * dpr);
        canvas.height = Math.round(immediateRect.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lastRect.width = immediateRect.width;
        lastRect.height = immediateRect.height;
      } else if (handlers.resize) {
        handlers.resize();
      }
    }

    ctx.clearRect(0, 0, rect.width, rect.height);

    drawTable();
    if (gameState && gameState.balls) {
      for (const b of gameState.balls) drawBall(b);
    }
    if (gameState && !gameState.is_moving) drawCue();
  }

  function drawTable() {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / totalGameWidth;
    const scaleY = rect.height / totalGameHeight;
    const scale = Math.min(scaleX, scaleY);

    const drawTotalW = totalGameWidth * scale;
    const drawTotalH = totalGameHeight * scale;
    const offsetX = (rect.width - drawTotalW) / 2;
    const offsetY = (rect.height - drawTotalH) / 2;
    const playX = offsetX + RAIL_SIZE * scale;
    const playY = offsetY + RAIL_SIZE * scale;
    const playW = TABLE_WIDTH * scale;
    const playH = TABLE_HEIGHT * scale;
    const cornerRadius = 8 * scale;

    const pockets = [
      { x: 0, y: 0 },
      { x: 0, y: TABLE_HEIGHT / 2 },
      { x: 0, y: TABLE_HEIGHT },
      { x: TABLE_WIDTH, y: 0 },
      { x: TABLE_WIDTH, y: TABLE_HEIGHT / 2 },
      { x: TABLE_WIDTH, y: TABLE_HEIGHT }
    ];

    const pocketRadiusGame = 60.0;
    const pocketRadiusPx = pocketRadiusGame * scale;

    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, playX, playY, playW, playH, cornerRadius);

    for (const p of pockets) {
      const sx = playX + p.x * scale;
      const sy = playY + p.y * scale;
      ctx.moveTo(sx + pocketRadiusPx, sy);
      ctx.arc(sx, sy, pocketRadiusPx, 0, Math.PI * 2);
    }

    ctx.clip('evenodd');

    ctx.fillStyle = '#0f8b1f';
    ctx.fillRect(playX, playY, playW, playH);
    ctx.restore();

    // Показ подсказки поставить биток.
    // Показать только если ballInHand и это твой ход и игра НЕ движется
    const showPlaceHint = !!(ballInHand && myTurn && gameState && !gameState.is_moving);
    if (showPlaceHint) {
      ctx.save();
      ctx.font = `${Math.max(12, 18 * Math.min(scale,1))}px sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.textAlign = 'center';
      ctx.fillText('Нажми по столу, чтобы поставить биток', playX + playW/2, playY + 30);
      ctx.restore();
    }

    // если одного игрока нет, показываем ожидание
    if (gameState && (!gameState.player2 || gameState.player2 === '')) {
      ctx.save();
      const textColor = '#0b6f18';
      ctx.fillStyle = textColor;
      const fontSize = Math.max(16, 36 * Math.min(scale, 1));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Ожидание второго игрока', playX + playW / 2, playY + playH / 2);
      ctx.restore();
    }

    ctx.strokeStyle = '#133c12';
    ctx.lineWidth = Math.max(2, 4 * scale);
    ctx.strokeRect(playX, playY, playW, playH);

    pockets.forEach(p => {
      const sx = playX + p.x * scale;
      const sy = playY + p.y * scale;

      ctx.beginPath();
      ctx.fillStyle = '#000';
      ctx.arc(sx, sy, pocketRadiusPx * 1.08, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.strokeStyle = 'rgba(220,220,220,0.08)';
      ctx.lineWidth = Math.max(1, 2 * scale);
      ctx.arc(sx, sy, pocketRadiusPx * 0.78, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.arc(sx + pocketRadiusPx * 0.035, sy + pocketRadiusPx * 0.035, pocketRadiusPx * 0.92, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = '#4a2511';
    ctx.fillRect(offsetX, offsetY, drawTotalW, RAIL_SIZE * scale);
    ctx.fillRect(offsetX, offsetY + drawTotalH - RAIL_SIZE * scale, drawTotalW, RAIL_SIZE * scale);
    ctx.fillRect(offsetX, offsetY, RAIL_SIZE * scale, drawTotalH);
    ctx.fillRect(offsetX + drawTotalW - RAIL_SIZE * scale, offsetY, RAIL_SIZE * scale, drawTotalH);

    const screwRad = 3 * scale;
    ctx.fillStyle = '#cfcfcf';
    for (let i = 0; i < 6; i++) {
      const sx = offsetX + (drawTotalW * (i + 1) / 7);
      const sy = offsetY + (RAIL_SIZE * scale) / 2;
      ctx.beginPath();
      ctx.arc(sx, sy, screwRad, 0, Math.PI * 2);
      ctx.fill();
    }

    // overlay для окончания игры, если сервер присылает флаг
    const gameOver = !!(gameState && (gameState.game_over || gameState.gameOver || gameState.GameOver));
    if (gameOver) {
      const winnerIdx = (gameState && (gameState.winner || gameState.Winner)) || 0;
      const winnerName = winnerIdx === 1 ? (gameState.player1 || '') : (winnerIdx === 2 ? (gameState.player2 || '') : '');
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(playX + 10, playY + playH/2 - 50, playW - 20, 100);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = `${Math.max(18, 28 * Math.min(scale, 1))}px sans-serif`;
      ctx.fillText(winnerName ? `Победитель: ${winnerName}` : 'Игра окончена', playX + playW/2, playY + playH/2);
      ctx.restore();
    }
  }

  function addRoundedRectPath(ctxArg, x, y, w, h, r) {
    const radius = Math.max(0, r);
    ctxArg.moveTo(x + radius, y);
    ctxArg.arcTo(x + w, y, x + w, y + h, radius);
    ctxArg.arcTo(x + w, y + h, x, y + h, radius);
    ctxArg.arcTo(x, y + h, x, y, radius);
    ctxArg.arcTo(x, y, x + w, y, radius);
  }

  function roundRect(ctxArg, x, y, w, h, r, fill, stroke) {
    if (typeof r === 'undefined') r = 5;
    ctxArg.beginPath();
    ctxArg.moveTo(x + r, y);
    ctxArg.arcTo(x + w, y, x + w, y + h, r);
    ctxArg.arcTo(x + w, y + h, x, y + h, r);
    ctxArg.arcTo(x, y + h, x, y, r);
    ctxArg.arcTo(x, y, x + w, y, r);
    ctxArg.closePath();
    if (fill) ctxArg.fill();
    if (stroke) ctxArg.stroke();
  }

  function drawBall(ball) {
    if (ball.pocketed) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / totalGameWidth;
    const scaleY = rect.height / totalGameHeight;
    const scale = Math.min(scaleX, scaleY);
    const drawTotalW = totalGameWidth * scale;
    const offsetX = (rect.width - drawTotalW) / 2;
    const offsetY = (rect.height - (totalGameHeight * scale)) / 2;

    const x = offsetX + (ball.x + RAIL_SIZE) * scale;
    const y = offsetY + (ball.y + RAIL_SIZE) * scale;
    const r = Math.max(2, ball.radius * scale);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (ball.number === 0) ctx.fillStyle = '#fff';
    else if (ball.number === 8) ctx.fillStyle = '#000';
    else if (ball.number <= 7) ctx.fillStyle = '#d63031';
    else ctx.fillStyle = '#f9ca24';
    ctx.fill();

    ctx.lineWidth = Math.max(1, 2 * (scale));
    ctx.strokeStyle = '#333';
    ctx.stroke();

    if (ball.number > 0) {
      ctx.fillStyle = (ball.number === 8 ? '#fff' : '#000');
      ctx.font = `${Math.max(8, r)}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ball.number.toString(), x, y);
    }
  }

  function drawCue() {
    if (!gameState || !gameState.balls) return;
    // если у текущего игрока режим ball in hand, не рисуем кий
    if ((gameState.ball_in_hand || gameState.ballInHand) && myTurn) return;

    const cueBall = gameState.balls.find(b => b.number === 0 && !b.pocketed);
    if (!cueBall) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / totalGameWidth;
    const scaleY = rect.height / totalGameHeight;
    const scale = Math.min(scaleX, scaleY);
    const drawTotalW = totalGameWidth * scale;
    const offsetX = (rect.width - drawTotalW) / 2;
    const offsetY = (rect.height - (totalGameHeight * scale)) / 2;

    const x = offsetX + (cueBall.x + RAIL_SIZE) * scale;
    const y = offsetY + (cueBall.y + RAIL_SIZE) * scale;

    const angleOpposite = mouseAngle + Math.PI;

    let cueLenGame;
    let drawPower;

    if (grabbed) {
      drawPower = computedPower;
      cueLenGame = VISUAL_CUE_MIN_LEN + drawPower * (VISUAL_CUE_MAX_LEN - VISUAL_CUE_MIN_LEN);
    } else {
      drawPower = 0;
      cueLenGame = VISUAL_CUE_DEFAULT_LEN;
    }

    const cueLenPx = cueLenGame * scale;

    const offset = 20 * scale;
    const startX = x + Math.cos(angleOpposite) * offset;
    const startY = y + Math.sin(angleOpposite) * offset;
    const endX = startX + Math.cos(angleOpposite) * cueLenPx;
    const endY = startY + Math.sin(angleOpposite) * cueLenPx;

    const cueWidth = Math.max(2, (3 + drawPower * 5) * scale);

    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = cueWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(startX, startY, Math.max(2, 4 * scale), 0, Math.PI * 2);
    ctx.fill();

    if (grabbed) {
      ctx.save();
      ctx.setLineDash([6 * scale, 8 * scale]);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 + drawPower * 0.5})`;
      ctx.lineWidth = Math.max(1, 2 * scale);
      ctx.beginPath();
      ctx.moveTo(x, y);

      const aimLength = 1000 + drawPower * 500;
      ctx.lineTo(
        x + Math.cos(mouseAngle) * aimLength * scale,
        y + Math.sin(mouseAngle) * aimLength * scale
      );
      ctx.stroke();
      ctx.restore();

      if (drawPower > 0.05) {
        const barWidth = 80;
        const barHeight = 8;
        const barX = rect.width - barWidth - 20;
        const barY = 20;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(barX, barY, barWidth, barHeight);

        const gradient = ctx.createLinearGradient(barX, barY, barX + barWidth, barY);
        gradient.addColorStop(0, '#0f0');
        gradient.addColorStop(0.5, '#ff0');
        gradient.addColorStop(1, '#f00');

        ctx.fillStyle = gradient;
        ctx.fillRect(barX, barY, barWidth * drawPower, barHeight);

        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX, barY, barWidth, barHeight);

        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(10, 12 * scale)}px Arial`;
        ctx.textAlign = 'left';
        ctx.fillText(`Сила: ${Math.round(drawPower * 100)}%`, barX, barY + barHeight + 15);
      }
    }
  }

  // Преобразование координат между экраном и игровым пространством
  function screenToGame(clientX, clientY) {
    if (!canvas) return { x: 0, y: 0, scale: 1, offsetX: 0, offsetY: 0 };
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const scaleX = rect.width / totalGameWidth;
    const scaleY = rect.height / totalGameHeight;
    const scale = Math.min(scaleX, scaleY);
    const drawTotalW = totalGameWidth * scale;
    const drawTotalH = totalGameHeight * scale;
    const offsetX = (rect.width - drawTotalW) / 2;
    const offsetY = (rect.height - drawTotalH) / 2;
    const gameX = (sx - offsetX) / scale - RAIL_SIZE;
    const gameY = (sy - offsetY) / scale - RAIL_SIZE;
    return { x: gameX, y: gameY, scale, offsetX, offsetY };
  }
  function gameToScreen(gameX, gameY) {
    if (!canvas) return { x: 0, y: 0, scale: 1 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / totalGameWidth;
    const scaleY = rect.height / totalGameHeight;
    const scale = Math.min(scaleX, scaleY);
    const drawTotalW = totalGameWidth * scale;
    const drawTotalH = totalGameHeight * scale;
    const offsetX = (rect.width - drawTotalW) / 2;
    const offsetY = (rect.height - drawTotalH) / 2;
    const sx = offsetX + (gameX + RAIL_SIZE) * scale;
    const sy = offsetY + (gameY + RAIL_SIZE) * scale;
    return { x: sx, y: sy, scale };
  }

  // HTMX + инициализация при загрузке страницы
  window.initGame = initGame;

  document.body.addEventListener('htmx:afterSwap', (e) => {
    const gameData = document.getElementById('gameData');
    const table = document.getElementById('billiardsTable');
    if (gameData && table) {
      const id = gameData.dataset.gameId;
      const player = gameData.dataset.playerName || '';
      try { initGame(id, player); } catch (err) { console.error('initGame error afterSwap', err); }
    } else {
      const mightBeGame = e.detail && e.detail.target && e.detail.target.id === 'content';
      if (mightBeGame) {
        setTimeout(() => {
          if (!document.getElementById('billiardsTable')) teardownGame();
        }, 20);
      }
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    const gameData = document.getElementById('gameData');
    const table = document.getElementById('billiardsTable');
    if (gameData && table) {
      const id = gameData.dataset.gameId;
      const player = gameData.dataset.playerName || '';
      try { initGame(id, player); } catch (err) { console.error('initGame error on load', err); }
    }
  });
}
