let gameId = '';
let canvas = null;
let ctx = null;
let gameState = null;
let mouseAngle = -Math.PI / 2; // По умолчанию кий смотрит вверх
let grabbed = false;
let pullPos = { x: 0, y: 0 };
let computedPower = 0;

// === КОНСТАНТЫ РАЗМЕРОВ (Вертикальная ориентация) ===
// Эти координаты соответствуют физике на сервере
const TABLE_WIDTH = 1400;
const TABLE_HEIGHT = 2800;

// Визуальные настройки
const RAIL_SIZE = 80; // Ширина деревянного борта (game units)
const MAX_PULL_DIST = 500; // На сколько в игровых единицах можно оттянуть мышь для 100% силы
const VISUAL_CUE_MAX_LEN = 800; // В игровых единицах (макс длины кия)
const VISUAL_CUE_DEFAULT_LEN = 300;
const VISUAL_CUE_MIN_LEN = 30; // В игровых единицах (минимальная длина кия)

// --- Вспомогательные состояния для рендера ---
let dpr = 1;                       // devicePixelRatio
let lastRect = { width: 0, height: 0 };
let totalGameWidth = TABLE_WIDTH + RAIL_SIZE * 2;
let totalGameHeight = TABLE_HEIGHT + RAIL_SIZE * 2;

// Debounce helper
function debounce(fn, ms = 100) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function initGame(id, playerName) {
    gameId = id;
    canvas = document.getElementById('billiardsTable');
    if (!canvas) throw new Error('Canvas #billiardsTable not found');
    ctx = canvas.getContext('2d');

    // Setup DPR-aware canvas size
    resizeCanvas();
    window.addEventListener('resize', debounce(resizeCanvas, 120));
    window.addEventListener('orientationchange', debounce(resizeCanvas, 200));

    // Start animation loop
    requestAnimationFrame(gameLoop);

    // Hide legacy controls (optional)
    const controls = document.getElementById('controls');
    if (controls) controls.style.display = 'none';

    // SSE (обновление состояния от сервера)
    const es = new EventSource(`/events?game_id=${gameId}`);
    es.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            gameState = data;
            updateUI(data);
        } catch (err) {
            console.error('SSE parse error', err);
        }
    };
    es.onerror = (err) => console.error('EventSource error', err);

    // Input handlers
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

// === RESIZE: стабильно настраиваем canvas под CSS-ширину и DPR ===
function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // guard
    if (!rect.width || !rect.height) return;

    dpr = window.devicePixelRatio || 1;

    // Выставляем физические размеры холста (device pixels)
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    // ВАЖНО: матрица так, чтобы далее рисовать в CSS px
    // Если использовать setTransform, координаты далее — CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    lastRect.width = rect.width;
    lastRect.height = rect.height;
}

// === ПРЕОБРАЗОВАНИЯ КООРДИНАТ ===
// screen coords (clientX, clientY) -> game coords (x,y), где (0,0) — внутренний левый угол игрового поля (без борта)
function screenToGame(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left; // CSS px from left
    const sy = clientY - rect.top;

    // Пропорция: CSS px per game unit
    const scaleX = rect.width / totalGameWidth;
    const scaleY = rect.height / totalGameHeight;
    // используем один масштаб (сохранение пропорций) — берем min, чтобы не растянуть
    const scale = Math.min(scaleX, scaleY);

    // вычисляем начало игрового поля (может быть центрированным если canvas не имеет точного соотношения)
    // посчитаем offset чтобы центрировать таблицу в canvas (если доступны дополнительные отступы)
    const drawTotalW = totalGameWidth * scale;
    const drawTotalH = totalGameHeight * scale;
    const offsetX = (rect.width - drawTotalW) / 2;
    const offsetY = (rect.height - drawTotalH) / 2;

    // gameX включает RAIL_SIZE смещение: 0..TABLE_WIDTH
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

// === INPUT HANDLERS ===
function handleStart(clientX, clientY) {
    if (!gameState || gameState.is_moving) return;
    const pos = screenToGame(clientX, clientY);
    const cueBall = (gameState.balls || []).find(b => b.number === 0 && !b.pocketed);
    if (!cueBall) return;
    const dist = Math.hypot(pos.x - cueBall.x, pos.y - cueBall.y);
    // более удобный радиус захвата на мобильных
    if (dist < 250) {
        grabbed = true;
        pullPos = { x: pos.x, y: pos.y };
        updateAim(pos.x, pos.y, cueBall);
    }
}

function handleMove(clientX, clientY) {
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

// === СЕТЕВАЯ ОТРАБОТКА ===
function shoot(angle, power) {
    fetch('/game/shoot', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ game_id: gameId, angle: angle, power: power })
    }).catch(console.error);
}

