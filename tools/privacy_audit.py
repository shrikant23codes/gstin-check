"""Pre-commit privacy and secret audit.

Scans the working tree for anything that should not be published: personal
identifiers, absolute home paths, IP addresses, credentials, session cookies and
API keys.

The forbidden terms are passed in (or read from a gitignored file) rather than
hard-coded — a scanner that names the person it is protecting would itself be the
leak.

    python3 tools/privacy_audit.py --forbid alice --forbid example.com
    python3 tools/privacy_audit.py --forbid-file .privacy-terms   # gitignored

Exits 1 if anything at or above --fail-on (default: high) is found.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
              ".ttf", ".otf", ".zip", ".gz", ".pdf", ".wasm", ".mp4", ".mp3"}
TEXT_EXT = {".html", ".js", ".mjs", ".cjs", ".css", ".json", ".webmanifest", ".md",
            ".txt", ".py", ".go", ".yml", ".yaml", ".toml", ".sh", ".xml", ".svg",
            ".gitignore", ".gitattributes", ".headers", ""}

# Generic, always-on rules. Each is (name, severity, compiled regex).
# `severity`: high = blocks a commit, medium = review, low = informational.
GENERIC_RULES = [
    ("email address", "high",
     re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("absolute home path", "high",
     re.compile(r"/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|C:\\Users\\[A-Za-z0-9._-]+")),
    ("private IPv4 literal", "medium",
     re.compile(r"\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b")),
    ("public IPv4 literal", "medium",
     re.compile(r"\b(?!(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01])|0\.0\.0\.0|255\.)"
                r")\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")),
    ("known API-key shape", "high",
     re.compile(r"\b(?:nvapi-|sk-|sk_live_|sk_test_|ghp_|gho_|github_pat_|xox[baprs]-|"
                r"AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-)[A-Za-z0-9_-]{6,}")),
    ("authorization header", "high",
     re.compile(r"(?i)\b(?:authorization|bearer)\s*[:=]\s*\S{8,}")),
    ("credential assignment", "high",
     re.compile(r"(?i)\b(?:api[_-]?key|apikey|secret|password|passwd|passphrase|"
                r"client[_-]?secret|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*"
                r"[\"']?[A-Za-z0-9_\-/+.]{12,}")),
    ("session/anti-bot cookie", "high",
     re.compile(r"(?i)\b(?:ak_bmsc|_abck|bm_sz|CaptchaCookie|TS[0-9a-f]{6,})\s*=")),
    ("browser cookie jar", "medium",
     re.compile(r"(?i)-b\s+['\"][^'\"]*=[0-9a-f]{16,}")),
    ("X/Twitter handle", "medium",
     re.compile(r"(?<![\w./])@[A-Za-z0-9_]{4,15}\b")),
    ("Indian mobile number", "medium",
     re.compile(r"(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)")),
    ("long hex blob", "medium",
     re.compile(r"\b[0-9a-fA-F]{40,}\b")),
    ("base64-ish blob", "medium",
     re.compile(r"\b[A-Za-z0-9+/]{64,}={0,2}\b")),
]

ALLOWLIST = re.compile(
    r"PKG_CHECK|sha256|integrity=|example\.com|example\.org|@media|@supports|@font|@keyframes|"
    r"@import|@charset|@layer|@namespace|return\s*@|@@|@\w+\s*\{|npmjs\.com|jsdelivr|googleapis|gstatic|"
    r"gst\.gov\.in|gstsystem\.in|cleartax\.in|consumerhelpline\.gov\.in|projectnaptha|"
    r"0\.0\.0\.0|127\.0\.0\.1|localhost|1\.1\.1\.1|8\.8\.8\.8|version/|VERSION|"
    r"user@host|you@example|@type|@param|@returns|@example|@ts-|@babel|@napi|"
    # GitHub noreply addresses are reserved and non-identifying by design,
    # so the neutral identity recommended in the README must not trip this.
    r"noreply\.github\.com"
)

# Values that look like a rule hit but are documentation placeholders.
PLACEHOLDER = re.compile(
    r"(?i)your[-_]?key|your[-_]?api|placeholder|redacted|dummy|fake|test[-_]?key|"
    r"<key>|\{key\}|xxx+|\.\.\.|TODO|changeme|sample"
)


def severity_rank(name: str) -> int:
    return {"high": 3, "medium": 2, "low": 1}[name]


def redact(text: str, keep: int = 6) -> str:
    """Show enough to locate the match, never enough to reuse it."""
    text = text.strip()
    if len(text) <= keep * 2:
        return text[:keep] + "…" if len(text) > keep else text
    return text[:keep] + "…" + text[-2:]


def iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            yield Path(dirpath) / name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--forbid", action="append", default=[],
                    help="case-insensitive term that must not appear (repeatable)")
    ap.add_argument("--forbid-file", default=None,
                    help="file of forbidden terms, one per line (keep it gitignored)")
    ap.add_argument("--fail-on", choices=["high", "medium", "low", "never"], default="high")
    ap.add_argument("--show-terms", action="store_true",
                    help="print the forbidden terms being searched for")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    terms = list(args.forbid)
    if args.forbid_file:
        p = root / args.forbid_file
        if p.exists():
            terms += [ln.strip() for ln in p.read_text().splitlines()
                      if ln.strip() and not ln.startswith("#")]
    terms = [t for t in terms if t]

    if args.show_terms:
        print("forbidden terms:", ", ".join(terms) or "(none)")
    print(f"auditing {root}")
    print(f"forbidden terms: {len(terms)} | fail-on: {args.fail_on}\n")

    term_rules = [(f"forbidden term {t!r}", "high", re.compile(re.escape(t), re.I)) for t in terms]
    rules = GENERIC_RULES + term_rules

    # Never scan the term file itself: it is gitignored, so it cannot be
    # committed, and reading it would report its own contents as findings.
    skip = set()
    if args.forbid_file:
        skip.add((root / args.forbid_file).resolve())

    findings: list[tuple[int, str, int, str, str]] = []
    scanned = binary = 0

    for path in sorted(iter_files(root)):
        if path.resolve() in skip:
            continue
        rel = path.relative_to(root)
        ext = path.suffix.lower()
        if ext in BINARY_EXT:
            binary += 1
            continue
        if ext not in TEXT_EXT:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="strict")
        except (UnicodeDecodeError, OSError):
            binary += 1
            continue
        scanned += 1
        for lineno, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            for name, sev, rx in rules:
                for m in rx.finditer(line):
                    raw = m.group(0)
                    if ALLOWLIST.search(raw) or PLACEHOLDER.search(raw):
                        continue
                    # An email on the reserved example domains is documentation.
                    if name == "email address" and re.search(
                            r"(?i)@(?:example\.(?:com|org|net)|localhost)$", raw):
                        continue
                    findings.append((severity_rank(sev), sev, lineno, name,
                                     f"{rel}:{lineno}  [{name}]  {redact(raw)}"))

    findings.sort(key=lambda f: (-f[0], f[4]))
    by_sev = {"high": 0, "medium": 0, "low": 0}
    for _, sev, _, _, _ in findings:
        by_sev[sev] += 1

    for _, sev, _, _, line in findings:
        print(f"{sev.upper():<6} {line}")

    print(f"\nscanned {scanned} text files, skipped {binary} binary/unreadable")
    print(f"findings: {by_sev['high']} high, {by_sev['medium']} medium, {by_sev['low']} low")

    if not findings:
        print("\nclean")
        return 0

    threshold = {"high": 3, "medium": 2, "low": 1, "never": 99}[args.fail_on]
    blocking = [f for f in findings if f[0] >= threshold]
    if blocking:
        print(f"\nBLOCKING: {len(blocking)} finding(s) at or above '{args.fail_on}'")
        return 1
    print(f"\nno findings at or above '{args.fail_on}' — review the rest, then commit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
