"""Isolate whether a GSTIN disagreement is about the check digit or the PAN sub-format."""
import sys

from stdnum import luhn
from stdnum.in_ import pan
from stdnum.in_ import gstin as G

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

for s in sys.argv[1:]:
    print("===", s)
    print("  luhn mod36 over full 15 == 0 ?", luhn.checksum(s, alphabet=ALPHABET) == 0)
    print("  gstin regex match          ?", bool(G._GSTIN_RE.match(s)))
    head_ok = luhn.checksum(s[:14] + "0", alphabet=ALPHABET)
    print("  expected check digit       :", ALPHABET[(-head_ok) % 36], " (actual", s[14], ")")
    try:
        pan.validate(s[2:12])
        print("  pan.validate               : ok")
    except Exception as exc:  # noqa: BLE001
        print("  pan.validate               :", type(exc).__name__, exc.args)
