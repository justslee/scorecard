"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Player, HoleInfo } from "@/lib/types";
import { T } from "@/components/yardage/tokens";
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

  // Animation variants for the content — fast and snappy
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
    <>
      {/* Ink-tinted overlay */}
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        style={{ background: 'rgba(26,42,26,0.45)' }}
      />

      {/* Sheet */}
      <div
        className="fixed inset-x-0 bottom-0 z-50"
        onTouchStart={handleContainerTouchStart}
        onTouchMove={handleContainerTouchMove}
        onTouchEnd={handleContainerTouchEnd}
        style={{ touchAction: 'pan-y', maxWidth: 480, margin: '0 auto' }}
      >
        <motion.div
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={T.springSoft}
          style={{
            background: T.paper,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            boxShadow: '0 -20px 50px rgba(26,42,26,0.25)',
            paddingBottom: 'max(32px, env(safe-area-inset-bottom))',
          }}
        >
          {/* Drag handle */}
          <div
            style={{
              width: 40,
              height: 4,
              borderRadius: 99,
              background: T.hairline,
              margin: '14px auto 0',
            }}
          />

          {/* Header with navigation */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            {/* Prev button */}
            <motion.button
              onClick={handlePrevHole}
              disabled={!canGoPrev}
              whileTap={{ scale: 0.9 }}
              style={{
                minWidth: 44,
                minHeight: 44,
                borderRadius: 99,
                border: `1px solid ${canGoPrev ? T.hairline : T.hairlineSoft}`,
                background: 'transparent',
                color: canGoPrev ? T.ink : T.pencilSoft,
                cursor: canGoPrev ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                fontFamily: T.serif,
              }}
            >
              ‹
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
                style={{ textAlign: 'center' }}
              >
                <h3
                  style={{
                    fontFamily: T.serif,
                    fontStyle: 'italic',
                    fontSize: 22,
                    color: T.ink,
                    letterSpacing: -0.4,
                    margin: 0,
                  }}
                >
                  Hole {hole.number}
                </h3>
                <p
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    color: T.pencilSoft,
                    textTransform: 'uppercase',
                    margin: 0,
                  }}
                >
                  Par {hole.par}
                </p>
              </motion.div>
            </AnimatePresence>

            {/* Next button */}
            <motion.button
              onClick={handleNextHole}
              disabled={!canGoNext}
              whileTap={{ scale: 0.9 }}
              style={{
                minWidth: 44,
                minHeight: 44,
                borderRadius: 99,
                border: `1px solid ${canGoNext ? T.hairline : T.hairlineSoft}`,
                background: 'transparent',
                color: canGoNext ? T.ink : T.pencilSoft,
                cursor: canGoNext ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                fontFamily: T.serif,
              }}
            >
              ›
            </motion.button>
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 18,
              right: 18,
              minWidth: 32,
              minHeight: 32,
              borderRadius: 99,
              border: `1px solid ${T.hairline}`,
              background: 'transparent',
              color: T.pencil,
              fontSize: 16,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
            }}
          >
            ×
          </button>

          {/* 2×2 Grid with slide animation */}
          <AnimatePresence mode="wait" custom={slideDirection}>
            <motion.div
              key={hole.number}
              custom={slideDirection}
              variants={contentVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.1, ease: "easeOut" }}
              className="grid grid-cols-2 gap-2 px-4 pt-1 pb-2"
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
          <div className="flex gap-2 px-4 pb-1">
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => {
                players.forEach((p) => onScoreChange(p.id, hole.par));
                hapticSuccess();
              }}
              style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 14,
                background: 'rgba(58,74,138,0.08)',
                color: T.accent,
                fontSize: 14,
                fontWeight: 600,
                fontFamily: T.sans,
                border: `1px solid rgba(58,74,138,0.18)`,
                cursor: 'pointer',
                minHeight: 44,
              }}
            >
              All Par
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => {
                hapticLight();
                onClose();
              }}
              style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 14,
                background: T.paperDeep,
                color: T.ink,
                fontSize: 14,
                fontWeight: 600,
                fontFamily: T.sans,
                border: `1px solid ${T.hairline}`,
                cursor: 'pointer',
                minHeight: 44,
              }}
            >
              Done
            </motion.button>
          </div>

          {/* Hole indicator dots */}
          <div className="flex justify-center gap-1 pt-2 pb-1 px-4">
            {[...Array(Math.min(9, totalHoles))].map((_, i) => {
              const holeNum = hole.number <= 9 ? i + 1 : i + 10;
              const isActive = hole.number === holeNum;
              const inRange = hole.number <= 9 ? holeNum <= 9 : holeNum > 9;
              if (!inRange) return null;
              return (
                <div
                  key={i}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 99,
                    background: isActive ? T.accent : T.hairline,
                    transform: isActive ? 'scale(1.3)' : 'scale(1)',
                    transition: 'transform 0.15s, background 0.15s',
                  }}
                />
              );
            })}
          </div>
          <p
            style={{
              textAlign: 'center',
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: '0.08em',
              color: T.pencilSoft,
              textTransform: 'uppercase',
              marginTop: 2,
              paddingBottom: 2,
            }}
          >
            {hole.number <= 9 ? 'Front 9' : 'Back 9'} · Swipe ← →
          </p>
        </motion.div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ScoreCell — yardage-book restyled; all logic/behavior/callbacks unchanged.
