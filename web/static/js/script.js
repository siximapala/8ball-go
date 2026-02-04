let gameId = '';
let canvas = null;
let ctx = null;
let gameState = null;
let mouseAngle = -Math.PI / 2; // По умолчанию кий смотрит вверх
let grabbed = false;
let pullPos = { x: 0, y: 0 };
let computedPower = 0;
let localPlayerName = '';
let localPlayerRole = 0; // 0 = spectator, 1 или 2
let myTurn = false;

// константы размера стола соответствуют физике на сервере
const TABLE_WIDTH = 1400;
const TABLE_HEIGHT = 2800;

// Визуальные настройки
const RAIL_SIZE = 80; // Ширина деревянного борта (game units)
const MAX_PULL_DIST = 500; // На сколько в игровых единицах можно оттянуть мышь для 100% силы
const VISUAL_CUE_MAX_LEN = 800; // В игровых единицах (макс длины кия)
const VISUAL_CUE_DEFAULT_LEN = 300;
const VISUAL_CUE_MIN_LEN = 30; // В игровых единицах (минимальная длина кия)

let dpr = 1;                       // devicePixelRatio
let lastRect = { width: 0, height: 0 };
let totalGameWidth = TABLE_WIDTH + RAIL_SIZE * 2;
let totalGameHeight = TABLE_HEIGHT + RAIL_SIZE * 2;
let ballInHand = false; // переменная для отслеживания режима состояния выставления битка на стол

// нужна для оптимизации ресайза
function debounce(fn, ms = 100) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function initGame(id, playerName) {
    gameId = id;
    localPlayerName = playerName || '';
    canvas = document.getElementById('billiardsTable');
    if (!canvas) throw new Error('Canvas #billiardsTable not found');
    ctx = canvas.getContext('2d');

    //  Ставим начальный размер и навешиваем обработчики ресайза
    resizeCanvas();
    window.addEventListener('resize', debounce(resizeCanvas, 120));
    window.addEventListener('orientationchange', debounce(resizeCanvas, 200));

    // Начинаем анимацию рендера
    requestAnimationFrame(gameLoop);

    const controls = document.getElementById('controls');
    if (controls) controls.style.display = 'none';

    // SSE (обновление состояния от сервера)
    const es = new EventSource(`/events?game_id=${gameId}`);
    es.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            gameState = data;
            
            // Установка состояния ballInHand изSSE
            ballInHand = !!data.ball_in_hand;

            // смотрим роль локального игрока
            if (localPlayerName) {
                if (localPlayerName === data.player1) localPlayerRole = 1;
                else if (localPlayerName === data.player2) localPlayerRole = 2;
                else localPlayerRole = 0;
            }

            // разрешаем ход только если оба игрока присутствуют
            const bothPresent = !!(data.player1 && data.player2);
            myTurn = (localPlayerRole !== 0) && (data.current_player === localPlayerRole) && bothPresent;

            updateUI(data);
        } catch (err) {
        }
    };
    es.onerror = (err) => console.error('EventSource error', err);

    // Хэндлеры ввода
    canvas.addEventListener('mousedown', e => handleStart(e.clientX, e.clientY));
    document.addEventListener('mousemove', e => handleMove(e.clientX, e.clientY));
    document.addEventListener('mouseup', handleEnd);

    canvas.addEventListener('touchstart', e => {
        if (!e.touches || e.touches.length === 0) return;
        e.preventDefault();
        const t = e.touches[0];
        handleStart(t.clientX, t.clientY);
    }, { passive: false });
    document.addEventListener('touchmove', e => {
        if (grabbed) e.preventDefault();
        if (!e.touches || e.touches.length === 0) return;
        const t = e.touches[0];
        handleMove(t.clientX, t.clientY);
    }, { passive: false });
    document.addEventListener('touchend', handleEnd);
}

// ресайз канваса с учётом DPR
function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    dpr = window.devicePixelRatio || 1;

    // физические размеры холста
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    lastRect.width = rect.width;
    lastRect.height = rect.height;
}

// screen coords (clientX, clientY) -> game coords (x,y), где (0,0) - внутренний левый угол игрового поля (без борта)
function screenToGame(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left; 
    const sy = clientY - rect.top;

    // ыSS px per game unit
    const scaleX = rect.width / totalGameWidth;
    const scaleY = rect.height / totalGameHeight;
    // используем один масштаб - берем min, иначе будет растяжение стола
    const scale = Math.min(scaleX, scaleY);

    // вычисляем начало игрового поля внутри canvas
    // посчитаем offset чтобы центрировать таблицу в canvas (если доступны дополнительные отступы)
    const drawTotalW = totalGameWidth * scale;
    const drawTotalH = totalGameHeight * scale;
    const offsetX = (rect.width - drawTotalW) / 2;
    const offsetY = (rect.height - drawTotalH) / 2;

    // gameX включает RAIL_SIZE смещение от края canvas
    const gameX = (sx - offsetX) / scale - RAIL_SIZE;
    const gameY = (sy - offsetY) / scale - RAIL_SIZE;

    return { x: gameX, y: gameY, scale, offsetX, offsetY };
}

