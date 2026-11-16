#!/usr/bin/env python3
"""A /usr/bin/time -v equivalent for hosts without GNU time: run one command,
then report wall time, child user+sys CPU, and peak child RSS (getrusage).

Usage: run-timed.py --out FILE -- CMD [ARGS...]
The four report lines are written to FILE (and echoed to stderr); the exit
code is the command's.
"""
import resource
import subprocess
import sys
import time

args = sys.argv[1:]
out = None
if args[:1] == ["--out"]:
    out = args[1]
    args = args[2:]
if args[:1] == ["--"]:
    args = args[1:]
t0 = time.monotonic()
proc = subprocess.run(args)
wall = time.monotonic() - t0
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
lines = [
    f"Elapsed (wall clock) time (h:mm:ss or m:ss): {int(wall // 60)}:{wall % 60:05.2f}",
    f"User time (seconds): {ru.ru_utime:.2f}",
    f"System time (seconds): {ru.ru_stime:.2f}",
    f"Maximum resident set size (kbytes): {ru.ru_maxrss}",
]
text = "\n".join(lines) + "\n"
if out:
    open(out, "w").write(text)
sys.stderr.write(text)
sys.exit(proc.returncode)
