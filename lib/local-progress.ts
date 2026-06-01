const progressKeys = [
  "chessengineered_progress",
  "chessengineered_daily_streak_earned",
  "chessengineered_usage",
  "chessengineered_pending_training_activity",
];

export function clearLocalUserData() {
  for (const key of progressKeys) localStorage.removeItem(key);
  localStorage.removeItem("chessengineered_free_opening");
  localStorage.removeItem("chessengineered_progress_owner");
}

export function prepareLocalProgressForUser(userId: string) {
  const ownerKey = "chessengineered_progress_owner";
  const previousOwner = localStorage.getItem(ownerKey);
  if (previousOwner && previousOwner !== userId) clearLocalUserData();
  localStorage.setItem(ownerKey, userId);
}
