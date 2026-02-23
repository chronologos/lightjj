.PHONY: install build frontend dev clean

install: frontend
	go install ./cmd/jj-web

build: frontend
	go build -o jj-web ./cmd/jj-web

frontend:
	cd frontend && pnpm install && pnpm run build

dev:
	cd frontend && pnpm run dev

clean:
	rm -f jj-web
	rm -rf cmd/jj-web/frontend-dist

