"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { clearLocalUserData, prepareLocalProgressForUser } from "../../lib/local-progress";
import catalog from "../../data/openings-catalog.json";
import { Chess } from "chess.js";
import { ChessboardReact } from "../openings/[slug]/chessboard-react";
import "./profile.css";
import "../openings/openings-library.css"; // Share core token imports

type PieceSet = "staunty" | "maestro" | "standard";
type BoardTheme = "green" | "white-violet" | "white-blue" | "blue" | "brown" | "classic" | "black-and-white";

type AccuracyBucket = {
  learn: { correct: number; incorrect: number };
  practice: { correct: number; incorrect: number };
};

type AccuracyDaily = Record<string, AccuracyBucket>;

type AccuracyLine = {
  totals: AccuracyBucket;
  daily: AccuracyDaily;
};

type AccuracyOpening = {
  totals: AccuracyBucket;
  daily: AccuracyDaily;
  lines: Record<string, AccuracyLine>;
};

type AccuracyData = {
  totals: AccuracyBucket;
  daily: AccuracyDaily;
  openings: Record<string, AccuracyOpening>;
};

type Progress = Record<string, any> & {
  dailyStreak?: { count?: number; lastActiveDate?: string; activityDates?: Record<string, number> };
  trainingTime?: Record<string, number>;
  accuracy?: AccuracyData;
};

