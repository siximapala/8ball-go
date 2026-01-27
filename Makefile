.PHONY: help build run clean install-deps

help:
	@echo "🎱 8Ball Game Commands"
	@echo ""
	@echo "make install-deps   - Install Go dependencies"
	@echo "make build          - Build the binary"
	@echo "make run            - Run the server (localhost:8080)"
	@echo "make clean          - Remove build artifacts"

install-deps:
	go mod download
	go mod tidy

build:
	go build -o bin/8ball cmd/8ball/main.go

run: install-deps
	go run cmd/8ball/main.go

clean:
	rm -rf bin/
