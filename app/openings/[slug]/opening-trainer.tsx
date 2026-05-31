"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Move, type Square } from "chess.js";
import { supabase } from "../../../lib/supabase";

type Opening = {
  id: string;
  displayName: string;
  playerSide: string;
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

const pieces: Record<string, string> = {
  b: "♝",
  k: "♚",
  n: "♞",
  p: "♟",
  q: "♛",
  r: "♜",
  B: "♗",
  K: "♔",
  N: "♘",
  P: "♙",
  Q: "♕",
  R: "♖",
};

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
  return chess
    .board()
    .flat()
    .reduce((score, piece) => score + (piece ? values[piece.type] * (piece.color === "w" ? 1 : -1) : 0), 0);
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

function playSound(name: string) {
  const audio = new Audio(`/sounds/${name}.mp3`);
  audio.volume = 0.45;
  void audio.play().catch(() => undefined);
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
        router.replace(`/login?next=/openings/${slug}`);
        return;
      }

      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      const response = await fetch(`${url}/functions/v1/get-opening?slug=${encodeURIComponent(slug)}`, {
        headers: {
          apikey: key ?? "",
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.status === 401) {
        router.replace(`/login?next=/openings/${slug}`);
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

  if (error) {
    return (
      <main className="trainer-page">
        <header className="trainer-topbar"><Link href="/openings">← Aperturas</Link></header>
        <section className="trainer-loading">{error}</section>
      </main>
    );
  }

  if (!opening) {
    return (
      <main className="trainer-page">
        <header className="trainer-topbar"><Link href="/openings">← Aperturas</Link></header>
        <section className="trainer-loading">Cargando apertura...</section>
      </main>
    );
  }

  return <TrainingBoard opening={opening} slug={slug} />;
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentLine = opening.lines[lineIndex];
  const moves = useMemo(() => parseLine(currentLine), [currentLine]);

  const updateInstruction = useCallback((chess: Chess) => {
    setInstruction(
      opening.descriptions[chess.fen()] ??
        "Encuentra el mejor movimiento para continuar la variante.",
    );
  }, [opening.descriptions]);

  const playOpponentMoves = useCallback((source: Chess, startIndex: number) => {
    const chess = new Chess(source.fen());
    let index = startIndex;

    const playNext = () => {
      const next = moves[index];
      if (!next) {
        setCompleted(true);
        saveLearnedLine(slug, currentLine);
        playSound("game-end");
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
      playSound(move.captured ? "capture" : "move-opponent");
      updateInstruction(chess);
      timer.current = setTimeout(playNext, 340);
    };

    timer.current = setTimeout(playNext, 240);
  }, [currentLine, moves, opening.playerSide, slug, updateInstruction]);

  const startLine = useCallback((index: number) => {
    if (timer.current) clearTimeout(timer.current);
    const chess = new Chess();
    setLineIndex(index);
    setGame(chess);
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
    playSound("game-start");
    playOpponentMoves(chess, 0);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [lineIndex, playOpponentMoves, restartVersion]);

  function selectSquare(square: Square) {
    if (completed) return;
    const expected = moves[moveIndex];
    if (!expected || expected.color !== opening.playerSide) return;

    if (!selected) {
      const piece = game.get(square);
      if (!piece || piece.color !== opening.playerSide) return;
      const targets = game.moves({ square, verbose: true }).map((move) => move.to);
      if (targets.length === 0) return;
      setSelected(square);
      setLegalTargets(targets);
      return;
    }

    if (selected === square) {
      setSelected(null);
      setLegalTargets([]);
      return;
    }

    const legal = game.moves({ square: selected, verbose: true }).find((move) => move.to === square);
    if (!legal) {
      const piece = game.get(square);
      if (piece?.color === opening.playerSide) {
        const targets = game.moves({ square, verbose: true }).map((move) => move.to);
        setSelected(square);
        setLegalTargets(targets);
      }
      return;
    }

    setSelected(null);
    setLegalTargets([]);
    setHint(null);

    if (expected.from !== selected || expected.to !== square) {
      setFeedback({ square, type: "wrong" });
      playSound("illegal");
      timer.current = setTimeout(() => setFeedback(null), 520);
      return;
    }

    const chess = new Chess(game.fen());
    const applied = chess.move({ from: selected, to: square, promotion: "q" });
    if (!applied) return;
    const nextIndex = moveIndex + 1;
    setGame(chess);
    setMoveIndex(nextIndex);
    setLastMove({ from: selected, to: square });
    setFeedback({ square, type: "correct" });
    playSound(applied.captured ? "capture" : "move-self");
    updateInstruction(chess);
    timer.current = setTimeout(() => {
      setFeedback(null);
      playOpponentMoves(chess, nextIndex);
    }, 360);
  }

  const orderedRanks = opening.playerSide === "b" ? [...ranks].reverse() : ranks;
  const orderedFiles = opening.playerSide === "b" ? [...files].reverse() : files;
  const score = materialScore(game);
  const whitePercent = Math.max(5, Math.min(95, 50 + score * 4));
  const progress = moves.length ? Math.round((moveIndex / moves.length) * 100) : 0;
  const nextExpected = moves[moveIndex];

  return (
    <main className="trainer-page">
      <header className="trainer-topbar">
        <Link href="/openings">← Aperturas</Link>
        <strong>{opening.displayName.replace(" Mastery", "")}</strong>
        <span>{opening.playerSide === "w" ? "Juegas con blancas" : "Juegas con negras"}</span>
      </header>

      <div className="trainer-workbench">
        <section className="trainer-board-area">
          <div className="line-progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="move-progress">
            <span>Movimiento {moveIndex}/{moves.length}</span>
            <span>{opening.lineNames[currentLine] ?? `Línea ${lineIndex + 1}`}</span>
          </div>

          <div className="board-row">
            <div className="eval-meter" aria-label={`Evaluación material ${score.toFixed(1)}`}>
              <span className="eval-score">{score > 0 ? "+" : ""}{score.toFixed(1)}</span>
              <span className="eval-white" style={{ height: `${whitePercent}%` }} />
            </div>
            <div className="training-board" role="grid" aria-label="Tablero de ajedrez">
              {orderedRanks.flatMap((rank) =>
                orderedFiles.map((file) => {
                  const square = `${file}${rank}` as Square;
                  const piece = game.get(square);
                  const symbol = piece ? pieces[piece.color === "w" ? piece.type.toUpperCase() : piece.type] : "";
                  const isDark = (files.indexOf(file) + Number(rank)) % 2 === 0;
                  const className = [
                    "board-square",
                    isDark ? "dark" : "light",
                    selected === square ? "selected" : "",
                    legalTargets.includes(square) ? "legal" : "",
                    lastMove?.from === square || lastMove?.to === square ? "last" : "",
                    hint === square ? "hint" : "",
                  ].join(" ");
                  return (
                    <button className={className} key={square} onClick={() => selectSquare(square)} role="gridcell" type="button">
                      <span>{symbol}</span>
                      {feedback?.square === square && <b className={`move-feedback ${feedback.type}`}>{feedback.type === "correct" ? "✓" : "×"}</b>}
                    </button>
                  );
                }),
              )}
            </div>
          </div>
        </section>

        <aside className="trainer-sidebar">
          <label className="line-select">
            Variante
            <select onChange={(event) => startLine(Number(event.target.value))} value={lineIndex}>
              {opening.lines.map((line, index) => <option key={line} value={index}>{index + 1}. {opening.lineNames[line] ?? `Línea ${index + 1}`}</option>)}
            </select>
          </label>

          <div className="coach-dialog">
            <span aria-hidden="true">♔</span>
            <p>{instruction || "Preparando la variante..."}</p>
          </div>

          <section className="mode-list">
            <button className="mode-option active" type="button"><strong>Aprender</strong><span>Descubre nuevas líneas</span></button>
            <button className="mode-option" type="button"><strong>Practicar</strong><span>Próxima etapa</span></button>
            <button className="mode-option locked" type="button"><strong>Drill y tiempo</strong><span>Se desbloquea después</span></button>
          </section>

          <div className="trainer-actions">
            <button onClick={() => setHint(nextExpected?.from ?? null)} type="button">Pista</button>
            <button onClick={() => startLine(lineIndex)} type="button">Reiniciar</button>
          </div>

          {completed && (
            <section className="line-complete">
              <strong>Línea completada</strong>
              <p>La variante quedó guardada en tu progreso local.</p>
              <button onClick={() => startLine((lineIndex + 1) % opening.lines.length)} type="button">Siguiente línea</button>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
