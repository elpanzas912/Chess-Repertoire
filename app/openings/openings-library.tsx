"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { clearLocalUserData, prepareLocalProgressForUser } from "../../lib/local-progress";

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
  try {
    return JSON.parse(localStorage.getItem("chessengineered_progress") ?? "{}");
  } catch {
    return {};
  }
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

  useEffect(() => {
    setProgress(readProgress());
    setStreak(readStreak());
    setFreeOpening(localStorage.getItem("chessengineered_free_opening"));

    if (!supabase) return;
    const client = supabase;

    const loadAccount = async () => {
      const {
        data: { user },
      } = await client.auth.getUser();

      setSessionEmail(user?.email ?? null);
      if (!user) return;
      prepareLocalProgressForUser(user.id);

      const [{ data: subscription }, { data: profile }] = await Promise.all([
        client
          .from("subscriptions")
          .select("status, current_period_end")
          .eq("user_id", user.id)
          .maybeSingle(),
        client.from("profiles").select("free_opening_slug").eq("id", user.id).maybeSingle(),
      ]);

      const paid =
        !!subscription &&
        ["active", "trialing"].includes(subscription.status) &&
        subscription.current_period_end &&
        new Date(subscription.current_period_end).getTime() > Date.now();

      setHasSubscription(!!paid);
      setFreeOpening(profile?.free_opening_slug ?? null);
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

  const visibleOpenings = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return Object.entries(openings)
      .filter(([, opening]) => side === "all" || opening.playerSide === side)
      .filter(([, opening]) =>
        `${opening.displayName} ${opening.description}`.toLocaleLowerCase().includes(normalizedQuery),
      )
      .sort(([, a], [, b]) => a.displayName.localeCompare(b.displayName));
  }, [openings, query, side]);

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

  return (
    <div className="app-shell library-v2">
      <header className="site-header library-v2-nav">
        <Link className="brand" href="/openings">
          <BrandMark />
          <span>chessengineered</span>
        </Link>
        <nav className="header-actions" aria-label="Cuenta">
          <span className="streak" title="Racha diaria">
            <span aria-hidden="true">♨</span>
            {streak}
          </span>
          {sessionEmail ? (
            <>
              <span className="account-email">{sessionEmail}</span>
              <button className="header-logout" onClick={logout} type="button">Salir</button>
            </>
          ) : (
            <Link className="text-button" href="/login">
              Entrar
            </Link>
          )}
        </nav>
      </header>

      <section className="library-v2-hero">
        <div>
          <p className="page-context">Repertorio de aperturas</p>
          <h1>Domina tu <em>repertorio.</em></h1>
          <p className="page-description">
            Aprende cada variante movimiento por movimiento y construye una preparación que puedas recordar.
          </p>
        </div>
      </section>

      <main className="library-shell">
        <section className="library-header library-v2-summary">
          <div>
            <p className="library-v2-section-label">Biblioteca de aperturas</p>
          </div>
          <div className="library-stats" aria-label="Resumen de biblioteca">
            <div>
              <strong>{Object.keys(openings).length}</strong>
              <span>Aperturas</span>
            </div>
            <div>
              <strong>{Object.values(openings).reduce((sum, opening) => sum + opening.lineCount, 0)}</strong>
              <span>Líneas</span>
            </div>
          </div>
        </section>

        {!hasSubscription && (
          <section className="plan-note library-v2-plan">
            <div>
              <strong>{freeOpening ? "Tu apertura gratuita está activa" : "Elige una apertura gratuita"}</strong>
              <p>
                {freeOpening
                  ? "Puedes practicar ese curso sin límite. El resto se desbloquea con el pase completo."
                  : "Prueba un curso completo antes de desbloquear la biblioteca."}
              </p>
            </div>
            <Link href="/plans">Ver planes</Link>
          </section>
        )}

        <section className="library-toolbar library-v2-toolbar" aria-label="Filtros de aperturas">
          <div className="filter-group">
            {[
              ["all", "Todas"],
              ["w", "Blancas"],
              ["b", "Negras"],
            ].map(([value, label]) => (
              <button
                className={side === value ? "filter-button active" : "filter-button"}
                key={value}
                onClick={() => setSide(value as SideFilter)}
                type="button"
              >
                <span className="library-v2-filter-dot" />
                {label}
              </button>
            ))}
          </div>
          <label className="search-box library-v2-search">
            <span aria-hidden="true">⌕</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar apertura"
              type="search"
              value={query}
            />
          </label>
        </section>

        <div className="result-row library-v2-results">
          <strong>{visibleOpenings.length} aperturas</strong>
          <span>{totalLines} líneas disponibles</span>
        </div>

        <section className="opening-grid" aria-label="Cursos de aperturas">
          {visibleOpenings.map(([slug, opening]) => {
            const learned = new Set(progress[slug]?.learnedLines ?? []).size;
            const perfected = Object.values(progress[slug]?.lines ?? {}).filter(
              (line) => Number(line.practicePerfectAttempts) > 0,
            ).length;
            const learnedPercent = Math.min(100, Math.round((learned / opening.lineCount) * 100));
            const isUnlocked = hasSubscription || freeOpening === slug;
            const canPickFree = !hasSubscription && !freeOpening;

            return (
              <article className={`opening-card library-v2-card ${isUnlocked ? "is-unlocked" : "is-locked"}`} key={opening.id}>
                <BoardPreview side={opening.playerSide} slug={slug} />
                <div className="opening-card-content">
                  <div className="card-heading">
                    <h2>{opening.displayName.replace(" Mastery", "")}</h2>
                    <div className="library-v2-badges">
                      <span className={`side-label side-${opening.playerSide}`}>
                        {opening.playerSide === "w" ? "Blancas" : "Negras"}
                      </span>
                      {isUnlocked && <span className="library-v2-unlocked">Activa</span>}
                    </div>
                  </div>
                  <p>{compactDescription(opening.description)}</p>
                  <div className="progress-copy">
                    <span>
                      <strong>{learned}</strong> de {opening.lineCount} líneas
                    </span>
                    {perfected > 0 && <span>{perfected} perfeccionadas</span>}
                  </div>
                  <div className="progress-track" aria-label={`${learnedPercent}% completado`}>
                    <span style={{ width: `${learnedPercent}%` }} />
                  </div>
                  <div className="card-footer">
                    <Link
                      href={`/opening/${slug}`}
                      onClick={() => {
                        if (!canPickFree) return;
                        localStorage.setItem("chessengineered_free_opening", slug);
                        setFreeOpening(slug);
                      }}
                    >
                      {isUnlocked ? "Continuar curso" : canPickFree ? "Elegir gratis" : "Ver curso"} <span aria-hidden="true">→</span>
                    </Link>
                    {!isUnlocked && !canPickFree && <span className="locked">Bloqueada</span>}
                  </div>
                </div>
              </article>
            );
          })}
        </section>

        {visibleOpenings.length === 0 && (
          <p className="empty-state">No encontramos aperturas con esos filtros.</p>
        )}
      </main>
    </div>
  );
}
