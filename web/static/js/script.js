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

  // Ресайз с дебаунсом
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

  // Инициализируем игру
  function initGame(id, playerName) {
    teardownGame();

    gameId = id;
    localPlayerName = playerName || '';

    canvas = document.getElementById('billiardsTable');
    if (!canvas) throw new Error('Canvas #billiardsTable not found');
    ctx = canvas.getContext('2d');

    // resizeCanvas с внутренней функцией
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

    // устанавливаем обработчики ресайза
    handlers.resize = debounce(resizeCanvas, 120);
    handlers.orientation = debounce(resizeCanvas, 200);

    window.addEventListener('resize', handlers.resize);
    window.addEventListener('orientationchange', handlers.orientation);

    // начальный ресайз
    ensureResize();

    // луп анимации
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
          gameState = data;
          ballInHand = !!data.ball_in_hand;

          if (localPlayerName) {
            if (localPlayerName === data.player1) localPlayerRole = 1;
            else if (localPlayerName === data.player2) localPlayerRole = 2;
            else localPlayerRole = 0;
          }

          const bothPresent = !!(data.player1 && data.player2);
          myTurn = (localPlayerRole !== 0) && (data.current_player === localPlayerRole) && bothPresent;

          updateUI(data);
        } catch (err) {
        
        }
      };
      es.onerror = (err) => {
        console.error('EventSource error', err);
      };
    }

    // Хэндлеры ввода (мышь и скрин тач )
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

    // инициализация UI на случай, если данные уже есть в разметке (например, при возвращении на страницу назад)
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

    if (ballInHand && myTurn) {
      placeCueAt(pos.x, pos.y);
      return;
    }

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
    if (!myTurn) return;
    const pos = screenToGame(clientX, clientY);
    if (!gameState) return;
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

  function updateUI(data) {
    const headerP1 = document.getElementById('headerPlayer1');
    const headerP2 = document.getElementById('headerPlayer1') ? document.getElementById('headerPlayer2') : null;

    if (headerP1 && data.player1) {
      headerP1.textContent = data.player1;
      headerP1.classList.toggle('active', data.current_player === 1);
    }

    if (headerP2 && data.player2) {
      headerP2.textContent = data.player2;
      headerP2.classList.toggle('active', data.current_player === 2);
    }

    const gutterP1 = document.getElementById('gutterPlayer1');
    const gutterP2 = document.getElementById('gutterPlayer2');

    if (gutterP1 && data.player1) {
      const nameSpan = gutterP1.querySelector('.player-name');
      const indicator = gutterP1.querySelector('.turn-indicator');
      if (nameSpan) nameSpan.textContent = data.player1;
      if (indicator) indicator.classList.toggle('active', data.current_player === 1);
    }

    if (gutterP2 && data.player2) {
      const nameSpan = gutterP2.querySelector('.player-name');
      const indicator = gutterP2.querySelector('.turn-indicator');
      if (nameSpan) nameSpan.textContent = data.player2;
      if (indicator) indicator.classList.toggle('active', data.current_player === 2);
    }

    const legacyP1 = document.getElementById('player1Info');
    const legacyP2 = document.getElementById('player2Info');

    if (legacyP1 && data.player1) {
      const prefix = legacyP1.getAttribute('data-prefix') || '';
      legacyP1.textContent = prefix + data.player1;
      legacyP1.classList.toggle('active', data.current_player === 1);
    }

    if (legacyP2 && data.player2) {
      const prefix = legacyP2.getAttribute('data-prefix') || '';
      legacyP2.textContent = prefix + data.player2;
      legacyP2.classList.toggle('active', data.current_player === 2);
    }
  }
  function gameLoop() {
    if (!ctx || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width !== lastRect.width || rect.height !== lastRect.height) {
      // Если размер изменился, обновляем канвас. Иногда браузеры могут отдать 0x0 при первом запросе, поэтому делаем несколько попыток с задержкой.
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

    if (ballInHand && myTurn) {
      ctx.save();
      ctx.font = `${Math.max(12, 18 * Math.min(scale,1))}px sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.textAlign = 'center';
      ctx.fillText('Нажмите по столу, чтобы поставить биток', playX + playW/2, playY + 30);
      ctx.restore();
    }

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
    if (ballInHand && myTurn) return;

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
