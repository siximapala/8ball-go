package service

import (
	"math"
	"sync"
	"time"
)

const (
	// ИЗМЕНЕНИЕ: ВЕРТИКАЛЬНАЯ ОРИЕНТАЦИЯ
	TableWidth  = 1400.0 // Было 2800
	TableHeight = 2800.0 // Было 1400
	BallRadius  = 28.5
	CueRadius   = 12

	// ФИЗИЧЕСКИЕ КОНСТАНТЫ (БЕЗ ИЗМЕНЕНИЙ)
	RollingFriction    = 0.992
	SlidingFriction    = 0.998
	AngularFriction    = 0.99
	CushionRestitution = 0.85
	MaxInitialVelocity = 5000.0
	MinVelocity        = 2.0
	StopThreshold      = 5.0
	DtScale            = 0.016
)

type Ball struct {
	X, Y, VelX, VelY, Omega float64
	Number                  int
	Pocketed                bool
	Radius                  float64
	IsSliding               bool
}

type GameState struct {
	ID             string
	Player1        string
	Player2        string
	CurrentPlayer  int
	Balls          []*Ball
	CuePosition    float64
	CuePower       float64
	IsMoving       bool
	LastUpdateTime time.Time
	Player1Balls   []int
	Player2Balls   []int
	PocketedBalls  []int
	Player1Score   int
	Player2Score   int
	GameOver       bool
	Winner         int
}

type GameService struct {
	mu    sync.RWMutex
	games map[string]*GameState
}

func NewGameService() *GameService {
	return &GameService{
		games: make(map[string]*GameState),
	}
}

// GetGame returns the game state for a given ID (or nil if not found)
func (s *GameService) GetGame(gameID string) *GameState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.games[gameID]
}

// JoinGame joins or creates a game and assigns player1/player2 roles
func (s *GameService) JoinGame(gameID, playerName string) (*GameState, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	game, exists := s.games[gameID]
	if !exists {
		game = &GameState{
			ID:             gameID,
			CurrentPlayer:  1,
			Balls:          initializeBalls(),
			LastUpdateTime: time.Now(),
		}
		s.games[gameID] = game
	}

	if game.Player1 == "" {
		game.Player1 = playerName
		return game, "player1"
	} else if game.Player2 == "" && game.Player1 != playerName {
		game.Player2 = playerName
		return game, "player2"
	}

	return game, ""
}

// SetCueAngle sets the cue angle for a game
func (s *GameService) SetCueAngle(gameID string, angle float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if game, ok := s.games[gameID]; ok {
		game.CuePosition = angle
	}
}

// GetPlayers returns player names for a game
func (s *GameService) GetPlayers(gameID string) (string, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if game, ok := s.games[gameID]; ok {
		return game.Player1, game.Player2
	}
	return "", ""
}

// ... CreateGame, GetGame, JoinGame, GetPlayers остаются БЕЗ ИЗМЕНЕНИЙ ...
// Вставь их сюда из своего старого файла
func (s *GameService) CreateGame(gameID string) *GameState {
	s.mu.Lock()
	defer s.mu.Unlock()
	game := &GameState{
		ID:             gameID,
		CurrentPlayer:  1,
		Balls:          initializeBalls(),
		LastUpdateTime: time.Now(),
		IsMoving:       false,
	}
	s.games[gameID] = game
	return game
}

// и так далее...

func (s *GameService) UpdateGameState(gameID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	game, exists := s.games[gameID]
	if !exists {
		return
	}

	dt := time.Since(game.LastUpdateTime).Seconds()
	if dt <= 0 {
		return
	}
	if dt > 0.05 {
		dt = 0.05
	}

	// ЛОГИКА ФИЗИКИ ОСТАЛАСЬ ТА ЖЕ, ЧТО ТЫ ПРИСЛАЛ
	// Только проверки координат (бортов) теперь используют новые width/height

	for _, ball := range game.Balls {
		if ball.Pocketed {
			continue
		}

		speed := math.Sqrt(ball.VelX*ball.VelX + ball.VelY*ball.VelY)

		if speed < StopThreshold {
			ball.VelX, ball.VelY, ball.Omega = 0, 0, 0
			ball.IsSliding = false
			continue
		}

		if ball.IsSliding {
			ball.VelX *= SlidingFriction
			ball.VelY *= SlidingFriction
			ball.Omega *= AngularFriction
			if speed < 300.0 {
				ball.IsSliding = false
			}
		} else {
			ball.VelX *= RollingFriction
			ball.VelY *= RollingFriction
			newSpeed := math.Sqrt(ball.VelX*ball.VelX + ball.VelY*ball.VelY)
			if newSpeed > 0 {
				ball.Omega = newSpeed / ball.Radius
			} else {
				ball.Omega = 0
			}
		}

		ball.X += ball.VelX * dt
		ball.Y += ball.VelY * dt

		// Борта (используем новые TableWidth / TableHeight)
		if ball.X-ball.Radius < 0 {
			ball.X = ball.Radius
			ball.VelX = -ball.VelX * CushionRestitution
			ball.Omega *= 0.9
		}
		if ball.X+ball.Radius > TableWidth {
			ball.X = TableWidth - ball.Radius
			ball.VelX = -ball.VelX * CushionRestitution
			ball.Omega *= 0.9
		}
		if ball.Y-ball.Radius < 0 {
			ball.Y = ball.Radius
			ball.VelY = -ball.VelY * CushionRestitution
			ball.Omega *= 0.9
		}
		if ball.Y+ball.Radius > TableHeight {
			ball.Y = TableHeight - ball.Radius
			ball.VelY = -ball.VelY * CushionRestitution
			ball.Omega *= 0.9
		}

		game.checkPocketing(ball)
	}

	// Столкновения шаров - БЕЗ ИЗМЕНЕНИЙ
	for i := 0; i < len(game.Balls); i++ {
		for j := i + 1; j < len(game.Balls); j++ {
			game.checkBallCollision(game.Balls[i], game.Balls[j])
		}
	}

	game.IsMoving = false
	for _, ball := range game.Balls {
		if !ball.Pocketed {
			if math.Sqrt(ball.VelX*ball.VelX+ball.VelY*ball.VelY) > MinVelocity {
				game.IsMoving = true
				break
			}
		}
	}

	game.LastUpdateTime = time.Now()
}

