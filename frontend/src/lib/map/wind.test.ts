import { describe, it, expect } from "vitest";
import { bearingDeg, relativeWind, playsLikeYards, compassFrom } from "./wind";

describe("bearingDeg", () => {
  it("due north ≈ 0°, due east ≈ 90°", () => {
    expect(bearingDeg({ lat: 40, lng: -73 }, { lat: 41, lng: -73 })).toBeCloseTo(0, 0);
    expect(bearingDeg({ lat: 40, lng: -73 }, { lat: 40, lng: -72 })).toBeCloseTo(90, 0);
  });
});

describe("relativeWind (golfer on the tee, facing the green)", () => {
  // Hole plays due north (bearing 0).
  it("wind FROM the north = headwind ('into')", () => {
    const w = relativeWind(0, 0, 10);
    expect(w.label).toBe("into");
    expect(w.headMph).toBeCloseTo(10, 1);
  });

  it("wind FROM the south = tailwind ('help')", () => {
    const w = relativeWind(180, 0, 10);
    expect(w.label).toBe("help");
    expect(w.headMph).toBeCloseTo(-10, 1);
  });

  it("wind FROM the west blows toward the right of play = L→R", () => {
    const w = relativeWind(270, 0, 10);
    expect(w.label).toBe("L→R");
    expect(w.headMph).toBeCloseTo(0, 1);
  });

  it("wind FROM the east = R→L", () => {
    expect(relativeWind(90, 0, 10).label).toBe("R→L");
  });

  it("quartering headwind gets the combined label", () => {
    // From the northwest on a north-playing hole: into + from the left.
    expect(relativeWind(315, 0, 10).label).toBe("into·L→R");
  });

  it("the SAME weather reads differently on holes with different bearings", () => {
    // The owner's exact complaint: values never changed hole to hole.
    const northHole = relativeWind(0, 0, 10);
    const southHole = relativeWind(0, 180, 10);
    expect(northHole.label).toBe("into");
    expect(southHole.label).toBe("help");
  });

  it("under 2mph is calm", () => {
    expect(relativeWind(123, 45, 1.5)).toEqual({ label: "calm", headMph: 0 });
  });
});

describe("playsLikeYards", () => {
  it("headwind plays longer, tailwind shorter, asymmetric", () => {
    expect(playsLikeYards(400, 10)).toBe(432); // +8%
    expect(playsLikeYards(400, -10)).toBe(380); // −5%
    expect(playsLikeYards(400, 0)).toBe(400);
  });

  it("clamps at ±15%", () => {
    expect(playsLikeYards(400, 40)).toBe(460);
    expect(playsLikeYards(400, -40)).toBe(340);
  });
});

describe("compassFrom", () => {
  it("maps degrees to points", () => {
    expect(compassFrom(0)).toBe("N");
    expect(compassFrom(90)).toBe("E");
    expect(compassFrom(225)).toBe("SW");
    expect(compassFrom(359)).toBe("N");
  });
});
