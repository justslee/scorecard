#!/usr/bin/env python3
"""Run the STT A/B (specs/live-transcription-plan.md §7) — streams each
synthesized clip to BOTH engines' live WS APIs at real-time pacing (chunked
sends, 250 ms cadence) and scores WER + golf-term error rate + latency.

STATUS: UNRUN. This script is code + design only (§11 build sequence step
7) — it has never been executed. Neither OPENAI_API_KEY nor DEEPGRAM_API_KEY
exists on the dev Mac that wrote this; the prod keys live on the EC2 boxes
(i-0826ae70df62d9fe8 / i-0a7f675b219a2a93a, SSM-reachable). An automated SSM
send-command was BLOCKED by the permission classifier in a prior session, so
running this is a MANUAL step — an interactive SSM session (eng-lead) or the
owner running it locally where a key is available. See specs/stt-live-ab
-report.md for the explicit UNRUN status and the P2 probe.

Run (manual, on a box with both keys):

    cd backend
    uv run python bench/stt_ab/synthesize.py   # writes bench/stt_ab/audio/*.wav
    uv run python bench/stt_ab/run_ab.py \
        --utterances bench/stt_ab/utterances.json \
        --audio-dir bench/stt_ab/audio \
        --out bench/stt_ab/results.json

Cutover rule (specs/live-transcription-plan.md §7, restated here so this
script's own output is self-explanatory): golf-term error rate must be <=
Deepgram's AND first-partial latency within +150 ms, across ALL THREE noise
conditions (clean / pink10 / wind5), before LIVE_STT_ENGINE flips to
"openai". If this script has never been run, the answer is NO CUTOVER.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import time
import wave
from pathlib import Path
from typing import Optional

import numpy as np
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # backend/ on sys.path
from app.services.deepgram import grant_live_token  # noqa: E402
from app.services.realtime_relay import mint_transcription_session  # noqa: E402

from wer import golf_term_error_rate, word_error_rate  # noqa: E402

CHUNK_MS = 250
DEEPGRAM_SAMPLE_RATE = 16000
OPENAI_SAMPLE_RATE = 24000

DEEPGRAM_WS_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-3&smart_format=true&punctuate=true&interim_results=true"
    f"&utterance_end_ms=1200&language=en-US"
    f"&encoding=linear16&sample_rate={DEEPGRAM_SAMPLE_RATE}&channels=1"
)
OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?intent=transcription"


# ── Audio I/O + resample (mirrors frontend/src/lib/voice/pcm-capture.ts's
#    downsampleTo16k linear-interpolation approach, so bench pacing matches
#    what the real client actually sends) ──────────────────────────────────


def _read_wav_int16(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        sample_rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
        n_channels = wf.getnchannels()
    samples = np.frombuffer(raw, dtype=np.int16)
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1).astype(np.int16)
    return samples, sample_rate


def _resample(samples: np.ndarray, in_rate: int, out_rate: int) -> np.ndarray:
    if in_rate == out_rate:
        return samples
    ratio = in_rate / out_rate
    out_len = max(1, int(len(samples) / ratio))
    src_idx = np.arange(out_len) * ratio
    i0 = np.floor(src_idx).astype(np.int64).clip(0, len(samples) - 1)
    i1 = np.clip(i0 + 1, 0, len(samples) - 1)
    frac = src_idx - i0
    return ((1 - frac) * samples[i0] + frac * samples[i1]).astype(np.int16)


def _chunks(samples: np.ndarray, sample_rate: int, chunk_ms: int) -> list[bytes]:
    chunk_n = max(1, int(sample_rate * chunk_ms / 1000))
    out = []
    for start in range(0, len(samples), chunk_n):
        out.append(samples[start : start + chunk_n].tobytes())
    return out


# ── Engine drivers ───────────────────────────────────────────────────────


async def stream_deepgram(samples_16k: np.ndarray) -> dict:
    token = await grant_live_token()
    accumulated_finals = ""
    latest_interim = ""
    first_partial_ms: Optional[float] = None
    last_final_at: Optional[float] = None
    t0 = time.monotonic()

    async with websockets.connect(
        DEEPGRAM_WS_URL, subprotocols=["token", token["access_token"]]
    ) as ws:

        async def receiver():
            nonlocal accumulated_finals, latest_interim, first_partial_ms, last_final_at
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                alt = (
                    msg.get("channel", {}).get("alternatives", [{}])[0]
                    if "channel" in msg
                    else None
                )
                if alt is None:
                    continue
                transcript = alt.get("transcript") or ""
                if not transcript:
                    continue
                if first_partial_ms is None:
                    first_partial_ms = (time.monotonic() - t0) * 1000
                if msg.get("is_final"):
                    accumulated_finals = " ".join(filter(None, [accumulated_finals, transcript]))
                    latest_interim = ""
                    last_final_at = time.monotonic()
                else:
                    latest_interim = transcript

        recv_task = asyncio.create_task(receiver())
        for chunk in _chunks(samples_16k, DEEPGRAM_SAMPLE_RATE, CHUNK_MS):
            await ws.send(chunk)
            await asyncio.sleep(CHUNK_MS / 1000)
        last_audio_at = time.monotonic()
        await ws.send(json.dumps({"type": "CloseStream"}))
        await asyncio.sleep(2.0)  # grace for the trailing final to land
        recv_task.cancel()

    settle_ms = (last_final_at - last_audio_at) * 1000 if last_final_at else None
    return {
        "transcript": accumulated_finals or latest_interim,
        "first_partial_ms": first_partial_ms,
        "settle_ms": settle_ms,
    }


async def stream_openai(samples_24k: np.ndarray, keyterms: list[str]) -> dict:
    mint = await mint_transcription_session(keyterms)
    token = mint.get("value")
    if not token:
        obj = mint.get("client_secret")
        token = obj.get("value") if isinstance(obj, dict) else None
    if not token:
        raise RuntimeError(f"OpenAI mint returned no client_secret: {mint}")

    accumulated_finals = ""
    current_delta = ""
    first_partial_ms: Optional[float] = None
    last_final_at: Optional[float] = None
    t0 = time.monotonic()

    async with websockets.connect(
        OPENAI_WS_URL, subprotocols=["realtime", f"openai-insecure-api-key.{token}"]
    ) as ws:

        async def receiver():
            nonlocal accumulated_finals, current_delta, first_partial_ms, last_final_at
            async for raw in ws:
                try:
                    evt = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                etype = evt.get("type")
                if etype == "conversation.item.input_audio_transcription.delta":
                    current_delta += evt.get("delta") or ""
                    if first_partial_ms is None:
                        first_partial_ms = (time.monotonic() - t0) * 1000
                elif etype == "conversation.item.input_audio_transcription.completed":
                    transcript = evt.get("transcript") or ""
                    if transcript:
                        accumulated_finals = " ".join(filter(None, [accumulated_finals, transcript]))
                    current_delta = ""
                    last_final_at = time.monotonic()

        recv_task = asyncio.create_task(receiver())
        for chunk in _chunks(samples_24k, OPENAI_SAMPLE_RATE, CHUNK_MS):
            b64 = base64.b64encode(chunk).decode("ascii")
            await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": b64}))
            await asyncio.sleep(CHUNK_MS / 1000)
        last_audio_at = time.monotonic()
        await asyncio.sleep(2.0)  # grace for the trailing completed event to land
        recv_task.cancel()

    settle_ms = (last_final_at - last_audio_at) * 1000 if last_final_at else None
    return {
        "transcript": accumulated_finals or current_delta,
        "first_partial_ms": first_partial_ms,
        "settle_ms": settle_ms,
    }


# ── Orchestration ────────────────────────────────────────────────────────


async def run(utterances_path: Path, audio_dir: Path, out_path: Path) -> None:
    data = json.loads(utterances_path.read_text())
    results = []

    for utt in data["utterances"]:
        uid = utt["id"]
        reference = utt["text"]
        scored_terms = utt.get("scored_terms", [])

        for condition in ["clean", "pink10", "wind5"]:
            wav_path = audio_dir / f"{uid}.{condition}.wav"
            if not wav_path.exists():
                print(f"[{uid}/{condition}] SKIP — {wav_path} not found (run synthesize.py first)")
                continue

            samples, sample_rate = _read_wav_int16(wav_path)
            samples_16k = _resample(samples, sample_rate, DEEPGRAM_SAMPLE_RATE)
            samples_24k = _resample(samples, sample_rate, OPENAI_SAMPLE_RATE)

            print(f"[{uid}/{condition}] streaming to Deepgram...")
            dg = await stream_deepgram(samples_16k)
            print(f"[{uid}/{condition}] streaming to OpenAI...")
            oa = await stream_openai(samples_24k, keyterms=scored_terms)

            row = {
                "id": uid,
                "condition": condition,
                "reference": reference,
                "deepgram": {
                    **dg,
                    "wer": word_error_rate(reference, dg["transcript"]),
                    "golf_term_error_rate": golf_term_error_rate(
                        reference, dg["transcript"], scored_terms
                    ),
                },
                "openai": {
                    **oa,
                    "wer": word_error_rate(reference, oa["transcript"]),
                    "golf_term_error_rate": golf_term_error_rate(
                        reference, oa["transcript"], scored_terms
                    ),
                },
            }
            results.append(row)
            print(json.dumps(row, indent=2))

    out_path.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {len(results)} rows to {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--utterances", type=Path, default=Path(__file__).parent / "utterances.json")
    parser.add_argument("--audio-dir", type=Path, default=Path(__file__).parent / "audio")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "results.json")
    args = parser.parse_args()
    asyncio.run(run(args.utterances, args.audio_dir, args.out))


if __name__ == "__main__":
    main()
