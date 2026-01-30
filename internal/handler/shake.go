package handler

import (
	"encoding/json"
	"html/template"
	"math"
	"net/http"
	"time"

	"8ball-go/internal/service"

	"fmt"

	"github.com/google/uuid"
)

type ShakeHandler struct {
	gameService *service.GameService
	templates   *template.Template
}

func NewShakeHandler(gameService *service.GameService) (*ShakeHandler, error) {
	tmpl, err := template.ParseGlob("web/templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("не удалось распарсить шаблоны: %w", err)
	}
	return &ShakeHandler{
		gameService: gameService,
		templates:   tmpl,
	}, nil
}

func (h *ShakeHandler) GetHome(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	h.templates.ExecuteTemplate(w, "index.html", nil)
}

func (h *ShakeHandler) JoinGame(w http.ResponseWriter, r *http.Request) {
	playerName := r.FormValue("player_name")
	gameID := r.FormValue("game_id")

	if gameID == "" {
		gameID = uuid.New().String()[:8]
	}

	game, playerRole := h.gameService.JoinGame(gameID, playerName)
	if playerRole == "" {
		http.Error(w, "Игра заполнена или игрок уже присоединился", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	h.templates.ExecuteTemplate(w, "game.html", map[string]interface{}{
		"gameID":     gameID,
		"playerName": playerName,
		"playerRole": playerRole,
		"player1":    game.Player1,
		"player2":    game.Player2,
	})
}

type GameStateJSON struct {
	Balls      []BallJSON `json:"balls"`
	Player1    string     `json:"player1"`
	Player2    string     `json:"player2"`
	Current    int        `json:"current_player"`
	IsMoving   bool       `json:"is_moving"`
	CueAngle   float64    `json:"cue_angle"`
	CuePower   float64    `json:"cue_power"`
	BallInHand bool       `json:"ball_in_hand"`
}

type BallJSON struct {
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Number   int     `json:"number"`
	Pocketed bool    `json:"pocketed"`
	Radius   float64 `json:"radius"`
}

func (h *ShakeHandler) GetGameState(w http.ResponseWriter, r *http.Request) {
	gameID := r.URL.Query().Get("game_id")
	// Обновление физики на стороне сервера перед возвратом состояния
	h.gameService.UpdateGameState(gameID)

	game := h.gameService.GetGame(gameID)

	if game == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	state := GameStateJSON{
		Player1:    game.Player1,
		Player2:    game.Player2,
		Current:    game.CurrentPlayer,
		IsMoving:   game.IsMoving,
		CueAngle:   game.CuePosition,
		CuePower:   game.CuePower,
		BallInHand: game.BallInHand,
		Balls:      make([]BallJSON, 0),
	}

	for _, ball := range game.Balls {
		state.Balls = append(state.Balls, BallJSON{
			X:        ball.X,
			Y:        ball.Y,
			Number:   ball.Number,
			Pocketed: ball.Pocketed,
			Radius:   ball.Radius,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(state)
}

func (h *ShakeHandler) SetCueAngle(w http.ResponseWriter, r *http.Request) {
	gameID := r.FormValue("game_id")
	var req struct {
		Angle float64 `json:"angle"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	h.gameService.SetCueAngle(gameID, req.Angle)
	w.WriteHeader(http.StatusOK)
}

func (h *ShakeHandler) Shoot(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GameID     string  `json:"game_id"`
		Angle      float64 `json:"angle"`
		Power      float64 `json:"power"`
		PlayerName string  `json:"player_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "неверный запрос", http.StatusBadRequest)
		return
	}

	// авторизация на стороне сервера: запретить стрельбу, пока оба игрока не присоединились
	game := h.gameService.GetGame(req.GameID)
	if game == nil {
		http.Error(w, "игра не найдена", http.StatusNotFound)
		return
	}

	// если второй игрок еще не присоединился, запретить стрельбу
	if game.Player1 == "" || game.Player2 == "" {
		http.Error(w, "ожидание второго игрока", http.StatusForbidden)
		return
	}

	// разрешить выстрел только если запрашивающий - текущий игрок
	allowed := false
	if req.PlayerName != "" {
		if game.CurrentPlayer == 1 && req.PlayerName == game.Player1 {
			allowed = true
		}
		if game.CurrentPlayer == 2 && req.PlayerName == game.Player2 {
			allowed = true
		}
	}

	if !allowed {
		http.Error(w, "не разрешено стрелять", http.StatusForbidden)
		return
	}
	h.gameService.ShootCue(req.GameID, req.Angle, req.Power)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
}

func (h *ShakeHandler) GetGame(w http.ResponseWriter, r *http.Request) {
	gameID := r.URL.Query().Get("game_id")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	game := h.gameService.GetGame(gameID)
	if game == nil {
		http.Error(w, "игра не найдена", http.StatusNotFound)
		return
	}

	// Выполнить шаблон с map, чтобы ключи соответствовали ожиданиям шаблонов (ключи в нижнем регистре)
	h.templates.ExecuteTemplate(w, "game.html", map[string]interface{}{
		"gameID":     gameID,
		"playerName": "",
		"playerRole": "",
		"player1":    game.Player1,
		"player2":    game.Player2,
	})
}

// StreamGame передает состояние игры как Server-Sent Events (SSE).
// На каждом тике обновляет физику и отправляет JSON-закодированное состояние клиенту.
func (h *ShakeHandler) StreamGame(w http.ResponseWriter, r *http.Request) {
	gameID := r.URL.Query().Get("game_id")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "потоковая передача не поддерживается", http.StatusInternalServerError)
		return
	}

	// Установить заголовки для SSE
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ticker := time.NewTicker(time.Millisecond * 16) // ~60Hz
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Обновление физики на стороне сервера
			h.gameService.UpdateGameState(gameID)

			game := h.gameService.GetGame(gameID)
			if game == nil {
				// отправить пустой keepalive
				_, _ = w.Write([]byte(":\n\n"))
				flusher.Flush()
				continue
			}

			state := GameStateJSON{
				Player1:    game.Player1,
				Player2:    game.Player2,
				Current:    game.CurrentPlayer,
				IsMoving:   game.IsMoving,
				CueAngle:   game.CuePosition,
				CuePower:   game.CuePower,
				BallInHand: game.BallInHand,
				Balls:      make([]BallJSON, 0),
			}

			for _, ball := range game.Balls {
				state.Balls = append(state.Balls, BallJSON{
					X:        ball.X,
					Y:        ball.Y,
					Number:   ball.Number,
					Pocketed: ball.Pocketed,
					Radius:   ball.Radius,
				})
			}

			// Запись строки SSE "data:" с JSON-данными
			// кодировать в буфер, чтобы избежать смешивания записей
			var buf []byte
			b, err := json.Marshal(state)
			if err != nil {
				// пропустить этот тик
				continue
			}
			buf = append(buf, []byte("data: ")...)
			buf = append(buf, b...)
			buf = append(buf, []byte("\n\n")...)

			if _, err := w.Write(buf); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *ShakeHandler) PlaceCue(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GameID     string  `json:"game_id"`
		X          float64 `json:"x"`
		Y          float64 `json:"y"`
		PlayerName string  `json:"player_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "неверный запрос", http.StatusBadRequest)
		return
	}

	game := h.gameService.GetGame(req.GameID)
	if game == nil {
		http.Error(w, "игра не найдена", http.StatusNotFound)
		return
	}

	// Разрешить размещение только если BallInHand и запрашивающий - текущий игрок
	if !game.BallInHand {
		http.Error(w, "ball in hand не разрешен", http.StatusForbidden)
		return
	}

	allowed := false
	if req.PlayerName != "" {
		if game.CurrentPlayer == 1 && req.PlayerName == game.Player1 {
			allowed = true
		}
		if game.CurrentPlayer == 2 && req.PlayerName == game.Player2 {
			allowed = true
		}
	}
	if !allowed {
		http.Error(w, "не разрешено размещать", http.StatusForbidden)
		return
	}

	// Базовая валидация координат: внутри стола, не в лузе и не пересекается с другими шарами
	// Найти биток (тип из пакета service)
	var cueBall *service.Ball
	for _, b := range game.Balls {
		if b.Number == 0 {
			cueBall = b
			break
		}
	}
	if cueBall == nil {
		http.Error(w, "биток отсутствует", http.StatusInternalServerError)
		return
	}

	// границы (используем cueBall.Radius, если установлен, иначе service.BallRadius)
	rBall := cueBall.Radius
	if rBall == 0 {
		rBall = service.BallRadius
	}

	if req.X < rBall || req.X > service.TableWidth-rBall || req.Y < rBall || req.Y > service.TableHeight-rBall {
		http.Error(w, "неверное размещение: за пределами границ", http.StatusBadRequest)
		return
	}

	// запретить размещение слишком близко к лузам
	pocketRadius := 60.0
	pockets := []struct{ x, y float64 }{
		{0, 0},
		{service.TableWidth, 0},
		{0, service.TableHeight},
		{service.TableWidth, service.TableHeight},
		{0, service.TableHeight / 2},
		{service.TableWidth, service.TableHeight / 2},
	}
	for _, p := range pockets {
		dx := req.X - p.x
		dy := req.Y - p.y
		if math.Hypot(dx, dy) < pocketRadius+2 {
			http.Error(w, "неверное размещение: слишком близко к лузе", http.StatusBadRequest)
			return
		}
	}

	// не пересекаться с другими шарами
	for _, b := range game.Balls {
		if b.Pocketed || b.Number == 0 {
			continue
		}
		dx := req.X - b.X
		dy := req.Y - b.Y
		if math.Hypot(dx, dy) < (rBall + b.Radius + 2) {
			http.Error(w, "неверное размещение: пересекается с шаром", http.StatusBadRequest)
			return
		}
	}

	// Разместить биток
	cueBall.X = req.X
	cueBall.Y = req.Y
	cueBall.Pocketed = false
	cueBall.VelX = 0
	cueBall.VelY = 0
	cueBall.Omega = 0
	cueBall.IsSliding = false

	// Очистить BallInHand
	game.BallInHand = false
	game.IsMoving = false
	game.LastUpdateTime = time.Now()

	w.WriteHeader(http.StatusOK)
}
