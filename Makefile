.PHONY: install build frontend dev clean

install: frontend
	go install ./cmd/lightjj

build: frontend
	go build -o lightjj ./cmd/lightjj

frontend:
	cd frontend && bun install && bun run build

dev:
	cd frontend && bun run dev

clean:
	rm -f lightjj
	rm -rf cmd/lightjj/frontend-dist

