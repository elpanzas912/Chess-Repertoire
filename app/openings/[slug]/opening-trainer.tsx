"use client";

import Link from "next/link";
import confetti from "canvas-confetti";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Chess, type Square } from "chess.js";
import { supabase } from "../../../lib/supabase";
import { createEventId, readCachedProgress, recordTrainingCompletion, recordTrainingActivity, resetOpeningProgress, saveDrillHighScore, savePuzzleResult, saveTimeHighScore, type TrainingMode } from "../../../lib/cloud-progress";
import { loadOpening, OpeningAccessError, readCachedOpening, type CachedOpening } from "../../../lib/opening-cache";
import { ChessboardReact } from "./chessboard-react";

type Opening = CachedOpening;

type CourseMove = {
  color: string;
  from: Square;
  promotion?: string;
  san: string;
  to: Square;
};

type Puzzle = {
  FEN: string;
  Moves: string;
  Rating: number;
  id: string;
};

type Feedback = { square: Square; type: "correct" | "wrong" } | null;
type PieceSet = "staunty" | "maestro" | "standard";
type BoardTheme = "green" | "white-violet" | "white-blue" | "blue" | "brown" | "classic" | "black-and-white";

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
const PRACTICE_TRANSITION_DELAY_MS = 800;
const PUZZLE_TRANSITION_DELAY_MS = 600;
const PUZZLE_ASSET_SLUGS: Record<string, string> = {
  "bishop-s-opening": "bishops-opening",
  "king-s-gambit": "kings-gambit",
  "king-s-indian-defense": "kings-indian-defense",
  "queen-s-gambit-accepted": "queens-gambit-accepted",
  "queen-s-gambit-declined": "queens-gambit-declined",
};

function parseLine(pgn: string): CourseMove[] {
  const chess = new Chess();
  chess.loadPgn(`[Result "*"]\n\n${pgn} *`);
  return chess.history({ verbose: true }).map((move) => ({
    color: move.color,
    from: move.from,
    san: move.san,
    to: move.to,
  }));
}

function parsePuzzleMoves(puzzle: Puzzle): CourseMove[] {
  const chess = new Chess(puzzle.FEN);
  const tokens = String(puzzle.Moves).split(/\s+/).filter((uci) => /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uci));
  const moves: CourseMove[] = [];

  for (const uci of tokens) {
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    const promotion = uci.length > 4 ? uci.slice(4, 5).toLowerCase() : undefined;
    const legal = chess.moves({ verbose: true }).find((move) =>
      move.from === from && move.to === to && (!promotion || move.promotion === promotion),
    );
    if (!legal) break;
    const applied = chess.move({ from, to, ...(promotion ? { promotion } : {}) });
    if (!applied) break;
    moves.push({ color: applied.color, from, to, promotion, san: applied.san });
  }

  return moves;
}

function getPuzzleProgress() {
  const progress = readCachedProgress();
  return {
    elo: Math.max(400, Math.round(Number(progress.puzzleELO) || 1500)),
    streak: Math.max(0, Math.round(Number(progress.puzzleStreak) || 0)),
  };
}

function saveLocalPuzzleProgress(elo: number, streak: number) {
  const progress = readCachedProgress();
  localStorage.setItem("chessengineered_progress", JSON.stringify({
    ...progress,
    puzzleELO: Math.max(400, Math.round(elo)),
    puzzleStreak: Math.max(0, Math.round(streak)),
  }));
}

function puzzleRatingChange(playerRating: number, puzzleRating: number, solved: boolean) {
  const expectedScore = 1 / (1 + Math.pow(10, (puzzleRating - playerRating) / 400));
  return Math.round(32 * ((solved ? 1 : 0) - expectedScore));
}

function selectPuzzle(puzzles: Puzzle[], elo: number, previousId?: string) {
  for (let range = 150; range <= 1050; range += 100) {
    const candidates = puzzles.filter((puzzle) =>
      Math.abs((Number(puzzle.Rating) || 1500) - elo) <= range && (puzzles.length <= 1 || puzzle.id !== previousId),
    );
    if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return puzzles.find((puzzle) => puzzle.id !== previousId) ?? puzzles[0];
}

function materialScore(chess: Chess) {
  const values: Record<string, number> = { p: 1, n: 3.2, b: 3.3, r: 5, q: 9, k: 0 };
  return chess.board().flat().reduce(
    (score, piece) => score + (piece ? values[piece.type] * (piece.color === "w" ? 1 : -1) : 0),
    0,
  );
}

const PIECE_VAL: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function fallbackEvaluate(chess: Chess): number {
  const board = chess.board();
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = board[r][c];
      if (!sq) continue;
      score += (sq.color === "w" ? 1 : -1) * PIECE_VAL[sq.type];
    }
  }
  return score / 100;
}

function saveLearnedLine(slug: string, line: string) {
  const raw = localStorage.getItem("chessengineered_progress");
  const progress = raw ? JSON.parse(raw) : {};
  const opening = progress[slug] ?? {};
  const learned = new Set<string>(opening.learnedLines ?? []);
  learned.add(line);
  progress[slug] = { ...opening, learnedLines: [...learned] };
  localStorage.setItem("chessengineered_progress", JSON.stringify(progress));
}

function getLearnedLines(slug: string) {
  try {
    const progress = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
    return new Set<string>(progress[slug]?.learnedLines ?? []);
  } catch {
    return new Set<string>();
  }
}

function getKnownLearnedLines(slug: string, lines: string[]) {
  const knownLines = new Set(lines);
  return new Set([...getLearnedLines(slug)].filter((line) => knownLines.has(line)));
}

function savePracticeCompletion(slug: string, line: string, perfect: boolean) {
  const raw = localStorage.getItem("chessengineered_progress");
  const progress = raw ? JSON.parse(raw) : {};
  const opening = progress[slug] ?? {};
  const lines = opening.lines ?? {};
  const lineProgress = lines[line] ?? {};
  lines[line] = {
    ...lineProgress,
    practiceCompletions: (Number(lineProgress.practiceCompletions) || 0) + 1,
    practicePerfectAttempts: (Number(lineProgress.practicePerfectAttempts) || 0) + (perfect ? 1 : 0),
  };
  progress[slug] = { ...opening, lines };
  localStorage.setItem("chessengineered_progress", JSON.stringify(progress));
}

function getPracticePerfectedCount(slug: string, learnedLines: Set<string>) {
  try {
    const progress = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
    const lines = progress[slug]?.lines ?? {};
    return [...learnedLines].filter((line) => Number(lines[line]?.practicePerfectAttempts) > 0).length;
  } catch {
    return 0;
  }
}

function getRandomPracticeLineIndex(lines: string[], learnedLines: Set<string>, currentIndex = -1) {
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => learnedLines.has(line) && (learnedLines.size <= 1 || index !== currentIndex));
  if (!candidates.length) return Math.max(0, currentIndex);
  return candidates[Math.floor(Math.random() * candidates.length)].index;
}

function getOpeningHighScore(slug: string, key: "drillHighScore" | "timeHighScore") {
  try {
    const progress = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
    return Math.max(0, Math.round(Number(progress[slug]?.[key]) || 0));
  } catch {
    return 0;
  }
}

function saveOpeningHighScore(slug: string, key: "drillHighScore" | "timeHighScore", score: number) {
  const raw = localStorage.getItem("chessengineered_progress");
  const progress = raw ? JSON.parse(raw) : {};
  const opening = progress[slug] ?? {};
  const nextScore = Math.max(Number(opening[key]) || 0, Math.round(score));
  progress[slug] = { ...opening, [key]: nextScore };
  localStorage.setItem("chessengineered_progress", JSON.stringify(progress));
  return nextScore;
}

const resumeLinesKey = "chessengineered_resume_lines";

function getNextLearnLineIndex(lines: string[], learnedLines: Set<string>, startIndex = 0) {
  if (!lines.length) return 0;
  const normalizedStart = ((startIndex % lines.length) + lines.length) % lines.length;
  if (learnedLines.size < lines.length) {
    for (let offset = 0; offset < lines.length; offset += 1) {
      const index = (normalizedStart + offset) % lines.length;
      if (!learnedLines.has(lines[index])) return index;
    }
  }
  return normalizedStart;
}

function getResumeLineIndex(slug: string, lines: string[]) {
  try {
    const resumeLines = JSON.parse(localStorage.getItem(resumeLinesKey) ?? "{}");
    const index = lines.indexOf(resumeLines[slug]);
    return getNextLearnLineIndex(lines, getKnownLearnedLines(slug, lines), index >= 0 ? index : 0);
  } catch {
    return getNextLearnLineIndex(lines, getKnownLearnedLines(slug, lines));
  }
}

function saveResumeLine(slug: string, line: string) {
  try {
    const resumeLines = JSON.parse(localStorage.getItem(resumeLinesKey) ?? "{}");
    resumeLines[slug] = line;
    localStorage.setItem(resumeLinesKey, JSON.stringify(resumeLines));
  } catch {
    localStorage.setItem(resumeLinesKey, JSON.stringify({ [slug]: line }));
  }
}

function lichessAnalysisUrl(fen: string) {
  return `https://lichess.org/analysis/standard/${fen.replaceAll(" ", "_")}`;
}

