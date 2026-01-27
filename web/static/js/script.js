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
const RAIL_SIZE = 80; // Ширина деревянного борта (рисуется снаружи игрового поля)
const MAX_PULL_DIST = 500; // На сколько пикселей можно оттянуть мышь для 100% силы
const VISUAL_CUE_MAX_LEN = 800; // Визуальное ограничение длины кия (чтобы не был бесконечным)

function initGame(id, playerName) {
    gameId = id;
    canvas = document.getElementById('billiardsTable');
    ctx = canvas.getContext('2d');
    
    // Первичная настройка размера
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    console.log(`Game initialized: ${id}`);
    
    // Запуск цикла отрисовки
    requestAnimationFrame(gameLoop);

    // Скрываем старые контролы, если они есть
    const controls = document.getElementById('controls');
    if (controls) controls.style.display = 'none';

    // Подключение к SSE
    const es = new EventSource(`/events?game_id=${gameId}`);
    es.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            gameState = data;
            updateUI(data);
        } catch (err) { console.error(err); }
    };

    // === УПРАВЛЕНИЕ (Мышь + Тач) ===
    
    const handleStart = (clientX, clientY) => {
        if (gameState && gameState.is_moving) return;

        const pos = screenToGame(clientX, clientY);
        
        // Проверяем, попали ли рядом с битком
        if (gameState && gameState.balls) {
            const cueBall = gameState.balls.find(b => b.number === 0 && !b.pocketed);
            if (cueBall) {
                const dist = Math.hypot(pos.x - cueBall.x, pos.y - cueBall.y);
                // Увеличенный радиус захвата для удобства на телефоне
                if (dist < 250) {
                    grabbed = true;
                    // Запоминаем точку нажатия как "точку захвата"
                    pullPos = pos;
                    updateAim(pos.x, pos.y, cueBall);
                }
            }
        }
    };

    const handleMove = (clientX, clientY) => {
        const pos = screenToGame(clientX, clientY);

        if (gameState) {
            const cueBall = gameState.balls.find(b => b.number === 0 && !b.pocketed);
            if (cueBall) {
                if (grabbed) {
                    updateAim(pos.x, pos.y, cueBall);
                } else {
                    // Просто водим мышкой (прицел без силы)
                    mouseAngle = Math.atan2(cueBall.y - pos.y, cueBall.x - pos.x);
                }
            }
        }
    };

    const handleEnd = () => {
        if (grabbed) {
            grabbed = false;
            if (computedPower > 0.05) { // Мин. порог силы
                shoot(mouseAngle, computedPower);
            }
            computedPower = 0;
        }
    };

    // Mouse Events
    canvas.addEventListener('mousedown', e => handleStart(e.clientX, e.clientY));
    document.addEventListener('mousemove', e => handleMove(e.clientX, e.clientY));
    document.addEventListener('mouseup', handleEnd);

    // Touch Events (Mobile)
    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        handleStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    
    document.addEventListener('touchmove', e => {
        if (grabbed) e.preventDefault(); // Блокируем скролл при натягивании
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    
    document.addEventListener('touchend', handleEnd);
}

// Адаптивный ресайз: вписывает стол в экран с учетом бортов
function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Пропорции стола + борта
    // Полная ширина = 1400 + 2*RAIL_SIZE
    const fullTableWidth = TABLE_WIDTH + (RAIL_SIZE * 2);
    const fullTableHeight = TABLE_HEIGHT + (RAIL_SIZE * 2);
    const targetRatio = fullTableWidth / fullTableHeight;
    
    const screenRatio = w / h;

    let finalW, finalH;

    // Вписываем в экран (contain)
    if (screenRatio > targetRatio) {
        finalH = h;
        finalW = finalH * targetRatio;
    } else {
        finalW = w;
        finalH = finalW / targetRatio;
    }

    canvas.width = finalW;
    canvas.height = finalH;
    
    // Центрируем CSS
    canvas.style.position = 'absolute';
    canvas.style.left = `${(w - finalW) / 2}px`;
    canvas.style.top = `${(h - finalH) / 2}px`;
}

// Перевод координат экрана в координаты стола
function screenToGame(sx, sy) {
    const rect = canvas.getBoundingClientRect();
    
    // Коэффициент масштаба
    // canvas.width соответствует TABLE_WIDTH + 2*RAIL_SIZE
    const totalGameWidth = TABLE_WIDTH + (RAIL_SIZE * 2);
    const scale = totalGameWidth / canvas.width;

    const relX = (sx - rect.left) * scale;
    const relY = (sy - rect.top) * scale;

    // Игровая зона начинается с отступом RAIL_SIZE
    return {
        x: relX - RAIL_SIZE,
        y: relY - RAIL_SIZE
    };
}

function updateAim(inputX, inputY, cueBall) {
    // Вектор от кия до шара
    const dx = cueBall.x - inputX;
    const dy = cueBall.y - inputY;
    
    mouseAngle = Math.atan2(dy, dx); // Угол удара
    
    const dist = Math.hypot(dx, dy);
    // Сила считается честно, даже если палец ушел за экран
    computedPower = Math.min(1, dist / MAX_PULL_DIST);
}

function shoot(angle, power) {
    fetch('/game/shoot', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ game_id: gameId, angle: angle, power: power })
    }).catch(console.error);
}

