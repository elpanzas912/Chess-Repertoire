import Link from "next/link";

export default function PlansPage() {
  return (
    <main className="placeholder-shell">
      <Link className="back-link" href="/openings">
        ← Volver a aperturas
      </Link>
      <section className="placeholder-card">
        <span className="side-label">Pase completo</span>
        <h1>Planes</h1>
        <p>
          La pantalla de planes se conectará con Stripe en la siguiente etapa.
          El flujo existente de Checkout ya quedó preservado en las Edge
          Functions.
        </p>
      </section>
    </main>
  );
}