function playSound(name: string, enabled = true) {
  if (!enabled) return;
  const audio = new Audio(`/sounds/${name}.mp3`);
  audio.volume = 0.45;
  void audio.play().catch(() => undefined);
}

function pieceSound(move: { captured?: string; san: string }, playerMove: boolean) {
  if (move.san.includes("+")) return "move-check";
  if (move.san === "O-O" || move.san === "O-O-O") return "castle";
  if (move.captured) return "capture";
  return playerMove ? "move-self" : "move-opponent";
}

export function OpeningTrainer({ slug }: { slug: string }) {
  const router = useRouter();
  const [opening, setOpening] = useState<Opening | null>(() => readCachedOpening(slug));
  const [error, setError] = useState("");
  const [showLoginOverlay, setShowLoginOverlay] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [triggerReload, setTriggerReload] = useState(0);

  useEffect(() => {
    let active = true;

    async function loadOpeningData() {
      if (!supabase) {
        setError("Supabase no está configurado.");
        return;
      }

      const loadedOpening = await loadOpening(supabase, slug);
      if (active) {
        setOpening(loadedOpening);
        setError(""); // Clear error on successful load
      }
    }

    void loadOpeningData().catch((loadError) => {
      if (loadError instanceof OpeningAccessError && loadError.status === 401) {
        setShowLoginOverlay(true);
        return;
      }
      if (loadError instanceof OpeningAccessError && loadError.status === 403) {
        router.replace("/plans");
        return;
      }
      if (active) setError("No se pudo cargar la apertura. Intenta nuevamente.");
    });

    return () => {
      active = false;
    };
  }, [router, slug, triggerReload]);

  async function handleGoogleLogin() {
    setLoginError(null);
    if (!supabase) {
      setLoginError("Supabase no está configurado.");
      return;
    }
    setLoginPending(true);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (oauthError) {
      setLoginPending(false);
      setLoginError("No pudimos iniciar sesión con Google.");
    }
  }

  async function handleEmailLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError(null);
    if (!supabase) {
      setLoginError("Supabase no está configurado.");
      return;
    }
    setLoginPending(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password: loginPassword,
    });
    setLoginPending(false);
    if (signInError) {
      setLoginError("No pudimos iniciar sesión. Revisa tus datos.");
      return;
    }
    setShowLoginOverlay(false);
    setTriggerReload((prev) => prev + 1); // Trigger loadOpeningData again!
  }

  if (showLoginOverlay) {
    return (
      <div className="login-overlay-container">
        <div className="bg-glows" aria-hidden="true">
          <div className="glow glow-1"></div>
          <div className="glow glow-2"></div>
        </div>
        <form className="login-card floating-login-card" onSubmit={handleEmailLogin}>
          <h1>Iniciar sesión</h1>
          <p>Accede a tu progreso y a tus cursos desbloqueados.</p>
          <button className="google-login" disabled={loginPending} onClick={handleGoogleLogin} type="button">
            Continuar con Google
          </button>
          <div className="login-separator">
            <span>o usa tu email</span>
          </div>
          <label>
            Email
            <input
              autoComplete="email"
              onChange={(event) => setLoginEmail(event.target.value)}
              required
              type="email"
              value={loginEmail}
            />
          </label>
          <label>
            Contraseña
            <input
              autoComplete="current-password"
              minLength={6}
              onChange={(event) => setLoginPassword(event.target.value)}
              required
              type="password"
              value={loginPassword}
            />
          </label>
          {loginError && <p className="form-error">{loginError}</p>}
          <button disabled={loginPending} type="submit">
            {loginPending ? "Ingresando..." : "Ingresar"}
          </button>
        </form>
      </div>
    );
  }

  if (error) return <TrainerMessage message={error} />;
  if (!opening) return null;
  return <TrainingBoard opening={opening} slug={slug} />;
}

function TrainerMessage({ message }: { message: string }) {
  return (
    <main className="trainer-layout" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <div className="bg-glows" aria-hidden="true">
        <div className="glow glow-1"></div>
        <div className="glow glow-2"></div>
      </div>
      <section style={{ fontSize: "1.25rem", fontWeight: 500, color: "var(--color-muted)", fontFamily: "var(--font-display)" }}>
        {message}
      </section>
    </main>
  );
}

