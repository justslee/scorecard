"use client";

/**
 * OfflineCaddieCard — tier 3 of the caddie transport ladder.
 *
 * When the phone is fully offline, the voice orb opens this static card
 * instead of a live conversation: the current hole's yardages, hazards, and
 * the last recommendation, rendered from the HoleIntelBundle cached in
 * IndexedDB at session start (lib/caddie/hole-intel-cache.ts). Quiet,
 * on-paper, no error language — the yardage book still works in a dead zone.
 */

import { motion, AnimatePresence } from "framer-motion";
import { T } from "@/components/yardage/tokens";
import type { CachedHoleIntel, CachedRecommendation } from "@/lib/caddie/hole-intel-cache";

export default function OfflineCaddieCard({
  open,
  onClose,
  holeNumber,
  par,
  yards,
  intel,
  lastRecommendation,
}: {
  open: boolean;
  onClose: () => void;
  holeNumber: number;
  par: number;
  yards: number;
  /** Cached intel for this hole (hazards, plays-like); null = round data only. */
  intel: CachedHoleIntel | null;
  lastRecommendation: CachedRecommendation | null;
}) {
  const playsLike = intel?.effectiveYards && intel.effectiveYards !== intel.yards
    ? intel.effectiveYards
    : null;
  const hazards = intel?.hazards ?? [];
  const rec = lastRecommendation && lastRecommendation.holeNumber === holeNumber
    ? lastRecommendation
    : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="offline-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(26,42,26,0.35)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={T.springSoft}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 340,
              background: T.paper,
              borderRadius: 20,
              boxShadow: "0 20px 50px rgba(26,42,26,0.25)",
              padding: "20px 22px 22px",
            }}
          >
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.4,
                color: T.pencilSoft,
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              Off the grid · from your book
            </div>

            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 24,
                letterSpacing: -0.4,
                color: T.ink,
                marginBottom: 4,
              }}
            >
              Hole {holeNumber} · Par {par}
            </div>

            <div style={{ fontFamily: T.sans, fontSize: 13, color: T.pencil, marginBottom: 14 }}>
              {yards} yards
              {playsLike !== null && (
                <span style={{ color: T.inkSoft }}>
                  {" "}· plays like {playsLike}
                </span>
              )}
            </div>

            {hazards.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.4,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}
                >
                  Trouble
                </div>
                {hazards.slice(0, 4).map((h, i) => (
                  <div
                    key={i}
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 15,
                      color: T.inkSoft,
                      letterSpacing: -0.2,
                      lineHeight: 1.5,
                    }}
                  >
                    &mdash; {h.type} {h.side}
                    {h.distance_from_green > 0 && `, ${h.distance_from_green}y from the green`}
                  </div>
                ))}
              </div>
            )}

            {rec && (
              <div
                style={{
                  borderTop: `1px solid ${T.hairline}`,
                  paddingTop: 12,
                  marginBottom: 2,
                }}
              >
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.4,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}
                >
                  Last call
                </div>
                <div
                  style={{
                    fontFamily: T.serif,
                    fontSize: 17,
                    color: T.ink,
                    letterSpacing: -0.2,
                    lineHeight: 1.4,
                  }}
                >
                  {rec.club} to {rec.targetYards} · {rec.aim}
                  {rec.missSide && (
                    <span style={{ color: T.pencil }}> · miss {rec.missSide}</span>
                  )}
                </div>
              </div>
            )}

            {hazards.length === 0 && !rec && (
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 15,
                  color: T.pencilSoft,
                  letterSpacing: -0.2,
                }}
              >
                That&rsquo;s all I have penciled in for this one.
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
