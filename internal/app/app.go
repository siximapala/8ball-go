package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"8ball-go/internal/handler"
	"8ball-go/internal/http/middleware"
	"8ball-go/internal/service"
)

type App struct {
	server *http.Server
}

func New() (*App, error) {
	cfg := LoadConfig()

	r := chi.NewRouter()

	// Apply global middleware
	r.Use(middleware.Logger)
	r.Use(middleware.Recover)

	// Initialize service (in-memory sessions)
	gameService := service.NewGameService()

	// Handlers
	shakeHandler, err := handler.NewShakeHandler(gameService)
	if err != nil {
		return nil, fmt.Errorf("failed to create shake handler: %w", err)
	}

	// Routes
	r.Get("/", shakeHandler.GetHome)
	r.Post("/join", shakeHandler.JoinGame)
	r.Get("/game/state", shakeHandler.GetGameState)
	r.Post("/game/shoot", shakeHandler.Shoot)
	r.Get("/ws", shakeHandler.GetGame)
	r.Get("/events", shakeHandler.StreamGame)

	// Static files
	fs := http.FileServer(http.Dir("web/static"))
	r.Handle("/static/*", http.StripPrefix("/static", fs))

	httpServer := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: r,
	}

	return &App{
		server: httpServer,
	}, nil
}

func (a *App) Run() error {
	fmt.Printf("Starting server on :%s\n", a.server.Addr[1:])
	if err := a.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func (a *App) Shutdown(ctx context.Context) error {
	shutdownCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return a.server.Shutdown(shutdownCtx)
}
