'use client';

/**
 * CameraCapture — yardage-book-styled image capture overlay.
 *
 * Restyled from the original dark (zinc/lucide) version to the yardage-book
 * aesthetic: T.* tokens, PAPER_NOISE background, inline SVGs. No lucide-react.
 * Used by ScanSheet to acquire a scorecard image before OCR.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import Image from 'next/image';
import { AnimatePresence, motion } from 'framer-motion';
import { T, PAPER_NOISE } from '@/components/yardage/tokens';

// ---------------------------------------------------------------------------
// Inline icon helpers — no lucide-react
// ---------------------------------------------------------------------------

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 6a2 2 0 0 1 2-2h1.2l1.3-2h6l1.3 2H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V6Z" />
      <circle cx="9" cy="10" r="2.8" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2" />
      <polyline points="12 6 9 3 6 6" />
      <line x1="9" y1="3" x2="9" y2="12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M1.5 1.5l10 10M11.5 1.5l-10 10" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CameraCaptureProps {
  onCapture: (imageBase64: string) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'select' | 'camera' | 'preview'>('select');
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Stop camera tracks on unmount so the browser camera indicator clears.
  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [stream]);

  const startCamera = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play();
      }
      setStream(mediaStream);
      setMode('camera');
      setError(null);
    } catch (err) {
      console.error('Camera error:', err);
      setError('Could not access camera. Please use file upload instead.');
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
  }, [stream]);

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const imageData = canvas.toDataURL('image/jpeg', 0.8);
    setPreviewImage(imageData);
    setMode('preview');
    stopCamera();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setPreviewImage(result);
      setMode('preview');
    };
    reader.readAsDataURL(file);
  };

  const confirmCapture = () => {
    if (previewImage) onCapture(previewImage);
  };

  const retake = () => {
    setPreviewImage(null);
    setMode('select');
  };

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: 'multiply',
        fontFamily: T.sans,
        color: T.ink,
      }}
    >
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          padding: '14px 18px 12px',
          paddingTop: 'max(14px, env(safe-area-inset-top))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${T.hairline}`,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.5,
              color: T.pencil,
              textTransform: 'uppercase',
              marginBottom: 2,
            }}
          >
            Scorecard scan
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: 'italic',
              fontSize: 20,
              color: T.ink,
              letterSpacing: -0.3,
              lineHeight: 1.1,
            }}
          >
            Capture the card
          </div>
        </div>

        {/* Close — 44×44 */}
        <button
          onClick={handleClose}
          aria-label="Close"
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: 99,
            border: `1px solid ${T.hairline}`,
            background: 'transparent',
            color: T.pencil,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <CloseIcon />
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px 18px',
          overflowY: 'auto',
        }}
      >
        {/* Error banner */}
        <AnimatePresence>
          {error && (
            <motion.div
              key="cam-error"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.16 }}
              style={{
                padding: '9px 12px',
                borderRadius: 12,
                background: T.errorWash,
                border: `1px solid ${T.errorInk}33`,
                fontFamily: T.serif,
                fontStyle: 'italic',
                fontSize: 14,
                color: T.errorInk,
                marginBottom: 16,
                maxWidth: 380,
                width: '100%',
              }}
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Select mode */}
        {mode === 'select' && (
          <div
            style={{
              width: '100%',
              maxWidth: 380,
              padding: '18px',
              borderRadius: 18,
              border: `1px solid ${T.hairline}`,
              background: T.paperDeep,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: 'italic',
                fontSize: 15,
                color: T.inkSoft,
                lineHeight: 1.5,
              }}
            >
              Take a photo of the scorecard with good lighting. Keep the card flat.
            </div>

            {/* Take Photo */}
            <button
              onClick={startCamera}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '13px 20px',
                borderRadius: 99,
                border: 'none',
                background: T.ink,
                color: T.paper,
                fontFamily: T.serif,
                fontStyle: 'italic',
                fontSize: 15,
                cursor: 'pointer',
                width: '100%',
                minHeight: 44,
              }}
            >
              <CameraIcon />
              Take Photo
            </button>

            {/* Upload Image */}
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '13px 20px',
                borderRadius: 99,
                border: `1px solid ${T.hairline}`,
                background: 'transparent',
                color: T.ink,
                fontFamily: T.serif,
                fontStyle: 'italic',
                fontSize: 15,
                cursor: 'pointer',
                width: '100%',
                minHeight: 44,
              }}
            >
              <UploadIcon />
              Upload Image
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
          </div>
        )}

        {/* Camera mode */}
        {mode === 'camera' && (
          <div style={{ width: '100%', maxWidth: 420, position: 'relative' }}>
            <div
              style={{
                borderRadius: 18,
                border: `1px solid ${T.hairline}`,
                overflow: 'hidden',
                background: T.paperDeep,
                position: 'relative',
              }}
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{ width: '100%', display: 'block' }}
              />
              {/* Dashed guide frame — T.pencil at 80% so it's visible over the live feed */}
              <div
                style={{
                  position: 'absolute',
                  inset: 16,
                  borderRadius: 10,
                  border: `1.5px dashed ${T.pencil}cc`,
                  pointerEvents: 'none',
                }}
              />
            </div>
            <div
              style={{
                marginTop: 10,
                textAlign: 'center',
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.3,
                color: T.pencil,
                textTransform: 'uppercase',
              }}
            >
              Frame the scorecard inside the border
            </div>
          </div>
        )}

        {/* Preview mode */}
        {mode === 'preview' && previewImage && (
          <div style={{ width: '100%', maxWidth: 420 }}>
            <div
              style={{
                borderRadius: 18,
                border: `1px solid ${T.hairline}`,
                overflow: 'hidden',
                background: T.paperDeep,
              }}
            >
              <Image
                src={previewImage}
                alt="Captured scorecard"
                width={1600}
                height={1200}
                unoptimized
                style={{ width: '100%', height: 'auto', display: 'block' }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Bottom action bar */}
      <div
        style={{
          flexShrink: 0,
          padding: '14px 20px',
          paddingBottom: 'max(14px, calc(env(safe-area-inset-bottom) + 8px))',
          borderTop: `1px solid ${T.hairline}`,
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: 'multiply',
        }}
      >
        <div
          style={{
            maxWidth: 420,
            margin: '0 auto',
            display: 'flex',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          {mode === 'camera' && (
            <>
              <button
                onClick={() => { stopCamera(); setMode('select'); }}
                style={{
                  flex: 1,
                  padding: '13px 0',
                  borderRadius: 99,
                  border: `1px solid ${T.hairline}`,
                  background: 'transparent',
                  color: T.pencil,
                  fontFamily: T.serif,
                  fontStyle: 'italic',
                  fontSize: 15,
                  cursor: 'pointer',
                  minHeight: 44,
                }}
              >
                Cancel
              </button>
              <button
                onClick={capturePhoto}
                style={{
                  flex: 2,
                  padding: '13px 0',
                  borderRadius: 99,
                  border: 'none',
                  background: T.ink,
                  color: T.paper,
                  fontFamily: T.serif,
                  fontStyle: 'italic',
                  fontSize: 15,
                  cursor: 'pointer',
                  minHeight: 44,
                }}
              >
                Capture
              </button>
            </>
          )}

          {mode === 'preview' && (
            <>
              <button
                onClick={retake}
                style={{
                  flex: 1,
                  padding: '13px 0',
                  borderRadius: 99,
                  border: `1px solid ${T.hairline}`,
                  background: 'transparent',
                  color: T.pencil,
                  fontFamily: T.serif,
                  fontStyle: 'italic',
                  fontSize: 15,
                  cursor: 'pointer',
                  minHeight: 44,
                }}
              >
                Retake
              </button>
              <button
                onClick={confirmCapture}
                style={{
                  flex: 2,
                  padding: '13px 0',
                  borderRadius: 99,
                  border: 'none',
                  background: T.ink,
                  color: T.paper,
                  fontFamily: T.serif,
                  fontStyle: 'italic',
                  fontSize: 15,
                  cursor: 'pointer',
                  minHeight: 44,
                }}
              >
                Use Photo
              </button>
            </>
          )}
        </div>
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}
