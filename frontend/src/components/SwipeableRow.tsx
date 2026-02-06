'use client';

import { ReactNode, useState } from 'react';
import { motion, useMotionValue, useTransform, PanInfo, animate } from 'framer-motion';
import { Trash2, AlertTriangle } from 'lucide-react';

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
  
  // Background color intensity based on swipe distance
  const backgroundColor = useTransform(
    x,
    [0, deleteThreshold],
    ['rgba(239, 68, 68, 0)', 'rgba(239, 68, 68, 0.3)']
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
        {/* Delete background */}
        <motion.div
          style={{ backgroundColor }}
          className="absolute inset-0 flex items-center pl-6 rounded-2xl"
        >
          <motion.div style={{ opacity: iconOpacity, scale: iconScale }}>
            <Trash2 className="h-6 w-6 text-red-400" />
          </motion.div>
        </motion.div>

        {/* Swipeable content */}
        <motion.div
          drag="x"
          dragConstraints={{ left: 0, right: deleteThreshold + 50 }}
          dragElastic={{ left: 0, right: 0.5 }}
          onDragEnd={handleDragEnd}
          style={{ x }}
          className="relative z-10"
        >
          {children}
        </motion.div>
      </div>

      {/* Confirmation Modal */}
      {showConfirm && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={handleCancelDelete}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 max-w-sm w-full shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">Confirm Delete</h3>
            </div>
            
            <p className="text-zinc-400 mb-6">{confirmMessage}</p>
            
            <div className="flex gap-3">
              <button
                onClick={handleCancelDelete}
                className="flex-1 px-4 py-3 rounded-xl bg-zinc-800 text-white font-medium hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="flex-1 px-4 py-3 rounded-xl bg-red-600 text-white font-medium hover:bg-red-500 transition-colors"
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
