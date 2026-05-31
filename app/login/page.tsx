"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function nextPath() {
    const next = new URLSearchParams(window.location.search).get("next");
    return next?.startsWith("/") ? next : "/openings";
  }

  async function handleGoogleLogin() {
    setError(null);

    if (!supabase) {
      setError("Supabase no está configurado.");
      return;
    }

    setPending(true);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}${nextPath()}` },
    });

    if (oauthError) {
      setPending(false);
      setError("No pudimos iniciar sesión con Google.");
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!supabase) {
      setError("Supabase no está configurado.");
      return;
    }

    setPending(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setPending(false);

    if (signInError) {
      setError("No pudimos iniciar sesión. Revisa tus datos.");
      return;
    }

    router.push(nextPath());
  }

  return (
    <main className="login-shell">
      <Link className="back-link" href="/openings">
        ← Volver a aperturas
      </Link>
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Iniciar sesión</h1>
        <p>Accede a tu progreso y a tus cursos desbloqueados.</p>
        <button className="google-login" disabled={pending} onClick={handleGoogleLogin} type="button">
          Continuar con Google
        </button>
        <div className="login-separator">
          <span>o usa tu email</span>
        </div>
        <label>
          Email
          <input
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label>
          Contraseña
          <input
            autoComplete="current-password"
            minLength={6}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button disabled={pending} type="submit">
          {pending ? "Ingresando..." : "Ingresar"}
        </button>
      </form>
    </main>
  );
}
