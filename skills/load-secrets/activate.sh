#!/usr/bin/env bash
# activate.sh — load every secret VibeStudio manages into the agent's
# environment. Agent-agnostic and sandbox-tolerant: it never hard-fails just
# because it can't write to your shell startup files (some agents, e.g. Codex,
# run each command in a fresh shell with a read-only HOME).
#
# Most portable (works even in a read-only, fresh-shell sandbox) — source the
# env file in the SAME command that needs the secrets:
#   . "$HOME/.config/vibestudio/env" && your-command
#
# For a persistent shell, load them into the current shell via eval:
#   eval "$(bash /path/to/load-secrets/activate.sh --print)"
#
#   (no flag)   try to wire future shells to load the secrets; print a summary.
#   --print     also emit `export KEY=VALUE` on stdout for eval to consume.
#
# Secret values reach stdout only with --print (eval consumes them, so they
# never hit the transcript). Only key names are printed, to stderr.

# NOT -e: patching startup files is best-effort and must never abort the script
# before it has printed the exports the caller actually depends on.
set -uo pipefail

ENV_FILE="${VIBESTUDIO_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/vibestudio/env}"
MARKER='# vibestudio (managed — loads your VibeStudio secrets)'

if [ ! -s "$ENV_FILE" ]; then
  echo "vibestudio: no secrets configured yet ($ENV_FILE is missing or empty)." >&2
  echo "Add them in VibeStudio, then run this again." >&2
  exit 0
fi

# 1. ESSENTIAL FIRST: emit the exports for the current shell, so `eval` always
#    receives the credentials even if the best-effort steps below can't run.
[ "${1:-}" = "--print" ] && cat "$ENV_FILE"

# 2. BEST-EFFORT: make future shells source the env file. Skip any target we
#    can't write (read-only HOME in a sandbox); never let a failure abort.
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zshenv" "$HOME/.profile"; do
  grep -qF "$MARKER" "$rc" 2>/dev/null && continue
  [ -w "$rc" ] 2>/dev/null || [ -w "$(dirname "$rc")" ] 2>/dev/null || continue
  tmp="$(mktemp 2>/dev/null)" || continue
  if {
       printf '%s\n' "$MARKER"
       printf '[ -f "%s" ] && . "%s"\n' "$ENV_FILE" "$ENV_FILE"
       printf '# end vibestudio\n\n'
       cat "$rc" 2>/dev/null || true
     } >"$tmp" 2>/dev/null && mv "$tmp" "$rc" 2>/dev/null; then
    :
  else
    rm -f "$tmp" 2>/dev/null
  fi
done

# 3. Summary — key names only, plus where to source them directly.
names="$(sed -n 's/^[[:space:]]*export[[:space:]]\{1,\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$ENV_FILE" | paste -sd' ' - 2>/dev/null)"
echo "vibestudio: ready — ${names:-no secrets found}  (source directly: . '$ENV_FILE')" >&2
exit 0
