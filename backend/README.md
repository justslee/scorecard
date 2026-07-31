# Looper backend

FastAPI backend for Looper. See the repo root `CLAUDE.md` for commands
(`uv sync`, `python -m uvicorn app.main:app --reload`, `ruff check .`).

## Environment variables

`.env.example` documents the full set this backend reads. The variables
below were added by specs/live-transcription-plan.md (the live-STT dictation
engine flag) and are called out here because the guard hook that blocks
edits to `**/.env*` also catches `.env.example` — see that file's own
comments for everything else already documented there.

| Variable | Default | Purpose |
|---|---|---|
| `LIVE_STT_ENGINE` | `deepgram` | Which vendor `POST /api/voice/live-session` mints for the browser's dictation surfaces (score entry, search, classic caddie sheet). `deepgram` (default) is byte-equivalent to the pre-existing `/live-token` path. `openai` mints an OpenAI `gpt-live-transcribe` transcription session instead — the frontend genuinely falls back to Deepgram on ANY failure (mint, WS handshake, first-frame error), so flipping this flag never breaks dictation, only changes which vendor serves it when healthy. Read fresh per-request (not cached at import time), so flipping it needs no redeploy — only a restart of the running process (env vars are read via `os.getenv` at call time in `app/routes/voice.py`, but the process itself doesn't re-read the shell environment without a restart). |
| `LIVE_STT_OPENAI_MODEL` | `gpt-live-transcribe` | The transcription model minted for the `type:"transcription"` session when `LIVE_STT_ENGINE=openai`. Separate from `OPENAI_REALTIME_TRANSCRIBE_MODEL` below — see the code comment at `app/services/realtime_relay.py` for why these are structurally different mints, not interchangeable. |
| `OPENAI_REALTIME_TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | The transcription model used INSIDE the conversational caddie's `type:"realtime"` WebRTC session (in-round live caddie, round setup). Confirmed accepted values: `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`. |
| `OPENAI_REALTIME_VAD` | `server_vad` | Voice-activity-detection mode for the conversational realtime session — `server_vad` (energy-threshold) or `semantic_vad` (language-model classifier). |

Existing/unchanged, for context: `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`,
`OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_DEFAULT_VOICE` — see
`app/services/realtime_relay.py` and `app/services/deepgram.py`.
