"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { clearLocalUserData, prepareLocalProgressForUser } from "../../lib/local-progress";
import { loadCloudProgress, readCachedProgress } from "../../lib/cloud-progress";

type Opening = {
  id: string;
  displayName: string;
  playerSide: string;
  lineCount: number;
  description: string;
};

type Openings = Record<string, Opening>;
type SideFilter = "all" | "w" | "b";
type Progress = Record<
  string,
  { learnedLines?: string[]; lines?: Record<string, { practicePerfectAttempts?: number }> }
>;

const boardImageNames: Record<string, string> = {
  "bishop-s-opening": "bishops-opening",
  "king-s-gambit": "kings-gambit",
  "king-s-indian-defense": "kings-indian-defense",
  "queen-s-gambit-accepted": "queens-gambit-accepted",
  "queen-s-gambit-declined": "queens-gambit-declined",
};

function readProgress(): Progress {
  return readCachedProgress() as Progress;
}

function readStreak() {
  try {
    const progress = readProgress() as Progress & {
      dailyStreak?: { count?: number; lastActiveDate?: string };
    };
    return Math.max(0, Math.round(Number(progress.dailyStreak?.count) || 0));
  } catch {
    return 0;
  }
}

function compactDescription(description: string) {
  const firstSentence = description.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? description;
  return firstSentence.length > 150 ? `${firstSentence.slice(0, 147)}...` : firstSentence;
}

function BoardPreview({ side, slug }: { side: string; slug: string }) {
  const imageName = boardImageNames[slug] ?? slug;

  return (
    <div className={`board-preview board-${side === "w" ? "white" : "black"}`}>
      <img alt="" src={`/boards/${imageName}.png`} />
    </div>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      ♜
    </span>
  );
}

