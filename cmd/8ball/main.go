package main

import (
	"log"

	"8ball-go/internal/app"
)

func main() {
	a, err := app.New()
	if err != nil {
		log.Fatalf("failed to create app: %v", err)
	}

	if err := a.Run(); err != nil {
		log.Fatalf("failed to run app: %v", err)
	}
}
