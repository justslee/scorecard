import { T, DEFAULT_ACCENT } from "@/components/yardage/tokens";

// Wind / Elev / Plays + F/C/B tiles — restored below the map (owner
// 2026-07-02). F/C/B uses real from-tee coordinates when the course has
// them. Extracted from RoundPageClient (specs/fcb-caption-proximity-plan.md)
// as a pure presentational component so DOM order (caption directly above
// the tiles) is render-testable without pulling in mapbox-gl/Capacitor.
interface DistancesCardProps {
  fcbCaption: { text: string; isLive: boolean }; // from fcbSourceCaption
  fcbTiles: { k: string; v: number; color: string }[];
  windTile: { v: string; sub: string };
  elevTile: { v: string; sub: string };
  playsTile: { v: string; sub: string };
}

export default function DistancesCard({
  fcbCaption,
  fcbTiles,
  windTile,
  elevTile,
  playsTile,
}: DistancesCardProps) {
  return (
    <div
      data-overlay
      style={{
        background: T.paper,
        padding: "10px 14px max(20px, calc(env(safe-area-inset-bottom) + 14px))",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          padding: "8px 0",
          borderBottom: `1px solid ${T.hairline}`,
          marginBottom: 12,
        }}
      >
        <MapStat k="Wind" v={windTile.v} sub={windTile.sub} />
        <MapStat k="Elev" v={elevTile.v} sub={elevTile.sub} />
        <MapStat k="Plays" v={playsTile.v} sub={playsTile.sub} />
      </div>
      {/* F/C/B source caption — anchored immediately above the tiles it
          describes (specs/fcb-caption-proximity-plan.md §2a; supersedes the
          top-of-card placement from specs/fcb-caption-visibility-plan.md
          §4.4). Same tokens, quiet right-aligned micro-label. */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
        <span
          data-testid="fcb-caption"
          style={{
            fontFamily: T.mono,
            fontSize: 8.5,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: fcbCaption.isLive ? DEFAULT_ACCENT : T.pencilSoft,
          }}
        >
          {fcbCaption.text}
        </span>
      </div>
      <div data-testid="fcb-tile-row" style={{ display: "flex", gap: 8 }}>
        {fcbTiles.map((d) => (
          <div
            key={d.k}
            style={{
              flex: 1,
              padding: "10px 10px 8px",
              borderRadius: 10,
              border: `1px solid ${T.hairline}`,
              textAlign: "center",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: d.color }} />
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.2,
                color: T.pencil,
                textTransform: "uppercase",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  background: d.color,
                  border: d.k === "Center" ? `1px solid ${T.pencilSoft}` : "none",
                }}
              />
              {d.k}
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 22, color: T.ink, fontVariantNumeric: "tabular-nums" }}>{d.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MapStat({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>{k}</div>
      <div style={{ fontFamily: T.serif, fontSize: 20, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{v}</div>
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 0.8, color: T.pencil }}>{sub}</div>
    </div>
  );
}
