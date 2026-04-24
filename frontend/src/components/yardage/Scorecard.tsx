"use client";

import { T } from "./tokens";

export type SeedPlayer = { id: string; name: string; hcp: number; color: string };

export function ScoreDot({ score, par, accent }: { score: number | null; par: number; accent: string }) {
  if (score == null) {
    return (
      <span style={{ color: T.pencilSoft, fontFamily: T.serif, fontSize: 18, fontVariantNumeric: "tabular-nums" }}>
        &mdash;
      </span>
    );
  }
  const diff = score - par;
  const common: React.CSSProperties = {
    position: "relative",
    width: 28,
    height: 28,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: T.serif,
    fontSize: 18,
    fontVariantNumeric: "tabular-nums",
    color: diff <= -1 ? accent : T.ink,
  };
  return (
    <span style={common}>
      {diff <= -2 && (
        <>
          <span style={{ position: "absolute", inset: 0, borderRadius: 99, border: `1.5px solid ${accent}` }} />
          <span style={{ position: "absolute", inset: 3, borderRadius: 99, border: `1px solid ${accent}` }} />
        </>
      )}
      {diff === -1 && <span style={{ position: "absolute", inset: 0, borderRadius: 99, border: `1.5px solid ${accent}` }} />}
      {diff === 1 && <span style={{ position: "absolute", inset: 1, border: `1px solid ${T.pencil}` }} />}
      {diff >= 2 && (
        <>
          <span style={{ position: "absolute", inset: 0, border: `1.5px solid ${T.pencil}` }} />
          <span style={{ position: "absolute", inset: 3, border: `1px solid ${T.pencil}` }} />
        </>
      )}
      {score}
    </span>
  );
}

export function PlayerPanel({
  player,
  scores,
  pars,
  currentHole,
  onSelectHole,
  accent,
  density,
}: {
  player: SeedPlayer;
  scores: (number | null)[];
  pars: number[];
  currentHole: number;
  onSelectHole: (n: number) => void;
  accent: string;
  density: "spacious" | "dense";
}) {
  const front = scores.slice(0, 9);
  const back = scores.slice(9, 18);
  const total = scores.reduce<number>((a, b) => a + (b ?? 0), 0);
  const played = scores.filter((s) => s != null) as number[];
  const thru = played.length;
  const relPar = played.reduce((a, s, i) => a + (s - pars[i]), 0);

  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.hairline}`,
        borderRadius: 18,
        padding: density === "dense" ? "12px 14px 14px" : "16px 18px 18px",
        boxShadow: "0 4px 16px rgba(26,42,26,0.04)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 99,
              background: player.color || T.ink,
              color: T.paper,
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 15,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {player.name[0]}
          </div>
          <div>
            <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink, letterSpacing: -0.2 }}>{player.name}</div>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencil, textTransform: "uppercase" }}>
              HCP {player.hcp} · Thru {thru}
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: T.serif, fontSize: 28, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
            {total || "—"}
          </div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.2,
              color: relPar < 0 ? accent : T.pencil,
              textTransform: "uppercase",
            }}
          >
            {relPar === 0 ? "E" : relPar > 0 ? `+${relPar}` : relPar}
          </div>
        </div>
      </div>

      <HoleRow nine="OUT" holes={front} pars={pars.slice(0, 9)} start={1} currentHole={currentHole} onSelectHole={onSelectHole} accent={accent} />
      <HoleRow nine="IN" holes={back} pars={pars.slice(9, 18)} start={10} currentHole={currentHole} onSelectHole={onSelectHole} accent={accent} />
    </div>
  );
}

function HoleRow({
  nine,
  holes,
  pars,
  start,
  currentHole,
  onSelectHole,
  accent,
}: {
  nine: string;
  holes: (number | null)[];
  pars: number[];
  start: number;
  currentHole: number;
  onSelectHole: (n: number) => void;
  accent: string;
}) {
  const sum = holes.reduce<number>((a, b) => a + (b ?? 0), 0);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(9, 1fr) 34px", gap: 2, alignItems: "center" }}>
        {holes.map((s, i) => {
          const h = start + i;
          const isCur = h === currentHole;
          return (
            <button
              key={i}
              onClick={() => onSelectHole(h)}
              style={{
                position: "relative",
                border: "none",
                background: "transparent",
                padding: "4px 0",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 0.4,
                  color: isCur ? accent : T.pencilSoft,
                  fontWeight: isCur ? 600 : 400,
                }}
              >
                {h}
              </div>
              <ScoreDot score={s} par={pars[i]} accent={accent} />
              {isCur && <div style={{ width: 18, height: 1.5, background: accent, borderRadius: 99, marginTop: 1 }} />}
            </button>
          );
        })}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            borderLeft: `1px solid ${T.hairline}`,
            paddingLeft: 4,
          }}
        >
          <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 0.8, color: T.pencil }}>{nine}</div>
          <div style={{ fontFamily: T.serif, fontSize: 18, color: T.ink, fontVariantNumeric: "tabular-nums" }}>{sum || "—"}</div>
        </div>
      </div>
    </div>
  );
}

export function StakesTicker({ accent }: { accent: string }) {
  const games = [
    { g: "Nassau", status: "\u22121 F · E B · \u22121 T", you: "+$20" },
    { g: "Skins", status: "2 pots carrying", you: "$30" },
    { g: "Closest", status: "Hole 7", you: "" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderRadius: 14,
        overflow: "hidden",
        border: `1px solid ${T.hairline}`,
        background: T.paper,
      }}
    >
      {games.map((g, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            padding: "10px 12px",
            borderLeft: i > 0 ? `1px solid ${T.hairline}` : "none",
          }}
        >
          <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencil, textTransform: "uppercase" }}>{g.g}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 2 }}>
            <div style={{ fontFamily: T.serif, fontSize: 12, fontStyle: "italic", color: T.inkSoft, lineHeight: 1.1 }}>{g.status}</div>
            {g.you && <div style={{ fontFamily: T.mono, fontSize: 11, color: accent, fontWeight: 500 }}>{g.you}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
