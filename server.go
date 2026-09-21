// server.go — serve GSTIN Check over HTTP or HTTPS.
//
//	go run server.go                                  # http://localhost:8788
//	go run server.go -addr :8443 -tls-cert c.pem -tls-key k.pem
//
// The app is a pure static PWA with no build step, so this is not load-bearing:
// any static host serves the same files. It exists for two reasons.
//
//  1. The camera needs a secure context. localhost already counts as one, but a
//     phone on the LAN does not, so -tls-cert is here to test on a real device.
//  2. Two headers are easy to get wrong and break the app when you do — the
//     manifest content type, and no-cache on the service worker. Getting the
//     latter wrong means an installed client can never receive an update.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	addr := flag.String("addr", ":8788", "listen address")
	dir := flag.String("dir", ".", "directory to serve")
	tlsCert := flag.String("tls-cert", "", "TLS certificate (camera access on a phone needs HTTPS)")
	tlsKey := flag.String("tls-key", "", "TLS private key")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.Handle("/", staticHandler(*dir))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           logRequests(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	scheme := "http"
	if *tlsCert != "" && *tlsKey != "" {
		scheme = "https"
	}
	log.Printf("GSTIN Check on %s://localhost%s (serving %s)", scheme, *addr, *dir)

	var err error
	if scheme == "https" {
		err = srv.ListenAndServeTLS(*tlsCert, *tlsKey)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// Serve the app. Go's content sniffer is usually right, but a couple of types
// matter enough to set explicitly. .webmanifest in particular: the wrong content
// type silently suppresses the PWA install prompt.
func staticHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	overrides := map[string]string{
		".webmanifest": "application/manifest+json",
		".js":          "text/javascript; charset=utf-8",
		".svg":         "image/svg+xml",
		".json":        "application/json",
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ext := strings.ToLower(pathExt(r.URL.Path)); ext != "" {
			if typ, ok := overrides[ext]; ok {
				w.Header().Set("Content-Type", typ)
			}
		}
		// A service worker served from a stale HTTP cache can never be replaced,
		// so a released fix would never reach an installed client.
		if strings.HasSuffix(r.URL.Path, "/sw.js") {
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		fs.ServeHTTP(w, r)
	})
}

func pathExt(p string) string {
	if i := strings.LastIndex(p, "."); i >= 0 {
		if j := strings.LastIndex(p, "/"); j < i {
			return p[i:]
		}
	}
	return ""
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.code = code
	s.ResponseWriter.WriteHeader(code)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, code: 200}
		start := time.Now()
		next.ServeHTTP(rec, r)
		fmt.Fprintf(os.Stderr, "%s %s %d %s\n", r.Method, r.URL.Path, rec.code, time.Since(start).Round(time.Millisecond))
	})
}
