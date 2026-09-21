"""Independent ground truth for GSTIN check digits, via python-stdnum.

Usage:  uv run --with python-stdnum verify_gstin.py <gstin> [<gstin> ...]
Prints one JSON line per input so a JS test can diff against it.
"""
import json
import sys

from stdnum.in_ import gstin as G

CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def luhn36(first14: str) -> str:
    """Re-implemented straight from the GSTN Java reference (independent of stdnum)."""
    total = 0
    for i, ch in enumerate(reversed(first14)):
        code = CHARSET.index(ch)
        factor = 1 if i % 2 == 0 else 2
        addend = factor * code
        addend = (addend // 36) + (addend % 36)
        total += addend
    return CHARSET[(36 - (total % 36)) % 36]


def main(argv):
    for raw in argv:
        s = raw.strip().upper()
        rec = {"input": s}
        try:
            G.validate(s)
            rec["stdnum_valid"] = True
            rec["stdnum_error"] = None
        except Exception as exc:  # noqa: BLE001
            rec["stdnum_valid"] = False
            rec["stdnum_error"] = type(exc).__name__
        if len(s) == 15:
            rec["stdlib_check"] = luhn36(s[:14])
            rec["stdlib_matches"] = rec["stdlib_check"] == s[14]
            try:
                rec["stdnum_info"] = G.info(s)
            except Exception:  # noqa: BLE001
                rec["stdnum_info"] = None
        print(json.dumps(rec))


if __name__ == "__main__":
    main(sys.argv[1:])
