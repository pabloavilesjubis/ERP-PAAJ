import { useState, type FormEvent } from 'react';
import { env } from '@/config/env';
import { login, signup } from './useAuth';

/**
 * Página de login/signup para PIPELINE ERP — auth local (sin Supabase).
 * Sin magic links ni 2FA por ahora — solo email + password.
 */

type Mode = 'signin' | 'signup';

export function SignInPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      if (mode === 'signin') {
        await login({ email, password });
      } else {
        await signup({ email, password, full_name: fullName || undefined });
      }
      // useAuth state se actualiza vía evento — AuthGate re-renderiza.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)', padding: 24,
    }}>
      <div style={{
        background: 'white', borderRadius: 12, padding: 40, width: '100%', maxWidth: 420,
        boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
      }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: -0.5, color: '#065f46' }}>
          {env.productName}
        </h1>
        <p style={{ marginTop: 4, marginBottom: 28, color: '#6b7280', fontSize: 14 }}>
          ERP fiscal multi-empresa — facturación electrónica MH.
        </p>

        <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#f3f4f6', borderRadius: 8, padding: 4 }}>
          {([['signin', 'Ingresar'], ['signup', 'Crear cuenta']] as Array<[Mode, string]>).map(([m, label]) => (
            <button key={m}
              type="button"
              onClick={() => { setMode(m); setError(null); }}
              style={{
                flex: 1, padding: '8px 12px', border: 'none', borderRadius: 6, cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
                background: mode === m ? 'white' : 'transparent',
                color: mode === m ? '#065f46' : '#6b7280',
                boxShadow: mode === m ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}>
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {mode === 'signup' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>Tu nombre</span>
              <input
                value={fullName} onChange={e => setFullName(e.target.value)}
                style={inputStyle}
                placeholder="Pablo Aviles"
              />
            </label>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>Email</span>
            <input
              type="email" required autoComplete="email"
              value={email} onChange={e => setEmail(e.target.value)}
              style={inputStyle}
              placeholder="vos@empresa.com"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>Contraseña</span>
            <input
              type="password" required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password} onChange={e => setPassword(e.target.value)}
              style={inputStyle}
              placeholder={mode === 'signup' ? 'Mínimo 8 caracteres' : '••••••••'}
              minLength={mode === 'signup' ? 8 : undefined}
            />
          </label>

          {error && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, fontSize: 13 }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={primaryButtonStyle}>
            {loading ? 'Procesando…' : (mode === 'signin' ? 'Ingresar' : 'Crear cuenta')}
          </button>
        </form>

        <p style={{ marginTop: 24, fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
          {mode === 'signin'
            ? '¿No tenés cuenta? Cambiá a "Crear cuenta" arriba.'
            : 'Tu password se guarda hasheada (bcrypt) en nuestro Postgres self-hosted.'}
        </p>
        {/* Debug discreto — confirma qué build y qué backend está usando.
            Útil para troubleshooting de deploy. */}
        <p style={{
          marginTop: 8, fontSize: 10, color: '#d1d5db', textAlign: 'center',
          fontFamily: 'ui-monospace, monospace',
        }}>
          build: PIPELINE-ERP-v2 · api: {(import.meta.env.VITE_DTE_SERVICE_URL ?? '(default)').replace(/^https?:\/\//, '')}
        </p>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 14, outline: 'none',
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '12px', background: '#10b981', color: 'white', border: 'none',
  borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  marginTop: 8,
};
