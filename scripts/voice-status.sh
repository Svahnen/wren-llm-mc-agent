#!/usr/bin/env bash
# Authenticated voice /status summary; never prints the token.
cd "$(dirname "$0")/.." || exit 1
tok=$(sed -n 's/^VOICE_TOKEN=//p' voice/secrets.env)
curl -s -m 5 -H "x-voice-token: $tok" http://127.0.0.1:19521/status | python3 -I -c "import sys,json;d=json.load(sys.stdin);print('voice mod',d.get('connected_mod'),'bot',d.get('bot_online'))"