function TrainingBoard({ opening, slug }: { opening: Opening; slug: string }) {
  const [lineIndex, setLineIndex] = useState(() => getResumeLineIndex(slug, opening.lines));
  const [restartVersion, setRestartVersion] = useState(0);
  const [game, setGame] = useState(() => new Chess());
  const [moveIndex, setMoveIndex] = useState(0);
  const [selected, setSelected] = useState<Square | null>(null);
  const [legalTargets, setLegalTargets] = useState<Square[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [completed, setCompleted] = useState(false);
  const [hint, setHint] = useState<Square | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [linePickerOpen, setLinePickerOpen] = useState(false);
  const [showDialog, setShowDialog] = useState(true);
  const [showEval, setShowEval] = useState(true);
  const [soundsEnabled, setSoundsEnabled] = useState(true);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [trainingArrows, setTrainingArrows] = useState(true);
  const [pieceSet, setPieceSet] = useState<PieceSet>("staunty");
  const [boardTheme, setBoardTheme] = useState<BoardTheme>("green");
  const [learnedLines, setLearnedLines] = useState(() => getKnownLearnedLines(slug, opening.lines));
  const [mode, setMode] = useState<TrainingMode>("learn");
  const [practicePerfectedCount, setPracticePerfectedCount] = useState(() =>
    getPracticePerfectedCount(slug, getKnownLearnedLines(slug, opening.lines)),
  );
  const [drillScore, setDrillScore] = useState(0);
  const [drillHighScore, setDrillHighScore] = useState(() => getOpeningHighScore(slug, "drillHighScore"));
  const [drillGameOver, setDrillGameOver] = useState(false);
  const [timeScore, setTimeScore] = useState(0);
  const [timeHighScore, setTimeHighScore] = useState(() => getOpeningHighScore(slug, "timeHighScore"));
  const [timeRemainingMs, setTimeRemainingMs] = useState(60000);
  const [timeGameOver, setTimeGameOver] = useState(false);
  const [puzzles, setPuzzles] = useState<Puzzle[]>([]);
  const [currentPuzzle, setCurrentPuzzle] = useState<Puzzle | null>(null);
  const [puzzleMoves, setPuzzleMoves] = useState<CourseMove[]>([]);
  const [puzzleElo, setPuzzleElo] = useState(() => getPuzzleProgress().elo);
  const [puzzleStreak, setPuzzleStreak] = useState(() => getPuzzleProgress().streak);
  const [puzzleMessage, setPuzzleMessage] = useState("");
  const [puzzleLoading, setPuzzleLoading] = useState(false);
  const [boardLocked, setBoardLocked] = useState(true);
  
  // Estados y referencias para la barra de evaluación asíncrona Stockfish
  const [evalScore, setEvalScore] = useState<number>(0);
  const [evalMate, setEvalMate] = useState<number | null>(null);
  const [evalLoading, setEvalLoading] = useState<boolean>(false);
  const [evalFallback, setEvalFallback] = useState<boolean>(false);

  const evalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evalSeqRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStartedAtRef = useRef(Date.now());
  const correctMovesRef = useRef(0);
  const incorrectMovesRef = useRef(0);
  const completedLineRef = useRef(false);
  const activityStartedAtRef = useRef(Date.now());
  const activityModeRef = useRef<TrainingMode>("learn");
  const startNextPracticeLineRef = useRef<() => void>(() => undefined);
  const startNextDrillLineRef = useRef<() => void>(() => undefined);
  const drillScoreRef = useRef(0);
  const startNextTimeLineRef = useRef<() => void>(() => undefined);
  const restartTimeLineRef = useRef<() => void>(() => undefined);
  const timeScoreRef = useRef(0);
  const timeDeadlineRef = useRef(0);
  const timeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tenSecondSoundPlayedRef = useRef(false);
  const puzzlePenalizedRef = useRef(false);
  const currentPuzzleRef = useRef<Puzzle | null>(null);
  const puzzleMovesRef = useRef<CourseMove[]>([]);
  const puzzleEloRef = useRef(getPuzzleProgress().elo);
  const puzzleStreakRef = useRef(getPuzzleProgress().streak);
  const puzzleSyncRef = useRef(Promise.resolve());
  const puzzleSyncSeqRef = useRef(0);
  const puzzleLoadSeqRef = useRef(0);
  const loadNextPuzzleRef = useRef<() => void>(() => undefined);
  const handlePuzzleSuccessRef = useRef<() => void>(() => undefined);
  const playOpponentPuzzleMovesRef = useRef<(source: Chess, startIndex: number) => void>(() => undefined);
  const currentLine = opening.lines[lineIndex];
  const lineMoves = useMemo(() => parseLine(currentLine), [currentLine]);
  const moves = mode === "puzzle" ? puzzleMoves : lineMoves;
  const learnedCount = learnedLines.size;
  const nextLearnLineIndex = getNextLearnLineIndex(opening.lines, learnedLines, lineIndex + 1);
  const nextPracticeLineIndex = getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex);

  useEffect(() => {
    setShowEval(localStorage.getItem("chessengineered_show_eval") !== "false");
    setShowDialog(localStorage.getItem("chessengineered_show_dialog") !== "false");
    setSoundsEnabled(localStorage.getItem("chessengineered_sound") !== "false");
    setHapticsEnabled(localStorage.getItem("chessengineered_haptic") !== "false");
    setTrainingArrows(localStorage.getItem("chessengineered_training_arrows") !== "false");
    setPieceSet((localStorage.getItem("chessengineered_piece_set") as PieceSet) || "staunty");
    setBoardTheme((localStorage.getItem("chessengineered_board_theme") as BoardTheme) || "green");
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;

    const flushActivity = (force = false) => {
      if (!force && document.visibilityState !== "visible") return;
      const now = Date.now();
      const durationMs = now - activityStartedAtRef.current;
      activityStartedAtRef.current = now;
      if (durationMs < 1000) return;
      void recordTrainingActivity(client, slug, durationMs, activityModeRef.current).catch((error) =>
        console.warn("Unable to sync training time:", error.message),
      );
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushActivity(true);
      } else {
        activityStartedAtRef.current = Date.now();
      }
    };

    activityStartedAtRef.current = Date.now();
    const interval = window.setInterval(flushActivity, 10000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const handlePageHide = () => flushActivity(true);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.clearInterval(interval);
      flushActivity(true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [slug]);

  useEffect(() => {
    activityModeRef.current = mode;
  }, [mode]);

  function persistBoolean(key: string, value: boolean, setter: (value: boolean) => void) {
    localStorage.setItem(key, String(value));
    setter(value);
  }

  function vibrate(pattern: number | number[]) {
    if (hapticsEnabled && "vibrate" in navigator) navigator.vibrate(pattern);
  }

  const updateEvaluation = useCallback((chess: Chess) => {
    const fallbackScore = fallbackEvaluate(chess);
    
    // Configurar inmediatamente el loading y el fallbackScore (cálculo de material instantáneo)
    setEvalScore(fallbackScore);
    setEvalMate(null);
    setEvalLoading(true);
    setEvalFallback(false);

    // Cancelar cualquier temporizador de debounce previo
    if (evalTimerRef.current) {
      clearTimeout(evalTimerRef.current);
    }
    // Cancelar cualquier petición HTTP anterior en curso
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const seq = ++evalSeqRef.current;
    const fen = chess.fen();

    evalTimerRef.current = setTimeout(async () => {
      abortControllerRef.current = new AbortController();
      const controller = abortControllerRef.current;

      try {
        const response = await fetch("https://chess-api.com/v1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fen,
            variants: 1,
            depth: 8,
            maxThinkingTime: 50,
          }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`API error ${response.status}`);
        const data = await response.json();

        if (seq !== evalSeqRef.current) return;

        // Normalizar puntuación de Stockfish
        let score = fallbackScore;
        let mateValue = null;

        if (data.mate !== null && data.mate !== undefined) {
          const mate = Number(data.mate);
          mateValue = mate;
          const sign = mate >= 0 ? 1 : -1;
          score = sign * (100 - Math.min(99, Math.abs(mate)));
        } else if (Number.isFinite(Number(data.eval))) {
          score = Number(data.eval);
        } else if (Number.isFinite(Number(data.centipawns))) {
          score = Number(data.centipawns) / 100;
        }

        setEvalScore(score);
        setEvalMate(mateValue);
        setEvalLoading(false);
      } catch (err: any) {
        if (err.name === "AbortError" || seq !== evalSeqRef.current) return;
        setEvalLoading(false);
        setEvalFallback(true);
      }
    }, 10); // Debounce de 10ms
  }, []);

  const updateInstruction = useCallback((chess: Chess) => {
    if (mode === "puzzle") {
      setInstruction(`Streak: ${puzzleStreakRef.current} — resuelve el puzzle y encuentra la mejor jugada.`);
      return;
    }
    if (mode === "time") {
      setInstruction(`Score: ${timeScoreRef.current} — completa tantas líneas como puedas antes de que termine el tiempo.`);
      return;
    }
    if (mode === "drill") {
      setInstruction(`Streak: ${drillScoreRef.current} — completa tantas líneas seguidas como puedas.`);
      return;
    }
    if (mode === "practice") {
      setInstruction(chess.turn() === opening.playerSide ? "¿Cuál es la mejor jugada?" : "Preparando la respuesta del rival...");
      return;
    }
    setInstruction(opening.descriptions[chess.fen()] ?? "Encuentra el mejor movimiento para continuar la variante.");
  }, [mode, opening.descriptions, opening.playerSide]);
  const completeCurrentLine = useCallback(() => {
    if (completedLineRef.current) return;
    completedLineRef.current = true;

    if (mode === "learn") {
      saveLearnedLine(slug, currentLine);
      const nextLearnedLines = getKnownLearnedLines(slug, opening.lines);
      const nextIndex = getNextLearnLineIndex(opening.lines, nextLearnedLines, lineIndex + 1);
      saveResumeLine(slug, opening.lines[nextIndex]);
      setLearnedLines(nextLearnedLines);
    } else if (mode === "practice") {
      savePracticeCompletion(slug, currentLine, incorrectMovesRef.current === 0);
      setPracticePerfectedCount(getPracticePerfectedCount(slug, getKnownLearnedLines(slug, opening.lines)));
    } else if (mode === "drill") {
      drillScoreRef.current += 1;
      setDrillScore(drillScoreRef.current);
    } else if (mode === "time") {
      timeScoreRef.current += 1;
      setTimeScore(timeScoreRef.current);
    }

    if (!supabase || mode === "drill" || mode === "time") return;
    const now = Date.now();
    const activeDurationMs = now - activityStartedAtRef.current;
    activityStartedAtRef.current = now;
    if (activeDurationMs >= 1000) {
      void recordTrainingActivity(supabase, slug, activeDurationMs, mode).catch((error) =>
        console.warn("Unable to sync training time:", error.message),
      );
    }
    void recordTrainingCompletion(supabase, {
      eventId: createEventId(),
      slug,
      line: currentLine,
      mode: mode as "learn" | "practice",
      correctMoves: correctMovesRef.current,
      incorrectMoves: incorrectMovesRef.current,
      durationMs: Math.max(0, Date.now() - sessionStartedAtRef.current),
    })
      .then(() => {
        const nextLearnedLines = getKnownLearnedLines(slug, opening.lines);
        setLearnedLines(nextLearnedLines);
        setPracticePerfectedCount(getPracticePerfectedCount(slug, nextLearnedLines));
      })
      .catch((error) => console.warn("Unable to sync training progress:", error.message));
  }, [currentLine, lineIndex, mode, opening.lines, slug]);

  const playCompletionConfetti = useCallback(() => {
    if (localStorage.getItem("chessengineered_confetti") === "false") return;

    const boardEl = document.getElementById("board");
    let originX = 0.5;
    let originY = 1.1;
    if (boardEl) {
      const rect = boardEl.getBoundingClientRect();
      originX = (rect.left + rect.width / 2) / window.innerWidth;
      originY = (rect.bottom + 20) / window.innerHeight;
    }

    const count = 300;
    const defaults = {
      origin: { x: originX, y: originY },
      scalar: 1.8,
      gravity: 0.8,
      ticks: 250,
      colors: ["#a78bfa", "#8b5cf6", "#22c55e", "#fbbf24", "#f472b6", "#60a5fa"],
      zIndex: 999999
    };

    const fire = (particleRatio: number, opts: confetti.Options) => {
      confetti({
        ...defaults,
        ...opts,
        particleCount: Math.floor(count * particleRatio),
      });
    };

    fire(0.3, { spread: 40, startVelocity: 65, angle: 90 });
    fire(0.25, { spread: 80, startVelocity: 55, angle: 90 });
    fire(0.3, { spread: 120, startVelocity: 45, angle: 90, decay: 0.92 });
    fire(0.15, { spread: 160, startVelocity: 30, angle: 90, decay: 0.94, scalar: 2.2 });
  }, []);

  const playOpponentMoves = useCallback((source: Chess, startIndex: number, initialDelay = 0) => {
    const chess = new Chess(source.fen());
    let index = startIndex;

    const playNext = () => {
      const next = moves[index];
      if (!next) {
        setCompleted(true);
        completeCurrentLine();
        setBoardLocked(true);
        if (mode === "drill") {
          timer.current = setTimeout(() => startNextDrillLineRef.current(), PRACTICE_TRANSITION_DELAY_MS);
          return;
        }
        if (mode === "time") {
          timer.current = setTimeout(() => startNextTimeLineRef.current(), 300);
          return;
        }
        if (mode === "practice") {
          timer.current = setTimeout(() => startNextPracticeLineRef.current(), PRACTICE_TRANSITION_DELAY_MS);
          return;
        }
        playSound("game-end", soundsEnabled);
        playCompletionConfetti();
        return;
      }
      if (next.color === opening.playerSide) {
        const nextChess = new Chess(chess.fen());
        setGame(nextChess);
        updateEvaluation(nextChess);
        setMoveIndex(index);
        updateInstruction(chess);
        const unlockDelay = index > startIndex ? 0 : 200;
        setTimeout(() => {
          setBoardLocked(false);
        }, unlockDelay);
        return;
      }

      const move = chess.move(next.san);
      if (!move) return;
      index += 1;
      setLastMove({ from: move.from, to: move.to });
      const nextChess = new Chess(chess.fen());
      setGame(nextChess);
      updateEvaluation(nextChess);
      setMoveIndex(index);
      playSound(pieceSound(move, false), soundsEnabled);
      updateInstruction(chess);
      timer.current = setTimeout(playNext, 200);
    };

    setBoardLocked(true);
    timer.current = setTimeout(playNext, initialDelay);
  }, [completeCurrentLine, mode, moves, opening.playerSide, soundsEnabled, updateInstruction, updateEvaluation, playCompletionConfetti]);

  const endDrillRound = useCallback(() => {
    if (drillGameOver) return;
    setDrillGameOver(true);
    setCompleted(true);
    setBoardLocked(true);
    playSound("illegal", soundsEnabled);
    document.getElementById("board")?.classList.add("shake-error");
    const nextHighScore = saveOpeningHighScore(slug, "drillHighScore", drillScore);
    setDrillHighScore(nextHighScore);
    if (supabase && drillScore >= nextHighScore) {
      void saveDrillHighScore(supabase, slug, drillScore)
        .catch((error) => console.warn("Unable to save drill high score:", error.message));
    }
  }, [drillGameOver, drillScore, slug, soundsEnabled]);

  const endTimeRound = useCallback(() => {
    if (timeGameOver) return;
    if (timeIntervalRef.current) clearInterval(timeIntervalRef.current);
    if (timer.current) clearTimeout(timer.current);
    timeIntervalRef.current = null;
    timer.current = null;
    setTimeRemainingMs(0);
    setTimeGameOver(true);
    setCompleted(true);
    setBoardLocked(true);
    playSound("illegal", soundsEnabled);
    document.getElementById("board")?.classList.add("shake-error");
    const nextHighScore = saveOpeningHighScore(slug, "timeHighScore", timeScoreRef.current);
    setTimeHighScore(nextHighScore);
    if (supabase && timeScoreRef.current >= nextHighScore) {
      void saveTimeHighScore(supabase, slug, timeScoreRef.current)
        .catch((error) => console.warn("Unable to save time high score:", error.message));
    }
  }, [slug, timeGameOver, soundsEnabled]);

  const startTimeRound = useCallback(() => {
    if (timeIntervalRef.current) clearInterval(timeIntervalRef.current);
    timeScoreRef.current = 0;
    setTimeScore(0);
    setTimeGameOver(false);
    tenSecondSoundPlayedRef.current = false;
    timeDeadlineRef.current = Date.now() + 60000;
    setTimeRemainingMs(60000);
    timeIntervalRef.current = setInterval(() => {
      const remaining = Math.max(0, timeDeadlineRef.current - Date.now());
      setTimeRemainingMs(remaining);
      if (remaining > 0 && remaining <= 10000 && !tenSecondSoundPlayedRef.current) {
        tenSecondSoundPlayedRef.current = true;
        playSound("tenseconds", soundsEnabled);
      }
      if (remaining <= 0) endTimeRound();
    }, 30);
  }, [endTimeRound, soundsEnabled]);

  const syncPuzzleResult = useCallback((puzzleRating: number, solved: boolean) => {
    if (!supabase) return;
    const client = supabase;
    const syncSeq = ++puzzleSyncSeqRef.current;
    puzzleSyncRef.current = puzzleSyncRef.current
      .then(() => savePuzzleResult(client, puzzleRating, solved))
      .then((progress) => {
        if (syncSeq !== puzzleSyncSeqRef.current) return;
        const nextElo = Math.max(400, Math.round(Number(progress.puzzleELO) || 1500));
        const nextStreak = Math.max(0, Math.round(Number(progress.puzzleStreak) || 0));
        puzzleEloRef.current = nextElo;
        puzzleStreakRef.current = nextStreak;
        setPuzzleElo(nextElo);
        setPuzzleStreak(nextStreak);
      })
      .catch((error) => console.warn("Unable to sync puzzle result:", error.message));
  }, []);

  const applyLocalPuzzleResult = useCallback((solved: boolean) => {
    const puzzleRating = Math.max(400, Math.round(Number(currentPuzzleRef.current?.Rating) || 1500));
    const ratingChange = puzzleRatingChange(puzzleEloRef.current, puzzleRating, solved);
    const nextElo = Math.max(400, puzzleEloRef.current + ratingChange);
    const nextStreak = solved ? puzzleStreakRef.current + 1 : 0;
    puzzleEloRef.current = nextElo;
    puzzleStreakRef.current = nextStreak;
    saveLocalPuzzleProgress(nextElo, nextStreak);
    setPuzzleElo(nextElo);
    setPuzzleStreak(nextStreak);
    setPuzzleMessage(`${ratingChange >= 0 ? "+" : ""}${ratingChange} ELO`);
    syncPuzzleResult(puzzleRating, solved);
  }, [syncPuzzleResult]);

  const handlePuzzleFailure = useCallback(() => {
    if (puzzlePenalizedRef.current) return;
    puzzlePenalizedRef.current = true;
    applyLocalPuzzleResult(false);
  }, [applyLocalPuzzleResult]);

  const handlePuzzleSuccess = useCallback(() => {
    if (completedLineRef.current) return;
    completedLineRef.current = true;
    setCompleted(true);
    setBoardLocked(true);
    applyLocalPuzzleResult(true);
    playSound("game-end", soundsEnabled);
    timer.current = setTimeout(() => loadNextPuzzleRef.current(), PUZZLE_TRANSITION_DELAY_MS);
  }, [applyLocalPuzzleResult, soundsEnabled]);

  const playOpponentPuzzleMoves = useCallback((source: Chess, startIndex: number) => {
    const chess = new Chess(source.fen());
    let index = startIndex;

    const playNext = () => {
      const next = puzzleMovesRef.current[index];
      if (!next) {
        handlePuzzleSuccessRef.current();
        return;
      }
      if (next.color === opening.playerSide) {
        setGame(new Chess(chess.fen()));
        updateEvaluation(chess);
        setMoveIndex(index);
        setBoardLocked(false);
        updateInstruction(chess);
        return;
      }

      const move = chess.move({ from: next.from, to: next.to, ...(next.promotion ? { promotion: next.promotion } : {}) });
      if (!move) return;
      index += 1;
      setGame(new Chess(chess.fen()));
      updateEvaluation(chess);
      setMoveIndex(index);
      setLastMove({ from: move.from, to: move.to });
      playSound(pieceSound(move, false), soundsEnabled);
      timer.current = setTimeout(playNext, 200);
    };

    setBoardLocked(true);
    timer.current = setTimeout(playNext, 200);
  }, [opening.playerSide, soundsEnabled, updateEvaluation, updateInstruction]);

  const loadNextPuzzle = useCallback(async () => {
    const loadSeq = ++puzzleLoadSeqRef.current;
    if (timer.current) clearTimeout(timer.current);
    setPuzzleLoading(true);
    setPuzzleMessage("");
    setBoardLocked(true);

    try {
      let availablePuzzles = puzzles;
      if (!availablePuzzles.length) {
        const assetSlug = PUZZLE_ASSET_SLUGS[slug] ?? slug;
        const response = await fetch(`/puzzles/${assetSlug}.json`);
        if (!response.ok) throw new Error("Puzzle dataset not found");
        availablePuzzles = (await response.json()) as Puzzle[];
        setPuzzles(availablePuzzles);
      }
      if (loadSeq !== puzzleLoadSeqRef.current) return;

      const puzzle = selectPuzzle(availablePuzzles, puzzleEloRef.current, currentPuzzleRef.current?.id);
      if (!puzzle) throw new Error("No playable puzzles available");
      const nextMoves = parsePuzzleMoves(puzzle);
      if (!nextMoves.length) throw new Error("Puzzle has no playable moves");

      const chess = new Chess(puzzle.FEN);
      currentPuzzleRef.current = puzzle;
      puzzleMovesRef.current = nextMoves;
      puzzlePenalizedRef.current = false;
      completedLineRef.current = false;
      setCurrentPuzzle(puzzle);
      setPuzzleMoves(nextMoves);
      setGame(chess);
      updateEvaluation(chess);
      setMoveIndex(0);
      setSelected(null);
      setLegalTargets([]);
      setFeedback(null);
      setLastMove(null);
      setHint(null);
      setCompleted(false);
      setInstruction("Resuelve el puzzle y encuentra la mejor jugada.");
      playOpponentPuzzleMovesRef.current(chess, 0);
    } catch (error) {
      setInstruction("No hay puzzles disponibles para esta apertura.");
      console.warn("Unable to load puzzles:", error);
    } finally {
      setPuzzleLoading(false);
    }
  }, [puzzles, slug, updateEvaluation]);

  useEffect(() => {
    loadNextPuzzleRef.current = () => void loadNextPuzzle();
    handlePuzzleSuccessRef.current = handlePuzzleSuccess;
    playOpponentPuzzleMovesRef.current = playOpponentPuzzleMoves;
  }, [handlePuzzleSuccess, loadNextPuzzle, playOpponentPuzzleMoves]);

  const startLine = useCallback((index: number, nextMode = mode) => {
    const nextIndex = index >= 0 && index < opening.lines.length ? index : 0;
    if (timer.current) clearTimeout(timer.current);
    sessionStartedAtRef.current = Date.now();
    correctMovesRef.current = 0;
    incorrectMovesRef.current = 0;
    completedLineRef.current = false;
    if (nextMode === "learn") saveResumeLine(slug, opening.lines[nextIndex]);
    setLineIndex(nextIndex);
    setGame(new Chess());
    setMoveIndex(0);
    setSelected(null);
    setLegalTargets([]);
    setFeedback(null);
    setLastMove(null);
    setHint(null);
    setCompleted(false);
    setBoardLocked(true);
    setRestartVersion((version) => version + 1);
    document.getElementById("board")?.classList.remove("shake-error");
  }, [mode, opening.lines, slug]);

  const changeMode = useCallback((nextMode: TrainingMode) => {
    document.body.classList.remove("show-mobile-modes");
    if (nextMode === mode) return;
    if (nextMode === "practice" && learnedLines.size === 0) {
      alert("Learn some lines first!");
      return;
    }
    if (nextMode === "drill" && learnedLines.size < 3) {
      alert("Learn 3 lines to unlock Drill!");
      return;
    }
    if (nextMode === "time" && learnedLines.size < 3) {
      alert("Learn 3 lines to unlock Time Trials!");
      return;
    }
    if (nextMode === "puzzle" && learnedLines.size < 2) {
      alert("Learn 2 lines to unlock Puzzles!");
      return;
    }
    const now = Date.now();
    const durationMs = now - activityStartedAtRef.current;
    activityStartedAtRef.current = now;
    if (supabase && durationMs >= 1000) {
      void recordTrainingActivity(supabase, slug, durationMs, mode).catch((error) =>
        console.warn("Unable to sync training time:", error.message),
      );
    }
    setMode(nextMode);
    activityModeRef.current = nextMode;
    setDrillGameOver(false);
    setTimeGameOver(false);
    if (nextMode === "drill") {
      drillScoreRef.current = 0;
      setDrillScore(0);
    }
    if (nextMode === "time") startTimeRound();
    else if (timeIntervalRef.current) {
      clearInterval(timeIntervalRef.current);
      timeIntervalRef.current = null;
    }
    if (nextMode === "puzzle") {
      void loadNextPuzzle();
      return;
    }
    puzzleLoadSeqRef.current += 1;
    const nextIndex = nextMode === "practice" || nextMode === "drill" || nextMode === "time"
      ? getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex)
      : getResumeLineIndex(slug, opening.lines);
    startLine(nextIndex, nextMode);
  }, [learnedLines, lineIndex, loadNextPuzzle, mode, opening.lines, slug, startLine, startTimeRound]);

  useEffect(() => {
    if (mode === "puzzle") return;
    const chess = new Chess();
    setGame(chess);
    updateEvaluation(chess);
    setMoveIndex(0);
    setCompleted(false);
    setBoardLocked(true);
    playSound("game-start", soundsEnabled);
    playOpponentMoves(chess, 0, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (evalTimerRef.current) clearTimeout(evalTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, [lineIndex, mode, playOpponentMoves, restartVersion, updateEvaluation]);

  useEffect(() => {
    startNextPracticeLineRef.current = () => {
      startLine(getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex), "practice");
    };
    startNextDrillLineRef.current = () => {
      startLine(getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex), "drill");
    };
    startNextTimeLineRef.current = () => {
      startLine(getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex), "time");
    };
    restartTimeLineRef.current = () => {
      startLine(lineIndex, "time");
    };
  }, [learnedLines, lineIndex, opening.lines, startLine]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (document.body.classList.contains("show-mobile-modes")) {
        const target = e.target as HTMLElement;
        const isClickSelector = target.closest(".mode-selector");
        const isClickToggle = target.closest(".mobile-mode-toggle");
        if (!isClickSelector && !isClickToggle) {
          document.body.classList.remove("show-mobile-modes");
        }
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("touchstart", handleOutsideClick, { passive: true });
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("touchstart", handleOutsideClick);
    };
  }, []);

  function chooseSquare(square: Square) {
    if (boardLocked) return;
    if (!selected) {
      const piece = game.get(square);
      if (!piece || piece.color !== opening.playerSide) return;
      const targets = game.moves({ square, verbose: true }).map((move) => move.to);
      if (!targets.length) return;
      setSelected(square);
      setLegalTargets(targets);
      return;
    }
    if (selected === square) {
      setSelected(null);
      setLegalTargets([]);
      return;
    }
    attemptMove(selected, square);
  }

  const handleMoveAttempt = useCallback(
    (from: Square, to: Square) => {
      if (completed || boardLocked) return false;
      const expected = moves[moveIndex];
      if (!expected || expected.color !== opening.playerSide) return false;

      const legal = game.moves({ square: from, verbose: true }).find((m) => m.to === to);
      if (!legal) return false;

      setSelected(null);
      setLegalTargets([]);
      setHint(null);
      setBoardLocked(true);

      if (expected.from !== from || expected.to !== to) {
        incorrectMovesRef.current += 1;
        if (mode === "puzzle") handlePuzzleFailure();
        if (mode === "drill") endDrillRound();
        if (mode === "time") {
          setFeedback({ square: to, type: "wrong" });
          vibrate([18, 20, 18]);
          playSound("illegal", soundsEnabled);
          timer.current = setTimeout(() => restartTimeLineRef.current(), 520);
          return true;
        }
        // Movimiento incorrecto
        const fenBefore = game.fen();

        setFeedback({ square: to, type: "wrong" });
        vibrate([18, 20, 18]);
        playSound("illegal", soundsEnabled);

        // Ejecutamos temporalmente la jugada incorrecta para permitir que caiga en la casilla equivocada
        // y para actualizar la barra de evaluación material con el error
        const tempChess = new Chess(fenBefore);
        try {
          tempChess.move({ from, to, promotion: "q" });
          setGame(tempChess);
          updateEvaluation(tempChess);
          setLastMove({ from, to });
        } catch (e) {
          // Fallback seguro en caso de que sea ilegal para chess.js
        }

        setTimeout(() => {
          setFeedback(null);
          // Rollback: restauramos el FEN original de antes de la jugada errónea
          const originalChess = new Chess(fenBefore);
          setGame(originalChess);
          updateEvaluation(originalChess);
          setLastMove(null);
          if (mode !== "drill") {
            setTimeout(() => {
              setBoardLocked(false);
            }, 200);
          }
        }, 500);

        return true; // Permite soltar la pieza en la casilla incorrecta para simular el feedback visual
      }

      // Movimiento correcto
      const chess = new Chess(game.fen());
      const move = chess.move({ from, to, promotion: expected.promotion ?? "q" });
      if (!move) {
        setBoardLocked(false);
        return false;
      }

      const nextIndex = moveIndex + 1;
      correctMovesRef.current += 1;
      setGame(chess);
      updateEvaluation(chess);
      setMoveIndex(nextIndex);
      setLastMove({ from, to });
      setFeedback({ square: to, type: "correct" });
      vibrate(10);
      playSound(pieceSound(move, true), soundsEnabled);
      updateInstruction(chess);

      setTimeout(() => {
        setFeedback(null);
        if (mode === "puzzle") playOpponentPuzzleMovesRef.current(chess, nextIndex);
        else playOpponentMoves(chess, nextIndex, 0); // 0 delay inicial porque ya esperamos los 350ms del checkmark
      }, 350);

      return true; // Pieza se queda
    },
    [completed, boardLocked, moves, moveIndex, opening.playerSide, game, soundsEnabled, vibrate, playOpponentMoves, updateInstruction, updateEvaluation, mode, endDrillRound, handlePuzzleFailure]
  );

  function attemptMove(from: Square, to: Square) {
    if (boardLocked || completed) return;
    const expected = moves[moveIndex];
    if (!expected || expected.color !== opening.playerSide) return;
    const legal = game.moves({ square: from, verbose: true }).find((move) => move.to === to);
    if (!legal) {
      const replacement = game.get(to);
      if (replacement?.color === opening.playerSide) chooseSquare(to);
      return;
    }

    setSelected(null);
    setLegalTargets([]);
    setHint(null);
    setBoardLocked(true);

    if (expected.from !== from || expected.to !== to) {
      incorrectMovesRef.current += 1;
      if (mode === "puzzle") handlePuzzleFailure();
      if (mode === "drill") endDrillRound();
      if (mode === "time") {
        setFeedback({ square: to, type: "wrong" });
        vibrate([18, 20, 18]);
        playSound("illegal", soundsEnabled);
        timer.current = setTimeout(() => restartTimeLineRef.current(), 520);
        return;
      }
      setFeedback({ square: to, type: "wrong" });
      vibrate([18, 20, 18]);
      playSound("illegal", soundsEnabled);
      timer.current = setTimeout(() => {
        setFeedback(null);
        if (mode !== "drill") setBoardLocked(false);
      }, 520);
      return;
    }

    const chess = new Chess(game.fen());
    const move = chess.move({ from, to, promotion: expected.promotion ?? "q" });
    if (!move) {
      setBoardLocked(false);
      return;
    }
    const nextIndex = moveIndex + 1;
    correctMovesRef.current += 1;
    setGame(chess);
    setMoveIndex(nextIndex);
    setLastMove({ from, to });
    setFeedback({ square: to, type: "correct" });
    vibrate(10);
    playSound(pieceSound(move, true), soundsEnabled);
    updateInstruction(chess);
    timer.current = setTimeout(() => {
      setFeedback(null);
      if (mode === "puzzle") playOpponentPuzzleMovesRef.current(chess, nextIndex);
      else playOpponentMoves(chess, nextIndex);
    }, 360);
  }

  const handleHintClick = useCallback(() => {
    if (completed || boardLocked) return;
    const expected = moves[moveIndex];
    if (!expected || expected.color !== opening.playerSide) return;

    if (hint) {
      // Si el hint ya está activo, hacemos "Solve" (Resolver la jugada automáticamente)
      if (mode === "practice") incorrectMovesRef.current += 1;
      if (mode === "puzzle") handlePuzzleFailure();
      setHint(null);
      setSelected(null);
      setLegalTargets([]);
      setBoardLocked(true);

      const from = expected.from as Square;
      const to = expected.to as Square;

      const chess = new Chess(game.fen());
      const move = chess.move({ from, to, promotion: expected.promotion ?? "q" });
      if (!move) {
        setBoardLocked(false);
        return;
      }
      const nextIndex = moveIndex + 1;
      correctMovesRef.current += 1;
      setGame(chess);
      updateEvaluation(chess);
      setMoveIndex(nextIndex);
      setLastMove({ from, to });
      setFeedback({ square: to, type: "correct" });
      vibrate(10);
      playSound(pieceSound(move, true), soundsEnabled);
      updateInstruction(chess);
      timer.current = setTimeout(() => {
        setFeedback(null);
        if (mode === "puzzle") playOpponentPuzzleMovesRef.current(chess, nextIndex);
        else playOpponentMoves(chess, nextIndex, 0); // 0 delay inicial porque ya esperamos los 350ms del checkmark
      }, 350);
    } else {
      // Si no, activamos el hint (Pista) que resalta la casilla origen
      setHint(expected.from as Square);
    }
  }, [
    completed,
    boardLocked,
    moves,
    moveIndex,
    opening.playerSide,
    hint,
    game,
    soundsEnabled,
    vibrate,
    playOpponentMoves,
    updateInstruction,
    updateEvaluation,
    mode,
    handlePuzzleFailure,
  ]);


  function startDrag(event: DragEvent, square: Square) {
    const piece = game.get(square);
    if (!piece || piece.color !== opening.playerSide) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData("text/plain", square);
    event.dataTransfer.effectAllowed = "move";
    setSelected(square);
    setLegalTargets(game.moves({ square, verbose: true }).map((move) => move.to));
  }

  function drop(event: DragEvent, square: Square) {
    event.preventDefault();
    const from = event.dataTransfer.getData("text/plain") as Square;
    if (from) attemptMove(from, square);
  }

  async function copyText(value: string) {
    await navigator.clipboard.writeText(value);
    setSettingsOpen(false);
  }

  async function resetProgress() {
    const progress = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
    progress[slug] = {};
    localStorage.setItem("chessengineered_progress", JSON.stringify(progress));
    saveResumeLine(slug, opening.lines[0]);
    setLearnedLines(new Set());
    setPracticePerfectedCount(0);
    drillScoreRef.current = 0;
    setDrillScore(0);
    setDrillHighScore(0);
    setDrillGameOver(false);
    if (timeIntervalRef.current) clearInterval(timeIntervalRef.current);
    timeIntervalRef.current = null;
    timeScoreRef.current = 0;
    setTimeScore(0);
    setTimeHighScore(0);
    setTimeRemainingMs(60000);
    setTimeGameOver(false);
    setMode("learn");
    activityModeRef.current = "learn";
    startLine(0);
    setSettingsOpen(false);
    if (!supabase) return;
    try {
      await resetOpeningProgress(supabase, slug);
    } catch (error: any) {
      console.warn("Unable to reset cloud progress:", error.message);
    }
  }

  const handlePrev = useCallback(() => {
    if (moveIndex > 0) {
      const prevIndex = moveIndex - 1;
      const prevChess = new Chess();
      for (let i = 0; i < prevIndex; i++) {
        prevChess.move(moves[i].san);
      }
      setGame(prevChess);
      updateEvaluation(prevChess);
      setMoveIndex(prevIndex);
      setLastMove(prevIndex > 0 ? { from: moves[prevIndex - 1].from, to: moves[prevIndex - 1].to } : null);
      setFeedback(null);
      setCompleted(false);
      setBoardLocked(false);
    }
  }, [moveIndex, moves, updateEvaluation]);

  const handleNext = useCallback(() => {
    if (moveIndex < moves.length) {
      const expected = moves[moveIndex];
      const chess = new Chess(game.fen());
      const move = chess.move(expected.san);
      if (move) {
        const nextIndex = moveIndex + 1;
        setGame(chess);
        updateEvaluation(chess);
        setMoveIndex(nextIndex);
        setLastMove({ from: move.from, to: move.to });
        setFeedback(null);
        setBoardLocked(false);
        if (nextIndex === moves.length) {
          setCompleted(true);
          playSound("game-end", soundsEnabled);
        }
      }
    }
  }, [moveIndex, moves, game, soundsEnabled, updateEvaluation]);

  useEffect(() => {
    document.body.classList.add("trainer-active");
    return () => {
      document.body.classList.remove("trainer-active");
      if (timeIntervalRef.current) clearInterval(timeIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (completed && mode === "learn") {
      document.body.classList.add("line-complete-mobile");
    } else {
      document.body.classList.remove("line-complete-mobile");
    }
    return () => {
      document.body.classList.remove("line-complete-mobile");
    };
  }, [completed, mode]);

  const orderedRanks = opening.playerSide === "b" ? [...ranks].reverse() : ranks;
  const orderedFiles = opening.playerSide === "b" ? [...files].reverse() : files;
  const clampedScore = Math.max(-10, Math.min(10, evalScore));
  const whitePercent = Math.max(3, Math.min(97, 50 + (clampedScore / 10) * 45));
  
  const formatScoreText = () => {
    if (evalMate !== null && evalMate !== undefined) {
      return `${evalMate >= 0 ? "+" : "-"}M${Math.abs(evalMate)}`;
    }
    return evalScore >= 0 ? `+${evalScore.toFixed(1)}` : evalScore.toFixed(1);
  };

  const progress = moves.length ? Math.round((moveIndex / moves.length) * 100) : 0;
  const nextExpected = moves[moveIndex];
  const timeSeconds = Math.floor(timeRemainingMs / 1000);
  const timeCentiseconds = Math.floor((timeRemainingMs % 1000) / 10).toString().padStart(2, "0");

  return (
    <div className="trainer-layout">
      {/* Ambient Glowing Background Elements */}
      <div className="bg-glows" aria-hidden="true">
        <div className="glow glow-1"></div>
        <div className="glow glow-2"></div>
      </div>

      {/* Board */}
      <div className="board-area">
        <div className="line-progress-wrap">
          <div className="line-progress-row">
            <Link className="progress-back-btn" href="/openings" aria-label="Back to openings">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.283 10.94a1.5 1.5 0 0 0 0 2.12l5.656 5.658a1.5 1.5 0 1 0 2.122-2.122L7.965 13.5H19.5a1.5 1.5 0 0 0 0-3H7.965l3.096-3.096a1.5 1.5 0 1 0-2.122-2.121z"/>
              </svg>
            </Link>
            <div className="line-progress-track">
              <div className="line-progress-fill" id="lineProgressBar" style={{ width: `${progress}%` }}></div>
            </div>
          </div>
          <div className="line-progress-label">
            <span className="move-num" id="progressMoveNum">Move {moveIndex}/{moves.length}</span>
            <span className="move-name" id="progressLineName">{mode === "puzzle" ? `Puzzle ~${currentPuzzle?.Rating ?? puzzleElo} ELO` : opening.lineNames[currentLine] ?? `Línea ${lineIndex + 1}`}</span>
          </div>
        </div>

        <div className="board-with-eval">
          {showEval && (
            <div
              className="eval-bar"
              id="evalBar"
              style={{
                "--white-pct": `${whitePercent}%`,
                "--black-pct": `${100 - whitePercent}%`
              } as React.CSSProperties}
            >
              <div className="eval-bar-white" id="evalBarWhite"></div>
              <div className="eval-bar-black" id="evalBarBlack"></div>
              <div className={`eval-bar-score ${evalLoading ? "is-loading" : ""} ${evalFallback ? "is-fallback" : ""}`} id="evalBarScore">
                {formatScoreText()}
              </div>
            </div>
          )}
          <div id="board">
            <ChessboardReact
              position={game.fen()}
              orientation={opening.playerSide}
              pieceSet={pieceSet}
              boardTheme={boardTheme}
              inputEnabled={!completed && !boardLocked && moves[moveIndex] !== undefined && (moves[moveIndex].color === opening.playerSide)}
              inputColor={opening.playerSide}
              onMoveAttempt={handleMoveAttempt}
              lastMove={lastMove}
              hintSquare={hint}
              feedback={feedback}
              showLegalMarkers={true}
              gameInstance={game}
            />
          </div>
        </div>

        <div className={`completion-overlay ${completed && mode === "learn" ? "open" : ""}`} id="completionOverlay">
          <h2>Line Complete!</h2>
          <div className="completion-sub" id="completionSub">
            {mode === "practice" ? "Practice complete. Loading another learned line..." : "Great job! You learned a new line."}
          </div>
        </div>
      </div>

      {/* Right Panel */}
      <div className="trainer-panel">
        <div className="panel-content">
          {/* Mode Header */}
          <div className="mode-header" id="modeHeader" onClick={() => {
            if (mode !== "puzzle") setLinePickerOpen((open) => !open);
          }}>
            <div className="mode-info">
              <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink-2)" }}>
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
              <div>
                <div className="mode-name">{mode === "puzzle" ? "Puzzles" : mode === "time" ? "Time Trials" : mode === "drill" ? "Drill" : mode === "practice" ? "Practice" : "Learn"}</div>
                <div className="opening-name" id="openingName">{opening.displayName.replace(" Mastery", "")}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="line-counter" id="lineCounter">{mode === "puzzle" ? "Puzzle" : `#${lineIndex + 1}`}</span>
              <span id="dropdownChevron" style={{ fontSize: "0.7rem", color: "var(--color-muted)", transition: "transform 0.2s", transform: linePickerOpen ? "rotate(180deg)" : "" }}>▼</span>
            </div>

            {/* Line Dropdown */}
            <div className={`line-dropdown ${linePickerOpen && mode !== "puzzle" ? "open" : ""}`} id="lineDropdown">
              <div className="dropdown-list" id="dropdownList">
                {opening.lines.map((line, index) => {
                  const learned = learnedLines.has(line);
                  const locked = mode === "practice" || mode === "drill" || mode === "time"
                    ? !learned
                    : !learned && index !== getNextLearnLineIndex(opening.lines, learnedLines);
                  return (
                    <div
                      key={line}
                      className={`dropdown-item ${index === lineIndex ? "active" : ""} ${locked ? "locked" : ""}`}
                      aria-disabled={locked}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (locked) return;
                        startLine(index);
                        setLinePickerOpen(false);
                      }}
                    >
                      <span className="line-num">#{index + 1}</span>
                      <span className="line-icon">{locked ? "🔒" : learned ? "✓" : "🎯"}</span>
                      <span className="line-label">{opening.lineNames[line] ?? `Línea ${index + 1}`}</span>
                      {locked && <span className="line-locked-label">Locked</span>}
                      {index === lineIndex && <span className="line-check">✓</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
             {/* Instruction Dialog (placed right below Mode Header) */}
          {showDialog && (
            <div className="instruction-dialog">
              <div className="coach-avatar">
                <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="50" cy="50" r="48" fill="#fbbf24"/>
                  <text x="50" y="70" text-anchor="middle" fontSize="55" fill="#fff">♔</text>
                </svg>
              </div>
              <div className="speech-bubble">
                <div className="instruction-text" id="instruction">
                  {instruction || "Preparando la variante..."}
                </div>
              </div>
            </div>
          )}

          {/* Spacer to push mode buttons to the center */}
          {/* Mode Selector */}
          <div className={`mode-selector ${mode === "drill" || mode === "time" || mode === "puzzle" ? "drill-hidden" : ""}`}>
            {completed && mode === "learn" ? (
              <div style={{ display: "flex", gap: "12px", width: "100%" }}>
                <button
                  className="focus-visible:ring-ring inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50 touch-manipulation select-none border-input hover:bg-accent hover:text-accent-foreground border shadow-xs h-8 rounded-md px-3 sm:px-4 text-xs sm:h-10 sm:text-base btn-secondary"
                  type="button"
                  data-cwv="trainer-restart-button"
                  onClick={() => startLine(lineIndex)}
                  style={{
                    height: "56px",
                    width: "56px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    padding: 0
                  }}
                  title="Restart Line"
                  aria-label="Restart Line"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5">
                      <path d="M12 3a9 9 0 1 1-5.657 2"></path>
                      <path d="M3 4.5h4v4"></path>
                    </g>
                  </svg>
                </button>
                <button
                  className="btn-next-line"
                  onClick={() => startLine(nextLearnLineIndex)}
                  style={{
                    flex: 1,
                    height: "56px",
                    fontSize: "1.1rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer"
                  }}
                >
                  Next Line
                </button>
              </div>
            ) : (
              <>
                <button className={`mode-btn ${mode === "learn" ? "active" : ""}`} id="modeLearn" type="button" onClick={() => changeMode("learn")}>
                  <div className="mode-btn-main">
                    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink)" }}>
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                    </svg>
                    <span className="mode-title">Learn</span>
                  </div>
                  <span className="mode-sub" id="learnStats">{learnedCount} lines discovered</span>
                </button>

                <button className={`mode-btn ${mode === "practice" ? "active" : ""} ${learnedCount === 0 ? "locked" : ""}`} id="modePractice" disabled={learnedCount === 0} type="button" onClick={() => changeMode("practice")}>
                  <div className="mode-btn-main">
                    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink)" }}>
                      <circle cx="12" cy="12" r="10"/>
                      <circle cx="12" cy="12" r="6"/>
                      <circle cx="12" cy="12" r="2"/>
                    </svg>
                    <span className="mode-title">Practice</span>
                  </div>
                  <span className="mode-sub" id="practiceStats">{practicePerfectedCount}/{learnedCount} lines perfected</span>
                </button>

                <button className={`mode-btn ${learnedCount < 2 ? "locked" : ""}`} id="modePuzzles" disabled={learnedCount < 2} type="button" onClick={() => changeMode("puzzle")}>
                  <div className="mode-btn-main">
                    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink)", opacity: 0.5 }}>
                      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.378 1.378a1 1 0 0 1 .289.878c0 .486-.166.893-.457 1.181l-1.99 1.99a1 1 0 0 1-.878.289 1 1 0 0 1-.878-.289l-1.378-1.378a1.05 1.05 0 0 0-.878-.289c-.322 0-.649.059-.878.289l-1.378 1.378a1 1 0 0 1-.878.289 1 1 0 0 1-.878-.289l-1.99-1.99a1 1 0 0 1-.289-.878c0-.486.166-.893.457-1.181l1.378-1.378a1.05 1.05 0 0 0 .289-.878c0-.322-.059-.649-.289-.878l-1.378-1.378a1 1 0 0 1-.289-.878c0-.486.166-.893.457-1.181l1.99-1.99a1 1 0 0 1 .878-.289c.322 0 .649.059.878.289l1.378 1.378a1.05 1.05 0 0 0 .878.289c.322 0 .649-.059.878-.289l1.378-1.378a1 1 0 0 1 .878-.289 1 1 0 0 1 .878.289l1.99 1.99a1 1 0 0 1 .289.878c0 .486-.166.893-.457 1.181l-1.378 1.378a1.05 1.05 0 0 0-.289.878z"/>
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
                    </svg>
                    <span className="mode-title">Puzzles</span>
                  </div>
                  <span className="mode-sub">Solve puzzles, win ELO</span>
                </button>

                <div className="mode-grid">
                  <button className={`mode-btn small ${learnedCount < 3 ? "locked" : ""}`} id="modeDrill" disabled={learnedCount < 3} type="button" onClick={() => changeMode("drill")}>
                    <div className="mode-btn-main">
                      <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink)", opacity: 0.5 }}>
                        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
                      </svg>
                      <span className="mode-title">Drill</span>
                    </div>
                    <span className="mode-sub">Max your streak</span>
                  </button>

                  <button className={`mode-btn small ${learnedCount < 3 ? "locked" : ""}`} id="modeTime" disabled={learnedCount < 3} type="button" onClick={() => changeMode("time")}>
                    <div className="mode-btn-main">
                      <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink)", opacity: 0.5 }}>
                        <path d="M5 22h14"/>
                        <path d="M5 2h14"/>
                        <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/>
                        <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l-4.414-4.414A2 2 0 0 0 17 6.172V2"/>
                      </svg>
                      <span className="mode-title">Time Trials</span>
                    </div>
                    <span className="mode-sub">Race the clock</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Drill Panel */}
          {mode === "drill" && (
            <div className="drill-panel active" id="drillPanel">
              <div className="drill-scoreboard">
                <div className="drill-score-item">
                  <span className="drill-score-label">Score</span>
                  <span className="drill-score-value" id="drillScore">{drillScore}</span>
                </div>
                <div className={`drill-high-score ${drillHighScore > 0 ? "" : "locked"}`} id="drillHighScoreWrap">
                  <span className="drill-score-label">High Score</span>
                  <span className="drill-score-value" id="drillHighScore">{drillHighScore > 0 ? drillHighScore : "--"}</span>
                </div>
              </div>
              <div className="drill-leaderboard">
                <div className="drill-leaderboard-header">
                  <h3>Drill Mode</h3>
                </div>
                <div className="drill-leaderboard-msg">Un error termina la ronda. Completa tantas líneas seguidas como puedas.</div>
              </div>
              <button className="btn-leave-drill" type="button" onClick={() => changeMode("learn")}>Leave Drill Mode</button>
            </div>
          )}

          {/* Time Trials Panel */}
          {mode === "time" && (
            <div className="time-panel active" id="timePanel">
              <div className="time-timer" aria-label={`${timeSeconds} seconds remaining`}>
                <span className="timer-secs">{timeSeconds}</span>
                <span className="timer-cs">.{timeCentiseconds}</span>
                <span className="timer-label">seconds</span>
              </div>
              <div className="time-scoreboard">
                <div className="drill-score-item">
                  <span className="drill-score-label">Score</span>
                  <span className="drill-score-value" id="timeScore">{timeScore}</span>
                </div>
                <div className={`drill-high-score ${timeHighScore > 0 ? "" : "locked"}`}>
                  <span className="drill-score-label">High Score</span>
                  <span className="drill-score-value" id="timeHighScore">{timeHighScore > 0 ? timeHighScore : "--"}</span>
                </div>
              </div>
              <div className="time-leaderboard">
                <div className="drill-leaderboard-msg">Un error reinicia la línea. Completa tantas líneas como puedas en 60 segundos.</div>
              </div>
              <button className="btn-leave-drill" type="button" onClick={() => changeMode("learn")}>Leave Time Trials</button>
            </div>
          )}

          {/* Puzzle Panel */}
          {mode === "puzzle" && (
            <div className="puzzle-panel active" id="puzzlePanel">
              <div className="puzzle-rating-display">
                <span className="puzzle-rating-label">Your Puzzle ELO</span>
                <span className="puzzle-rating-value" id="puzzleRating">{puzzleElo}</span>
              </div>
              <div className="puzzle-divider"></div>
              <div className="puzzle-streak">
                <svg className="puzzle-streak-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
                </svg>
                <div className="puzzle-streak-info">
                  <span className="puzzle-streak-label">Current streak</span>
                  <span className="puzzle-streak-value" id="puzzleStreak">{puzzleStreak}</span>
                </div>
              </div>
              <div className="puzzle-streak">
                <div className="puzzle-streak-info">
                  <span className="puzzle-streak-label">Puzzle difficulty</span>
                  <span className="puzzle-streak-value">{currentPuzzle ? `~${currentPuzzle.Rating} rating` : puzzleLoading ? "Loading..." : "---"}</span>
                </div>
              </div>
              {puzzleMessage && <div className="drill-leaderboard-msg">{puzzleMessage}</div>}
              <button className="btn-leave-drill" type="button" onClick={() => changeMode("learn")}>Leave Puzzles</button>
            </div>
          )}
          
          <div className="panel-spacer" style={{ flex: 1 }} />
        </div>

        {/* Bottom Toolbar */}
        <div className="trainer-toolbar">
          <div className="toolbar-group toolbar-default-left">
            <button className="toolbar-btn icon-only" id="btnSettings" aria-label="Settings" aria-haspopup="menu" aria-expanded={settingsOpen} type="button" onClick={() => setSettingsOpen((open) => !open)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
            <div className={`settings-menu ${settingsOpen ? "open" : ""}`} id="settingsMenu" role="menu" aria-label="Settings">
              <div className="settings-menu-title">Settings</div>
              <div className="settings-menu-separator"></div>
              <button className="settings-menu-item is-check" type="button" role="menuitemcheckbox" aria-checked={showEval} onClick={() => persistBoolean("chessengineered_show_eval", !showEval, setShowEval)}>
                <span className="settings-check" aria-hidden="true">✓</span>
                <span>Show Evaluation Bar</span>
              </button>
              <button className="settings-menu-item is-check" type="button" role="menuitemcheckbox" aria-checked={soundsEnabled} onClick={() => persistBoolean("chessengineered_sound", !soundsEnabled, setSoundsEnabled)}>
                <span className="settings-check" aria-hidden="true">✓</span>
                <span>Play Sounds</span>
              </button>
              <button className="settings-menu-item is-check" type="button" role="menuitemcheckbox" aria-checked={hapticsEnabled} onClick={() => persistBoolean("chessengineered_haptic", !hapticsEnabled, setHapticsEnabled)}>
                <span className="settings-check" aria-hidden="true">✓</span>
                <span>Haptic Feedback</span>
              </button>
              <div className="settings-menu-separator"></div>
              <div className="settings-menu-title">Board Style</div>
              <label className="settings-select-row">
                <span>Piece Set</span>
                <select value={pieceSet} onChange={(event) => {
                  const value = event.target.value as PieceSet;
                  localStorage.setItem("chessengineered_piece_set", value);
                  setPieceSet(value);
                }}>
                  <option value="staunty">Staunty</option>
                  <option value="maestro">Maestro</option>
                  <option value="standard">Standard</option>
                </select>
              </label>
              <label className="settings-select-row">
                <span>Chessboard Theme</span>
                <select value={boardTheme} onChange={(event) => {
                  const value = event.target.value as BoardTheme;
                  localStorage.setItem("chessengineered_board_theme", value);
                  setBoardTheme(value);
                }}>
                  <option value="green">Green</option>
                  <option value="white-violet">White Violet</option>
                  <option value="white-blue">White Blue</option>
                  <option value="blue">Blue</option>
                  <option value="brown">Brown</option>
                  <option value="classic">Classic</option>
                  <option value="black-and-white">Black & White</option>
                </select>
              </label>
              <div className="settings-menu-separator"></div>
              <div className="settings-menu-title">Export &amp; Share</div>
              <button className="settings-menu-item" type="button" onClick={() => window.open(lichessAnalysisUrl(game.fen()), "_blank", "noopener,noreferrer")}>Open in Lichess</button>
              <button className="settings-menu-item" type="button" onClick={() => void copyText(currentLine)}>Copy PGN</button>
              <button className="settings-menu-item" type="button" onClick={() => void copyText(game.fen())}>Copy FEN</button>
              <div className="settings-menu-separator"></div>
              <div className="settings-menu-title">Learn Settings</div>
              <label className="settings-select-row">
                <span>Training Arrows</span>
                <select value={trainingArrows ? "on" : "off"} onChange={(event) => persistBoolean("chessengineered_training_arrows", event.target.value === "on", setTrainingArrows)}>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <label className="settings-select-row">
                <span>Learn Dialog</span>
                <select value={showDialog ? "open" : "closed"} onChange={(event) => persistBoolean("chessengineered_show_dialog", event.target.value === "open", setShowDialog)}>
                  <option value="open">Always Open</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
              <button className="settings-menu-item" type="button" onClick={() => void resetProgress()}>Reset Progress</button>
            </div>
            <span className="version-badge">v1.4.0</span>
            <button 
              className={`toolbar-btn ${hint ? "solve-active" : ""}`} 
              id="btnHint" 
              type="button" 
              onClick={handleHintClick}
            >
              {hint ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1.5"/>
                    <path d="m22 10-7.5 7.5L11 14"/>
                  </svg>
                  <span>Solve</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>
                    <path d="M9 18h6"/>
                    <path d="M10 22h4"/>
                  </svg>
                  <span>Hint</span>
                </>
              )}
            </button>
          </div>
          <div className="toolbar-group">
            <button className="toolbar-btn mobile-mode-toggle" type="button" aria-label="Change mode" onClick={() => document.body.classList.toggle("show-mobile-modes")}>Mode</button>
          </div>
          <div className="toolbar-group nav-group toolbar-default-right">
            <button className="toolbar-btn icon-only" id="btnPrev" aria-label="Previous move" type="button" onClick={handlePrev}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6"/>
              </svg>
            </button>
            <button className="toolbar-btn icon-only" id="btnNext" aria-label="Next move" type="button" onClick={handleNext}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6"/>
              </svg>
            </button>
          </div>
          <div className="mobile-complete-controls" id="mobileCompleteControls">
            <button className="toolbar-btn icon-only" type="button" id="btnCompleteRestart" aria-label="Restart line" onClick={() => startLine(lineIndex)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3a9 9 0 1 1-5.657 2"/>
                <path d="M3 4.5h4v4"/>
              </svg>
            </button>
            <button className="toolbar-btn complete-next-line" type="button" id="btnCompleteNext" onClick={() => startLine(mode === "practice" ? nextPracticeLineIndex : nextLearnLineIndex)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
              <span id="completeNextLabel">Next Line</span>
            </button>
          </div>
        </div>
      </div>
      <div className={`gameover-overlay ${drillGameOver ? "open" : ""}`} id="gameoverOverlay">
        <div className="gameover-card">
          <h2 className="gameover-title-danger">Game Over</h2>
          <div className="gameover-stats">
            <div className="gameover-score">
              <span className="score-label">SCORE</span>
              <span className="score-value">{drillScore}</span>
            </div>
            <div className="gameover-high">
              <span className="high-label">High Score:</span>
              <span className="high-value">{drillHighScore}</span>
            </div>
          </div>
          <div className="gameover-actions">
            <button className="btn-next-line" type="button" onClick={() => {
              drillScoreRef.current = 0;
              setDrillScore(0);
              setDrillGameOver(false);
              startLine(getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex), "drill");
            }}>Try Again</button>
            <button className="btn-secondary" type="button" onClick={() => changeMode("learn")}>Leave Drill</button>
          </div>
        </div>
      </div>
      <div className={`gameover-overlay ${timeGameOver ? "open" : ""}`} id="timeGameoverOverlay">
        <div className="gameover-card">
          <h2 className="gameover-title-warning">Time&apos;s Up</h2>
          <div className="gameover-stats">
            <div className="gameover-score">
              <span className="score-label">SCORE</span>
              <span className="score-value">{timeScore}</span>
            </div>
            <div className="gameover-high">
              <span className="high-label">High Score:</span>
              <span className="high-value">{timeHighScore}</span>
            </div>
          </div>
          <div className="gameover-actions">
            <button className="btn-next-line" type="button" onClick={() => {
              startTimeRound();
              startLine(getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex), "time");
            }}>Try Again</button>
            <button className="btn-secondary" type="button" onClick={() => changeMode("learn")}>Leave Time Trials</button>
          </div>
        </div>
      </div>
    </div>
  );
}