func (s *GameService) ShootCue(gameID string, angle, power float64) {
	// ЛОГИКА БЕЗ ИЗМЕНЕНИЙ, только сигнатура подправлена под JSON input
	s.mu.Lock()
	defer s.mu.Unlock()

	game, exists := s.games[gameID]
	if !exists || game.IsMoving {
		return
	}

	for _, ball := range game.Balls {
		if ball.Number == 0 && !ball.Pocketed {
			velocityMag := power * MaxInitialVelocity
			ball.VelX = math.Cos(angle) * velocityMag
			ball.VelY = math.Sin(angle) * velocityMag
			ball.Omega = velocityMag / ball.Radius * 0.5
			ball.IsSliding = true
			break
		}
	}
	game.IsMoving = true
	game.LastUpdateTime = time.Now() // Важно обновить время
}

// ... Остальные методы (SetCueAngle и т.д.) ...

func (game *GameState) checkPocketing(ball *Ball) {
	// ИЗМЕНЕНИЕ: КООРДИНАТЫ ЛУНОК (Вертикальная раскладка)
	pockets := []struct{ x, y float64 }{
		{0, 0},                        // Top-Left
		{TableWidth, 0},               // Top-Right
		{0, TableHeight},              // Bottom-Left
		{TableWidth, TableHeight},     // Bottom-Right
		{0, TableHeight / 2},          // Mid-Left
		{TableWidth, TableHeight / 2}, // Mid-Right
	}

	// Увеличил чувствительность, чтобы шар падал, если центр близок к лузе
	pocketRadius := 60.0

	for _, pocket := range pockets {
		dx := ball.X - pocket.x
		dy := ball.Y - pocket.y
		distance := math.Sqrt(dx*dx + dy*dy)

		if distance < pocketRadius {
			ball.Pocketed = true
			ball.X = pocket.x
			ball.Y = pocket.y
			ball.VelX = 0
			ball.VelY = 0
			ball.Omega = 0

			if ball.Number != 0 {
				game.PocketedBalls = append(game.PocketedBalls, ball.Number)
			}
			return
		}
	}
}

func (game *GameState) checkBallCollision(b1, b2 *Ball) {
	// ЛОГИКА БЕЗ ИЗМЕНЕНИЙ (копируем из твоего файла)
	if b1.Pocketed || b2.Pocketed {
		return
	}
	dx := b2.X - b1.X
	dy := b2.Y - b1.Y
	distance := math.Sqrt(dx*dx + dy*dy)
	minDist := b1.Radius + b2.Radius
	if distance >= minDist {
		return
	}

	nx := dx / distance
	ny := dy / distance
	dvx := b2.VelX - b1.VelX
	dvy := b2.VelY - b1.VelY
	dvn := dvx*nx + dvy*ny
	if dvn >= 0 {
		return
	}

	impulse := dvn / 2.0
	b1.VelX += impulse * nx
	b1.VelY += impulse * ny
	b2.VelX -= impulse * nx
	b2.VelY -= impulse * ny

	b1.IsSliding = true
	b2.IsSliding = true

	overlap := minDist - distance
	b1.X -= overlap / 2.0 * nx
	b1.Y -= overlap / 2.0 * ny
	b2.X += overlap / 2.0 * nx
	b2.Y += overlap / 2.0 * ny
}

func initializeBalls() []*Ball {
	balls := make([]*Ball, 16)

	// ИЗМЕНЕНИЕ: РАССТАНОВКА ШАРОВ ДЛЯ ВЕРТИКАЛИ

	// Биток (внизу стола)
	balls[0] = &Ball{
		X:         TableWidth / 2,
		Y:         TableHeight * 0.75,
		Number:    0,
		Radius:    BallRadius,
		IsSliding: false,
	}

	// Пирамида (вверху стола)
	apexX := TableWidth / 2.0
	apexY := TableHeight * 0.25 // Точка вершины пирамиды

	ballNum := 1
	// Строим пирамиду "вверх" от вершины (к началу координат), или вниз?
	// Обычно разбивают от "дома" в сторону пирамиды. Биток на 0.75, значит пирамида на 0.25.
	// Вершина (1-й шар) ближе к битку. Остальные ряды ДАЛЬШЕ от битка (меньше по Y).

	for row := 0; row < 5; row++ {
		// Y уменьшается для каждого следующего ряда (уходим к верхнему борту 0)
		rowY := apexY - float64(row)*(BallRadius*1.732)

		startX := apexX - float64(row)*BallRadius // Центрируем ряд по X

		for col := 0; col <= row; col++ {
			x := startX + float64(col)*BallRadius*2
			y := rowY

			balls[ballNum] = &Ball{
				X:         x,
				Y:         y,
				Number:    ballNum,
				Radius:    BallRadius,
				IsSliding: false,
			}
			ballNum++
		}
	}

	return balls
}

// GetPlayers и другие вспомогательные методы тоже копируй как было
