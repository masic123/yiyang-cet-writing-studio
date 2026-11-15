export type LeaderboardEntry = {
  rank: number;
  name: string;
  points: number;
  attempts: number;
  isMe: boolean;
  isVip: boolean;
};
export type LeaderboardSummary = { rank: number | null; points: number; attempts: number };
export type LeaderboardData = {
  date: string;
  timezone: "Asia/Shanghai";
  daily: LeaderboardEntry[];
  total: LeaderboardEntry[];
  mine: { daily: LeaderboardSummary; total: LeaderboardSummary } | null;
};