// game coords -> screen (CSS px)
function gameToScreen(gameX, gameY) {
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

// хэндлеры ввода
function handleStart(clientX, clientY) {
    if (!gameState) return;
    const pos = screenToGame(clientX, clientY);
    
    // Если разрешено поставить биток - один клик ставит
    if (ballInHand && myTurn) {
        placeCueAt(pos.x, pos.y);
        return;
    }
    
    // запретить прицеливание, если шары движутся или не наш ход
    if (gameState.is_moving) return;
    if (!myTurn) return;
    
    const cueBall = (gameState.balls || []).find(b => b.number === 0 && !b.pocketed);
    if (!cueBall) return;
    const dist = Math.hypot(pos.x - cueBall.x, pos.y - cueBall.y);
    // мобильная поддержка: увеличить зону захвата кия
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

// отправка удара на сервер
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
        } else {
            // ждем подтверждения от сервера через SSE
        }
    }).catch(console.error);
}

function updateUI(data) {
    // Обновляем имена игроков в header'е
    const headerP1 = document.getElementById('headerPlayer1');
    const headerP2 = document.getElementById('headerPlayer2');
    
    if (headerP1 && data.player1) {
        headerP1.textContent = data.player1;
        headerP1.classList.toggle('active', data.current_player === 1);
    }
    
    if (headerP2 && data.player2) {
        headerP2.textContent = data.player2;
        headerP2.classList.toggle('active', data.current_player === 2);
    }
    
    // Обновляем имена игроков в правом gutter
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

    // Получаем rect каждый кадр на случай изменения CSS размеров
    const rect = canvas.getBoundingClientRect();
    if (rect.width !== lastRect.width || rect.height !== lastRect.height) {
        // Если CSS изменился - пересоздать физический размер холста
        resizeCanvas();
    }

    // Чистим область в CSS px (после ctx.setTransform(dpr,0,0,dpr,0,0) используем CSS px)
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Рисуем стол, шары и кий
    drawTable();
    if (gameState && gameState.balls) {
        for (const b of gameState.balls) drawBall(b);
    }
    if (gameState && !gameState.is_moving) drawCue();

    requestAnimationFrame(gameLoop);
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
        // левая колонка (top, middle, bottom)
        { x: 0, y: 0 },
        { x: 0, y: TABLE_HEIGHT / 2 },
        { x: 0, y: TABLE_HEIGHT },
        // правая колонка (top, middle, bottom)
        { x: TABLE_WIDTH, y: 0 },
        { x: TABLE_WIDTH, y: TABLE_HEIGHT / 2 },
        { x: TABLE_WIDTH, y: TABLE_HEIGHT }
    ];

    // Радиус лунок и.е. синхронизируем с сервером (60.0)
    const pocketRadiusGame = 60.0;
    const pocketRadiusPx = pocketRadiusGame * scale;

    // Рисуем стол, вырезаем лунки (clip evenodd)
    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, playX, playY, playW, playH, cornerRadius);

    // Добавляем в path круги для лунок
    for (const p of pockets) {
        const sx = playX + p.x * scale;
        const sy = playY + p.y * scale;
        ctx.moveTo(sx + pocketRadiusPx, sy);
        ctx.arc(sx, sy, pocketRadiusPx, 0, Math.PI * 2);
    }

    // Вырезаем
    ctx.clip('evenodd');

    // филл стола
    ctx.fillStyle = '#0f8b1f';
    ctx.fillRect(playX, playY, playW, playH);
    ctx.restore();

    // Если разрешена постановка битка (нарушение, сотояние ball in hand) - показать подсказку
    if (ballInHand && myTurn) {
        ctx.save();
        ctx.font = `${Math.max(12, 18 * Math.min(scale,1))}px sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText('Нажмите по столу, чтобы поставить биток', playX + playW/2, playY + 30);
        ctx.restore();
    }

    // Если ждем второго игрока - показать сообщение посередине стола
    if (gameState && (!gameState.player2 || gameState.player2 === '')) {
        ctx.save();
        const textColor = '#0b6f18'; // чуть темнее цвета сукна
        ctx.fillStyle = textColor;
        const fontSize = Math.max(16, 36 * Math.min(scale, 1));
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Ожидание второго игрока', playX + playW / 2, playY + playH / 2);
        ctx.restore();
    }

    // Рисуем окантовку 
    ctx.strokeStyle = '#133c12';
    ctx.lineWidth = Math.max(2, 4 * scale);
    ctx.strokeRect(playX, playY, playW, playH);

    // 7) Накладываем рейки  поверх лунок
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

        // внутренняя тень 
        ctx.beginPath();
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.arc(sx + pocketRadiusPx * 0.035, sy + pocketRadiusPx * 0.035, pocketRadiusPx * 0.92, 0, Math.PI * 2);
        ctx.fill();
    });

    ctx.fillStyle = '#4a2511';
    // верхняя рейка
    ctx.fillRect(offsetX, offsetY, drawTotalW, RAIL_SIZE * scale);
    // нижняя рейка
    ctx.fillRect(offsetX, offsetY + drawTotalH - RAIL_SIZE * scale, drawTotalW, RAIL_SIZE * scale);
    // левая рейка
    ctx.fillRect(offsetX, offsetY, RAIL_SIZE * scale, drawTotalH);
    // правая рейка
    ctx.fillRect(offsetX + drawTotalW - RAIL_SIZE * scale, offsetY, RAIL_SIZE * scale, drawTotalH);

    // Декорации
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

// Всп. функция Сздать путь закруглённого прямоугольника (не закрываем путь, чтобы арки добавлялись как субпути)
function addRoundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, r);
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
}


// Вспомогательная функция добавить путь закругленного rect
function addRoundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, r);
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
}

// Вспомогательная функция рисовать закругленный rect
function roundRect(ctx, x, y, w, h, r, fill, stroke) {
    if (typeof r === 'undefined') r = 5;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
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
    
    // Не показывать кий в режиме ball in hand
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
        // При прицеливании: кий меняет длину от минимальной до максимальной
        drawPower = computedPower;
        cueLenGame = VISUAL_CUE_MIN_LEN + drawPower * (VISUAL_CUE_MAX_LEN - VISUAL_CUE_MIN_LEN);
    } else {
        // В дефолтном состоянии: кий средней длины
        drawPower = 0; // сила 0, но кий виден
        cueLenGame = VISUAL_CUE_DEFAULT_LEN
    }
    
    const cueLenPx = cueLenGame * scale;

    const offset = 20 * scale; // отступ от центра шара
    const startX = x + Math.cos(angleOpposite) * offset;
    const startY = y + Math.sin(angleOpposite) * offset;
    const endX = startX + Math.cos(angleOpposite) * cueLenPx;
    const endY = startY + Math.sin(angleOpposite) * cueLenPx;

    // толщина кия от силы 
    const cueWidth = Math.max(2, (3 + drawPower * 5) * scale);

    // рендер кия
    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = cueWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    // рендер наконечника
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(startX, startY, Math.max(2, 4 * scale), 0, Math.PI * 2);
    ctx.fill();

    // Рендер линии прицеливания когда тянем кий
    if (grabbed) {
        ctx.save();
        ctx.setLineDash([6 * scale, 8 * scale]);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 + drawPower * 0.5})`;
        ctx.lineWidth = Math.max(1, 2 * scale);
        ctx.beginPath();
        ctx.moveTo(x, y);
        
        // Длина линии прицеливания  зависит от силы
        const aimLength = 1000 + drawPower * 500;
        ctx.lineTo(
            x + Math.cos(mouseAngle) * aimLength * scale, 
            y + Math.sin(mouseAngle) * aimLength * scale
        );
        ctx.stroke();
        ctx.restore();
        
        // Индикатор силы
        if (drawPower > 0.05) {
            const barWidth = 80;
            const barHeight = 8;
            const barX = rect.width - barWidth - 20;
            const barY = 20;
            
            // Фон
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(barX, barY, barWidth, barHeight);
            
            // Градиент ффилл
            const gradient = ctx.createLinearGradient(barX, barY, barX + barWidth, barY);
            gradient.addColorStop(0, '#0f0');
            gradient.addColorStop(0.5, '#ff0');
            gradient.addColorStop(1, '#f00');
            
            ctx.fillStyle = gradient;
            ctx.fillRect(barX, barY, barWidth * drawPower, barHeight);
            
            // Обводка
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.strokeRect(barX, barY, barWidth, barHeight);
            
            // Текст
            ctx.fillStyle = '#fff';
            ctx.font = `${Math.max(10, 12 * scale)}px Arial`;
            ctx.textAlign = 'left';
            ctx.fillText(`Сила: ${Math.round(drawPower * 100)}%`, barX, barY + barHeight + 15);
        }
    }
}

// Экспортируем initGame в глобальную область видимости
if (typeof window !== 'undefined') window.initGame = initGame;