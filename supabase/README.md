# Supabase — pasos rápidos

1. **Crea un proyecto** en https://supabase.com.
2. En el panel del proyecto, abre **SQL Editor** y pega `migrations/0001_initial.sql`. Click **Run**.
3. Copia las credenciales de **Project Settings → API**:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public` key → `VITE_SUPABASE_ANON_KEY`
4. En la raíz del proyecto crea `.env.local`:
   ```
   VITE_SUPABASE_URL=https://xxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGc...
   VITE_DATA_ADAPTER=supabase
   ```
5. Reinicia `npm run dev`. Verás el login en pantalla.
6. Crea tu cuenta. La primera empresa se crea automáticamente al guardar el primer registro.

## Cómo funciona el aislamiento

Cada usuario ve **solo** los registros de sus empresas. RLS verifica `companies.owner_id = auth.uid()` antes de cada select/insert/update/delete. Si un atacante intenta consultar registros de otra empresa, la policy los filtra.

## Backup / migraciones futuras

Versiona cualquier nueva migración como `0002_*.sql`, `0003_*.sql`, etc. Si instalas la CLI de Supabase puedes correr `supabase db push` para aplicarlas.
