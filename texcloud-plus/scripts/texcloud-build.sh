#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 path/to/file.tex" >&2
  exit 1
fi

INPUT="$1"

abs_path() {
  python3 - "$1" <<'PY2'
import os, sys
print(os.path.abspath(sys.argv[1]))
PY2
}

resolve_path() {
  python3 - "$1" "$2" <<'PY2'
import os, sys
base = os.path.dirname(os.path.abspath(sys.argv[1]))
target = sys.argv[2]
if os.path.isabs(target):
    print(os.path.abspath(target))
else:
    print(os.path.abspath(os.path.join(base, target)))
PY2
}

get_magic() {
  python3 - "$1" "$2" <<'PY2'
import re, sys
file = sys.argv[1]
key = sys.argv[2]
pat = re.compile(r'^\s*%\s*!TeX\s+' + re.escape(key) + r'\s*=\s*(.+?)\s*$', re.I)
try:
    with open(file, encoding='utf-8', errors='ignore') as f:
        for line in f:
            m = pat.match(line)
            if m:
                print(m.group(1))
                raise SystemExit(0)
except FileNotFoundError:
    pass
raise SystemExit(1)
PY2
}

get_documentclass() {
  python3 - "$1" <<'PY2'
import re, sys
file = sys.argv[1]
pat = re.compile(r'\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}')
try:
    with open(file, encoding='utf-8', errors='ignore') as f:
        for line in f:
            m = pat.search(line)
            if m:
                print(m.group(1).strip())
                raise SystemExit(0)
except FileNotFoundError:
    pass
raise SystemExit(1)
PY2
}

contains_japanese() {
  python3 - "$1" <<'PY2'
import re, sys
pat = re.compile(r'[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]')
try:
    text = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
    raise SystemExit(0 if pat.search(text) else 1)
except FileNotFoundError:
    raise SystemExit(1)
PY2
}

INPUT="$(abs_path "$INPUT")"

if [ ! -f "$INPUT" ]; then
  echo "Input not found: $INPUT" >&2
  exit 1
fi

ROOT="$INPUT"
RAW_ROOT="$(get_magic "$INPUT" root || true)"
if [ -n "${RAW_ROOT:-}" ]; then
  ROOT="$(resolve_path "$INPUT" "$RAW_ROOT")"
fi

if [ ! -f "$ROOT" ]; then
  echo "Root file not found: $ROOT" >&2
  exit 1
fi

PROGRAM="$(get_magic "$ROOT" program || true)"
if [ -z "${PROGRAM:-}" ] && [ "$ROOT" != "$INPUT" ]; then
  PROGRAM="$(get_magic "$INPUT" program || true)"
fi
PROGRAM="$(printf '%s' "${PROGRAM:-}" | tr '[:upper:]' '[:lower:]')"

CLASS="$(get_documentclass "$ROOT" || true)"
CLASS="$(printf '%s' "${CLASS:-}" | tr '[:upper:]' '[:lower:]')"

JAPANESE="no"
if contains_japanese "$ROOT"; then
  JAPANESE="yes"
fi

ENGINE=""
if [ -n "$PROGRAM" ]; then
  case "$PROGRAM" in
    lualatex|luatex)
      ENGINE="lualatex"
      ;;
    uplatex)
      ENGINE="uplatex"
      ;;
    platex|ptex2pdf)
      ENGINE="uplatex"
      ;;
    pdflatex)
      ENGINE="pdflatex"
      ;;
  esac
fi

if [ -z "$ENGINE" ]; then
  case "$CLASS" in
    ltjsarticle|ltjsbook|ltjsreport)
      ENGINE="lualatex"
      ;;
    jarticle|jbook|jreport|jsarticle|jsbook|jsreport)
      ENGINE="uplatex"
      ;;
    article|book|report)
      if [ "$JAPANESE" = "yes" ]; then
        ENGINE="uplatex"
      else
        ENGINE="lualatex"
      fi
      ;;
    *)
      if [ "$JAPANESE" = "yes" ]; then
        ENGINE="uplatex"
      else
        ENGINE="lualatex"
      fi
      ;;
  esac
fi

ROOT_DIR="$(dirname "$ROOT")"
ROOT_FILE="$(basename "$ROOT")"
BASE="${ROOT_FILE%.tex}"

echo "INPUT  = $INPUT"
echo "ROOT   = $ROOT"
echo "CLASS  = ${CLASS:-unknown}"
echo "JP     = $JAPANESE"
echo "ENGINE = $ENGINE"

cd "$ROOT_DIR"

case "$ENGINE" in
  lualatex)
    exec latexmk -lualatex "$ROOT_FILE"
    ;;
  pdflatex)
    exec latexmk -pdf "$ROOT_FILE"
    ;;
  uplatex)
    uplatex -interaction=nonstopmode -file-line-error "$ROOT_FILE"
    uplatex -interaction=nonstopmode -file-line-error "$ROOT_FILE"
    if [ -f "${BASE}.dvi" ]; then
      dvipdfmx "${BASE}.dvi"
    fi
    exit 0
    ;;
  platex)
    platex -kanji=utf8 -interaction=nonstopmode -file-line-error "$ROOT_FILE" || true
    platex -kanji=utf8 -interaction=nonstopmode -file-line-error "$ROOT_FILE" || true
    if [ -f "${BASE}.dvi" ]; then
      dvipdfmx "${BASE}.dvi"
    fi
    exit 0
    ;;
  *)
    echo "Unknown engine: $ENGINE" >&2
    exit 1
    ;;
esac
