//go:build embed

package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
)

//go:embed all:frontend-dist
var embeddedFrontend embed.FS

func frontendHandler() http.Handler {
	sub, err := fs.Sub(embeddedFrontend, "frontend-dist")
	if err != nil {
		log.Fatalf("failed to load frontend: %v", err)
	}
	return http.FileServer(http.FS(sub))
}
