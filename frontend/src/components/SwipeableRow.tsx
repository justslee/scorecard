'use client';

import { ReactNode, useState, CSSProperties } from 'react';
import { motion, useMotionValue, useTransform, PanInfo, animate } from 'framer-motion';
import { T } from '@/components/yardage/tokens';
import { isEdgeStart, readSafeAreaLeft } from './nav/backSwipeGesture';

// ---------------------------------------------------------------------------
// Inline icons — no lucide-react
// ---------------------------------------------------------------------------

function TrashIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function AlertTriangleIcon({ size = 18, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

interface SwipeableRowProps {
  children: ReactNode;
  onDelete: () => void;
  deleteThreshold?: number;
  confirmMessage?: string;
}

export default function SwipeableRow({
  children,
  onDelete,
  deleteThreshold = 100,
  confirmMessage = "Delete this item?",
}: SwipeableRowProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const x = useMotionValue(0);

  // Swipe reveal: T.errorInk tint fades in as the row is dragged right.
  const backgroundColor = useTransform(
    x,
    [0, deleteThreshold],
    ['rgba(184,74,58,0)', 'rgba(184,74,58,0.18)']
  );

  // Trash icon opacity and scale
  const iconOpacity = useTransform(x, [0, deleteThreshold * 0.5, deleteThreshold], [0, 0.5, 1]);
  const iconScale = useTransform(x, [0, deleteThreshold], [0.5, 1]);

  const handleDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.x >= deleteThreshold) {
      // Show confirmation instead of immediately deleting
      animate(x, 0, { type: 'spring', stiffness: 500, damping: 30 });
      setShowConfirm(true);
    } else {
      // Snap back to original position
      animate(x, 0, { type: 'spring', stiffness: 500, damping: 30 });
    }
  };

  const handleConfirmDelete = () => {
    setShowConfirm(false);
    setIsDeleting(true);
    setTimeout(() => {
      onDelete();
    }, 200);
  };

  const handleCancelDelete = () => {
    setShowConfirm(false);
  };

  if (isDeleting) {
    return (
      <motion.div
        initial={{ height: 'auto', opacity: 1 }}
        animate={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="overflow-hidden"
      />
    );
  }

  return (
    <>
      <div className="relative overflow-hidden rounded-2xl">
        {/* Delete reveal background */}
        <motion.div
          style={{ backgroundColor }}
          className="absolute inset-0 flex items-center pl-6 rounded-2xl"
        >
          <motion.div style={{ opacity: iconOpacity, scale: iconScale }}>
            <TrashIcon
              className="h-6 w-6"
              style={{ color: T.errorInk }}
            />
          </motion.div>
        </motion.div>

        {/* Swipeable content */}
        <motion.div
          drag="x"
          dragConstraints={{ left: 0, right: deleteThreshold + 50 }}
          dragElastic={{ left: 0, right: 0.5 }}
          onDragEnd={handleDragEnd}
          // Claim the left edge for the global back-swipe (specs/universal-
          // swipe-back-plan.md §8): an edge-start touch never becomes a row
          // drag — stopping propagation here (capture phase, before framer's
          // own bubble-registered pointerdown) keeps this row from moving
          // under an edge flick, so it's back-swipe-only there. Starts ≥24px
          // in are untouched and drag normally.
          onPointerDownCapture={(e) => {
            if (isEdgeStart(e.clientX, readSafeAreaLeft())) e.stopPropagation();
          }}
          style={{ x }}
          className="relative z-10"
        >
          {children}
        </motion.div>
      </div>

      {/* Confirmation dialog — yardage-book style */}
      {showConfirm && (
        <motion.div
          data-no-backswipe
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: 'rgba(26,42,26,0.45)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
          }}
          onClick={handleCancelDelete}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
            transition={T.spring}
            style={{
              background: T.paper,
              border: `1px solid ${T.hairline}`,
              borderRadius: 18,
              padding: 24,
              maxWidth: 360,
              width: '100%',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: T.errorWash,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <AlertTriangleIcon
                  size={18}
                  style={{ color: T.errorInk }}
                />
              </div>
              <h3
                style={{
                  fontFamily: T.serif,
                  fontSize: 19,
                  fontWeight: 400,
                  color: T.ink,
                  margin: 0,
                }}
              >
                Confirm delete
              </h3>
            </div>

            {/* Message */}
            <p
              style={{
                fontSize: 14,
                color: T.pencil,
                margin: '0 0 20px',
                lineHeight: 1.5,
              }}
            >
              {confirmMessage}
            </p>

            {/* Buttons — both ≥ 44pt */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleCancelDelete}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  borderRadius: 999,
                  border: `1px solid ${T.hairline}`,
                  background: T.paperDeep,
                  color: T.inkSoft,
                  fontFamily: T.sans,
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: 'pointer',
                  minHeight: 44,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  borderRadius: 999,
                  border: 'none',
                  background: T.errorInk,
                  color: T.paper,
                  fontFamily: T.sans,
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: 'pointer',
                  minHeight: 44,
                }}
              >
                Delete
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
