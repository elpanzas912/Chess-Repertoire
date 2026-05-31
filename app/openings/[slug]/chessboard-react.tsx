"use client";

import { useEffect, useRef, useState } from "react";
import type { Square } from "chess.js";

type PieceSet = "staunty" | "maestro" | "standard";
type BoardTheme = "green" | "white-violet" | "white-blue" | "blue" | "brown" | "classic" | "black-and-white";

interface ChessboardReactProps {
  position: string;
  orientation: "w" | "b";
  pieceSet: PieceSet;
  boardTheme: BoardTheme;
  inputEnabled: boolean;
  inputColor: "w" | "b";
  onMoveAttempt?: (from: Square, to: Square) => boolean | Promise<boolean>;
  onMoveFinished?: (from: Square, to: Square, legal: boolean) => void;
  lastMove?: { from: Square; to: Square } | null;
  hintSquare?: Square | null;
  feedback?: { square: Square; type: "correct" | "wrong" } | null;
  showLegalMarkers?: boolean;
  gameInstance: any; // Instancia de chess.js para calcular movimientos legales
}

export function ChessboardReact({
  position,
  orientation,
  pieceSet,
  boardTheme,
  inputEnabled,
  inputColor,
  onMoveAttempt,
  onMoveFinished,
  lastMove,
  hintSquare,
  feedback,
  showLegalMarkers = true,
  gameInstance,
}: ChessboardReactProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const boardInstanceRef = useRef<any>(null);
  const [boardLoaded, setBoardLoaded] = useState(false);
  const propsRef = useRef({
    position,
    orientation,
    pieceSet,
    boardTheme,
    inputEnabled,
    inputColor,
    onMoveAttempt,
    onMoveFinished,
    gameInstance,
    showLegalMarkers,
  });

  // Mantener los props actualizados en un ref para que la máquina de estados de cm-chessboard tenga acceso a los handlers frescos
  useEffect(() => {
    propsRef.current = {
      position,
      orientation,
      pieceSet,
      boardTheme,
      inputEnabled,
      inputColor,
      onMoveAttempt,
      onMoveFinished,
      gameInstance,
      showLegalMarkers,
    };
  }, [
    position,
    orientation,
    pieceSet,
    boardTheme,
    inputEnabled,
    inputColor,
    onMoveAttempt,
    onMoveFinished,
    gameInstance,
    showLegalMarkers,
  ]);

  // Inicialización de cm-chessboard (solo cliente)
  useEffect(() => {
    let board: any = null;
    let active = true;

    async function init() {
      if (!containerRef.current) return;

      // Importación dinámica para evitar errores de SSR
      const { Chessboard, COLOR, BORDER_TYPE } = await import(
        "../../../lib/cm-chessboard-src/Chessboard.js"
      );
      const { Markers } = await import(
        "../../../lib/cm-chessboard-src/extensions/markers/Markers.js"
      );
      const { RightClickAnnotator } = await import(
        "../../../lib/cm-chessboard-src/extensions/right-click-annotator/RightClickAnnotator.js"
      );

      if (!active || !containerRef.current) return;

      const storedTheme = propsRef.current.boardTheme === "brown" ? "chessboard-js" : propsRef.current.boardTheme;
      const cssClass = storedTheme === "classic" ? "default" : storedTheme;

      board = new Chessboard(containerRef.current, {
        assetsUrl: "/cm-chessboard-assets/",
        assetsCache: false,
        position: propsRef.current.position,
        style: {
          pieces: { file: `pieces/${propsRef.current.pieceSet}.svg`, tileSize: 40 },
          cssClass: cssClass,
          borderType: BORDER_TYPE.none,
          animationDuration: 250,
        },
        orientation: propsRef.current.orientation === "w" ? COLOR.white : COLOR.black,
        extensions: [{ class: Markers }, { class: RightClickAnnotator }],
      });

      boardInstanceRef.current = board;
      setBoardLoaded(true);
    }

    void init();

    return () => {
      active = false;
      if (board) {
        try {
          board.destroy();
        } catch (e) {
          // Evitar errores silenciosos al desmontar
        }
      }
    };
  }, []);

  // Sincronizar FEN
  useEffect(() => {
    if (!boardLoaded || !boardInstanceRef.current) return;
    const board = boardInstanceRef.current;
    if (board.state.position.getFen() !== position) {
      void board.setPosition(position, true);
    }
  }, [position, boardLoaded]);

  // Sincronizar Orientación
  useEffect(() => {
    if (!boardLoaded || !boardInstanceRef.current) return;
    const board = boardInstanceRef.current;
    const currentOrientation = board.state.orientation;
    const targetOrientation = orientation === "w" ? "w" : "b";
    if (currentOrientation !== targetOrientation) {
      void board.setOrientation(targetOrientation, true);
    }
  }, [orientation, boardLoaded]);

  // Sincronizar Apariencia (Tema y Piezas)
  useEffect(() => {
    if (!boardLoaded || !boardInstanceRef.current) return;
    const board = boardInstanceRef.current;

    const storedTheme = boardTheme === "brown" ? "chessboard-js" : boardTheme;
    const cssClass = storedTheme === "classic" ? "default" : storedTheme;

    board.props.style.cssClass = cssClass;
    board.props.style.pieces = {
      ...board.props.style.pieces,
      file: `pieces/${pieceSet}.svg`,
    };

    const borderType = board.props.style.borderType || "none";
    board.view.svg?.setAttribute("class", `cm-chessboard border-type-${borderType} ${cssClass}`);
    board.view.redrawPieces();
  }, [boardTheme, pieceSet, boardLoaded]);

  // Sincronizar Estado de Entrada (Move Input)
  useEffect(() => {
    if (!boardLoaded || !boardInstanceRef.current) return;
    const board = boardInstanceRef.current;

    if (!inputEnabled) {
      board.disableMoveInput();
      return;
    }

    const { COLOR, INPUT_EVENT_TYPE } = require("../../../lib/cm-chessboard-src/Chessboard.js");

    const moveInputHandler = async (event: any) => {
      const { onMoveAttempt, gameInstance, showLegalMarkers } = propsRef.current;

      if (event.type === INPUT_EVENT_TYPE.moveInputStarted) {
        const piece = gameInstance.get(event.squareFrom);
        if (!piece || piece.color !== propsRef.current.inputColor) {
          return false;
        }
        
        // Mostrar marcadores de movimientos legales
        if (showLegalMarkers) {
          const moves = gameInstance.moves({ square: event.squareFrom, verbose: true });
          if (moves.length > 0) {
            event.chessboard.addLegalMovesMarkers(moves);
          }
        }
        return true;
      }

      if (event.type === INPUT_EVENT_TYPE.validateMoveInput) {
        event.chessboard.removeLegalMovesMarkers();
        
        // Verificar validez del movimiento
        const from = event.squareFrom as Square;
        const to = event.squareTo as Square;
        
        if (onMoveAttempt) {
          const isValid = await onMoveAttempt(from, to);
          return isValid; // true permite soltar la pieza, false la hace rebotar
        }
        return true;
      }

      if (event.type === INPUT_EVENT_TYPE.moveInputCanceled) {
        event.chessboard.removeLegalMovesMarkers();
      }
    };

    const targetColor = inputColor === "w" ? COLOR.white : COLOR.black;
    board.enableMoveInput(moveInputHandler, targetColor);

    return () => {
      board.disableMoveInput();
    };
  }, [inputEnabled, inputColor, boardLoaded]);

  // Sincronizar Marcador de Último Movimiento
  useEffect(() => {
    if (!boardLoaded || !boardInstanceRef.current) return;
    const board = boardInstanceRef.current;
    const svg = board.view.svg;
    if (!svg) return;

    // Limpiar marcadores viejos
    svg.querySelectorAll(".square.last-move-from, .square.last-move-to").forEach((el: SVGElement) => {
      el.classList.remove("last-move-from", "last-move-to");
    });

    if (lastMove) {
      const fromEl = svg.querySelector(`.square[data-square="${lastMove.from}"]`);
      const toEl = svg.querySelector(`.square[data-square="${lastMove.to}"]`);
      if (fromEl) fromEl.classList.add("last-move-from");
      if (toEl) toEl.classList.add("last-move-to");
    }
  }, [lastMove, boardLoaded]);

  // Sincronizar Marcador de Pistas (Hint Square)
  useEffect(() => {
    if (!boardLoaded || !boardInstanceRef.current) return;
    const board = boardInstanceRef.current;
    const svg = board.view.svg;
    if (!svg) return;

    svg.querySelectorAll(".square.hint-square").forEach((el: SVGElement) => {
      el.classList.remove("hint-square");
    });

    if (hintSquare) {
      const squareEl = svg.querySelector(`.square[data-square="${hintSquare}"]`);
      if (squareEl) squareEl.classList.add("hint-square");
    }
  }, [hintSquare, boardLoaded]);

  // Sincronizar Marcadores de Acierto / Error SVG
  useEffect(() => {
    if (!boardLoaded || !boardInstanceRef.current) return;
    const board = boardInstanceRef.current;
    const svg = board.view.svg;
    if (!svg) return;

    // Limpiar feedbacks anteriores
    svg.querySelectorAll(".correct-checkmark, .incorrect-cross").forEach((el: SVGElement) => el.remove());

    if (feedback) {
      const point = board.view.squareToPoint(feedback.square);
      const size = board.view.squareWidth * 0.38;
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("transform", `translate(${point.x}, ${point.y})`);

      if (feedback.type === "correct") {
        g.setAttribute("class", "correct-checkmark");

        const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        bg.setAttribute("cx", String(size / 2));
        bg.setAttribute("cy", String(size / 2));
        bg.setAttribute("r", String(size / 2));
        bg.setAttribute("fill", "#22c55e");
        g.appendChild(bg);

        const check = document.createElementNS("http://www.w3.org/2000/svg", "path");
        check.setAttribute("d", `M ${size * 0.22},${size * 0.52} L ${size * 0.42},${size * 0.72} L ${size * 0.78},${size * 0.30}`);
        check.setAttribute("stroke", "#fff");
        check.setAttribute("stroke-width", String(size * 0.13));
        check.setAttribute("fill", "none");
        check.setAttribute("stroke-linecap", "round");
        check.setAttribute("stroke-linejoin", "round");
        g.appendChild(check);
      } else {
        g.setAttribute("class", "incorrect-cross");

        const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        bg.setAttribute("cx", String(size / 2));
        bg.setAttribute("cy", String(size / 2));
        bg.setAttribute("r", String(size / 2));
        bg.setAttribute("fill", "#ca3331");
        g.appendChild(bg);

        const xPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        xPath.setAttribute("d", `M ${size * 0.28},${size * 0.28} L ${size * 0.72},${size * 0.72} M ${size * 0.72},${size * 0.28} L ${size * 0.28},${size * 0.72}`);
        xPath.setAttribute("stroke", "#fff");
        xPath.setAttribute("stroke-width", String(size * 0.14));
        xPath.setAttribute("fill", "none");
        xPath.setAttribute("stroke-linecap", "round");
        g.appendChild(xPath);
      }

      svg.appendChild(g);
    }
  }, [feedback, boardLoaded]);

  return (
    <div className="w-full h-full relative aspect-square">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{
          minWidth: "100%",
          minHeight: "100%",
        }}
      />
    </div>
  );
}
