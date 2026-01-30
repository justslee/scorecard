'use client';

import { useRef, useState, useCallback } from 'react';

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
      stream.getTracks().forEach(track => track.stop());
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
    if (previewImage) {
      onCapture(previewImage);
    }
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
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center p-4 bg-gray-900">
        <h2 className="text-lg font-bold">📷 Scan Scorecard</h2>
        <button onClick={handleClose} className="p-2 text-gray-400 hover:text-white">
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center p-4">
        {error && (
          <div className="bg-red-900 text-red-200 p-4 rounded-lg mb-4 max-w-md">
            {error}
          </div>
        )}

        {mode === 'select' && (
          <div className="flex flex-col gap-4 w-full max-w-md">
            <p className="text-center text-gray-400 mb-4">
              Take a photo of your scorecard or upload an existing image
            </p>
            
            <button
              onClick={startCamera}
              className="p-6 bg-green-600 hover:bg-green-700 rounded-xl text-xl font-bold flex items-center justify-center gap-3"
            >
              📸 Take Photo
            </button>
            
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-6 bg-blue-600 hover:bg-blue-700 rounded-xl text-xl font-bold flex items-center justify-center gap-3"
            >
              📁 Upload Image
            </button>
            
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>
        )}

        {mode === 'camera' && (
          <div className="relative w-full max-w-2xl">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full rounded-lg"
            />
            <div className="absolute inset-0 border-4 border-dashed border-white/30 rounded-lg pointer-events-none m-4" />
            <p className="absolute bottom-20 left-0 right-0 text-center text-white/80 text-sm">
              Position the scorecard within the frame
            </p>
          </div>
        )}

        {mode === 'preview' && previewImage && (
          <div className="w-full max-w-2xl">
            <img
              src={previewImage}
              alt="Captured scorecard"
              className="w-full rounded-lg"
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 bg-gray-900">
        {mode === 'camera' && (
          <div className="flex justify-center gap-4">
            <button
              onClick={() => { stopCamera(); setMode('select'); }}
              className="px-6 py-3 bg-gray-700 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={capturePhoto}
              className="px-8 py-3 bg-green-600 rounded-full text-xl"
            >
              📸 Capture
            </button>
          </div>
        )}

        {mode === 'preview' && (
          <div className="flex justify-center gap-4">
            <button
              onClick={retake}
              className="px-6 py-3 bg-gray-700 rounded-lg"
            >
              Retake
            </button>
            <button
              onClick={confirmCapture}
              className="px-8 py-3 bg-green-600 rounded-lg font-bold"
            >
              ✓ Use This Photo
            </button>
          </div>
        )}
      </div>

      {/* Hidden canvas for capture */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
