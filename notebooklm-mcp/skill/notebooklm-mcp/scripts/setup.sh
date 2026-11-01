#!/usr/bin/env bash
# Installs the nblm-mcp NotebookLM server and registers it with Claude Code.
#
# Usage: bash setup.sh [--ref <git branch or tag>] [--scope user|project|local]
set -euo pipefail

REF="main"
SCOPE="user"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

PYTHON="${PYTHON:-python3}"
if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  echo "Python 3.10 or newer is required (set PYTHON=/path/to/python)." >&2
  exit 1
fi

PKG="nblm-mcp[login] @ git+https://github.com/C-Kajanan/C-Kajanan.git@${REF}#subdirectory=notebooklm-mcp"

if command -v nblm-mcp >/dev/null 2>&1; then
  echo "nblm-mcp is already installed: $(command -v nblm-mcp)"
elif command -v uv >/dev/null 2>&1; then
  echo "Installing nblm-mcp with uv ($REF)..."
  uv tool install "$PKG"
elif command -v pipx >/dev/null 2>&1; then
  echo "Installing nblm-mcp with pipx ($REF)..."
  pipx install "$PKG"
else
  echo "Installing nblm-mcp with pip --user ($REF)..."
  "$PYTHON" -m pip install --user "$PKG"
fi

SERVER="$(command -v nblm-mcp || true)"
if [[ -z "$SERVER" ]]; then
  for dir in "$HOME/.local/bin" "$("$PYTHON" -c 'import site, os; print(os.path.join(site.USER_BASE, "bin"))')"; do
    if [[ -x "$dir/nblm-mcp" ]]; then SERVER="$dir/nblm-mcp"; break; fi
  done
fi
if [[ -z "$SERVER" ]]; then
  echo "Installed, but nblm-mcp is not on PATH. Add ~/.local/bin to PATH and re-run." >&2
  exit 1
fi

# The Python that runs the server; notebooklm and playwright live in the same environment.
SERVER_PY="$(head -n1 "$SERVER" | sed -e 's/^#!//' -e 's/[[:space:]].*$//')"
[[ -x "$SERVER_PY" ]] || SERVER_PY="$PYTHON"

echo "Installing Chromium for the NotebookLM sign-in..."
"$SERVER_PY" -m playwright install chromium || echo "Chromium install failed; 'notebooklm login' may not open a browser."

if command -v claude >/dev/null 2>&1; then
  if claude mcp get notebooklm >/dev/null 2>&1; then
    echo "Claude Code already has an MCP server named 'notebooklm'."
  else
    claude mcp add --scope "$SCOPE" notebooklm -- "$SERVER"
    echo "Registered 'notebooklm' with Claude Code ($SCOPE scope)."
  fi
else
  echo "Claude Code CLI not found. Add this to your MCP client config:"
  echo "  { \"mcpServers\": { \"notebooklm\": { \"command\": \"$SERVER\" } } }"
fi

LOGIN_CMD="$SERVER_PY -m notebooklm login"
if "$SERVER_PY" -m notebooklm auth check --test >/dev/null 2>&1; then
  echo "NotebookLM sign-in is valid."
else
  echo
  echo "Next step: sign in to NotebookLM once (opens a browser):"
  echo "  $LOGIN_CMD"
fi
echo "Restart Claude Code so it loads the notebooklm tools."
