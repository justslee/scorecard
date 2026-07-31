#!/usr/bin/env python3
"""Synthesize the bench's audio fixtures (specs/live-transcription-plan.md §7).

For each utterance in utterances.json: synthesize CLEAN audio via the
existing server-side TTS (app/services/openai_tts.py, gpt-4o-mini-tts,
requesting response_format="wav"), then write two augmented copies —
+pink-noise at SNR 10 dB and +wind-like low-frequency noise at SNR 5 dB.
numpy is the ONE new dependency this bench introduces (see pyproject.toml
dev group); everything else is the stdlib `wave` module (no mp3 decoder
needed — the wav response_format param on synthesize_speech exists for
exactly this).

Run (manual step — requires OPENAI_API_KEY on the box that runs it, e.g. the
EC2 instances; NOT run on this dev machine, which has no key):

    cd backend && uv run python bench/stt_ab/synthesize.py \
        --utterances bench/stt_ab/utterances.json \
        --out-dir bench/stt_ab/audio

Writes, per utterance id <id>: <id>.clean.wav, <id>.pink10.wav, <id>.wind5.wav.

HONEST LIMITATION (stated in the plan and repeated in README.md): clean TTS
+ synthetic noise does NOT represent outdoor wind, distance-to-mic, or
Lombard speech — exactly the conditions where WER matters most on a golf
course. This synthesizes a credible vocabulary/latency signal, not a
real-world acoustic one.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import sys
import wave
from pathlib import Path
from typing import Optional

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # backend/ on sys.path
from app.services.openai_tts import synthesize_speech  # noqa: E402


def _read_wav_int16(wav_bytes: bytes) -> tuple[np.ndarray, int]:
    """Return (mono int16 samples, sample_rate) from WAV bytes."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        n_channels = wf.getnchannels()
        raw = wf.readframes(n_frames)
    samples = np.frombuffer(raw, dtype=np.int16)
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1).astype(np.int16)
    return samples, sample_rate


def _write_wav_int16(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # int16
        wf.setframerate(sample_rate)
        wf.writeframes(samples.astype(np.int16).tobytes())


def _pink_noise(n_samples: int, rng: np.random.Generator) -> np.ndarray:
    """Pink (1/f) noise via FFT shaping of white noise — good enough for a
    bench fixture, not a DSP-grade generator."""
    white = rng.standard_normal(n_samples)
    spectrum = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n_samples)
    freqs[0] = freqs[1] if len(freqs) > 1 else 1.0  # avoid div-by-zero at DC
    shaped = spectrum / np.sqrt(freqs)
    pink = np.fft.irfft(shaped, n=n_samples)
    return pink / (np.max(np.abs(pink)) + 1e-9)


def _wind_noise(n_samples: int, sample_rate: int, rng: np.random.Generator) -> np.ndarray:
    """Crude wind-like proxy: white noise low-pass shaped to emphasize
    energy under ~500 Hz (real wind noise is broadband-low-frequency with
    gusty amplitude modulation — this is a bench proxy, not a physical
    model; see the module docstring's honesty note)."""
    white = rng.standard_normal(n_samples)
    spectrum = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n_samples, d=1.0 / sample_rate)
    cutoff_hz = 500.0
    # Smooth low-pass rolloff (not a brick wall) via a simple 2-pole shape.
    gain = 1.0 / (1.0 + (freqs / cutoff_hz) ** 2)
    shaped = spectrum * gain
    wind = np.fft.irfft(shaped, n=n_samples)
    # Gusty amplitude modulation (~0.3 Hz) — wind isn't constant-level.
    t = np.arange(n_samples) / sample_rate
    gust = 0.6 + 0.4 * np.sin(2 * np.pi * 0.3 * t + rng.uniform(0, 2 * np.pi))
    wind = wind * gust
    return wind / (np.max(np.abs(wind)) + 1e-9)


def _mix_at_snr(clean: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    """Scale `noise` (already unit-peak-normalized) so the mix hits the
    target SNR (dB, RMS-based) against `clean`, add, and clip to int16."""
    clean_f = clean.astype(np.float64)
    noise_f = noise.astype(np.float64)
    clean_rms = np.sqrt(np.mean(clean_f**2)) + 1e-9
    noise_rms = np.sqrt(np.mean(noise_f**2)) + 1e-9
    target_noise_rms = clean_rms / (10 ** (snr_db / 20.0))
    scaled_noise = noise_f * (target_noise_rms / noise_rms)
    mixed = clean_f + scaled_noise
    return np.clip(mixed, -32768, 32767).astype(np.int16)


async def synthesize_utterance(
    text: str, voice_id: Optional[str] = None
) -> tuple[np.ndarray, int]:
    """Synthesize `text` and return (int16 mono samples, sample_rate)."""
    wav_bytes = await synthesize_speech(text, voice_id, response_format="wav")
    return _read_wav_int16(wav_bytes)


async def synthesize_all(utterances_path: Path, out_dir: Path, voice_id: Optional[str]) -> None:
    data = json.loads(utterances_path.read_text())
    rng = np.random.default_rng(seed=42)  # reproducible noise across runs

    for utt in data["utterances"]:
        uid = utt["id"]
        text = utt["text"]
        print(f"[{uid}] synthesizing: {text!r}")
        clean, sample_rate = await synthesize_utterance(text, voice_id)
        _write_wav_int16(out_dir / f"{uid}.clean.wav", clean, sample_rate)

        pink = _pink_noise(len(clean), rng)
        _write_wav_int16(out_dir / f"{uid}.pink10.wav", _mix_at_snr(clean, pink, 10.0), sample_rate)

        wind = _wind_noise(len(clean), sample_rate, rng)
        _write_wav_int16(out_dir / f"{uid}.wind5.wav", _mix_at_snr(clean, wind, 5.0), sample_rate)

    print(f"Done — wrote {3 * len(data['utterances'])} files to {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--utterances", type=Path, default=Path(__file__).parent / "utterances.json")
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).parent / "audio")
    parser.add_argument("--voice", type=str, default=None, help="OpenAI TTS voice id (default: sage)")
    args = parser.parse_args()
    asyncio.run(synthesize_all(args.utterances, args.out_dir, args.voice))


if __name__ == "__main__":
    main()
