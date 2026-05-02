.PHONY: install build frontend dev clean

VERSION := $(shell cat version.txt)
LDFLAGS := -ldflags "-X main.version=$(VERSION)"

install: frontend
	go install -tags embed $(LDFLAGS) ./cmd/lightjj

build: frontend
	go build -tags embed $(LDFLAGS) -o lightjj ./cmd/lightjj

frontend:
	cd frontend && pnpm install && pnpm run build

dev:
	cd frontend && pnpm run dev

clean:
	rm -f lightjj
	rm -rf cmd/lightjj/frontend-dist

