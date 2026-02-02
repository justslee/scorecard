"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Player, HoleInfo } from "@/lib/types";
import { hapticLight, hapticSuccess } from "@/lib/haptics";

interface HoleScoreModalProps {
  hole: HoleInfo;
  players: Player[];
  scores: Record<string, number | null>;
  onScoreChange: (playerId: string, score: number | null) => void;
  onClose: () => void;
  onPrevHole?: () => void;
  onNextHole?: () => void;
  totalHoles?: number;
}

export default function HoleScoreModal({
  hole,
  players,
  scores,
  onScoreChange,
  onClose,
  onPrevHole,
  onNextHole,
  totalHoles = 18,
}: HoleScoreModalProps) {
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | null>(null);
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);
  const swipeAxis = useRef<'horizontal' | 'vertical' | null>(null);
  const swipeDelta = useRef(0);

  // Lock body scroll when modal is open
  useEffect(() => {
    const originalStyle = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalStyle;
    };
  }, []);

  const handlePrevHole = () => {
    if (hole.number > 1 && onPrevHole) {
      setSlideDirection('right');
      onPrevHole();
    }
  };

  const handleNextHole = () => {
    if (hole.number < totalHoles && onNextHole) {
      setSlideDirection('left');
      onNextHole();
    }
  };

  // Handle swipe for hole navigation
  const handleContainerTouchStart = (e: React.TouchEvent) => {
    swipeStartX.current = e.touches[0].clientX;
    swipeStartY.current = e.touches[0].clientY;
    swipeAxis.current = null;
    swipeDelta.current = 0;
  };

  const handleContainerTouchMove = (e: React.TouchEvent) => {
    if (!swipeStartX.current) return;
    
    const deltaX = e.touches[0].clientX - swipeStartX.current;
    const deltaY = e.touches[0].clientY - swipeStartY.current;
    
    // Determine axis on first significant movement
    if (!swipeAxis.current) {
      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
        swipeAxis.current = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
      }
    }
    
    // Track horizontal swipe progress
    if (swipeAxis.current === 'horizontal') {
      swipeDelta.current = deltaX;
    }
  };

  const handleContainerTouchEnd = () => {
    if (swipeAxis.current === 'horizontal') {
      // Lower threshold (50px) for faster response
      if (swipeDelta.current > 50 && hole.number > 1) {
        handlePrevHole();
      } else if (swipeDelta.current < -50 && hole.number < totalHoles) {
        handleNextHole();
      }
    }
    swipeStartX.current = 0;
    swipeStartY.current = 0;
    swipeAxis.current = null;
    swipeDelta.current = 0;
  };

  const gridPlayers = players.slice(0, 4);
  const canGoPrev = hole.number > 1;
  const canGoNext = hole.number < totalHoles;

  // Animation variants for the content - fast and snappy
  const contentVariants = {
    enter: (direction: 'left' | 'right' | null) => ({
      x: direction === 'left' ? 60 : direction === 'right' ? -60 : 0,
      opacity: 0,
    }),
    center: {
      x: 0,
      opacity: 1,
    },
    exit: (direction: 'left' | 'right' | null) => ({
      x: direction === 'left' ? -60 : direction === 'right' ? 60 : 0,
      opacity: 0,
    }),
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onTouchStart={handleContainerTouchStart}
      onTouchMove={handleContainerTouchMove}
      onTouchEnd={handleContainerTouchEnd}
      style={{ touchAction: 'pan-y' }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.1 }}
        className="w-full max-w-sm px-4 py-8 overflow-hidden"
      >
        {/* Header with navigation */}
        <div className="flex items-center justify-between mb-3">
          {/* Prev button */}
          <motion.button
            onClick={handlePrevHole}
            disabled={!canGoPrev}
            whileTap={{ scale: 0.9 }}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
              canGoPrev 
                ? 'bg-zinc-800/80 hover:bg-zinc-700 text-white' 
                : 'bg-zinc-900/50 text-zinc-600 cursor-not-allowed'
            }`}
          >
            <ChevronLeft className="w-6 h-6" />
          </motion.button>

          {/* Hole info with animation */}
          <AnimatePresence mode="wait" custom={slideDirection}>
            <motion.div
              key={hole.number}
              custom={slideDirection}
              variants={contentVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.1, ease: "easeOut" }}
              className="text-center"
            >
              <h3 className="text-xl font-bold text-white">Hole {hole.number}</h3>
              <p className="text-sm text-zinc-400">Par {hole.par}</p>
            </motion.div>
          </AnimatePresence>

          {/* Next button */}
          <motion.button
            onClick={handleNextHole}
            disabled={!canGoNext}
            whileTap={{ scale: 0.9 }}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
              canGoNext 
                ? 'bg-zinc-800/80 hover:bg-zinc-700 text-white' 
                : 'bg-zinc-900/50 text-zinc-600 cursor-not-allowed'
            }`}
          >
            <ChevronRight className="w-6 h-6" />
          </motion.button>
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-full bg-zinc-800/80 flex items-center justify-center hover:bg-zinc-700 z-10"
        >
          <X className="w-4 h-4 text-zinc-400" />
        </button>

        {/* 2x2 Grid with slide animation */}
        <AnimatePresence mode="wait" custom={slideDirection}>
          <motion.div
            key={hole.number}
            custom={slideDirection}
            variants={contentVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.1, ease: "easeOut" }}
            className="grid grid-cols-2 gap-2"
          >
            {gridPlayers.map((player) => (
              <ScoreCell
                key={player.id}
                playerName={player.name}
                score={scores[player.id] ?? null}
                par={hole.par}
                onChange={(score) => onScoreChange(player.id, score)}
              />
            ))}
          </motion.div>
        </AnimatePresence>

        {/* Quick actions */}
        <div className="flex gap-2 mt-3">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => {
              players.forEach((p) => onScoreChange(p.id, hole.par));
              hapticSuccess();
            }}
            className="flex-1 py-3 rounded-xl bg-emerald-500/20 text-emerald-300 text-sm font-semibold border border-emerald-500/30"
          >
            All Par
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => {
              hapticLight();
              onClose();
            }}
            className="flex-1 py-3 rounded-xl bg-white/10 text-white text-sm font-semibold border border-white/20"
          >
            Done
          </motion.button>
        </div>

        {/* Hole indicator dots */}
        <div className="flex justify-center gap-1 mt-3">
          {[...Array(Math.min(9, totalHoles))].map((_, i) => {
            const holeNum = hole.number <= 9 ? i + 1 : i + 10;
            const isActive = hole.number === holeNum;
            const inRange = hole.number <= 9 ? holeNum <= 9 : holeNum > 9;
            if (!inRange) return null;
            return (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-all ${
                  isActive ? 'bg-emerald-400 scale-125' : 'bg-zinc-600'
                }`}
              />
            );
          })}
        </div>
        <p className="text-center text-xs text-zinc-600 mt-1">
          {hole.number <= 9 ? 'Front 9' : 'Back 9'} • Swipe ← →
        </p>
      </motion.div>
    </div>
  );
}

function ScoreCell({
  playerName,
  score,
  par,
  onChange,
}: {
  playerName: string;
  score: number | null;
  par: number;
  onChange: (score: number | null) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startX = useRef(0);
  const startScore = useRef(score ?? par);
  const isVerticalSwipe = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const getScoreColor = (s: number | null): string => {
    if (s === null) return "text-zinc-500";
    const diff = s - par;
    if (diff <= -2) return "text-yellow-400";
    if (diff === -1) return "text-red-400";
    if (diff === 0) return "text-emerald-400";
    if (diff === 1) return "text-sky-400";
    return "text-blue-400";
  };

  const getScoreLabel = (s: number | null): string => {
    if (s === null) return "–";
    const diff = s - par;
    if (diff <= -2) return "🦅";
    if (diff === -1) return "🐦";
    if (diff === 0) return "✓";
    if (diff === 1) return "+1";
    if (diff === 2) return "+2";
    return `+${diff}`;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const current = score ?? par;
    const delta = e.deltaY > 0 ? 1 : -1;
    const newScore = Math.max(1, Math.min(15, current + delta));
    onChange(newScore);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    startY.current = e.touches[0].clientY;
    startX.current = e.touches[0].clientX;
    startScore.current = score ?? par;
    isVerticalSwipe.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const deltaX = Math.abs(e.touches[0].clientX - startX.current);
    const deltaY = Math.abs(e.touches[0].clientY - startY.current);
    
    if (!isVerticalSwipe.current && (deltaX > 10 || deltaY > 10)) {
      isVerticalSwipe.current = deltaY > deltaX;
    }
    
    if (!isVerticalSwipe.current) return;
    
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    
    const actualDeltaY = startY.current - e.touches[0].clientY;
    const deltaScore = Math.round(actualDeltaY / 20);
    const newScore = Math.max(1, Math.min(15, startScore.current + deltaScore));
    if (newScore !== score) {
      onChange(newScore);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    setIsDragging(false);
    isVerticalSwipe.current = false;
  };

  const increment = (e: React.MouseEvent) => {
    e.stopPropagation();
    const current = score ?? par;
    if (current < 15) {
      onChange(current + 1);
      hapticLight();
    }
  };

  const decrement = (e: React.MouseEvent) => {
    e.stopPropagation();
    const current = score ?? par;
    if (current > 1) {
      onChange(current - 1);
      hapticLight();
    }
  };

  const handleTap = () => {
    if (score === null) {
      onChange(par);
      hapticSuccess();
    }
  };

  return (
    <motion.div
      ref={containerRef}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={handleTap}
      whileTap={{ scale: 0.98 }}
      style={{ touchAction: "pan-x" }}
      className={`relative aspect-square rounded-2xl flex flex-col items-center justify-center cursor-ns-resize select-none transition-colors ${
        isDragging
          ? "bg-emerald-500/20 border-emerald-500"
          : "bg-zinc-800/80 border-zinc-700 hover:bg-zinc-800"
      } border-2`}
    >
      <div className="absolute top-2 left-0 right-0 text-center">
        <span className="text-xs font-medium text-zinc-400 truncate px-2">
          {playerName}
        </span>
      </div>

      <span className={`text-4xl font-bold ${getScoreColor(score)}`}>
        {score ?? "–"}
      </span>

      <span className={`text-xs mt-1 ${getScoreColor(score)}`}>
        {getScoreLabel(score)}
      </span>

      <div className="absolute bottom-2 left-2 right-2 flex justify-between">
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={decrement}
          className="w-8 h-8 rounded-full bg-zinc-900/80 flex items-center justify-center text-zinc-400 text-lg font-bold hover:bg-zinc-700"
        >
          −
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={increment}
          className="w-8 h-8 rounded-full bg-zinc-900/80 flex items-center justify-center text-zinc-400 text-lg font-bold hover:bg-zinc-700"
        >
          +
        </motion.button>
      </div>

      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 bg-emerald-500/10 rounded-2xl" />
        </div>
      )}
    </motion.div>
  );
}