function updateUI(data) {
    // Replace textual status with compact turn indicators next to player names.
    const status = document.getElementById('status');
    if (status) status.style.display = 'none';

    // Header player name indicators
    const p1Header = document.getElementById('player1Info');
    const p2Header = document.getElementById('player2Info');
    if (p1Header) { if (data.current_player === 1) p1Header.classList.add('active'); else p1Header.classList.remove('active'); }
    if (p2Header) { if (data.current_player === 2) p2Header.classList.add('active'); else p2Header.classList.remove('active'); }

    // Sidebar / gutter indicators (if present)
    const gut1 = document.getElementById('player1');
    const gut2 = document.getElementById('player2');
    if (gut1) {
        const ind = gut1.querySelector('.turn-indicator');
        if (ind) ind.classList.toggle('active', data.current_player === 1);
    }
    if (gut2) {
        const ind = gut2.querySelector('.turn-indicator');
        if (ind) ind.classList.toggle('active', data.current_player === 2);
    }
}

// === РЕНДЕР ===
function gameLoop() {
    if (!ctx || !canvas) return;

    // Получаем rect каждый кадр (на случай layout shift)
    const rect = canvas.getBoundingClientRect();
    if (rect.width !== lastRect.width || rect.height !== lastRect.height) {
        // Если CSS изменился — пересоздать физический размер холста
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

    // 3) play area (внутреннее зелёное поле)
    const playX = offsetX + RAIL_SIZE * scale;
    const playY = offsetY + RAIL_SIZE * scale;
    const playW = TABLE_WIDTH * scale;
    const playH = TABLE_HEIGHT * scale;
    const cornerRadius = 8 * scale;

    // ---- Позиции лунок: 2 вертикальных столбца по 3 лунки ----
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

    // Радиус лунок (игровые единицы) — синхронизируйте с сервером (60.0)
    const pocketRadiusGame = 60.0;
    const pocketRadiusPx = pocketRadiusGame * scale;

    // 4) Рисуем play area, вырезаем лунки (clip evenodd)
    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, playX, playY, playW, playH, cornerRadius);

    // Добавляем в path круги для лунок — они станут "дырками"
    for (const p of pockets) {
        const sx = playX + p.x * scale;
        const sy = playY + p.y * scale;
        ctx.moveTo(sx + pocketRadiusPx, sy);
        ctx.arc(sx, sy, pocketRadiusPx, 0, Math.PI * 2);
    }

    // Вырезаем (evenodd)
    ctx.clip('evenodd');

    // Заливаем сукно
    ctx.fillStyle = '#0f8b1f'; // мягкий зелёный (можете поменять)
    ctx.fillRect(playX, playY, playW, playH);
    ctx.restore();

    // 5) Рисуем тонкую окантовку поля
    ctx.strokeStyle = '#133c12';
    ctx.lineWidth = Math.max(2, 4 * scale);
    ctx.strokeRect(playX, playY, playW, playH);

    // 6) Рисуем горловины лунок (чёрные внутренности) — чуть больше, чем вырез
    pockets.forEach(p => {
        const sx = playX + p.x * scale;
        const sy = playY + p.y * scale;

        // тёмная горловина
        ctx.beginPath();
        ctx.fillStyle = '#000';
        ctx.arc(sx, sy, pocketRadiusPx * 1.08, 0, Math.PI * 2);
        ctx.fill();

        // пластиковая вставка/ободок (светлый тон у края)
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(220,220,220,0.08)';
        ctx.lineWidth = Math.max(1, 2 * scale);
        ctx.arc(sx, sy, pocketRadiusPx * 0.78, 0, Math.PI * 2);
        ctx.stroke();

        // внутренняя тень (для глубины)
        ctx.beginPath();
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.arc(sx + pocketRadiusPx * 0.035, sy + pocketRadiusPx * 0.035, pocketRadiusPx * 0.92, 0, Math.PI * 2);
        ctx.fill();
    });

    // 7) Накладываем рейки (rail) поверх — это делает лунки "встроенными"
    ctx.fillStyle = '#4a2511';
    // верхняя рейка
    ctx.fillRect(offsetX, offsetY, drawTotalW, RAIL_SIZE * scale);
    // нижняя рейка
    ctx.fillRect(offsetX, offsetY + drawTotalH - RAIL_SIZE * scale, drawTotalW, RAIL_SIZE * scale);
    // левая рейка
    ctx.fillRect(offsetX, offsetY, RAIL_SIZE * scale, drawTotalH);
    // правая рейка
    ctx.fillRect(offsetX + drawTotalW - RAIL_SIZE * scale, offsetY, RAIL_SIZE * scale, drawTotalH);

    // 8) Декоративные винтики / блики на рейке (необязательно)
    const screwRad = 3 * scale;
    ctx.fillStyle = '#cfcfcf';
    for (let i = 0; i < 6; i++) {
        // по верхней рейке
        const sx = offsetX + (drawTotalW * (i + 1) / 7);
        const sy = offsetY + (RAIL_SIZE * scale) / 2;
        ctx.beginPath();
        ctx.arc(sx, sy, screwRad, 0, Math.PI * 2);
        ctx.fill();
    }
}

