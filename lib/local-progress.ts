import { clearCachedOpenings } from "./opening-cache";

const progressKeys = [
  "chessengineered_progress",
  "chessengineered_daily_streak_earned",
  "chessengineered_usage",
  "chessengineered_pending_training_activity",
  "chessengineered_resume_lines",
];

export function clearLocalUserData() {
  for (const key of progressKeys) localStorage.removeItem(key);
  clearCachedOpenings();
  localStorage.removeItem("chessengineered_free_opening");
  localStorage.removeItem("chessengineered_progress_owner");
}

export function prepareLocalProgressForUser(userId: string) {
  const ownerKey = "chessengineered_progress_owner";
  const previousOwner = localStorage.getItem(ownerKey);
  if (previousOwner && previousOwner !== userId) clearLocalUserData();
  localStorage.setItem(ownerKey, userId);
}
