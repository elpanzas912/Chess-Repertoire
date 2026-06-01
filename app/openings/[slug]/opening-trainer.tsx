"use client";

import Link from "next/link";
import confetti from "canvas-confetti";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Chess, type Square } from "chess.js";
import { supabase } from "../../../lib/supabase";
import { createEventId, recordTrainingCompletion, recordTrainingActivity, resetOpeningProgress, saveDrillHighScore, type TrainingMode } from "../../../lib/cloud-progress";
import { loadOpening, OpeningAccessError, readCachedOpening, type CachedOpening } from "../../../lib/opening-cache";
import { ChessboardReact } from "./chessboard-react";

type Opening = CachedOpening;

type CourseMove = {
  color: string;
  from: Square;
  san: string;
  to: Square;
};

type Feedback = { square: Square; type: "correct" | "wrong" } | null;
type PieceSet = "staunty" | "maestro" | "standard";
type BoardTheme = "green" | "white-violet" | "white-blue" | "blue" | "brown" | "classic" | "black-and-white";

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
const PRACTICE_TRANSITION_DELAY_MS = 800;

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

function getOpeningHighScore(slug: string, key: "drillHighScore") {
  try {
    const progress = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
    return Math.max(0, Math.round(Number(progress[slug]?.[key]) || 0));
  } catch {
    return 0;
  }
}

