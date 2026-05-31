"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Chess, type Square } from "chess.js";
import { supabase } from "../../../lib/supabase";
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
    <main className="trainer-v2-page">
      <header className="trainer-v2-topbar"><Link href="/openings">← Aperturas</Link></header>
      <section className="trainer-v2-loading">{message}</section>
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
  
  // Estados y referencias para la barra de evaluación asíncrona Stockfish
  const [evalScore, setEvalScore] = useState<number>(0);
  const [evalMate, setEvalMate] = useState<number | null>(null);
  const [evalLoading, setEvalLoading] = useState<boolean>(false);
  const [evalFallback, setEvalFallback] = useState<boolean>(false);

  const evalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evalSeqRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const playOpponentMoves = useCallback((source: Chess, startIndex: number, initialDelay = 0) => {
    const chess = new Chess(source.fen());
    let index = startIndex;

    const playNext = () => {
      const next = moves[index];
      if (!next) {
        setCompleted(true);
        saveLearnedLine(slug, currentLine);
        setLearnedCount(getLearnedCount(slug));
        playSound("game-end", soundsEnabled);
        return;
      }
      if (next.color === opening.playerSide) {
        const nextChess = new Chess(chess.fen());
        setGame(nextChess);
        updateEvaluation(nextChess);
        setMoveIndex(index);
        updateInstruction(chess);
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

    timer.current = setTimeout(playNext, initialDelay);
  }, [currentLine, moves, opening.playerSide, slug, soundsEnabled, updateInstruction, updateEvaluation]);

  const startLine = useCallback((index: number) => {
    if (timer.current) clearTimeout(timer.current);
    setLineIndex(index);
    setGame(new Chess());
    setMoveIndex(0);
    setSelected(null);
    setLegalTargets([]);
    setFeedback(null);
    setLastMove(null);
    setHint(null);
    setCompleted(false);
    setRestartVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    const chess = new Chess();
    setGame(chess);
    updateEvaluation(chess);
    setMoveIndex(0);
    setCompleted(false);
    playSound("game-start", soundsEnabled);
    playOpponentMoves(chess, 0, 240);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (evalTimerRef.current) clearTimeout(evalTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, [lineIndex, playOpponentMoves, restartVersion, updateEvaluation]);

  function chooseSquare(square: Square) {
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
      if (completed) return false;
      const expected = moves[moveIndex];
      if (!expected || expected.color !== opening.playerSide) return false;

      const legal = game.moves({ square: from, verbose: true }).find((m) => m.to === to);
      if (!legal) return false;

      setSelected(null);
      setLegalTargets([]);
      setHint(null);
      if (expected.from !== from || expected.to !== to) {
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
        }, 500);

        return true; // Permite soltar la pieza en la casilla incorrecta para simular el feedback visual
      }

      // Movimiento correcto
      const chess = new Chess(game.fen());
      const move = chess.move({ from, to, promotion: "q" });
      if (!move) return false;

      const nextIndex = moveIndex + 1;
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
    [completed, moves, moveIndex, opening.playerSide, game, soundsEnabled, vibrate, playOpponentMoves, updateInstruction, updateEvaluation]
  );

  function attemptMove(from: Square, to: Square) {
    if (completed) return;
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

    if (expected.from !== from || expected.to !== to) {
      setFeedback({ square: to, type: "wrong" });
      vibrate([18, 20, 18]);
      playSound("illegal", soundsEnabled);
      timer.current = setTimeout(() => setFeedback(null), 520);
      return;
    }

    const chess = new Chess(game.fen());
    const move = chess.move({ from, to, promotion: "q" });
    if (!move) return;
    const nextIndex = moveIndex + 1;
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

  function resetProgress() {
    const progress = JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
    progress[slug] = {};
    localStorage.setItem("chessengineered_progress", JSON.stringify(progress));
    setLearnedCount(0);
    startLine(0);
    setSettingsOpen(false);
  }

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
    <main className={`trainer-v2-page theme-${boardTheme}`}>
      <div className="trainer-v2-glow glow-one" />
      <div className="trainer-v2-glow glow-two" />
      <div className="trainer-v2-layout">
        <section className="trainer-v2-board-area">
          <div className="trainer-v2-progress-row">
            <Link aria-label="Volver a aperturas" href="/openings">←</Link>
            <div className="trainer-v2-progress-track"><span style={{ width: `${progress}%` }} /></div>
          </div>
          <div className="trainer-v2-progress-copy">
            <span>Movimiento {moveIndex}/{moves.length}</span>
            <span>{opening.lineNames[currentLine] ?? `Línea ${lineIndex + 1}`}</span>
          </div>

          <div className="trainer-v2-board-row">
            {showEval && (
              <div className="trainer-v2-eval" aria-label={`Evaluación ${formatScoreText()}`}>
                <span className={`${evalLoading ? "is-loading" : ""} ${evalFallback ? "is-fallback" : ""}`}>
                  {formatScoreText()}
                </span>
                <i style={{ height: `${whitePercent}%` }} />
              </div>
            )}
            <div className="trainer-v2-board" style={{ display: "block" }}>
              <ChessboardReact
                position={game.fen()}
                orientation={opening.playerSide}
                pieceSet={pieceSet}
                boardTheme={boardTheme}
                inputEnabled={!completed}
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

          {completed && (
            <section className="trainer-v2-complete">
              <strong>Línea completada</strong>
              <span>Aprendiste una nueva variante.</span>
              <button onClick={() => startLine((lineIndex + 1) % opening.lines.length)} type="button">Siguiente línea</button>
            </section>
          )}
        </section>

        <aside className="trainer-v2-panel">
          <div className="trainer-v2-course-select">
            <button onClick={() => setLinePickerOpen((open) => !open)} type="button">
              <span><strong>Aprender</strong><small>{opening.displayName.replace(" Mastery", "")}</small></span>
              <b>#{lineIndex + 1} <i>{linePickerOpen ? "▲" : "▼"}</i></b>
            </button>
            {linePickerOpen && (
              <div className="trainer-v2-line-picker">
                {opening.lines.map((line, index) => (
                  <button
                    className={index === lineIndex ? "active" : ""}
                    key={line}
                    onClick={() => {
                      startLine(index);
                      setLinePickerOpen(false);
                    }}
                    type="button"
                  >
                    <span>#{index + 1}</span>
                    <strong>{opening.lineNames[line] ?? `Línea ${index + 1}`}</strong>
                    {index < learnedCount && <em>✓</em>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {showDialog && (
            <div className="trainer-v2-dialog">
              <span aria-hidden="true">♔</span>
              <p>{instruction || "Preparando la variante..."}</p>
            </div>
          )}

          <section className="trainer-v2-modes">
            <button className="active" type="button"><strong>Aprender</strong><span>{learnedCount} líneas descubiertas</span></button>
            <button type="button"><strong>Practicar</strong><span>Repasa las variantes aprendidas</span></button>
            <button disabled type="button"><strong>Puzzles</strong><span>Resuelve posiciones y gana ELO</span></button>
            <div>
              <button disabled type="button"><strong>Drill</strong><span>Maximiza tu racha</span></button>
              <button disabled type="button"><strong>Tiempo</strong><span>Corre contra el reloj</span></button>
            </div>
          </section>

          <footer className="trainer-v2-toolbar">
            <div className="trainer-v2-settings-wrap">
              <button aria-expanded={settingsOpen} aria-label="Ajustes" onClick={() => setSettingsOpen((open) => !open)} type="button">⚙</button>
              {settingsOpen && (
                <div className="trainer-v2-settings">
                  <strong>Ajustes</strong>
                  <label><input checked={showEval} onChange={(event) => persistBoolean("chessengineered_show_eval", event.target.checked, setShowEval)} type="checkbox" /> Barra de evaluación</label>
                  <label><input checked={soundsEnabled} onChange={(event) => persistBoolean("chessengineered_sound", event.target.checked, setSoundsEnabled)} type="checkbox" /> Sonidos</label>
                  <label><input checked={hapticsEnabled} onChange={(event) => persistBoolean("chessengineered_haptic", event.target.checked, setHapticsEnabled)} type="checkbox" /> Vibración</label>
                  <hr />
                  <strong>Estilo del tablero</strong>
                  <label>Piezas
                    <select onChange={(event) => {
                      const value = event.target.value as PieceSet;
                      localStorage.setItem("chessengineered_piece_set", value);
                      setPieceSet(value);
                    }} value={pieceSet}>
                      <option value="staunty">Staunty</option>
                      <option value="maestro">Maestro</option>
                      <option value="standard">Standard</option>
                    </select>
                  </label>
                  <label>Tema
                    <select onChange={(event) => {
                      const value = event.target.value as BoardTheme;
                      localStorage.setItem("chessengineered_board_theme", value);
                      setBoardTheme(value);
                    }} value={boardTheme}>
                      <option value="green">Verde</option>
                      <option value="white-violet">Blanco violeta</option>
                      <option value="white-blue">Blanco azul</option>
                      <option value="blue">Azul</option>
                      <option value="brown">Marrón</option>
                      <option value="classic">Clásico</option>
                      <option value="black-and-white">Blanco y negro</option>
                    </select>
                  </label>
                  <hr />
                  <strong>Aprendizaje</strong>
                  <label><input checked={trainingArrows} onChange={(event) => persistBoolean("chessengineered_training_arrows", event.target.checked, setTrainingArrows)} type="checkbox" /> Flechas de ayuda</label>
                  <label><input checked={showDialog} onChange={(event) => persistBoolean("chessengineered_show_dialog", event.target.checked, setShowDialog)} type="checkbox" /> Instrucciones</label>
                  <hr />
                  <strong>Exportar</strong>
                  <button onClick={() => window.open(`https://lichess.org/analysis/${encodeURIComponent(game.fen())}`, "_blank", "noopener,noreferrer")} type="button">Abrir en Lichess</button>
                  <button onClick={() => void copyText(currentLine)} type="button">Copiar PGN</button>
                  <button onClick={() => void copyText(game.fen())} type="button">Copiar FEN</button>
                  <button onClick={resetProgress} type="button">Reiniciar progreso</button>
                </div>
              )}
            </div>
            <span className="trainer-v2-version">v1.4.0</span>
            <button onClick={() => setHint(nextExpected?.from ?? null)} type="button">Pista</button>
            <button onClick={() => startLine(lineIndex)} type="button">Reiniciar</button>
          </footer>
        </aside>
      </div>
    </main>
  );
}
