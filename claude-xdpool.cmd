@echo off
setlocal
set "ANTHROPIC_BASE_URL=http://127.0.0.1:8327"
set "ANTHROPIC_AUTH_TOKEN=xdpool-local"
set "ANTHROPIC_MODEL=deepseek-v4.1-flash"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4.1-flash"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4.1-flash"
set "ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4.1-flash"
set "ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4.1-flash"
set "CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4.1-flash"
set "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
claude %*
