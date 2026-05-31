# Chess Repertoire

Web app para aprender y practicar repertorios de aperturas de ajedrez.

## Stack

- Next.js
- React
- TypeScript
- Supabase Auth, Storage y Edge Functions
- Stripe Checkout

## Desarrollo local

```bash
npm install
cp .env.example .env.local
npm run dev
```

Variables requeridas:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```

## Contenido privado

Los PGN fuente y el archivo generado `openings.json` no forman parte del
repositorio público. El entrenador solicita cada apertura autorizada mediante
la Edge Function `get-opening`, que lee el contenido desde el bucket privado
`private-opening-data`.

Los scripts de `scripts/` permiten compilar y validar el contenido desde la
carpeta local ignorada `mastery_courses/`.

## Verificación

```bash
npm run typecheck
npm run build
npm run validate:openings
```
