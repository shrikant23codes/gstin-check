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
| **Judge** | The verdict engine applies Section 10(4): a composition or suspended supplier may not collect tax at all, so a bill that adds it anyway is flagged with the amount that should not have been charged. Needs a known status — see the section below. |
| **Act** | Copy a plain-text summary, or open the official GSTIN search in your own browser. |

Bill photos and GSTINs never leave the device. The only network requests the app
makes are its OCR library and web fonts loading from a CDN.

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

## Why there is no live status lookup

The one thing this app cannot do is fetch a supplier's **registration status**. That
is deliberate, not an oversight — every source for it is gated:

| Source | What it does when asked |
|---|---|
| **gst.gov.in** (the authoritative one) | Its search API sits behind an Akamai bot check. A scripted `POST` is dropped at the TCP layer — `Recv failure: Connection reset by peer` — before any application code runs. The captcha is *downstream* of that gate, so it is not even the binding constraint. |
| **ClearTax** | `GET /f/compliance-report/{gstin}/?captcha_token=…` returns `401 {"detail":"reCaptcha verification failed"}` for absent, empty **and** dummy tokens. Google reCAPTCHA, verified server-side, plus an 11-request rate limit and no CORS grant to third-party origins. |
| **Commercial GSTIN APIs** | Key-gated and CORS-locked, so a page served from another origin cannot call them either. |

Rather than special-case one of these, or pretend a check digit settles the question,
the app does the one thing that genuinely works: **Check on GST portal** copies the
number and opens the official Search-by-GSTIN/UIN page in your own browser, where you
solve the captcha yourself. A GSTIN that passes its check digit can still belong to a
composition dealer — only the portal settles that.

**The honest consequence:** the stamped verdict — *"this GST is not collectible,
refuse it"* — cannot be reached from the UI as shipped. `gstin-core.js` still
implements and unit-tests that branch, so the logic is correct and present, but with
the status permanently unverified the app reports *"Registration status not yet
verified"* every time. Restoring it without a network call means letting the user pick
the status they just read on the portal, which keeps every source captcha-gated while
bringing back the refusal amount and the complaint flow. That is not built yet.

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
file input, and checks the OCR pipeline end to end. It also asserts that repeated
scans don't accumulate DOM nodes.

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

The audit also runs as a **pre-commit hook**, so it cannot be skipped by forgetting:

```bash
git config core.hooksPath .githooks
```

It fails closed — if the scanner cannot run at all, the commit is refused rather than
allowed silently. `git commit --no-verify` bypasses it; if you ever use that, fix the
finding immediately, because the hook only checks the working tree, not the history
you just wrote.

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

**Testing a deployed target.** The harness takes an explicit URL and has no
local-only dependencies, so it runs against a live deploy as-is:

```bash
node tools/e2e.mjs --url https://your-deploy.example.com
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
  composition dealer, and the app has no way to find out for you.
- **Status is always unverified.** Every source for it is captcha-gated, so the app
  opens the official portal instead of guessing. It will not accuse a supplier of an
  illegal collection on the strength of a check digit.
- **OCR is good, not perfect.** The app prefers to report that it found nothing over
  guessing — and when it rebuilds a number from a misread character it says so, and
  shows you the repaired version before you rely on it.
- **Restaurant GST is 5%** without input tax credit (the slabs were reworked in
  September 2025). The app flags an implied rate that matches no standard slab, but
  it does not audit rates.
- **Not legal or tax advice.** It is a pointer to Section 10(4) and to the official
  portal. For an actual dispute, talk to a CA.

---

## License

MIT — see `LICENSE`. You are free to use, modify, and re-host it, including
commercially. It ships with no warranty, and it is **not legal or tax advice**.

The code here is original and carries no vendored third-party source. It does lean
on others at runtime, and credit is due to them:

- **[Tesseract.js](https://github.com/naptha/tesseract.js)** (Apache-2.0) — the OCR
  engine, loaded from a CDN. The underlying
  [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) is also Apache-2.0.
- **Google Fonts** (SIL Open Font License) — the typefaces, loaded from a CDN.
- **Test tooling only, never shipped:** [Pillow](https://python-pillow.org)
  (MIT-CMU) generates the fixture bills and icons; [python-stdnum](https://github.com/arthurdejong/python-stdnum)
  (LGPL-2.1+) cross-checks the check digit.

---

## Files

```
LICENSE                  MIT
index.html               the app — markup, styles and UI wiring in one file
gstin-core.js            GSTIN decode, check digit, OCR extraction, verdict engine
bill-parse.js            reads taxable value / CGST / SGST / total off bill text
image-prep.js            contrast stretch + Otsu binarisation (no DOM)
sw.js                    service worker: app shell + OCR assets cached offline
manifest.webmanifest     PWA manifest
server.go                static file server for local dev and HTTPS device testing
_headers                 cache-control and content-type rules for Pages/Netlify
robots.txt               keeps the deployed site out of search engines
icons/                   app icons
tests/                   unit tests
tools/e2e.mjs            headless-Chrome end-to-end test (no dependencies)
tools/privacy_audit.py   pre-commit scan for identifiers and secrets
tools/bump_version.mjs   bumps the sw.js cache version (the release lever)
tools/crosscheck.mjs     check-digit cross-check against python-stdnum
tools/make_sample_bill.py  generates the OCR test fixtures
tools/isolate.py         shows which validation layer rejected a GSTIN
tools/probe_repair_safety.mjs  checks that OCR repairs are decisive, not a guess
```

`.privacy-terms` (gitignored) holds the identifiers the audit forbids.