// ---------------------------------------------------------------------------
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

  // Yardage-book score color (ink tones, not dark-mode neon)
  const getScoreInkColor = (s: number | null): string => {
    if (s === null) return T.pencilSoft;
    const diff = s - par;
    if (diff <= -2) return T.eagle;
    if (diff === -1) return T.flag;
    if (diff === 0) return T.par;
    if (diff === 1) return T.bogey;
    return T.double;
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

  const inkColor = getScoreInkColor(score);

  return (
    <motion.div
      ref={containerRef}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={handleTap}
      whileTap={{ scale: 0.98 }}
      style={{
        touchAction: "pan-x",
        position: 'relative',
        aspectRatio: '1 / 1',
        borderRadius: 18,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'ns-resize',
        userSelect: 'none',
        transition: 'background 0.15s, border-color 0.15s',
        background: isDragging ? 'rgba(58,74,138,0.08)' : T.paperDeep,
        border: `2px solid ${isDragging ? 'rgba(58,74,138,0.35)' : T.hairline}`,
        minHeight: 88, // 2× 44pt baseline for adequate touch area
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 0,
          right: 0,
          textAlign: 'center',
        }}
      >
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: '0.06em',
            color: T.pencil,
            textTransform: 'uppercase',
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            paddingLeft: 8,
            paddingRight: 8,
          }}
        >
          {playerName}
        </span>
      </div>

      <span
        style={{
          fontFamily: T.serif,
          fontSize: 42,
          color: inkColor,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}
      >
        {score ?? "–"}
      </span>

      <span
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: '0.04em',
          marginTop: 2,
          color: inkColor,
        }}
      >
        {getScoreLabel(score)}
      </span>

      {/* −/+ controls — 44pt touch targets */}
      <div
        style={{
          position: 'absolute',
          bottom: 6,
          left: 6,
          right: 6,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={decrement}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: 99,
            border: `1px solid ${T.hairline}`,
            background: T.paper,
            color: T.pencil,
            fontSize: 20,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontFamily: T.serif,
          }}
        >
          −
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={increment}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: 99,
            border: `1px solid ${T.hairline}`,
            background: T.paper,
            color: T.pencil,
            fontSize: 20,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontFamily: T.serif,
          }}
        >
          +
        </motion.button>
      </div>

      {isDragging && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(58,74,138,0.06)',
              borderRadius: 18,
            }}
          />
        </div>
      )}
    </motion.div>
  );
}