export function OpeningsLibrary({ openings }: { openings: Openings }) {
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<SideFilter>("all");
  const [progress, setProgress] = useState<Progress>({});
  const [freeOpening, setFreeOpening] = useState<string | null>(null);
  const [hasSubscription, setHasSubscription] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);
  const [streakOpen, setStreakOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [usage, setUsage] = useState<Record<string, { count: number; lastUsed: number }>>({});
  const [showCheckoutSuccess, setShowCheckoutSuccess] = useState(false);
  const [showUnlockOverlay, setShowUnlockOverlay] = useState(false);

  useEffect(() => {
    setMounted(true);
    setProgress(readProgress());
    setStreak(readStreak());
    setFreeOpening(localStorage.getItem("chessengineered_free_opening"));

    try {
      setUsage(JSON.parse(localStorage.getItem("chessengineered_usage") ?? "{}"));
    } catch {
      setUsage({});
    }

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("checkout") === "success") {
      setShowCheckoutSuccess(true);
      const sessionId = urlParams.get("session_id");
      if (sessionId) {
        const confirmCheckoutSession = async () => {
          if (!supabase) return;
          const { data: { session } } = await supabase.auth.getSession();
          const accessToken = session?.access_token;
          if (!accessToken) return;

          const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/confirm-checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + accessToken
            },
            body: JSON.stringify({ sessionId })
          });

          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "Unable to confirm checkout");
          }

          setShowUnlockOverlay(true);
          setHasSubscription(true);
          setTimeout(() => setShowUnlockOverlay(false), 1900);
        };
        void confirmCheckoutSession().catch((err) =>
          console.warn("Checkout confirmation failed:", err.message),
        );
      }
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (!supabase) return;
    const client = supabase;

    const loadAccount = async () => {
      const {
        data: { user },
      } = await client.auth.getUser();

      setSessionEmail(user?.email ?? null);
      if (!user) {
        setProgress(readProgress());
        setStreak(readStreak());
        return;
      }
      prepareLocalProgressForUser(user.id);
      setProgress(readProgress());
      setStreak(readStreak());
      try {
        setUsage(JSON.parse(localStorage.getItem("chessengineered_usage") ?? "{}"));
      } catch {
        setUsage({});
      }

      const [{ data: subscription }, { data: profile }, cloudProgress] = await Promise.all([
        client
          .from("subscriptions")
          .select("status, current_period_end")
          .eq("user_id", user.id)
          .maybeSingle(),
        client.from("profiles").select("free_opening_slug").eq("id", user.id).maybeSingle(),
        loadCloudProgress(client, user.id).catch(() => null),
      ]);

      const paid =
        !!subscription &&
        ["active", "trialing"].includes(subscription.status) &&
        subscription.current_period_end &&
        new Date(subscription.current_period_end).getTime() > Date.now();

      setHasSubscription(!!paid);
      setFreeOpening(profile?.free_opening_slug ?? null);
      if (cloudProgress) {
        setProgress(cloudProgress as Progress);
        setStreak(Math.max(0, Math.round(Number(cloudProgress.dailyStreak?.count) || 0)));
        if (cloudProgress.openingUsage && typeof cloudProgress.openingUsage === "object") {
          setUsage(cloudProgress.openingUsage);
          localStorage.setItem("chessengineered_usage", JSON.stringify(cloudProgress.openingUsage));
        }
      }
    };

    void loadAccount();
    const { data } = client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") clearLocalUserData();
      void loadAccount();
    });
    return () => {
      if (data && data.subscription) {
        data.subscription.unsubscribe();
      }
    };
  }, []);

  function trackOpeningUsage(slug: string) {
    const newUsage = { ...usage };
    if (!newUsage[slug]) {
      newUsage[slug] = { count: 0, lastUsed: 0 };
    }
    newUsage[slug].count += 1;
    newUsage[slug].lastUsed = Date.now();
    setUsage(newUsage);
    localStorage.setItem("chessengineered_usage", JSON.stringify(newUsage));
  }

  const streakDetails = useMemo(() => {
    if (typeof window === "undefined" || !mounted) {
      return { count: 0, lastActiveDate: null, activityDates: {} };
    }
    try {
      const raw = localStorage.getItem("chessengineered_progress") ?? "{}";
      const progressObj = JSON.parse(raw);
      const streakObj = progressObj.dailyStreak ?? {};
      return {
        count: Math.max(0, Math.round(Number(streakObj.count) || 0)),
        lastActiveDate: typeof streakObj.lastActiveDate === "string" ? streakObj.lastActiveDate : null,
        activityDates: streakObj.activityDates && typeof streakObj.activityDates === "object" ? streakObj.activityDates : {}
      };
    } catch {
      return { count: 0, lastActiveDate: null, activityDates: {} };
    }
  }, [progress, mounted]);

  const getLocalDateKey = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

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

  const visibleOpenings = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return Object.entries(openings)
      .filter(([, opening]) => side === "all" || opening.playerSide === side)
      .filter(([, opening]) =>
        `${opening.displayName} ${opening.description}`.toLocaleLowerCase().includes(normalizedQuery),
      )
      .sort((a, b) => {
        const slugA = a[0];
        const slugB = b[0];
        const usageA = usage[slugA] || { count: 0, lastUsed: 0 };
        const usageB = usage[slugB] || { count: 0, lastUsed: 0 };

        if (usageB.lastUsed !== usageA.lastUsed) {
          return usageB.lastUsed - usageA.lastUsed;
        }
        if (usageB.count !== usageA.count) {
          return usageB.count - usageA.count;
        }
        return a[1].displayName.localeCompare(b[1].displayName);
      });
  }, [openings, query, side, usage]);

  const totalLines = visibleOpenings.reduce((sum, [, opening]) => sum + opening.lineCount, 0);

  async function logout() {
    if (!supabase) return;
    clearLocalUserData();
    await supabase.auth.signOut();
    setSessionEmail(null);
    setHasSubscription(false);
    setFreeOpening(null);
    setProgress({});
  }

  const todayDone = streakDetails.lastActiveDate === getLocalDateKey();

  return (
    <div className="app-shell" style={{ position: "relative" }}>
      {/* Checkout Success Banner */}
      {showCheckoutSuccess && (
        <div className="checkout-success-banner" id="checkoutSuccessBanner">
          <div className="checkout-success-inner">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
            <span>Welcome aboard! Your Unlimited Pass is now active.</span>
            <button onClick={() => setShowCheckoutSuccess(false)} className="checkout-success-close">×</button>
          </div>
        </div>
      )}

      {/* Unlock Overlay */}
      <div className={`unlock-overlay ${showUnlockOverlay ? "active" : ""}`} id="unlockOverlay" aria-hidden="true">
        <div className="unlock-burst">
          <span className="unlock-spark s1"></span>
          <span className="unlock-spark s2"></span>
          <span className="unlock-spark s3"></span>
          <span className="unlock-spark s4"></span>
          <span className="unlock-spark s5"></span>
          <span className="unlock-spark s6"></span>
        </div>
        <div className="unlock-panel">
          <div className="unlock-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <rect width="18" height="11" x="3" y="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0 1 9.5-2.2"/>
              <path d="m15 7 3-3 2 2"/>
            </svg>
          </div>
          <div>
            <div className="unlock-kicker">Unlimited Pass active</div>
            <div className="unlock-title">All openings unlocked</div>
          </div>
        </div>
      </div>

      <nav className="nav">
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

            <div id="userMenu">
              {sessionEmail ? (
                <button className="nav-icon-btn" onClick={logout} title="Log out" type="button" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
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
            {mounted && (
              <>
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
                      {weekDays.map((day) => (
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
              </>
            )}
          </div>
        </div>
      </nav>

      {/* HERO */}
      <div className="hero">
        <div className="hero-bg"></div>
        <div className="hero-bg-fade"></div>
        <div className="hero-pieces">
          <span className="hero-piece hp-1">♜</span>
          <span className="hero-piece hp-2">♚</span>
          <span className="hero-piece hp-3">♞</span>
          <span className="hero-piece hp-4">♟</span>
        </div>
        <div className="hero-rule"></div>

        <div className="hero-content">
          <p className="hero-eyebrow">Chess Opening Repertoire</p>
          <h1 className="hero-title">Master the<br/><em>Opening</em></h1>
          <p className="hero-sub">Practice your openings with interactive<br/>move-by-move training.</p>
        </div>
      </div>

      {/* Free Tier Banner */}
      {!hasSubscription && (
        <div className="free-tier-banner" id="freeTierBanner">
          <div className="free-tier-inner">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 21 9.4a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <span>
              {freeOpening ? (
                <>Your <strong>free opening</strong> is active. Upgrade anytime to unlock all 30+ openings.</>
              ) : (
                <>Pick <strong>one opening</strong> to unlock for free. Upgrade anytime for all 30+.</>
              )}
            </span>
          </div>
        </div>
      )}

      {/* MAIN */}
      <main>
        <div className="toolbar">
          <div className="toolbar-left">
            <button className={`filter-btn ${side === "all" ? "active" : ""}`} onClick={() => setSide("all")} type="button">All</button>
            <button className={`filter-btn ${side === "w" ? "active" : ""}`} onClick={() => setSide("w")} type="button">
              <span className="filter-dot" style={{ background: "#e8e8e8" }}></span> White
            </button>
            <button className={`filter-btn ${side === "b" ? "active" : ""}`} onClick={() => setSide("b")} type="button">
              <span className="filter-dot" style={{ background: "#d4a843" }}></span> Black
            </button>
            <div className="search-wrap">
              <span className="search-icon">⌕</span>
              <input type="text" className="search-input" placeholder="Search openings…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
          <div className="toolbar-right">
            <strong>{visibleOpenings.length}</strong> openings · <strong>{totalLines}</strong> lines
          </div>
        </div>

        <div className="section-label" id="sectionLabel">
          {side === "all" ? "All openings" : side === "w" ? "White openings" : "Black openings"}
          {query.trim() && ` · "${query.trim()}"`}
        </div>

        <div className="grid" id="courseGrid">
          {visibleOpenings.map(([slug, o]) => {
            const learned = new Set(progress[slug]?.learnedLines ?? []).size;
            const perfected = Object.values(progress[slug]?.lines ?? {}).filter(
              (line) => Number(line.practicePerfectAttempts) > 0,
            ).length;
            const pct = o.lineCount > 0 ? Math.round((learned / o.lineCount) * 100) : 0;
            const practicePct = o.lineCount > 0 ? Math.round((perfected / o.lineCount) * 100) : 0;

            const isUnlocked = hasSubscription || freeOpening === slug;
            const isFreePickable = !hasSubscription && !freeOpening;

            return (
              <Link
                key={o.id}
                className={`card ${!isUnlocked && !isFreePickable ? "card-locked" : ""}`}
                href={!isUnlocked && !isFreePickable ? "/plans" : `/opening/${slug}`}
                onClick={() => {
                  if (isFreePickable) {
                    localStorage.setItem("chessengineered_free_opening", slug);
                    setFreeOpening(slug);
                    trackOpeningUsage(slug);
                  } else if (isUnlocked) {
                    trackOpeningUsage(slug);
                  }
                }}
              >
                <div className="card-thumb">
                  <img src={`/boards/${slug}.png`} alt={`${o.displayName} board`} />
                  {!isUnlocked && !isFreePickable && (
                    <div className="card-lock">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                    </div>
                  )}
                </div>
                <div className="card-body">
                  <div className="card-main">
                    <div className="card-top">
                      <h2 className="card-title">{o.displayName.replace(" Mastery", "")}</h2>
                      <div className="card-badges">
                        <span className={`badge badge-${o.playerSide === "w" ? "white" : "black"}`}>
                          {o.playerSide === "w" ? "White" : "Black"}
                        </span>
                        {isFreePickable && <span className="badge badge-free">Pick Free</span>}
                        {freeOpening === slug && !hasSubscription && <span className="badge badge-unlocked">Free</span>}
                      </div>
                    </div>
                    <p className="card-desc">{compactDescription(o.description)}</p>
                    <div className="card-progress-wrap">
                      <span className="card-lines"><strong>{learned}/{o.lineCount}</strong> lines</span>
                      <div className="progress-track" aria-label={`${learned}/${o.lineCount} lines discovered`}>
                        <div className="progress-fill progress-fill-practice" style={{ width: `${practicePct}%` }}></div>
                        <div className="progress-fill" style={{ width: `${pct}%` }}></div>
                      </div>
                    </div>
                  </div>
                  <div className="card-foot">
                    <span className="card-cta">
                      {isFreePickable ? "Pick as Free" : isUnlocked ? "Start training" : "Upgrade to unlock"}{" "}
                      <span className="cta-arrow">→</span>
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
        
        {visibleOpenings.length === 0 && (
          <p className="empty-state" style={{ color: "var(--color-muted)", textAlign: "center", padding: "40px 0" }}>
            No openings found matching those filters.
          </p>
        )}
      </main>

      {/* Footer */}
      <footer className="site-footer">
        <div className="footer-inner">
          <div className="footer-grid">
            <div className="footer-col">
              <Link href="/openings" className="footer-logo" aria-label="ChessEngineered home">
                <div className="logo-mark">
                  <svg viewBox="0 0 962 1973" xmlns="http://www.w3.org/2000/svg">
                    <path fillRule="evenodd" clipRule="evenodd" d="M260.013 382.733L182.267 165.24L354.227 210.947L475.627 0.0401493L598.907 214.787L773.933 165.24L696.826 380.947C636.506 335.054 561.24 307.787 479.6 307.787C396.893 307.787 320.733 335.76 260.013 382.733Z" fill="#FBBF24"></path>
                    <path fillRule="evenodd" clipRule="evenodd" d="M480.067 401.747C619.853 401.747 733.173 515.067 733.173 654.853C733.173 740.693 690.427 816.547 625.067 862.307H676.12C699.52 862.307 718.653 881.453 718.653 904.84C718.653 928.24 699.52 947.373 676.12 947.373H635.28C635.28 947.373 577.187 1320.81 788.813 1474.35V1538.67C788.813 1538.67 927.813 1644.48 929.893 1700.49C931.96 1756.51 919.52 1783.48 919.52 1783.48C919.52 1783.48 977.613 1862.32 956.867 1920.41C937.867 1973.57 547.04 1972.87 480.92 1972.37C414.8 1972.87 23.96 1973.57 4.96001 1920.41C-15.7867 1862.32 42.3066 1783.48 42.3066 1783.48C42.3066 1783.48 29.8666 1756.51 31.9333 1700.49C34.0133 1644.48 173.013 1538.67 173.013 1538.67V1474.35C384.64 1320.81 326.547 947.373 326.547 947.373H290.227C266.84 947.373 247.693 928.24 247.693 904.84C247.693 881.453 266.84 862.307 290.227 862.307H335.067C269.693 816.547 226.947 740.693 226.947 654.853C226.947 515.067 340.28 401.747 480.067 401.747Z" fill="white"></path>
                  </svg>
                </div>
              </Link>
              <p className="footer-desc">The best website to help you master your chess repertoire.</p>
            </div>
            <div className="footer-col">
              <h3 className="footer-heading">Resources</h3>
              <ul className="footer-links">
                <li><Link href="/plans">Pricing &amp; Plans</Link></li>
                <li><a href="mailto:support@chessengineered.com">Support &amp; Contact</a></li>
              </ul>
            </div>
          </div>
          <div className="footer-bottom">
            <p className="footer-copy">© 2026 ChessEngineered</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