function updateUI(data) {
    const status = document.getElementById('status');
    if (status) {
        if (data.is_moving) status.textContent = '...';
        else status.textContent = data.current_player === 1 ? "Ход Игрока 1" : "Ход Игрока 2";
    }
}

// === ОТРИСОВКА ===

function gameLoop() {
    if (!ctx) return;
    
    // Очистка и заливка фоном (под дерево)
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawTable();

    if (gameState && gameState.balls) {
        gameState.balls.forEach(drawBall);
    }
    
    if (gameState && !gameState.is_moving) {
        drawCue();
    }
    
    requestAnimationFrame(gameLoop);
}

function drawTable() {
    // Вычисляем масштаб отрисовки
    // canvas.width = (TABLE_WIDTH + 2*RAIL_SIZE) * scaleFactor
    const totalGameWidth = TABLE_WIDTH + (RAIL_SIZE * 2);
    const scale = canvas.width / totalGameWidth;
    
    // 1. Рисуем деревянный борт (весь канвас)
    ctx.fillStyle = '#5c3a21'; // Дуб
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Рисуем игровое поле (зеленое сукно)
    const playX = RAIL_SIZE * scale;
    const playY = RAIL_SIZE * scale;
    const playW = TABLE_WIDTH * scale;
    const playH = TABLE_HEIGHT * scale;

    ctx.fillStyle = '#228B22';
    ctx.fillRect(playX, playY, playW, playH);
    
    // Тень внутри борта для объема
    ctx.strokeStyle = '#155015';
    ctx.lineWidth = 5 * scale;
    ctx.strokeRect(playX, playY, playW, playH);

    // 3. Рисуем лунки (реалистично встроенные в борт)
    // Лунки находятся по краям игрового поля (0,0, width,0 и т.д.)
    const pockets = [
        {x: 0, y: 0}, 
        {x: TABLE_WIDTH, y: 0},
        {x: 0, y: TABLE_HEIGHT}, 
        {x: TABLE_WIDTH, y: TABLE_HEIGHT},
        {x: 0, y: TABLE_HEIGHT/2}, 
        {x: TABLE_WIDTH, y: TABLE_HEIGHT/2}
    ];

    ctx.fillStyle = '#000';
    const pocketRad = 55 * scale; // Визуальный радиус лунки

    pockets.forEach(p => {
        // Переводим игровые координаты в экранные (с учетом борта)
        const sx = (p.x + RAIL_SIZE) * scale;
        const sy = (p.y + RAIL_SIZE) * scale;
        
        ctx.beginPath();
        ctx.arc(sx, sy, pocketRad, 0, Math.PI * 2);
        ctx.fill();
        
        // Блик на краю лунки (пластиковая вставка)
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
    });
}

function drawBall(ball) {
    if (ball.pocketed) return;
    
    const totalGameWidth = TABLE_WIDTH + (RAIL_SIZE * 2);
    const scale = canvas.width / totalGameWidth;

    // Координаты шара + смещение на борт
    const x = (ball.x + RAIL_SIZE) * scale;
    const y = (ball.y + RAIL_SIZE) * scale;
    const r = ball.radius * scale;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    
    if (ball.number === 0) ctx.fillStyle = '#fff';
    else if (ball.number === 8) ctx.fillStyle = '#000';
    else if (ball.number <= 7) ctx.fillStyle = '#d63031'; // Solids
    else ctx.fillStyle = '#f9ca24'; // Stripes

    ctx.fill();
    
    // Полоска для полосатых
    if (ball.number > 8) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawCue() {
    const cueBall = gameState.balls.find(b => b.number === 0 && !b.pocketed);
    if (!cueBall) return;

    const totalGameWidth = TABLE_WIDTH + (RAIL_SIZE * 2);
    const scale = canvas.width / totalGameWidth;

    const x = (cueBall.x + RAIL_SIZE) * scale;
    const y = (cueBall.y + RAIL_SIZE) * scale;

    // Кий рисуется сзади шара, поэтому угол + 180 (PI)
    const angleOpposite = mouseAngle + Math.PI; 

    // Визуальная логика: 
    // Длина кия зависит от силы натяжения (computedPower), но не больше VISUAL_CUE_MAX_LEN
    // Это решает проблему "кия на полкомнаты"
    
    let drawPower = grabbed ? computedPower : 0;
    const baseLen = 300 * scale;
    const addedLen = (drawPower * 400) * scale; // Анимация оттягивания
    
    // Ограничиваем визуальную длину
    const maxLenPixels = VISUAL_CUE_MAX_LEN * scale;
    const totalLen = Math.min(baseLen + addedLen, maxLenPixels);

    // Отступ от шара
    const offset = 30 * scale;
    const startX = x + Math.cos(angleOpposite) * offset;
    const startY = y + Math.sin(angleOpposite) * offset;
    
    const endX = startX + Math.cos(angleOpposite) * totalLen;
    const endY = startY + Math.sin(angleOpposite) * totalLen;

    // Палка
    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = 8 * scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    
    // Линия прицеливания (пунктир)
    if (grabbed) {
        ctx.setLineDash([5, 10]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        // Рисуем линию вперед
        ctx.lineTo(x + Math.cos(mouseAngle) * 1500 * scale, y + Math.sin(mouseAngle) * 1500 * scale);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

// Expose initializer to global so template inline scripts can call it
if (typeof window !== 'undefined') {
    window.initGame = initGame;
}