"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Chess, type Square } from "chess.js";
import { supabase } from "../../../lib/supabase";
import { createEventId, recordLearnCompletion, recordTrainingActivity, resetOpeningProgress } from "../../../lib/cloud-progress";
import { ChessboardReact } from "./chessboard-react";

type Opening = {
  id: string;
  displayName: string;
  playerSide: "w" | "b";
  lines: string[];
  lineNames: Record<string, string>;
  lineCount: number;
  descriptions: Record<string, string>;
};

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

function getLearnedCount(slug: string) {
  try {
    const progress = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
    return new Set(progress[slug]?.learnedLines ?? []).size;
  } catch {
    return 0;
  }
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
  const [opening, setOpening] = useState<Opening | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadOpening() {
      if (!supabase) {
        setError("Supabase no está configurado.");
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        router.replace(`/login?next=/opening/${slug}`);
        return;
      }

      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      const response = await fetch(`${url}/functions/v1/get-opening?slug=${encodeURIComponent(slug)}`, {
        headers: { apikey: key ?? "", Authorization: `Bearer ${token}` },
      });

      if (response.status === 401) {
        router.replace(`/login?next=/opening/${slug}`);
        return;
      }
      if (response.status === 403) {
        router.replace("/plans");
        return;
      }
      if (!response.ok) {
        setError("No se pudo cargar la apertura. Intenta nuevamente.");
        return;
      }

      const payload = await response.json() as { opening?: Opening };
      if (active && payload.opening) setOpening(payload.opening);
    }

    void loadOpening().catch(() => {
      if (active) setError("No se pudo cargar la apertura. Intenta nuevamente.");
    });

    return () => {
      active = false;
    };
  }, [router, slug]);

  if (error) return <TrainerMessage message={error} />;
  if (!opening) return <TrainerMessage message="Cargando apertura..." />;
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
  const [lineIndex, setLineIndex] = useState(0);
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
  const [learnedCount, setLearnedCount] = useState(() => getLearnedCount(slug));
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
  const currentLine = opening.lines[lineIndex];
  const moves = useMemo(() => parseLine(currentLine), [currentLine]);

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
      void recordTrainingActivity(client, slug, durationMs).catch((error) =>
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
    }, 120); // Debounce de 120ms
  }, []);

  const updateInstruction = useCallback((chess: Chess) => {
    setInstruction(opening.descriptions[chess.fen()] ?? "Encuentra el mejor movimiento para continuar la variante.");
  }, [opening.descriptions]);
  const completeCurrentLine = useCallback(() => {
    if (completedLineRef.current) return;
    completedLineRef.current = true;

    saveLearnedLine(slug, currentLine);
    setLearnedCount(getLearnedCount(slug));

    if (!supabase) return;
    const now = Date.now();
    const activeDurationMs = now - activityStartedAtRef.current;
    activityStartedAtRef.current = now;
    if (activeDurationMs >= 1000) {
      void recordTrainingActivity(supabase, slug, activeDurationMs).catch((error) =>
        console.warn("Unable to sync training time:", error.message),
      );
    }
    void recordLearnCompletion(supabase, {
      eventId: createEventId(),
      slug,
      line: currentLine,
      correctMoves: correctMovesRef.current,
      incorrectMoves: incorrectMovesRef.current,
      durationMs: Math.max(0, Date.now() - sessionStartedAtRef.current),
    })
      .then(() => setLearnedCount(getLearnedCount(slug)))
      .catch((error) => console.warn("Unable to sync training progress:", error.message));
  }, [currentLine, slug]);

  const playOpponentMoves = useCallback((source: Chess, startIndex: number, initialDelay = 0) => {
    const chess = new Chess(source.fen());
    let index = startIndex;

    const playNext = () => {
      const next = moves[index];
      if (!next) {
        setCompleted(true);
        completeCurrentLine();
        playSound("game-end", soundsEnabled);
        setBoardLocked(true);
        return;
      }
      if (next.color === opening.playerSide) {
        const nextChess = new Chess(chess.fen());
        setGame(nextChess);
        updateEvaluation(nextChess);
        setMoveIndex(index);
        updateInstruction(chess);
        const unlockDelay = index > startIndex ? 50 : 250;
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
      timer.current = setTimeout(playNext, 340);
    };

    setBoardLocked(true);
    timer.current = setTimeout(playNext, initialDelay);
  }, [completeCurrentLine, moves, opening.playerSide, soundsEnabled, updateInstruction, updateEvaluation]);

  const startLine = useCallback((index: number) => {
    if (timer.current) clearTimeout(timer.current);
    sessionStartedAtRef.current = Date.now();
    correctMovesRef.current = 0;
    incorrectMovesRef.current = 0;
    completedLineRef.current = false;
    setLineIndex(index);
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
  }, []);

  useEffect(() => {
    const chess = new Chess();
    setGame(chess);
    updateEvaluation(chess);
    setMoveIndex(0);
    setCompleted(false);
    setBoardLocked(true);
    playSound("game-start", soundsEnabled);
    playOpponentMoves(chess, 0, 240);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (evalTimerRef.current) clearTimeout(evalTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, [lineIndex, playOpponentMoves, restartVersion, updateEvaluation]);

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
          setTimeout(() => {
            setBoardLocked(false);
          }, 250);
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
    [completed, boardLocked, moves, moveIndex, opening.playerSide, game, soundsEnabled, vibrate, playOpponentMoves, updateInstruction, updateEvaluation]
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
      setFeedback({ square: to, type: "wrong" });
      vibrate([18, 20, 18]);
      playSound("illegal", soundsEnabled);
      timer.current = setTimeout(() => {
        setFeedback(null);
        setBoardLocked(false);
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
    setLearnedCount(0);
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
    if (completed) {
      document.body.classList.add("line-complete-mobile");
    } else {
      document.body.classList.remove("line-complete-mobile");
    }
    return () => {
      document.body.classList.remove("line-complete-mobile");
    };
  }, [completed]);

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

        <div className={`completion-overlay ${completed ? "open" : ""}`} id="completionOverlay">
          <h2>Line Complete!</h2>
          <div className="completion-sub" id="completionSub">Great job! You learned a new line.</div>
          <button className="btn-next-line" onClick={() => startLine((lineIndex + 1) % opening.lines.length)}>Next Line</button>
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
                <div className="mode-name">Learn</div>
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
                {opening.lines.map((line, index) => (
                  <div
                    key={line}
                    className={`dropdown-item ${index === lineIndex ? "active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      startLine(index);
                      setLinePickerOpen(false);
                    }}
                  >
                    <span className="line-num">#{index + 1}</span>
                    <span className="line-label">{opening.lineNames[line] ?? `Línea ${index + 1}`}</span>
                    {index < learnedCount && <span className="line-check">✓</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Instruction Dialog */}
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

          {/* Mode Selector */}
          <div className="mode-selector">
            <button className="mode-btn active" id="modeLearn" type="button">
              <div className="mode-btn-main">
                <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink)" }}>
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
                <span className="mode-title">Learn</span>
              </div>
              <span className="mode-sub" id="learnStats">{learnedCount} lines discovered</span>
            </button>

            <button className="mode-btn" id="modePractice" type="button" onClick={() => {
              if (learnedCount === 0) {
                alert("Learn some lines first!");
              } else {
                alert("Practice mode is currently integrated into the learning sequence.");
              }
            }}>
              <div className="mode-btn-main">
                <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink)" }}>
                  <circle cx="12" cy="12" r="10"/>
                  <circle cx="12" cy="12" r="6"/>
                  <circle cx="12" cy="12" r="2"/>
                </svg>
                <span className="mode-title">Practice</span>
              </div>
              <span className="mode-sub" id="practiceStats">0/{opening.lines.length} lines perfected</span>
            </button>

            <div className="mode-grid">
              <button className="mode-btn small locked" id="modeDrill" disabled type="button">
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
                    <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
                  </svg>
                  <span className="mode-title">Time Trials</span>
                </div>
                <span className="mode-sub">Race the clock</span>
              </button>

              <button className="mode-btn small locked" id="modePuzzles" disabled type="button">
                <div className="mode-btn-main">
                  <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-ink)", opacity: 0.5 }}>
                    <path d="M19.439 7.85c-.049.322.059.648.289.878l1.378 1.378a1 1 0 0 1 .289.878c0 .486-.166.893-.457 1.181l-1.99 1.99a1 1 0 0 1-.878.289 1 1 0 0 1-.878-.289l-1.378-1.378a1.05 1.05 0 0 0-.878-.289c-.322 0-.649.059-.878.289l-1.378 1.378a1 1 0 0 1-.878.289 1 1 0 0 1-.878-.289l-1.99-1.99a1 1 0 0 1-.289-.878c0-.486.166-.893.457-1.181l1.378-1.378a1.05 1.05 0 0 0 .289-.878c0-.322-.059-.649-.289-.878l-1.378-1.378a1 1 0 0 1-.289-.878c0-.486.166-.893.457-1.181l1.99-1.99a1 1 0 0 1 .878-.289c.322 0 .649.059.878.289l1.378 1.378a1.05 1.05 0 0 0 .878.289c.322 0 .649-.059.878-.289l1.378-1.378a1 1 0 0 1 .878-.289 1 1 0 0 1 .878.289l1.99 1.99a1 1 0 0 1 .289.878c0 .486-.166.893-.457 1.181l-1.378 1.378a1.05 1.05 0 0 0-.289.878z"/>
                    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
                  </svg>
                  <span className="mode-title">Puzzles</span>
                </div>
                <span className="mode-sub">Solve puzzles, win ELO</span>
              </button>
            </div>
          </div>
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
              <button className="settings-menu-item" type="button" onClick={() => window.open(`https://lichess.org/analysis/${encodeURIComponent(game.fen())}`, "_blank", "noopener,noreferrer")}>Open in Lichess</button>
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
            <button className="toolbar-btn" id="btnHint" type="button" onClick={() => setHint(nextExpected?.from ?? null)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>
                <path d="M9 18h6"/>
                <path d="M10 22h4"/>
              </svg>
              <span>Hint</span>
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
            <button className="toolbar-btn complete-next-line" type="button" id="btnCompleteNext" onClick={() => startLine((lineIndex + 1) % opening.lines.length)}>
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
    </div>
  );
}