// Вспомогательная: создать путь закруглённого прямоугольника (не закрываем path, чтобы arcs добавлялись как субпути)
function addRoundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, r);
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    // не делаем closePath, чтобы кружки-лузы были отдельными под-путями
}


// Вспомогательная функция: добавить путь закругленного rect (без fill)
function addRoundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, r);
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    // path is left open (do not closePath) so that arcs added later are separate subpaths
}

// utility: rounded rect
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

    // border
    ctx.lineWidth = Math.max(1, 2 * (scale));
    ctx.strokeStyle = '#333';
    ctx.stroke();

    // number
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

    const offset = 20 * scale; // Отступ от шара
    const startX = x + Math.cos(angleOpposite) * offset;
    const startY = y + Math.sin(angleOpposite) * offset;
    const endX = startX + Math.cos(angleOpposite) * cueLenPx;
    const endY = startY + Math.sin(angleOpposite) * cueLenPx;

    // Толщина кия тоже может меняться с силой
    const cueWidth = Math.max(2, (3 + drawPower * 5) * scale);

    // Кий
    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = cueWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    // Наконечник
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(startX, startY, Math.max(2, 4 * scale), 0, Math.PI * 2);
    ctx.fill();

    // Линия прицеливания (только когда тянем)
    if (grabbed) {
        ctx.save();
        ctx.setLineDash([6 * scale, 8 * scale]);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 + drawPower * 0.5})`;
        ctx.lineWidth = Math.max(1, 2 * scale);
        ctx.beginPath();
        ctx.moveTo(x, y);
        
        // Длина линии прицеливания тоже зависит от силы
        const aimLength = 1000 + drawPower * 500;
        ctx.lineTo(
            x + Math.cos(mouseAngle) * aimLength * scale, 
            y + Math.sin(mouseAngle) * aimLength * scale
        );
        ctx.stroke();
        ctx.restore();
        
        // Индикатор силы (опционально)
        if (drawPower > 0.05) {
            const barWidth = 80;
            const barHeight = 8;
            const barX = rect.width - barWidth - 20;
            const barY = 20;
            
            // Фон
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(barX, barY, barWidth, barHeight);
            
            // Градиент заполнения
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

// Expose initializer
if (typeof window !== 'undefined') window.initGame = initGame;