export default function ProfilePage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  
  // Auth state
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [userJoined, setUserJoined] = useState<string>("—");
  const [hasSubscription, setHasSubscription] = useState(false);
  const [subscriptionEnd, setSubscriptionEnd] = useState<string | null>(null);
  
  // Client stats / storage state
  const [progress, setProgress] = useState<Progress>({});
  const [usage, setUsage] = useState<Record<string, { count: number; lastUsed: number }>>({});
  
  // Settings state
  const [boardTheme, setBoardTheme] = useState<BoardTheme>("green");
  const [pieceSet, setPieceSet] = useState<PieceSet>("staunty");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [hintsEnabled, setHintsEnabled] = useState(true);
  const [streak, setStreak] = useState(0);
  const [streakOpen, setStreakOpen] = useState(false);

  // Accuracy controls
  const [accuracyMode, setAccuracyMode] = useState<"all" | "learn" | "practice">("all");
  const [accuracyOpening, setAccuracyOpening] = useState<string>("all");
  const [accuracyLine, setAccuracyLine] = useState<string>("all");

  const dummyGame = useMemo(() => new Chess(), []);

  useEffect(() => {
    setMounted(true);
    
    // Load local storage values
    try {
      const prog = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
      setProgress(prog);
      setStreak(Math.max(0, Math.round(Number(prog.dailyStreak?.count) || 0)));
      setUsage(JSON.parse(localStorage.getItem("chessengineered_usage") ?? "{}"));
      
      let localTheme = localStorage.getItem("chessengineered_board_theme") || localStorage.getItem("chessengineered_boardTheme") || "green";
      if (localTheme === "brown") localTheme = "chessboard-js";
      // Map legacy names
      if (localTheme === "default" || localTheme === "chessboard-js") {
        setBoardTheme("classic" as any);
      } else {
        setBoardTheme(localTheme as BoardTheme);
      }
      
      setPieceSet((localStorage.getItem("chessengineered_piece_set") || "staunty") as PieceSet);
      setSoundEnabled(localStorage.getItem("chessengineered_sound") !== "false");
      setHintsEnabled(localStorage.getItem("chessengineered_hints") !== "false");
    } catch {
      // ignore
    }

    if (!supabase) return;
    const client = supabase;

    const loadAccount = async () => {
      const {
        data: { user },
      } = await client.auth.getUser();

      if (!user) {
        // Redirect to login if not logged in
        router.replace("/login?next=/profile");
        return;
      }

      setSessionEmail(user.email ?? null);
      if (user.created_at) {
        setUserJoined(
          new Date(user.created_at).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })
        );
      }
      prepareLocalProgressForUser(user.id);

      // Fetch subscription & cloud progress
      const [{ data: subscription }, { data: profile }] = await Promise.all([
        client
          .from("subscriptions")
          .select("status, current_period_end")
          .eq("user_id", user.id)
          .maybeSingle(),
        client.from("profiles").select("user_progress").eq("id", user.id).maybeSingle(),
      ]);

      const paid =
        !!subscription &&
        ["active", "trialing"].includes(subscription.status) &&
        subscription.current_period_end &&
        new Date(subscription.current_period_end).getTime() > Date.now();

      setHasSubscription(!!paid);
      if (paid && subscription.current_period_end) {
        setSubscriptionEnd(new Date(subscription.current_period_end).toLocaleDateString());
      }

      if (profile?.user_progress) {
        try {
          const local = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
          const merged = mergeProgress(local, profile.user_progress);
          localStorage.setItem("chessengineered_progress", JSON.stringify(merged));
          setProgress(merged);
          setStreak(Math.max(0, Math.round(Number(merged.dailyStreak?.count) || 0)));
        } catch {
          // ignore
        }
      }
    };

    void loadAccount();
  }, [router]);

  // Merge logic helper
  function mergeProgress(local: any, cloud: any) {
    const merged = { ...(cloud || {}) };
    merged.trainingTime = mergeTrainingTime(local?.trainingTime, cloud?.trainingTime);
    merged.accuracy = mergeAccuracy(local?.accuracy, cloud?.accuracy);
    for (const slug in local || {}) {
      if (["puzzleELO", "puzzleStreak", "dailyStreak", "trainingTime", "accuracy"].includes(slug)) {
        if (merged[slug] === undefined) merged[slug] = local[slug];
        continue;
      }
      if (!merged[slug]) {
        merged[slug] = local[slug];
        continue;
      }
      const localLearned = local[slug].learnedLines || [];
      const cloudLearned = merged[slug].learnedLines || [];
      merged[slug].learnedLines = [...new Set([...cloudLearned, ...localLearned])];
      const localLines = local[slug].lines || {};
      const cloudLines = merged[slug].lines || {};
      for (const pgn in localLines) {
        cloudLines[pgn] = {
          ...cloudLines[pgn],
          ...localLines[pgn],
          completions: Math.max(Number(localLines[pgn]?.completions) || 0, Number(cloudLines[pgn]?.completions) || 0),
          practicePerfectAttempts: Math.max(Number(localLines[pgn]?.practicePerfectAttempts) || 0, Number(cloudLines[pgn]?.practicePerfectAttempts) || 0),
        };
      }
      merged[slug].lines = cloudLines;
    }
    return merged;
  }

  function mergeTrainingTime(local: any, cloud: any) {
    const modes = ["learn", "practice", "drill", "time", "puzzle"];
    const localTime = local && typeof local === "object" ? local : {};
    const cloudTime = cloud && typeof cloud === "object" ? cloud : {};
    return modes.reduce((acc: any, mode) => {
      acc[mode] = Math.max(Number(localTime[mode]) || 0, Number(cloudTime[mode]) || 0);
      return acc;
    }, {});
  }

  function mergeAccuracy(local: any, cloud: any) {
    return cloud || local || {};
  }

  // Settings Save Helpers
  function saveBoardAppearance(key: "boardTheme" | "pieceSet", value: string) {
    if (key === "boardTheme") {
      setBoardTheme(value as BoardTheme);
      localStorage.setItem("chessengineered_board_theme", value);
    } else {
      setPieceSet(value as PieceSet);
      localStorage.setItem("chessengineered_piece_set", value);
    }
  }

  function saveSetting(key: "sound" | "hints", value: boolean) {
    if (key === "sound") {
      setSoundEnabled(value);
      localStorage.setItem("chessengineered_sound", String(value));
    } else {
      setHintsEnabled(value);
      localStorage.setItem("chessengineered_hints", String(value));
    }
  }

  async function handleLogout() {
    if (!supabase) return;
    clearLocalUserData();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  // --- STATS DERIVATION ---
  const stats = useMemo(() => {
    const openingsPracticed = Object.keys(usage).length;
    let linesLearned = 0;
    for (const slug in progress) {
      if (!["puzzleELO", "puzzleStreak", "dailyStreak", "trainingTime", "accuracy"].includes(slug)) {
        linesLearned += progress[slug]?.learnedLines?.length || 0;
      }
    }

    const tTime = progress.trainingTime && typeof progress.trainingTime === "object" ? progress.trainingTime : {};
    const normalizedTime = {
      learn: Math.max(0, Math.round(Number(tTime.learn) || 0)),
      practice: Math.max(0, Math.round(Number(tTime.practice) || 0)),
      drill: Math.max(0, Math.round(Number(tTime.drill) || 0)),
      time: Math.max(0, Math.round(Number(tTime.time) || 0)),
      puzzle: Math.max(0, Math.round(Number(tTime.puzzle) || 0)),
    };
    const totalTimeMs = Object.values(normalizedTime).reduce((sum, value) => sum + value, 0);

    return {
      openingsPracticed,
      linesLearned,
      totalTimeMs,
      normalizedTime,
    };
  }, [progress, usage]);

  function formatDuration(ms: number) {
    if (ms > 0 && ms < 60000) return "<1m";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remMins = minutes % 60;
    return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  }

  // --- FAVORITE OPENINGS ---
  const favorites = useMemo(() => {
    return Object.entries(usage)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);
  }, [usage]);

  // --- HEATMAP ---
  const getPracticeActivityDates = (prog: Progress) => {
    const openingsObj = prog.accuracy?.openings && typeof prog.accuracy.openings === "object" ? prog.accuracy.openings : {};
    const dates: Record<string, number> = {};

    for (const opening of Object.values(openingsObj)) {
      const lines = opening?.lines && typeof opening.lines === "object" ? opening.lines : {};
      for (const line of Object.values(lines)) {
        const daily = line?.daily && typeof line.daily === "object" ? line.daily : {};
        for (const [date, bucket] of Object.entries(daily)) {
          const result = getBucketResult(bucket, "all");
          if (result.correct + result.incorrect > 0) {
            dates[date] = (dates[date] || 0) + 1;
          }
        }
      }
    }

    if (Object.keys(dates).length > 0) return dates;

    const fallback = prog.dailyStreak?.activityDates || {};
    return Object.entries(fallback).reduce((acc: Record<string, number>, [date, count]) => {
      acc[date] = Math.max(0, Math.round(Number(count) || 0));
      return acc;
    }, {});
  };

  const getBucketResult = (bucket: any, mode: "all" | "learn" | "practice") => {
    const learnCorrect = Math.max(0, Math.round(Number(bucket?.learn?.correct) || 0));
    const learnIncorrect = Math.max(0, Math.round(Number(bucket?.learn?.incorrect) || 0));
    const practiceCorrect = Math.max(0, Math.round(Number(bucket?.practice?.correct) || 0));
    const practiceIncorrect = Math.max(0, Math.round(Number(bucket?.practice?.incorrect) || 0));

    if (mode === "learn") return { correct: learnCorrect, incorrect: learnIncorrect };
    if (mode === "practice") return { correct: practiceCorrect, incorrect: practiceIncorrect };
    return {
      correct: learnCorrect + practiceCorrect,
      incorrect: learnIncorrect + practiceIncorrect,
    };
  };

  const getLocalDateKey = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const heatmapData = useMemo(() => {
    if (!mounted) return { cells: [], monthLabels: [] };
    const activityDates = getPracticeActivityDates(progress);

    const weeks = 53;
    const days = 7;
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0);
    endDate.setDate(endDate.getDate() - (endDate.getDay() || 7) + 7); // Next Sunday
    const startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - (weeks * days - 1));

    const monthLabels = [];
    let previousMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const weekDate = new Date(startDate);
      weekDate.setDate(startDate.getDate() + w * days);
      const month = weekDate.getMonth();
      if (w === 0 || month !== previousMonth) {
        const label = weekDate.toLocaleDateString("en-US", { month: "short" });
        monthLabels.push({ label, col: w + 1 });
      }
      previousMonth = month;
    }

    const cells = [];
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < days; d++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + w * days + d);
        const dateStr = getLocalDateKey(date);

        const count = Number(activityDates[dateStr]) || 0;
        let intensity = 0;
        if (count > 0) intensity = 1;
        if (count >= 2) intensity = 2;
        if (count >= 4) intensity = 3;
        if (count >= 7) intensity = 4;

        const tooltip = `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ${count} ${count === 1 ? "line" : "lines"} practiced`;
        cells.push({ w, d, intensity, tooltip });
      }
    }

    return { cells, monthLabels, weeks };
  }, [progress, mounted]);

  // --- ACCURACY CHART ---
  const accuracyFilterOptions = useMemo(() => {
    const accuracy = progress.accuracy;
    if (!accuracy?.openings || Object.keys(accuracy.openings).length === 0) {
      return null;
    }
    const slugs = Object.keys(accuracy.openings).sort((a, b) => {
      const an = (catalog.openings as any)[a]?.displayName || a;
      const bn = (catalog.openings as any)[b]?.displayName || b;
      return an.localeCompare(bn);
    });

    const lines: string[] = [];
    if (accuracyOpening !== "all" && accuracy.openings[accuracyOpening]?.lines) {
      const rawLines = Object.keys(accuracy.openings[accuracyOpening].lines);
      // Sort lines according to catalog indices
      const catalogLines = (catalog.openings as any)[accuracyOpening]?.lines || [];
      lines.push(
        ...rawLines.sort((a, b) => {
          const ai = catalogLines.findIndex((line: string) => line.trim() === a.trim());
          const bi = catalogLines.findIndex((line: string) => line.trim() === b.trim());
          if (ai >= 0 && bi >= 0) return ai - bi;
          if (ai >= 0) return -1;
          if (bi >= 0) return 1;
          return a.localeCompare(b);
        })
      );
    }

    return { openings: slugs, lines };
  }, [progress, accuracyOpening]);

  const accuracyChartPoints = useMemo(() => {
    const accuracy = progress.accuracy;
    if (!accuracy) return null;

    const daily =
      accuracyOpening === "all"
        ? accuracy.daily
        : accuracyLine === "all"
          ? accuracy.openings[accuracyOpening]?.daily
          : accuracy.openings[accuracyOpening]?.lines?.[accuracyLine]?.daily;

    if (!daily) return null;

    // Get 14 recent dates
    const dates = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      dates.push(getLocalDateKey(date));
    }

    const points = dates.map((date) => {
      const bucket = daily[date] || { learn: { correct: 0, incorrect: 0 }, practice: { correct: 0, incorrect: 0 } };
      const result = getBucketResult(bucket, accuracyMode);
      return {
        date,
        label: date.slice(5).replace("-", "/"),
        correct: result.correct,
        incorrect: result.incorrect,
        total: result.correct + result.incorrect,
      };
    });

    const maxTotal = Math.max(1, ...points.map((p) => p.total));
    const totalCorrect = points.reduce((sum, p) => sum + p.correct, 0);
    const totalIncorrect = points.reduce((sum, p) => sum + p.incorrect, 0);
    const totalCount = totalCorrect + totalIncorrect;
    const accuracyPercent = totalCount ? Math.round((totalCorrect / totalCount) * 100) : 0;

    return { points, maxTotal, totalCorrect, totalIncorrect, accuracyPercent };
  }, [progress, accuracyOpening, accuracyLine, accuracyMode]);

  function getLineLabel(slug: string, linePgn: string) {
    const lines = (catalog.openings as any)[slug]?.lines || [];
    const index = lines.findIndex((line: string) => line.trim() === linePgn.trim());
    return index >= 0 ? `Line ${index + 1}` : `Line ${linePgn.slice(0, 15)}...`;
  }

  // --- LEADERBOARD WEEKDATES ---
  const streakDetails = useMemo(() => {
    if (typeof window === "undefined" || !mounted) {
      return { count: 0, lastActiveDate: null, activityDates: {} };
    }
    const streakObj = progress.dailyStreak ?? {};
    return {
      count: Math.max(0, Math.round(Number(streakObj.count) || 0)),
      lastActiveDate: typeof streakObj.lastActiveDate === "string" ? streakObj.lastActiveDate : null,
      activityDates: streakObj.activityDates && typeof streakObj.activityDates === "object" ? streakObj.activityDates : {}
    };
  }, [progress, mounted]);

  const weekDays = useMemo(() => {
    if (!mounted) return [];
    const labels = ["S", "M", "T", "W", "T", "F", "S"];
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay());
    return labels.map((label, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = getLocalDateKey(day);
      const active = Number(streakDetails.activityDates?.[key]) > 0;
      const isToday = key === getLocalDateKey(today);
      return { label, key, active, isToday };
    });
  }, [streakDetails, mounted]);

  const todayDone = streakDetails.lastActiveDate === getLocalDateKey();

  if (!mounted) {
    return (
      <div className="profile-wrap" style={{ minHeight: "100vh", display: "flex", justifyContent: "center", alignItems: "center" }}>
        <p style={{ color: "var(--color-muted)" }}>Loading profile...</p>
      </div>
    );
  }

  const username = sessionEmail ? sessionEmail.split("@")[0] : "Guest";
  const avatarLetter = username.charAt(0).toUpperCase();

  return (
    <div className="app-shell" style={{ position: "relative" }}>
      {/* NAV */}
      <nav>
        <div className="nav-shell">
          <Link href="/openings" className="nav-logo" aria-label="ChessEngineered home">
            <span className="nav-logo-mark" aria-hidden="true">
              <svg height="100%" width="100%" viewBox="0 0 962 1973" xmlns="http://www.w3.org/2000/svg">
                <path fillRule="evenodd" clipRule="evenodd" d="M260.013 382.733L182.267 165.24L354.227 210.947L475.627 0.0401493L598.907 214.787L773.933 165.24L696.826 380.947C636.506 335.054 561.24 307.787 479.6 307.787C396.893 307.787 320.733 335.76 260.013 382.733Z" fill="#FBBF24"/>
                <path fillRule="evenodd" clipRule="evenodd" d="M480.067 401.747C619.853 401.747 733.173 515.067 733.173 654.853C733.173 740.693 690.427 816.547 625.067 862.307H676.12C699.52 862.307 718.653 881.453 718.653 904.84C718.653 928.24 699.52 947.373 676.12 947.373H635.28C635.28 947.373 577.187 1320.81 788.813 1474.35V1538.67C788.813 1538.67 927.813 1644.48 929.893 1700.49C931.96 1756.51 919.52 1783.48 919.52 1783.48C919.52 1783.48 977.613 1862.32 956.867 1920.41C937.867 1973.57 547.04 1972.87 480.92 1972.37C414.8 1972.87 23.96 1973.57 4.96001 1920.41C-15.7867 1862.32 42.3066 1783.48 42.3066 1783.48C42.3066 1783.48 29.8666 1756.51 31.9333 1700.49C34.0133 1644.48 173.013 1538.67 173.013 1538.67V1474.35C384.64 1320.81 326.547 947.373 326.547 947.373H290.227C266.84 947.373 247.693 928.24 247.693 904.84C247.693 881.453 266.84 862.307 290.227 862.307H335.067C269.693 816.547 226.947 740.693 226.947 654.853C226.947 515.067 340.28 401.747 480.067 401.747Z" fill="white"/>
              </svg>
            </span>
            <span className="nav-wordmark nav-wordmark-mobile">chessengineered</span>
            <span className="nav-wordmark nav-wordmark-desktop">chessengineered.com</span>
          </Link>

          <div className="nav-right">
            {!hasSubscription && <Link className="nav-primary-link" href="/plans"><span>Upgrade Now</span></Link>}
            <div id="userMenu">
              {sessionEmail ? (
                <button className="nav-icon-btn" onClick={handleLogout} title="Log out" type="button" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span className="account-email" style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>{sessionEmail}</span>
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ width: "20px", height: "20px" }}>
                    <path d="M16 17v-3H9v-4h7V7l5 5-5 5M14 2a2 2 0 0 1 2 2v2h-2V4H5v16h9v-2h2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9z"/>
                  </svg>
                </button>
              ) : (
                <Link className="nav-primary-link" href="/login" style={{ background: "var(--color-paper-3)", border: "1px solid var(--color-rule)", color: "var(--color-ink)" }}>
                  <span>Log In</span>
                </Link>
              )}
            </div>
            {sessionEmail && (
              <Link className="nav-icon-btn nav-leaderboard" href="/profile" aria-label="Profile stats">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ width: "20px", height: "20px" }}>
                  <path d="M21.083 4.585a2.62 2.62 0 0 0-1.904-.69h-1.426a2.7 2.7 0 0 0-.768-1.162a2.68 2.68 0 0 0-1.924-.69H8.979a2.7 2.7 0 0 0-1.994.69a2.6 2.6 0 0 0-.748 1.161H4.831a2.64 2.64 0 0 0-1.934.69A2.73 2.73 0 0 0 2 6.497a7.6 7.6 0 0 0 .997 3.682a8.4 8.4 0 0 0 2.642 2.862l.848.57l.638.391a6.2 6.2 0 0 0 2.083 2.002v1.76H8.82c-.714 0-1.4.285-1.904.792a2.7 2.7 0 0 0-.788 1.91v.33a1.23 1.23 0 0 0 .359.881c.233.232.549.361.877.36h9.272a1.22 1.22 0 0 0 1.145-.764c.062-.15.093-.313.091-.476v-.33a2.7 2.7 0 0 0-.788-1.91a2.7 2.7 0 0 0-1.903-.792h-.39v-1.771a6.2 6.2 0 0 0 2.094-2.002l.658-.4l.808-.55a8.5 8.5 0 0 0 2.652-2.873A7.7 7.7 0 0 0 22 6.447a2.76 2.76 0 0 0-.917-1.861M4.303 9.458a6.1 6.1 0 0 1-.768-2.902a1.22 1.22 0 0 1 .825-1.08c.151-.05.312-.072.471-.06h1.306v5.343q.013.427.07.85a6.8 6.8 0 0 1-1.904-2.151m15.414 0a7.15 7.15 0 0 1-1.904 2.152q.057-.435.07-.871V5.415h1.335a1.15 1.15 0 0 1 .868.31c.227.2.37.48.399.781a6.2 6.2 0 0 1-.768 2.952"/>
                </svg>
              </Link>
            )}
            <button className="daily-streak-card" type="button" id="dailyStreakCard" aria-label="Daily streak" onClick={() => setStreakOpen(!streakOpen)}>
              <span className="daily-streak-flame" aria-hidden="true">
                <svg viewBox="0 0 70 85" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4 50.5C4 67.2 17.9 80.8 35 80.8S66 67.2 66 50.5c0-7.1-2.5-13.5-6.6-18.7L39.5 6.6a5.74 5.74 0 0 0-9 0L19.2 20.9l-6.4-4A5.75 5.75 0 0 0 4 21.7v28.8Z" fill="#FF9600"/>
                  <path d="M24.6 47.6c.1-.1.1-.1.1-.2l8.4-10.5a2.47 2.47 0 0 1 3.8 0l8.4 10.5.1.2a12.66 12.66 0 0 1 2.8 8c0 7.1-5.9 12.9-13.2 12.9s-13.2-5.8-13.2-12.9c0-3 1-5.8 2.8-8Z" fill="#FFC800"/>
                </svg>
              </span>
              <span className="daily-streak-count" id="dailyStreakCount">{streak}</span>
            </button>
            
            {/* Daily Streak Popover */}
            {streakOpen && (
              <div className="daily-streak-popover" id="dailyStreakPopover" role="dialog" aria-label="Daily streak details">
                <div className="daily-streak-popover-top">
                  <div className="daily-streak-popover-copy">
                    <strong id="dailyStreakPopoverTitle">{streakDetails.count} day streak</strong>
                    <span id="dailyStreakPopoverSub">
                      {todayDone ? "You've done your line for today!" : "Complete one line today to start."}
                    </span>
                  </div>
                  <div className="daily-streak-popover-flame" aria-hidden="true">
                    <svg viewBox="0 0 70 85" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M4 50.5C4 67.2 17.9 80.8 35 80.8S66 67.2 66 50.5c0-7.1-2.5-13.5-6.6-18.7L39.5 6.6a5.74 5.74 0 0 0-9 0L19.2 20.9l-6.4-4A5.75 5.75 0 0 0 4 21.7v28.8Z" fill="#FF9600"/>
                      <path d="M24.6 47.6c.1-.1.1-.1.1-.2l8.4-10.5a2.47 2.47 0 0 1 3.8 0l8.4 10.5.1.2a12.66 12.66 0 0 1 2.8 8c0 7.1-5.9 12.9-13.2 12.9s-13.2-5.8-13.2-12.9c0-3 1-5.8 2.8-8Z" fill="#FFC800"/>
                    </svg>
                  </div>
                </div>
                <div className="daily-week-grid" id="dailyWeekGrid">
                  {weekDays.map((day: any) => (
                    <div className={`daily-week-day ${day.isToday ? "today" : ""}`} key={day.key}>
                      <span>{day.label}</span>
                      <div className={`daily-week-dot ${day.active ? "active" : ""}`} title={day.key}>
                        {day.active && (
                          <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                            <path d="M9.765 3.205a.75.75 0 0 1 .03 1.06l-4.25 4.5a.75.75 0 0 1-1.075.015L2.22 6.53a.75.75 0 0 1 1.06-1.06l1.705 1.704l3.72-3.939a.75.75 0 0 1 1.06-.03"/>
                          </svg>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* BODY CONTENT */}
      <div className="profile-wrap">
        {/* Profile Header */}
        <div className="profile-header">
          <div className="profile-avatar">{avatarLetter}</div>
          <div className="profile-info">
            <h1 className="profile-name">{username}</h1>
            <p className="profile-email">{sessionEmail}</p>
            <p className="profile-meta">Member since <span>{userJoined}</span></p>
          </div>
          {!hasSubscription && (
            <Link href="/plans" className="nav-primary-link" style={{ flexShrink: 0 }}>
              Upgrade to Unlimited
            </Link>
          )}
        </div>

        {/* Subscription Card */}
        <div className="profile-card">
          <h2 className="card-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            Subscription
          </h2>
          <div className="subscription-status">
            {hasSubscription ? (
              <>
                <span className="status-badge status-active">Unlimited Pass</span>
                <span className="status-text">Active until {subscriptionEnd}</span>
              </>
            ) : (
              <>
                <span className="status-badge status-free">Free</span>
                <span className="status-text">1 opening unlocked</span>
              </>
            )}
          </div>
          <p className="subscription-desc">
            {hasSubscription
              ? "You have full access to all openings and features."
              : "Upgrade to unlock all 30+ openings and sync across devices."}
          </p>
          <div className="subscription-actions">
            {hasSubscription ? (
              <a href="https://billing.stripe.com/p/login/test" className="nav-primary-link" style={{ background: "var(--color-paper-3)", border: "1px solid var(--color-rule)", color: "var(--color-ink)" }}>
                Manage Subscription
              </a>
            ) : (
              <Link href="/plans" className="nav-primary-link">
                Upgrade — $11.99/year
              </Link>
            )}
          </div>
        </div>

        {/* Stats Grid */}
        <div className="stats-grid">
          <div className="stat-box">
            <span className="stat-value">{stats.openingsPracticed}</span>
            <span className="stat-label">Openings practiced</span>
          </div>
          <div className="stat-box">
            <span className="stat-value">{stats.linesLearned}</span>
            <span className="stat-label">Lines learned</span>
          </div>
          <div className="stat-box">
            <span className="stat-value">{streak}</span>
            <span className="stat-label">Day streak</span>
          </div>
          <div className="stat-box">
            <span className="stat-value">{formatDuration(stats.totalTimeMs)}</span>
            <span className="stat-label">Time trained</span>
          </div>
        </div>

        {/* Training Time */}
        <div className="profile-card training-time-card">
          <h2 className="card-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            Training time
          </h2>
          <div className="training-time-list">
            <div className="training-time-row">
              <span>Learn</span>
              <strong>{formatDuration(stats.normalizedTime.learn)}</strong>
            </div>
            <div className="training-time-row">
              <span>Practice</span>
              <strong>{formatDuration(stats.normalizedTime.practice)}</strong>
            </div>
            <div className="training-time-row">
              <span>Drill</span>
              <strong>{formatDuration(stats.normalizedTime.drill)}</strong>
            </div>
            <div className="training-time-row">
              <span>Time Trials</span>
              <strong>{formatDuration(stats.normalizedTime.time)}</strong>
            </div>
            <div className="training-time-row">
              <span>Puzzles</span>
              <strong>{formatDuration(stats.normalizedTime.puzzle)}</strong>
            </div>
          </div>
        </div>

        {/* Accuracy Chart */}
        {accuracyChartPoints && (
          <div className="profile-card accuracy-card">
            <h2 className="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18"/>
                <path d="m19 9-5 5-4-4-4 4"/>
              </svg>
              Accuracy over time
            </h2>
            <div className="accuracy-controls">
              <label>
                <span>Mode</span>
                <select
                  value={accuracyMode}
                  onChange={(e) => setAccuracyMode(e.target.value as any)}
                >
                  <option value="all">All</option>
                  <option value="learn">Learn</option>
                  <option value="practice">Practice</option>
                </select>
              </label>
              {accuracyFilterOptions && (
                <>
                  <label>
                    <span>Opening</span>
                    <select
                      value={accuracyOpening}
                      onChange={(e) => {
                        setAccuracyOpening(e.target.value);
                        setAccuracyLine("all");
                      }}
                    >
                      <option value="all">All openings</option>
                      {accuracyFilterOptions.openings.map((slug) => (
                        <option value={slug} key={slug}>
                          {(catalog.openings as any)[slug]?.displayName || slug}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Line</span>
                    <select
                      value={accuracyLine}
                      disabled={accuracyOpening === "all"}
                      onChange={(e) => setAccuracyLine(e.target.value)}
                    >
                      <option value="all">All lines</option>
                      {accuracyFilterOptions.lines.map((linePgn, idx) => (
                        <option value={linePgn} key={linePgn}>
                          {getLineLabel(accuracyOpening, linePgn)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>

            <div className="accuracy-chart">
              <svg viewBox="0 0 560 180" role="img" aria-label="Accuracy chart">
                <line x1="24" y1="152" x2="536" y2="152" className="accuracy-axis" />
                {accuracyChartPoints.points.map((pt, idx) => {
                  const barWidth = (560 - 24 * 2 - 8 * 13) / 14;
                  const x = 24 + idx * (barWidth + 8);
                  const chartHeight = 128;
                  const correctHeight = chartHeight * (pt.correct / accuracyChartPoints.maxTotal);
                  const incorrectHeight = chartHeight * (pt.incorrect / accuracyChartPoints.maxTotal);
                  const incorrectY = 24 + chartHeight - incorrectHeight;
                  const correctY = incorrectY - correctHeight;
                  return (
                    <g key={pt.date}>
                      <rect x={x} y={correctY} width={barWidth} height={correctHeight} rx="2" className="accuracy-correct" />
                      <rect x={x} y={incorrectY} width={barWidth} height={incorrectHeight} rx="2" className="accuracy-incorrect" />
                      <text x={x + barWidth / 2} y="168" textAnchor="middle">{pt.label}</text>
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="accuracy-summary">
              <span><b>{accuracyChartPoints.totalCorrect}</b> correct</span>
              <span><b>{accuracyChartPoints.totalIncorrect}</b> errors</span>
              <span><b>{accuracyChartPoints.accuracyPercent}%</b> accuracy</span>
            </div>
          </div>
        )}

        {/* Activity Heatmap */}
        <div className="profile-card activity-card">
          <div className="activity-heading">
            <span>Activity</span>
            <div className="activity-legend" aria-label="Activity intensity">
              <span>Less</span>
              <i className="activity-legend-cell level-0"></i>
              <i className="activity-legend-cell level-1"></i>
              <i className="activity-legend-cell level-2"></i>
              <i className="activity-legend-cell level-3"></i>
              <i className="activity-legend-cell level-4"></i>
              <span>More</span>
            </div>
          </div>
          <div className="activity-chart">
            <div className="activity-layout">
              <div className="activity-weekdays" aria-hidden="true">
                <span></span>
                <span>Mon</span>
                <span></span>
                <span>Wed</span>
                <span></span>
                <span>Fri</span>
                <span></span>
              </div>
              <div className="activity-scroll">
                <div
                  className="activity-month-row"
                  style={{ gridTemplateColumns: `repeat(${heatmapData.weeks}, 1fr)` }}
                >
                  {heatmapData.monthLabels.map((lbl, idx) => (
                    <span key={idx} style={{ gridColumn: lbl.col }}>{lbl.label}</span>
                  ))}
                </div>
                <div
                  className="activity-grid"
                  style={{ gridTemplateColumns: `repeat(${heatmapData.weeks}, 1fr)` }}
                >
                  {heatmapData.cells.map((cell, idx) => (
                    <div
                      key={idx}
                      className={`activity-cell level-${cell.intensity}`}
                      style={{ gridArea: `${cell.d + 1} / ${cell.w + 1}` }}
                      data-tooltip={cell.tooltip}
                      aria-label={cell.tooltip}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Favorite Openings */}
        {favorites.length > 0 && (
          <div className="profile-card">
            <h2 className="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
              </svg>
              Most practiced
            </h2>
            <div className="favorites-list">
              {favorites.map(([slug, data]) => (
                <Link className="favorite-item" href={`/opening/${slug}`} key={slug}>
                  <img src={`/boards/${slug}.png`} alt={slug} className="favorite-thumb" />
                  <div className="favorite-info">
                    <span className="favorite-name">
                      {slug.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())}
                    </span>
                    <span className="favorite-count">{data.count || 0} sessions</span>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 18 6-6-6-6"/>
                  </svg>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Settings */}
        <div className="profile-card">
          <h2 className="card-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            Settings
          </h2>

          <section className="board-appearance">
            <h3 className="settings-section-title">Board Appearance</h3>
            <div className="appearance-row">
              <span className="appearance-label">Board Color</span>
              <label className="appearance-select-wrap">
                <select
                  className="appearance-select"
                  value={boardTheme}
                  onChange={(e) => saveBoardAppearance("boardTheme", e.target.value)}
                >
                  <option value="green">Green</option>
                  <option value="white-violet">White Violet</option>
                  <option value="white-blue">White Blue</option>
                  <option value="blue">Blue</option>
                  <option value="classic">Classic</option>
                  <option value="black-and-white">Black & White</option>
                </select>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
              </label>
            </div>
            <div className="appearance-row">
              <span className="appearance-label">Piece Set</span>
              <label className="appearance-select-wrap">
                <select
                  className="appearance-select"
                  value={pieceSet}
                  onChange={(e) => saveBoardAppearance("pieceSet", e.target.value)}
                >
                  <option value="staunty">Staunty</option>
                  <option value="maestro">Maestro</option>
                  <option value="standard">Standard</option>
                </select>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
              </label>
            </div>
            <div className="board-preview-wrap">
              <div className="board-preview" id="boardAppearancePreview">
                <ChessboardReact
                  position="rn1qkbnr/ppp1pppp/8/3p4/3P4/2N2N2/PPP1PPPP/R1BQKB1R b KQkq - 2 3"
                  orientation="w"
                  pieceSet={pieceSet}
                  boardTheme={boardTheme}
                  inputEnabled={false}
                  inputColor="w"
                  gameInstance={dummyGame}
                />
              </div>
            </div>
          </section>

          <div className="settings-list">
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">Sound effects</span>
                <span className="setting-desc">Play sounds on move and capture</span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={(e) => saveSetting("sound", e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">Show hints</span>
                <span className="setting-desc">Display move hints during practice</span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={hintsEnabled}
                  onChange={(e) => saveSetting("hints", e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
            <div className="setting-divider"></div>
            <div className="setting-row setting-danger">
              <button className="btn btn-ghost" onClick={handleLogout} style={{ display: "flex", gap: "8px", alignItems: "center", color: "var(--color-danger)", background: "transparent", border: "none", cursor: "pointer", font: "inherit" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" x2="9" y1="12" y2="12"/>
                </svg>
                Log out
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
