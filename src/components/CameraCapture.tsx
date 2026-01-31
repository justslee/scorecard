'use client';

import { useRef, useState, useCallback } from 'react';
import Image from 'next/image';
import { AnimatePresence, motion } from 'framer-motion';
import { Camera, Upload, X } from 'lucide-react';

interface CameraCaptureProps {
  onCapture: (imageBase64: string) => void;
  onClose: () => void;
}

export default function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'select' | 'camera' | 'preview'>('select');
  const [previewImage, setPreviewImage] = useState<string | null>(null);

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
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      <div className="app-header">
        <div className="px-4 py-4 max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Scan Scorecard</h2>
            <p className="text-sm text-zinc-400">Use camera or upload an image.</p>
          </div>
          <button onClick={handleClose} className="btn btn-icon" aria-label="Close">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="header-divider" />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6">
        <AnimatePresence>
          {error && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.16 }}
              className="card border border-red-400/20 text-red-200 px-4 py-3 mb-4 max-w-md w-full"
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        {mode === 'select' && (
          <div className="w-full max-w-md">
            <div className="card p-5">
              <p className="text-zinc-300 leading-relaxed">
                Take a photo of the scorecard with good lighting and keep it as flat as possible.
              </p>

              <div className="mt-5 grid gap-3">
                <button onClick={startCamera} className="btn btn-primary w-full">
                  <span className="inline-flex items-center justify-center gap-2">
                    <Camera className="h-5 w-5" aria-hidden="true" />
                    <span>Take Photo</span>
                  </span>
                </button>

                <button onClick={() => fileInputRef.current?.click()} className="btn btn-secondary w-full">
                  <span className="inline-flex items-center justify-center gap-2">
                    <Upload className="h-5 w-5" aria-hidden="true" />
                    <span>Upload Image</span>
                  </span>
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>
            </div>
          </div>
        )}

        {mode === 'camera' && (
          <div className="relative w-full max-w-3xl">
            <div className="card p-2">
              <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-2xl" />
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-5 rounded-2xl border border-dashed border-white/20" />
              </div>
            </div>
            <p className="mt-3 text-center text-sm text-zinc-400">Position the scorecard within the frame.</p>
          </div>
        )}

        {mode === 'preview' && previewImage && (
          <div className="w-full max-w-3xl">
            <div className="card p-2">
              <Image
                src={previewImage}
                alt="Captured scorecard"
                width={1600}
                height={1200}
                unoptimized
                className="w-full h-auto rounded-2xl"
              />
            </div>
          </div>
        )}
      </div>

      <div className="backdrop-blur-xl bg-zinc-950/70 border-t border-white/10 px-4 py-4">
        <div className="max-w-3xl mx-auto">
          {mode === 'camera' && (
            <div className="flex justify-center gap-3">
              <button
                onClick={() => {
                  stopCamera();
                  setMode('select');
                }}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button onClick={capturePhoto} className="btn btn-primary">
                Capture
              </button>
            </div>
          )}

          {mode === 'preview' && (
            <div className="flex justify-center gap-3">
              <button onClick={retake} className="btn btn-secondary">
                Retake
              </button>
              <button onClick={confirmCapture} className="btn btn-primary">
                Use Photo
              </button>
            </div>
          )}
        </div>
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
