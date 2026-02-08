'use client';

import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Round } from '@/lib/types';
import type { CourseCoordinates } from '@/lib/golf-api';
import CaddiePanel from './CaddiePanel';

interface CaddieModalProps {
  round: Round;
  currentHole: number;
  onHoleChange: (hole: number) => void;
  onClose: () => void;
  holeCoordinates?: CourseCoordinates[];
}

export default function CaddieModal({ round, currentHole, onHoleChange, onClose, holeCoordinates }: CaddieModalProps) {
  // Lock body scroll when modal is open
  useEffect(() => {
    // Save current scroll position and styles
    const scrollY = window.scrollY;
    const originalStyle = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
    };

    // Lock the body
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';

    // Cleanup: restore scroll position and styles
    return () => {
      document.body.style.overflow = originalStyle.overflow;
      document.body.style.position = originalStyle.position;
      document.body.style.top = originalStyle.top;
      document.body.style.left = originalStyle.left;
      document.body.style.right = originalStyle.right;
      document.body.style.width = originalStyle.width;
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Prevent touch events from propagating to background
  const handleTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
  };

  return (
    <motion.div
      key="caddie-modal"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50"
      onTouchMove={handleTouchMove}
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className="absolute inset-0"
      >
        <CaddiePanel
          round={round}
          currentHole={currentHole}
          onHoleChange={onHoleChange}
          onClose={onClose}
          holeCoordinates={holeCoordinates}
        />
      </motion.div>
    </motion.div>
  );
}
