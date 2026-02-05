package service

import (
	"math"
	"sync"
	"time"
)

const (
	TableWidth  = 1400.0
	TableHeight = 2800.0
	BallRadius  = 28.5
	CueRadius   = 12

	// физические констануты
	RollingFriction    = 0.992
	SlidingFriction    = 0.998
	AngularFriction    = 0.99
	CushionRestitution = 0.85
	MaxInitialVelocity = 5000.0
	MinVelocity        = 2.0
	StopThreshold      = 5.0
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
	BallInHand     bool

	Player1Set        int   // 0 none 1 сплошные 2 полосатые
	Player2Set        int   // 0 none 1 сплошные 2 полосатые
	LastShooter       int   // игрок который совершил последний удар
	TempPocketedBalls []int // временный буфер шаров забитых в текущем розыгрыше
	PendingPlayer     int   // отложенная смена хода применяемая в конце розыгрыша
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

// Возвращает состояние игры по ID игры
func (s *GameService) GetGame(gameID string) *GameState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.games[gameID]
}

// Joingame добавляет игрока в игру и возвращает обновленное состояние игры и роль игрока
func (s *GameService) JoinGame(gameID, playerName string) (*GameState, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	game, exists := s.games[gameID]
	if !exists {
		game = &GameState{
			ID:                gameID,
			CurrentPlayer:     1,
			Balls:             initializeBalls(),
			LastUpdateTime:    time.Now(),
			Player1Set:        0,
			Player2Set:        0,
			LastShooter:       0,
			TempPocketedBalls: nil,
			PendingPlayer:     0,
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

// Ставит угол прицеливания для игрока
func (s *GameService) SetCueAngle(gameID string, angle float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if game, ok := s.games[gameID]; ok {
		game.CuePosition = angle
	}
}

// GetPlayers возвращает имена игроков в игре
func (s *GameService) GetPlayers(gameID string) (string, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if game, ok := s.games[gameID]; ok {
		return game.Player1, game.Player2
	}
	return "", ""
}

func (s *GameService) CreateGame(gameID string) *GameState {
	s.mu.Lock()
	defer s.mu.Unlock()
	game := &GameState{
		ID:                gameID,
		CurrentPlayer:     1,
		Balls:             initializeBalls(),
		LastUpdateTime:    time.Now(),
		Player1Set:        0,
		Player2Set:        0,
		LastShooter:       0,
		TempPocketedBalls: nil,
		PendingPlayer:     0,
	}
	s.games[gameID] = game
	return game
}

func (s *GameService) UpdateGameState(gameID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	game, exists := s.games[gameID]
	if !exists {
		return
	}

	prevMoving := game.IsMoving

	dt := time.Since(game.LastUpdateTime).Seconds()
	if dt <= 0 {
		return
	}
	if dt > 0.05 {
		dt = 0.05
	}

	// не очищаем temp буфер здесь он очищается при начале удара в ShootCue
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

		// пометить попавшие шары
		game.checkPocketing(ball)
	}

	// столкновения шаров
	for i := 0; i < len(game.Balls); i++ {
		for j := i + 1; j < len(game.Balls); j++ {
			game.checkBallCollision(game.Balls[i], game.Balls[j])
		}
	}

	// вычисляем движется ли сейчас игра
	moving := false
	for _, ball := range game.Balls {
		if !ball.Pocketed {
			if math.Sqrt(ball.VelX*ball.VelX+ball.VelY*ball.VelY) > MinVelocity {
				moving = true
				break
			}
		}
	}
	game.IsMoving = moving

	// если розыгрыш только что закончился то анализируем что произошло
	if prevMoving && !game.IsMoving && game.LastShooter != 0 && !game.GameOver {
		shooter := game.LastShooter
		opponent := 3 - shooter

		// соберём статистику по шарикам забитым в розыгрыше
		ownPocketed := 0
		oppPocketed := 0
		eightPocketed := false
		cuePocketed := false

		for _, n := range game.TempPocketedBalls {
			if n == 0 {
				cuePocketed = true
				continue
			}
			if n == 8 {
				eightPocketed = true
				continue
			}
		}

		// назначаем набор если ещё не назначен и есть первый попавший номерный шар
		for _, n := range game.TempPocketedBalls {
			if n == 0 || n == 8 {
				continue
			}
			if game.Player1Set == 0 && game.Player2Set == 0 {
				var shooterSet int
				if isSolid(n) {
					shooterSet = 1
				} else if isStripe(n) {
					shooterSet = 2
				}
				if shooterSet != 0 {
					if shooter == 1 {
						game.Player1Set = shooterSet
						game.Player2Set = 3 - shooterSet
					} else {
						game.Player2Set = shooterSet
						game.Player1Set = 3 - shooterSet
					}
				}
			}
			break
		}

		// теперь считаем сколько своих и чужих шаров попало
		for _, n := range game.TempPocketedBalls {
			if n == 0 {
				cuePocketed = true
				continue
			}
			if n == 8 {
				eightPocketed = true
				continue
			}
			// принадлежность к игроку определяется по назначенным наборам
			var owner int
			if isSolid(n) {
				if game.Player1Set == 1 {
					owner = 1
				} else if game.Player2Set == 1 {
					owner = 2
				}
			} else if isStripe(n) {
				if game.Player1Set == 2 {
					owner = 1
				} else if game.Player2Set == 2 {
					owner = 2
				}
			}
			if owner == shooter {
				ownPocketed++
			} else if owner == opponent {
				oppPocketed++
			} else {
				// если набор не назначен ещё то принадлежность пока не определена
				// считаем как свой для того кто забил если номерный
				if isSolid(n) || isStripe(n) {
					ownPocketed++
				}
			}
		}

		// правила для восьмёрки
		if eightPocketed {
			// если игрок к этому моменту не очистил свои шары то он проиграл
			var shooterSet int
			if shooter == 1 {
				shooterSet = game.Player1Set
			} else {
				shooterSet = game.Player2Set
			}

			// если набор не назначен то считать что это поражение игрока
			if shooterSet == 0 {
				// проигрыш по неправильной восьмёрке
				game.GameOver = true
				game.Winner = opponent
			} else {
				remaining := game.remainingForSet(shooterSet)
				if remaining == 0 {
					// легальная восьмёрка победа
					game.GameOver = true
					game.Winner = shooter
				} else {
					// нелегальная восьмёрка проигрыш
					game.GameOver = true
					game.Winner = opponent
				}
			}
		} else if cuePocketed {
			// фол битком даём оппоненту право поставить биток
			game.BallInHand = true
			// помечаем отложенную смену хода чтобы применить её только в конце розыгрыша
			if game.PendingPlayer == 0 {
				game.PendingPlayer = opponent
			}
		} else {
			// если игрок забил хотя бы один свой шар то он остаётся ходить
			if ownPocketed > 0 {
				game.CurrentPlayer = shooter
				// ball in hand сбрасываем если был
				game.BallInHand = false
				// отменяем отложенную смену если была
				game.PendingPlayer = 0
			} else {
				// иначе ход переходит оппоненту
				game.CurrentPlayer = opponent
				// ball in hand сбрасываем если был
				game.BallInHand = false
				// отменяем отложенную смену если была
				game.PendingPlayer = 0
			}
		}

		// если есть отложенная смена и игра не закончена применяем её
		if game.PendingPlayer != 0 && !game.GameOver {
			game.CurrentPlayer = game.PendingPlayer
			game.PendingPlayer = 0
		}

		// очищаем last shooter и временные данные
		game.LastShooter = 0
		game.TempPocketedBalls = nil
	}

	game.LastUpdateTime = time.Now()
}

func isSolid(n int) bool {
	return n >= 1 && n <= 7
}

func isStripe(n int) bool {
	return n >= 9 && n <= 15
}

// считает сколько шаров данного набора ещё не забито
func (game *GameState) remainingForSet(set int) int {
	if set == 0 {
		return -1
	}
	cnt := 0
	for _, b := range game.Balls {
		if b.Pocketed {
			continue
		}
		if set == 1 && isSolid(b.Number) {
			cnt++
		}
		if set == 2 && isStripe(b.Number) {
			cnt++
		}
	}
	return cnt
}

func (s *GameService) ShootCue(gameID string, angle, power float64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	game, exists := s.games[gameID]
	if !exists || game.IsMoving || game.GameOver {
		return
	}

	// записываем кто бьёт и начинаем новый буфер для розыгрыша
	game.LastShooter = game.CurrentPlayer
	game.TempPocketedBalls = nil
	game.PendingPlayer = 0

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
	game.LastUpdateTime = time.Now()
	// текущий игрок не меняем пока не закончится розыгрыш
}

func (game *GameState) checkPocketing(ball *Ball) {
	// проверяем все лузы
	pockets := []struct{ x, y float64 }{
		{0, 0},
		{TableWidth, 0},
		{0, TableHeight},
		{TableWidth, TableHeight},
		{0, TableHeight / 2},
		{TableWidth, TableHeight / 2},
	}

	pocketRadius := 60.0

	for _, pocket := range pockets {
		dx := ball.X - pocket.x
		dy := ball.Y - pocket.y
		distance := math.Sqrt(dx*dx + dy*dy)

		if distance < pocketRadius && !ball.Pocketed {
			// помечаем шар как забитый
			ball.Pocketed = true
			ball.X = pocket.x
			ball.Y = pocket.y
			ball.VelX = 0
			ball.VelY = 0
			ball.Omega = 0

			// добавляем номер шар в временный список для анализа розыгрыша
			if game.TempPocketedBalls == nil {
				game.TempPocketedBalls = make([]int, 0)
			}
			game.TempPocketedBalls = append(game.TempPocketedBalls, ball.Number)

			if ball.Number != 0 {
				game.PocketedBalls = append(game.PocketedBalls, ball.Number)
			} else {
				// если биток попал в лузу то включаем режим ball in hand
				game.BallInHand = true
				// планируем смену хода оппоненту но не применяем немедленно
				if game.LastShooter != 0 && game.PendingPlayer == 0 {
					game.PendingPlayer = 3 - game.LastShooter
				} else if game.PendingPlayer == 0 {
					game.PendingPlayer = 3 - game.CurrentPlayer
				}
			}

			return
		}
	}
}

func (game *GameState) checkBallCollision(b1, b2 *Ball) {
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
	// биток ставится внизу стола
	balls[0] = &Ball{
		X:         TableWidth / 2,
		Y:         TableHeight * 0.75,
		Number:    0,
		Radius:    BallRadius,
		IsSliding: false,
	}

	// пирамида (вверху стола)
	apexX := TableWidth / 2.0
	apexY := TableHeight * 0.25 // точка вершины пирамиды

	ballNum := 1
	// строим пирамиду "вверх" от вершины

	for row := 0; row < 5; row++ {
		rowY := apexY - float64(row)*(BallRadius*1.732)
		startX := apexX - float64(row)*BallRadius
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