function saveOpeningHighScore(slug: string, key: "drillHighScore", score: number) {
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

  useEffect(() => {
    let active = true;

    async function loadOpeningData() {
      if (!supabase) {
        setError("Supabase no está configurado.");
        return;
      }

      const loadedOpening = await loadOpening(supabase, slug);
      if (active) setOpening(loadedOpening);
    }

    void loadOpeningData().catch((loadError) => {
      if (loadError instanceof OpeningAccessError && loadError.status === 401) {
        router.replace(`/login?next=/opening/${slug}`);
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
  }, [router, slug]);

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
  const currentLine = opening.lines[lineIndex];
  const moves = useMemo(() => parseLine(currentLine), [currentLine]);
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
    } else {
      drillScoreRef.current += 1;
      setDrillScore(drillScoreRef.current);
    }

    if (!supabase || mode === "drill") return;
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
      mode,
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
    const nextHighScore = saveOpeningHighScore(slug, "drillHighScore", drillScore);
    setDrillHighScore(nextHighScore);
    if (supabase && drillScore >= nextHighScore) {
      void saveDrillHighScore(supabase, slug, drillScore)
        .catch((error) => console.warn("Unable to save drill high score:", error.message));
    }
  }, [drillGameOver, drillScore, slug]);

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
  }, [mode, opening.lines, slug]);

  const changeMode = useCallback((nextMode: TrainingMode) => {
    if (nextMode === mode) return;
    if (nextMode === "practice" && learnedLines.size === 0) {
      alert("Learn some lines first!");
      return;
    }
    if (nextMode === "drill" && learnedLines.size < 3) {
      alert("Learn 3 lines to unlock Drill!");
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
    if (nextMode === "drill") {
      drillScoreRef.current = 0;
      setDrillScore(0);
    }
    const nextIndex = nextMode === "practice" || nextMode === "drill"
      ? getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex)
      : getResumeLineIndex(slug, opening.lines);
    startLine(nextIndex, nextMode);
  }, [learnedLines, lineIndex, mode, opening.lines, slug, startLine]);

  useEffect(() => {
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
  }, [lineIndex, playOpponentMoves, restartVersion, updateEvaluation]);

  useEffect(() => {
    startNextPracticeLineRef.current = () => {
      startLine(getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex), "practice");
    };
    startNextDrillLineRef.current = () => {
      startLine(getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex), "drill");
    };
  }, [learnedLines, lineIndex, opening.lines, startLine]);

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
        if (mode === "drill") endDrillRound();
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
      const move = chess.move({ from, to, promotion: "q" });
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
        playOpponentMoves(chess, nextIndex, 0); // 0 delay inicial porque ya esperamos los 350ms del checkmark
      }, 350);

      return true; // Pieza se queda
    },
    [completed, boardLocked, moves, moveIndex, opening.playerSide, game, soundsEnabled, vibrate, playOpponentMoves, updateInstruction, updateEvaluation, mode, endDrillRound]
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
      if (mode === "drill") endDrillRound();
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
    const move = chess.move({ from, to, promotion: "q" });
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
      playOpponentMoves(chess, nextIndex);
    }, 360);
  }

  const handleHintClick = useCallback(() => {
    if (completed || boardLocked) return;
    const expected = moves[moveIndex];
    if (!expected || expected.color !== opening.playerSide) return;

    if (hint) {
      // Si el hint ya está activo, hacemos "Solve" (Resolver la jugada automáticamente)
      if (mode === "practice") incorrectMovesRef.current += 1;
      setHint(null);
      setSelected(null);
      setLegalTargets([]);
      setBoardLocked(true);

      const from = expected.from as Square;
      const to = expected.to as Square;

      const chess = new Chess(game.fen());
      const move = chess.move({ from, to, promotion: "q" });
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
        playOpponentMoves(chess, nextIndex, 0); // 0 delay inicial porque ya esperamos los 350ms del checkmark
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
            <span className="move-name" id="progressLineName">{opening.lineNames[currentLine] ?? `Línea ${lineIndex + 1}`}</span>
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
          <div className="mode-header" id="modeHeader" onClick={() => setLinePickerOpen((open) => !open)}>
            <div className="mode-info">
              <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink-2)" }}>
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
              <div>
                <div className="mode-name">{mode === "drill" ? "Drill" : mode === "practice" ? "Practice" : "Learn"}</div>
                <div className="opening-name" id="openingName">{opening.displayName.replace(" Mastery", "")}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="line-counter" id="lineCounter">#{lineIndex + 1}</span>
              <span id="dropdownChevron" style={{ fontSize: "0.7rem", color: "var(--color-muted)", transition: "transform 0.2s", transform: linePickerOpen ? "rotate(180deg)" : "" }}>▼</span>
            </div>

            {/* Line Dropdown */}
            <div className={`line-dropdown ${linePickerOpen ? "open" : ""}`} id="lineDropdown">
              <div className="dropdown-list" id="dropdownList">
                {opening.lines.map((line, index) => {
                  const learned = learnedLines.has(line);
                  const locked = mode === "practice" || mode === "drill"
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
          <div style={{ flex: 1 }} />

          {/* Mode Selector */}
          {mode === "drill" ? (
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
          ) : (
          <div className="mode-selector">
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

                <button className="mode-btn locked" id="modePuzzles" disabled type="button">
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

                  <button className="mode-btn small locked" id="modeTime" disabled type="button">
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
          )}

          {/* Bottom spacer to push mode buttons to the center */}
          <div style={{ flex: 1 }} />
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
            <button className="toolbar-btn mobile-mode-toggle" type="button" aria-label="Change mode" onClick={() => document.body.classList.toggle("show-mobile-modes")}>Mode</button>
          </div>
        </div>
      </div>
      <div className={`gameover-overlay ${drillGameOver ? "open" : ""}`} id="gameoverOverlay">
        <h2>Game Over</h2>
        <div className="gameover-score">Score: {drillScore}</div>
        <div className="gameover-high">High Score: {drillHighScore}</div>
        <button className="btn-next-line" type="button" onClick={() => {
          drillScoreRef.current = 0;
          setDrillScore(0);
          setDrillGameOver(false);
          startLine(getRandomPracticeLineIndex(opening.lines, learnedLines, lineIndex), "drill");
        }}>Try Again</button>
        <button className="btn-next-line" type="button" onClick={() => changeMode("learn")}>Leave Drill</button>
      </div>
    </div>
  );
}
