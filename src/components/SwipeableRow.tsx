'use client';

import { ReactNode, useState } from 'react';
import { motion, useMotionValue, useTransform, PanInfo } from 'framer-motion';
import { Trash2 } from 'lucide-react';

interface SwipeableRowProps {
  children: ReactNode;
  onDelete: () => void;
  deleteThreshold?: number;
}

export default function SwipeableRow({
  children,
  onDelete,
  deleteThreshold = 100,
}: SwipeableRowProps) {
  const [isDeleting, setIsDeleting] = useState(false);
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
      setIsDeleting(true);
      // Animate out then delete
      setTimeout(() => {
        onDelete();
      }, 200);
    }
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
  );
}
