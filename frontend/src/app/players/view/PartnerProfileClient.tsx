"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { getPlayersAsync, getRoundsAsync } from "@/lib/storage-api";
import { getSharedRounds } from "@/lib/partner-rounds";
import { roundHref } from "@/lib/round-url";
import type { SavedPlayer, Round } from "@/lib/types";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PartnerProfileClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get("id");

  const [player, setPlayer] = useState<SavedPlayer | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const [players, allRounds] = await Promise.all([
          getPlayersAsync(),
          getRoundsAsync(),
        ]);
        if (cancelled) return;
        setPlayer(players.find((p) => p.id === id) ?? null);
        setRounds(allRounds);
      } catch {
        if (!cancelled) {
          setPlayer(null);
          setRounds([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const shared = useMemo(
    () => getSharedRounds(rounds, id ?? ""),
    [rounds, id]
  );

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: 1.6,
          color: T.pencilSoft,
          textTransform: "uppercase",
        }}
      >
        Loading&hellip;
      </div>
    );
  }

  // ── Not-found state (missing id or unknown player) ────────────────────────

  if (!player) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px 22px",
          textAlign: "center",
          fontFamily: T.sans,
          color: T.ink,
        }}
      >
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 22,
            letterSpacing: -0.3,
            color: T.pencil,
            lineHeight: 1.3,
          }}
        >
          Player not found.
        </div>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.pencilSoft,
            textTransform: "uppercase",
            marginTop: 8,
          }}
        >
          They may have been removed from your players.
        </div>
        <button
          onClick={() => router.push("/players")}
          style={{
            marginTop: 24,
            padding: "11px 24px",
            borderRadius: 99,
            border: `1px solid ${T.hairline}`,
            background: "transparent",
            color: T.ink,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.3,
            cursor: "pointer",
            textTransform: "uppercase",
            minHeight: 44,
          }}
        >
          Back to players
        </button>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        fontFamily: T.sans,
        color: T.ink,
      }}
    >
      <div
        style={{
          maxWidth: 420,
          margin: "0 auto",
          paddingBottom: "calc(32px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: "max(14px, env(safe-area-inset-top)) 22px 14px",
          }}
        >
          <button
            onClick={() => router.push("/players")}
            style={{
              background: "transparent",
              border: "none",
              padding: "0 8px",
              cursor: "pointer",
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.4,
              color: T.pencil,
              textTransform: "uppercase",
              display: "flex",
              alignItems: "center",
              gap: 4,
              marginBottom: 10,
              minHeight: 44,
            }}
          >
            <span style={{ fontSize: 11 }}>{"←"}</span> Players
          </button>

          {/* Kicker */}
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.6,
              color: T.pencil,
              textTransform: "uppercase",
            }}
          >
            Partner
          </div>

          {/* Name */}
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 32,
              letterSpacing: -0.7,
              color: T.ink,
              lineHeight: 1.05,
              marginTop: 4,
            }}
          >
            {player.name}
          </div>

          {/* Nickname */}
          {player.nickname && (
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 14,
                color: T.pencil,
                letterSpacing: -0.1,
                marginTop: 2,
              }}
            >
              &ldquo;{player.nickname}&rdquo;
            </div>
          )}

          {/* Mini-stats row */}
          <div style={{ display: "flex", gap: 18, marginTop: 12 }}>
            {player.handicap !== undefined && (
              <MiniStat k="Handicap" v={player.handicap} />
            )}
            <MiniStat k="Rounds played" v={player.roundsPlayed} />
          </div>
        </div>

        {/* ── Shared rounds section ── */}
        <div style={{ padding: "18px 22px 10px" }}>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.6,
              color: T.pencil,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Recent rounds together
          </div>

          {shared.length === 0 ? (
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 14,
                color: T.pencilSoft,
                letterSpacing: -0.1,
                paddingTop: 4,
              }}
            >
              No rounds together yet.
            </div>
          ) : (
            <div>
              {shared.map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => router.push(roundHref(r.id))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "11px 0",
                    // Reset all borders first, then set the top dashed divider.
                    // Order matters: border shorthand must come before borderTop
                    // so the top-only override takes effect.
                    border: "none",
                    borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                    minHeight: 44,
                    width: "100%",
                    background: "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      fontFamily: T.serif,
                      fontSize: 16,
                      color: T.ink,
                      letterSpacing: -0.2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.courseName}
                  </div>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      letterSpacing: 1.1,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                      flexShrink: 0,
                    }}
                  >
                    {new Date(r.date).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MiniStat({ k, v }: { k: string; v: number | string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 8,
          letterSpacing: 1.2,
          color: T.pencilSoft,
          textTransform: "uppercase",
        }}
      >
        {k}
      </div>
      <div
        style={{
          fontFamily: T.serif,
          fontSize: 22,
          color: T.ink,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
          marginTop: 2,
        }}
      >
        {v}
      </div>
    </div>
  );
}
