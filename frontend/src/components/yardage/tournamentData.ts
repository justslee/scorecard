// Sunday Cup tournament seed data — ported from the prototype's TournamentData.jsx
// A tight group that meets a few times a year. Real lore, handicaps, history.

export type TPlayer = {
  id: string;
  name: string;
  initial: string;
  hcp: number;
  tag: string;
  wins: number;
  color: string;
  titles: string[];
};

export type TCourse = { id: string; short: string; full: string; round: number; done: boolean; par: number; live?: boolean };

export const TOURNAMENT = {
  id: "sunday-cup-2024",
  name: "The Sunday Cup",
  subtitle: "Volume VII · Monterey Weekend",
  dates: "Fri Oct 11 — Sun Oct 13",
  yearsRunning: 7,
  currentRound: 2,
  totalRounds: 3,
  courses: [
    { id: "pb", short: "Pebble Beach", full: "Pebble Beach Golf Links", round: 1, done: true, par: 72 },
    { id: "sp", short: "Spyglass Hill", full: "Spyglass Hill", round: 2, done: false, par: 72, live: true },
    { id: "sb", short: "Spanish Bay", full: "Spanish Bay", round: 3, done: false, par: 72 },
  ] as TCourse[],
  format: "Stableford · Net",
  stakes: "$50 buy-in · $200 winner · $100 runner-up",
};

export const TPLAYERS: TPlayer[] = [
  { id: "you", name: "You", initial: "M", hcp: 8, tag: "Defending champ", wins: 2, color: "#1a2a1a", titles: ["2022", "2023"] },
  { id: "justin", name: "Justin", initial: "J", hcp: 12, tag: "Big-talker", wins: 1, color: "#6b3a1a", titles: ["2019"] },
  { id: "jack", name: "Jack", initial: "K", hcp: 4, tag: "Low man — scratch-adjacent", wins: 2, color: "#3a4a8a", titles: ["2020", "2021"] },
  { id: "mike", name: "Mike", initial: "M", hcp: 18, tag: "Most improved", wins: 0, color: "#6a3a3a", titles: [] },
  { id: "sam", name: "Sam", initial: "S", hcp: 6, tag: "The wildcard", wins: 1, color: "#3a6a4a", titles: ["2018"] },
  { id: "riley", name: "Riley", initial: "R", hcp: 14, tag: "First timer", wins: 0, color: "#6a6a3a", titles: [] },
];

export type TStanding = {
  pid: string;
  r1Gross: number;
  r1Net: number;
  r1Pts: number;
  r2Thru: number;
  r2Gross: number;
  r2Pts: number;
  skins: number;
  presses: string;
};

export const TSTANDINGS: TStanding[] = [
  { pid: "jack", r1Gross: 73, r1Net: 69, r1Pts: 39, r2Thru: 9, r2Gross: 38, r2Pts: 20, skins: 2, presses: "+$40" },
  { pid: "you", r1Gross: 79, r1Net: 71, r1Pts: 37, r2Thru: 9, r2Gross: 41, r2Pts: 18, skins: 1, presses: "+$20" },
  { pid: "sam", r1Gross: 76, r1Net: 70, r1Pts: 36, r2Thru: 9, r2Gross: 40, r2Pts: 17, skins: 3, presses: "\u2013" },
  { pid: "justin", r1Gross: 84, r1Net: 72, r1Pts: 33, r2Thru: 9, r2Gross: 44, r2Pts: 15, skins: 0, presses: "\u2013$50" },
  { pid: "riley", r1Gross: 91, r1Net: 77, r1Pts: 28, r2Thru: 9, r2Gross: 48, r2Pts: 14, skins: 1, presses: "\u2013$10" },
  { pid: "mike", r1Gross: 98, r1Net: 80, r1Pts: 24, r2Thru: 9, r2Gross: 50, r2Pts: 12, skins: 0, presses: "\u2013$20" },
];

export type TFeedItem = { t: string; who: string; what: string; note: string; hole: number };

export const TFEED: TFeedItem[] = [
  { t: "just now", who: "sam", what: "birdie", note: "8-footer on 8 for skin #3", hole: 8 },
  { t: "4m", who: "jack", what: "par", note: "clutch up-and-down on 9", hole: 9 },
  { t: "9m", who: "mike", what: "bogey", note: "first par save of the day", hole: 7 },
  { t: "14m", who: "you", what: "birdie", note: "stuck a 7-iron to 4 ft on 7", hole: 7 },
  { t: "22m", who: "justin", what: "double", note: "into the ocean off 6", hole: 6 },
  { t: "28m", who: "riley", what: "par", note: "first par of the weekend", hole: 5 },
];

export const TGAMES = [
  { id: "sk", name: "Skins", stake: "$5 / hole", leader: "Sam", leaderPts: "3", note: "4 carried over into 9" },
  { id: "na", name: "Nassau", stake: "$20·20·20", leader: "Jack", leaderPts: "+$40", note: "Front closed, back open, overall live" },
  { id: "sn", name: "Snake", stake: "$2 / 3-putt", leader: "Justin", leaderPts: "4 putts held", note: "Holding the snake since 4" },
  { id: "wp", name: "Wolf", stake: "Per-hole", leader: "You", leaderPts: "+12", note: "Lone wolf once, won" },
];

export const TGROUPS = [
  { id: "g1", time: "9:10 AM", players: ["you", "jack"], thru: 9 },
  { id: "g2", time: "9:20 AM", players: ["justin", "sam"], thru: 9 },
  { id: "g3", time: "9:30 AM", players: ["mike", "riley"], thru: 9 },
];

export function suffix(n: number) {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}
