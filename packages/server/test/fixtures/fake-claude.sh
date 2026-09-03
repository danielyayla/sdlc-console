#!/usr/bin/env sh
# Fake Claude Code: echoes a stream-json init line, records its arguments, then a result line.
# FAKE_CLAUDE_FAIL=1 makes it report an error result and exit 1.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"11111111-2222-3333-4444-555555555555","model":"fake-model","tools":[]}'
printf '%s\n' "$*" > "${FAKE_CLAUDE_ARGS:-/dev/null}"
printf '%s\n' "git-author=${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>" >> "${FAKE_CLAUDE_ARGS:-/dev/null}"
if [ -n "$FAKE_CLAUDE_FAIL" ]; then
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"boom","session_id":"11111111-2222-3333-4444-555555555555"}'
  exit 1
fi
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.12,"num_turns":3,"session_id":"11111111-2222-3333-4444-555555555555"}'
exit 0
