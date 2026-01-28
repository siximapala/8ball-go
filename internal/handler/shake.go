package handler

import (
	"encoding/json"
	"html/template"
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
		return nil, fmt.Errorf("failed to parse templates: %w", err)
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
		http.Error(w, "Game is full or player already joined", http.StatusBadRequest)
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
	Balls    []BallJSON `json:"balls"`
	Player1  string     `json:"player1"`
	Player2  string     `json:"player2"`
	Current  int        `json:"current_player"`
	IsMoving bool       `json:"is_moving"`
	CueAngle float64    `json:"cue_angle"`
	CuePower float64    `json:"cue_power"`
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
	// Advance server-side physics before returning state
	h.gameService.UpdateGameState(gameID)

	game := h.gameService.GetGame(gameID)

	if game == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	state := GameStateJSON{
		Player1:  game.Player1,
		Player2:  game.Player2,
		Current:  game.CurrentPlayer,
		IsMoving: game.IsMoving,
		CueAngle: game.CuePosition,
		CuePower: game.CuePower,
		Balls:    make([]BallJSON, 0),
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
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	// server-side authorization: disallow shooting until both players joined
	game := h.gameService.GetGame(req.GameID)
	if game == nil {
		http.Error(w, "game not found", http.StatusNotFound)
		return
	}

	// if second player not joined yet, forbid shooting
	if game.Player1 == "" || game.Player2 == "" {
		http.Error(w, "waiting for second player", http.StatusForbidden)
		return
	}

	// allow shot only if requester is the current player
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
		http.Error(w, "not allowed to shoot", http.StatusForbidden)
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
		http.Error(w, "game not found", http.StatusNotFound)
		return
	}

	// Execute template with a map so keys match what templates expect (lower-case keys)
	h.templates.ExecuteTemplate(w, "game.html", map[string]interface{}{
		"gameID":     gameID,
		"playerName": "",
		"playerRole": "",
		"player1":    game.Player1,
		"player2":    game.Player2,
	})
}

// StreamGame streams game state as Server-Sent Events (SSE).
// It advances physics on each tick and pushes the JSON-encoded state to the client.
func (h *ShakeHandler) StreamGame(w http.ResponseWriter, r *http.Request) {
	gameID := r.URL.Query().Get("game_id")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Set headers for SSE
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
			// Advance server-side physics
			h.gameService.UpdateGameState(gameID)

			game := h.gameService.GetGame(gameID)
			if game == nil {
				// send empty keepalive
				_, _ = w.Write([]byte(":\n\n"))
				flusher.Flush()
				continue
			}

			state := GameStateJSON{
				Player1:  game.Player1,
				Player2:  game.Player2,
				Current:  game.CurrentPlayer,
				IsMoving: game.IsMoving,
				CueAngle: game.CuePosition,
				CuePower: game.CuePower,
				Balls:    make([]BallJSON, 0),
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

			// Write SSE "data:" line with JSON payload
			// encode into buffer to avoid mixing writes
			var buf []byte
			b, err := json.Marshal(state)
			if err != nil {
				// skip this tick
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
