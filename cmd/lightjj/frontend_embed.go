//go:build embed

package main

import (
	"embed"
	"io/fs"
	"log"
	"mime"
	"net/http"
)

//go:embed all:frontend-dist
var embeddedFrontend embed.FS

func frontendHandler() http.Handler {
	// Go's mime table doesn't know .webmanifest; without this the manifest
	// is served as text/plain (content-sniffed), which strict PWA validators flag.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	sub, err := fs.Sub(embeddedFrontend, "frontend-dist")
	if err != nil {
		log.Fatalf("failed to load frontend: %v", err)
	}
	return http.FileServer(http.FS(sub))
}
