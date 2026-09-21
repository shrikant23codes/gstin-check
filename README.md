# GSTIN Check

A small installable PWA. Photograph a bill, it reads the **GSTIN** off it, validates
the number, decodes what the number itself says about the business, and answers the
only question that matters at the counter:

> **Is this supplier actually allowed to collect this GST from me?**

---

## The rule it enforces

Under the **GST Composition Scheme** a registered dealer pays a flat rate (1% for
traders, 6% for service providers) **out of their own pocket**. They are expressly
barred from passing it on:

- **Section 10(4), CGST Act 2017** — a composition taxpayer *"shall not collect any
  tax from the recipient on supplies made by him"*.
- **Rule 5, CGST Rules 2017** — a composition supplier must issue a **bill of
  supply** marked *"composition taxable person, not eligible to collect tax on
  supplies"*, and may not issue a tax invoice.
- **Section 10(2A)** — the composition scheme for service providers.

So when a bill from a composition dealer adds CGST/SGST on top of the taxable value,
that money is being collected without legal authority. It does not go to the
government. It stays with the seller.

**Regular taxpayer** → collecting GST is lawful. (That the tax was *collected*
lawfully doesn't prove it was *remitted*; only the portal shows that much.)
**Composition / Suspended / Cancelled / Not found** → cannot collect.

---

## What it does

| Step | Detail |
|---|---|
| **Read** | Camera or gallery photo → Tesseract OCR in the browser. Two passes: contrast-stretched greyscale, then Otsu-binarised if the first finds nothing. |
| **Find** | Sliding 15-character windows over the text, repairing classic OCR confusions positionally (`O→0`, `I→1`, `S→5`…) and keeping only readings that survive the check digit. |
| **Validate** | **Luhn mod 36** check digit — the same algorithm GSTN uses. A wrong digit means either a misread character or a number that was made up. |
| **Decode** | State code → state, embedded PAN, constitution of the business (from the PAN's 4th character), registration count, and the first letter of the registered name. |
| **Read the money** | Taxable value, CGST/SGST/IGST and the total, each with the exact line it came from. Figures stay editable. |
| **Judge** | Status × whether the bill charged tax → *fine* / *right amounts, wrong document* / **not collectible, refuse it**. |
| **Act** | Copy the summary, or file a complaint on the GST grievance portal. |

Everything runs on the device. Nothing is uploaded anywhere.

---

## Running it

```bash
go run server.go                       # http://localhost:8788
```

Open that, and use the browser's *Install app* / *Add to Home Screen* prompt.

Camera access needs a secure context. `localhost` counts; **a phone on your LAN does
not** — serve it over HTTPS to use the camera there:

```bash
go run server.go -addr :8443 -tls-cert cert.pem -tls-key key.pem
```

Or deploy the static files (`index.html`, `*.js`, `manifest.webmanifest`, `icons/`)
to any HTTPS host — GitHub Pages, Cloudflare Pages, Netlify. No build step, no
dependencies, no bundler.

---

## About the live status lookup — read this

The one thing this app cannot do by itself is fetch a supplier's **registration
status**, because:

- **gst.gov.in is behind a bot check.** Its search is not a public API and cannot be
  queried by any script, this one included. This app deliberately does not try to
  defeat that. The **Check on GST portal** button copies the number and opens the
  official page for you to paste it into.
- **Commercial GSTIN APIs are CORS-locked**, so a page served from another origin
  can't call them directly either.

So there are three modes, in **Settings**:

| Mode | What it does |
|---|---|
| **Offline only** *(default)* | Structure, check digit, and everything decodable from the number. No network at all. |
| **API key** | Calls `sheet.gstincheck.co.in/check/<key>/<gstin>` (GSTINCheck's free tier). |
| **My own endpoint** | A URL template with `{gstin}` / `{key}`, plus an optional **proxy prefix**. |

The proxy prefix is what solves CORS: `server.go` exposes `/api/lookup?url=…`, which
forwards server-side and adds the CORS headers a browser needs.

```bash
go run server.go -allow-host sheet.gstincheck.co.in
```

It is **not an open proxy** — without `-allow-host` the relay refuses everything, and
with it, only the hosts you name are ever forwarded to. Point the app's proxy prefix
at `http://localhost:8788/api/lookup`.

Whatever comes back is parsed tolerantly (providers name the field differently), and
the **raw response is always shown** so you can check the mapping yourself. Values
from a third-party API are a hint, not proof. The GST portal is the only source that
counts.

---

## Tests

```bash
node --test tests/*.test.mjs      # 58 unit tests
node tools/e2e.mjs                # 34 checks in a real headless Chrome
```

The unit tests cover the check digit against `python-stdnum`, OCR extraction and
repair, bill parsing, image preprocessing and the verdict matrix.

The e2e test drives the actual app over the DevTools Protocol with no npm
dependencies — boots it, types a GSTIN, scans two real bill photos through the real
file input, runs a lookup through the relay to a stub upstream, and asserts the
verdict flips to *not collectible*. It also checks that repeated scans don't
accumulate DOM nodes.

```bash
node tools/e2e.mjs --headed --shot /tmp/shots    # watch it, and save screenshots
```

### Cross-checking the check digit

The Luhn mod 36 implementation is verified against an independent library rather
than trusted:

```bash
node tools/crosscheck.mjs > /tmp/gen.txt
uv run --with python-stdnum python tools/verify_gstin.py $(cat /tmp/gen.txt)
```

One gotcha when reading that output: `python-stdnum` raises `InvalidComponent` for
two things that are **not** check-digit failures — its state table predates **38
(Ladakh)**, and its embedded PAN validation is stricter than GSTN's. Use
`tools/isolate.py` to see which layer actually rejected a number; the `luhn mod36
over full 15 == 0 ? True` line is the one that matters here.

Fixture images are generated too, so the OCR path can be re-tested without a
printer:

```bash
uv run --with pillow python tools/make_sample_bill.py
uv run --with pillow python tools/make_icons.py
python3 tools/stub_lookup.py 8789          # fake upstream, for testing lookups
```

---

## Before you publish

Three things bite when a local utility becomes a public URL. Each has a tool here.

**1. Nothing personal ends up in the history.** Commits carry an author identity
forever, and a working tree is easy to leak by accident. Both are checked:

```bash
npm run audit      # identifiers, secrets, home paths, IPs, cookies, key shapes
```

Forbidden terms live in `.privacy-terms`, which is **gitignored** — a scanner that
names the person it is protecting would itself be the leak. Add anything that would
tie the project back to you. To check one-off terms without storing them:

```bash
python3 tools/privacy_audit.py --forbid some-term --fail-on medium
```

The repo carries a **neutral, repo-local git identity** so personal global settings
are never embedded. Set it before the first commit if it is not already:

```bash
git config user.name  "gstin-check"
git config user.email "gstin-check@users.noreply.github.com"
```

**2. The service worker cache name is the only version lever.** An installed client
keeps the old app shell until that name changes, so a forgotten bump means a fix
silently never ships:

```bash
npm run version:bump     # v1 -> v2
npm run version:check    # fails if sw.js is unchanged since HEAD (pre-deploy gate)
```

**3. Headers and robots.** `_headers` works for both Cloudflare Pages and Netlify: it
forces `sw.js` to `no-cache` and pins the manifest content type, which is what makes
updates and the install prompt actually work. `robots.txt` keeps the site out of
search engines by default — flip it if you would rather it be discoverable.

**Testing a deployed target.** The e2e harness asserts against a stub upstream on
`localhost`, which will not exist in production, so skip that section:

```bash
node tools/e2e.mjs --url https://your-deploy.example.com --skip-lookup
```

Two things still have to be checked by hand on a real phone over HTTPS: the camera,
and an actual bill photo. Neither can be exercised from a headless browser.

### A note on the test data

The fixture bills in `sample-bills/` are **synthetic reconstructions**, not scans of
anyone's real invoice, and the generated business names are invented. The GSTINs are
structurally valid — they pass the check digit, so they exercise the code properly —
but they are not assertions about any real registration. Treat them as test vectors,
not as facts about a business.

## Honest limits

- **A valid check digit is not a valid registration.** It proves the number wasn't
  mistyped. It says nothing about whether the taxpayer exists, is active, or is a
  composition dealer. Only a live lookup does that.
- **Status is unverified by default**, and the verdict says so. It will not accuse a
  supplier of an illegal collection on the strength of a check digit.
- **OCR is good, not perfect.** The app prefers to report that it found nothing over
  guessing — and when it rebuilds a number from a misread character it says so, and
  shows you the repaired version before you rely on it.
- **Restaurant GST is 5%** without input tax credit (the slabs were reworked in
  September 2025). The app flags an implied rate that matches no standard slab, but
  it does not audit rates.
- **Not legal or tax advice.** It is a pointer to Section 10(4) and to the official
  portal. For an actual dispute, talk to a CA.

---

## Files

```
index.html               the app — markup, styles and UI wiring in one file
gstin-core.js            GSTIN decode, check digit, OCR extraction, verdict engine
bill-parse.js            reads taxable value / CGST / SGST / total off bill text
image-prep.js            contrast stretch + Otsu binarisation (no DOM)
sw.js                    service worker: app shell + OCR assets cached offline
manifest.webmanifest     PWA manifest
server.go                static server + optional CORS/allow-listed lookup relay
_headers                 cache-control and content-type rules for Pages/Netlify
robots.txt               keeps the deployed site out of search engines
icons/                   app icons
tests/                   unit tests
tools/e2e.mjs            headless-Chrome end-to-end test (no dependencies)
tools/privacy_audit.py   pre-commit scan for identifiers and secrets
tools/bump_version.mjs   bumps the sw.js cache version (the release lever)
tools/crosscheck.mjs     check-digit cross-check against python-stdnum
tools/make_sample_bill.py  generates the OCR test fixtures
tools/stub_lookup.py     fake GSTIN API, for exercising the lookup path
```

`.privacy-terms` (gitignored) holds the identifiers the audit forbids.

