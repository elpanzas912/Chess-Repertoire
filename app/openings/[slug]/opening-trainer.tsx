"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Chess, type Square } from "chess.js";
import { supabase } from "../../../lib/supabase";

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

  const updateInstruction = useCallback((chess: Chess) => {
    setInstruction(opening.descriptions[chess.fen()] ?? "Encuentra el mejor movimiento para continuar la variante.");
  }, [opening.descriptions]);

  const playOpponentMoves = useCallback((source: Chess, startIndex: number) => {
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
        setGame(new Chess(chess.fen()));
        setMoveIndex(index);
        updateInstruction(chess);
        return;
      }

      const move = chess.move(next.san);
      if (!move) return;
      index += 1;
      setLastMove({ from: move.from, to: move.to });
      setGame(new Chess(chess.fen()));
      setMoveIndex(index);
      playSound(pieceSound(move, false), soundsEnabled);
      updateInstruction(chess);
      timer.current = setTimeout(playNext, 340);
    };

    timer.current = setTimeout(playNext, 240);
  }, [currentLine, moves, opening.playerSide, slug, soundsEnabled, updateInstruction]);

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
    setMoveIndex(0);
    setCompleted(false);
    playSound("game-start", soundsEnabled);
    playOpponentMoves(chess, 0);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [lineIndex, playOpponentMoves, restartVersion]);

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
  const score = materialScore(game);
  const whitePercent = Math.max(5, Math.min(95, 50 + score * 4));
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
              <div className="trainer-v2-eval" aria-label={`Evaluación material ${score.toFixed(1)}`}>
                <span>{score > 0 ? "+" : ""}{score.toFixed(1)}</span>
                <i style={{ height: `${whitePercent}%` }} />
              </div>
            )}
            <div className="trainer-v2-board" role="grid" aria-label="Tablero de ajedrez">
              {orderedRanks.flatMap((rank, rankIndex) =>
                orderedFiles.map((file, fileIndex) => {
                  const square = `${file}${rank}` as Square;
                  const piece = game.get(square);
                  const id = piece ? `${piece.color}${piece.type}` : "";
                  const className = [
                    "trainer-v2-square",
                    (files.indexOf(file) + Number(rank)) % 2 === 0 ? "dark" : "light",
                    selected === square ? "selected" : "",
                    legalTargets.includes(square) ? "legal" : "",
                    lastMove?.from === square || lastMove?.to === square ? "last" : "",
                    hint === square ? "hint" : "",
                  ].join(" ");
                  return (
                    <button
                      className={className}
                      key={square}
                      onClick={() => chooseSquare(square)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => drop(event, square)}
                      role="gridcell"
                      type="button"
                    >
                      {piece && (
                        <span className="trainer-v2-piece" draggable onDragStart={(event) => startDrag(event, square)}>
                          <svg viewBox="0 0 40 40">
                            <use href={`/pieces/${pieceSet}.svg#${id}`} />
                          </svg>
                        </span>
                      )}
                      {fileIndex === 0 && <em className="rank-label">{rank}</em>}
                      {rankIndex === 7 && <em className="file-label">{file}</em>}
                      {trainingArrows && hint === square && nextExpected && <span className="trainer-v2-arrow">→</span>}
                      {feedback?.square === square && <b className={`trainer-v2-feedback ${feedback.type}`}>{feedback.type === "correct" ? "✓" : "×"}</b>}
                    </button>
                  );
                }),
              )}
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
