/**
 * One-shot speech-to-text via the backend's Deepgram bridge.
 *
 * Used for voice round setup + score entry — the user holds a button, speaks,
 * releases. We record with MediaRecorder, POST the blob to /api/voice/transcribe,
 * and return the transcript. The conversational caddie uses OpenAI Realtime
 * (lib/voice/realtime.ts) — different surface, different vendor.
 */

export interface TranscribeResult {
  transcript: string;
  confidence: number;
  duration: number;
  model: string;
}

/** Pick a recorder mime type the browser actually supports. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType: string | undefined;

  /** True when MediaRecorder is available in this browser. */
  static isSupported(): boolean {
    return typeof window !== 'undefined'
      && typeof MediaRecorder !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<void> {
    if (this.recorder) return;
    this.mimeType = pickMimeType();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.recorder = new MediaRecorder(
      this.stream,
      this.mimeType ? { mimeType: this.mimeType } : undefined,
    );
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  /** Stop recording and return the accumulated blob. */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('Recorder not started'));
        return;
      }
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
        this.cleanup();
        resolve(blob);
      };
      this.recorder.onerror = (ev) => {
        this.cleanup();
        reject(new Error(`MediaRecorder error: ${(ev as Event).type}`));
      };
      this.recorder.stop();
    });
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch {}
    }
    this.cleanup();
  }

  private cleanup() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

/** POST a recorded audio blob to the backend transcribe endpoint. */
export async function transcribeBlob(blob: Blob): Promise<TranscribeResult> {
  const form = new FormData();
  const ext = blob.type.includes('mp4') ? 'mp4'
    : blob.type.includes('ogg') ? 'ogg'
    : 'webm';
  form.append('audio', blob, `clip.${ext}`);
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Transcribe failed (${res.status}): ${text}`);
  }
  return res.json();
}
