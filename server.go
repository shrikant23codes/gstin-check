// server.go — serve GSTIN Check, and (optionally) relay a lookup endpoint that
// refuses to talk to browsers directly.
//
//	go run server.go                              # static files on :8788
//	go run server.go -allow-host sheet.gstincheck.co.in
//	go run server.go -addr :8443 -tls-cert c.pem -tls-key k.pem
//
// Why the relay exists: the GST portal's own search is behind a bot check, so
// it cannot be queried from a script at all. Most commercial GSTIN APIs are
// CORS-locked, so a page served from another origin cannot call them either.
// This little proxy fixes the second case and nothing else — point the PWA's
// "proxy prefix" at http://<this-host>:8788/api/lookup and configure the real
// endpoint in Settings.
//
// Deliberately not an open proxy: /api/lookup only forwards to hosts named with
// -allow-host. Without that flag the relay is switched off entirely.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type mimeOverride struct {
	ext, typ string
}

func main() {
	addr := flag.String("addr", ":8788", "listen address")
	dir := flag.String("dir", ".", "directory to serve")
	allow := flag.String("allow-host", "", "comma-separated hosts the lookup relay may forward to (empty disables the relay)")
	timeout := flag.Duration("timeout", 20*time.Second, "upstream timeout for the relay")
	tlsCert := flag.String("tls-cert", "", "TLS certificate (camera access on a phone needs HTTPS)")
	tlsKey := flag.String("tls-key", "", "TLS private key")
	flag.Parse()

	allowed := parseHosts(*allow)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/api/lookup", relayHandler(allowed, *timeout))
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
	if len(allowed) == 0 {
		log.Printf("lookup relay disabled — pass -allow-host to enable it")
	} else {
		log.Printf("lookup relay will forward only to: %s", strings.Join(allowed, ", "))
	}

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

func parseHosts(list string) []string {
	var out []string
	for _, h := range strings.Split(list, ",") {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" {
			out = append(out, h)
		}
	}
	return out
}

func hostAllowed(host string, allowed []string) bool {
	host = strings.ToLower(host)
	for _, a := range allowed {
		if host == a || strings.HasSuffix(host, "."+a) {
			return true
		}
	}
	return false
}

// Serve the app. Unknown extensions are left to Go's sniffer, but a couple of
// types matter enough to set explicitly — .webmanifest in particular, since a
// wrong content type stops the install prompt from appearing.
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
		// The service worker must not be served from a stale HTTP cache, or a
		// version bump never reaches an installed client.
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

// GET /api/lookup?url=<absolute https URL> -> the upstream's body, untouched.
func relayHandler(allowed []string, timeout time.Duration) http.HandlerFunc {
	client := &http.Client{Timeout: timeout}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Headers", "*")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if len(allowed) == 0 {
			http.Error(w, "relay disabled: start the server with -allow-host", http.StatusForbidden)
			return
		}
		raw := r.URL.Query().Get("url")
		if raw == "" {
			http.Error(w, "missing url parameter", http.StatusBadRequest)
			return
		}
		target, err := url.Parse(raw)
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") {
			http.Error(w, "url must be an absolute http(s) URL", http.StatusBadRequest)
			return
		}
		if !hostAllowed(target.Hostname(), allowed) {
			http.Error(w, "host not in -allow-host: "+target.Hostname(), http.StatusForbidden)
			return
		}

		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		req.Header.Set("Accept", "application/json, text/plain, */*")
		req.Header.Set("User-Agent", "gstin-check/1.0")

		res, err := client.Do(req)
		if err != nil {
			http.Error(w, "upstream: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer res.Body.Close()

		if ct := res.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(res.StatusCode)
		io.Copy(w, io.LimitReader(res.Body, 1<<20))
	}
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
