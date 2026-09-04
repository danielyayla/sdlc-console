#!/usr/bin/env sh
# Fake Claude Code: echoes a stream-json init line, records its arguments, then a result line.
# FAKE_CLAUDE_FAIL=1 makes it report an error result and exit 1.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"11111111-2222-3333-4444-555555555555","model":"fake-model","tools":[]}'
# FAKE_CLAUDE_SLEEP=<s> keeps the harness alive (a downgrade or stop ends it).
if [ -n "$FAKE_CLAUDE_SLEEP" ]; then sleep "$FAKE_CLAUDE_SLEEP"; fi
printf '%s\n' "$*" > "${FAKE_CLAUDE_ARGS:-/dev/null}"
printf '%s\n' "git-author=${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>" >> "${FAKE_CLAUDE_ARGS:-/dev/null}"
if [ -n "$FAKE_CLAUDE_FAIL" ]; then
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"boom","session_id":"11111111-2222-3333-4444-555555555555"}'
  exit 1
fi
# FAKE_CLAUDE_SKILL=<name> makes it load that skill (a Skill tool_use line), as a trigger test expects.
if [ -n "$FAKE_CLAUDE_SKILL" ]; then
  printf '%s\n' "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01\",\"name\":\"Skill\",\"input\":{\"skill\":\"$FAKE_CLAUDE_SKILL\"}}]}}"
fi
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.12,"num_turns":3,"session_id":"11111111-2222-3333-4444-555555555555"}'
exit 0
