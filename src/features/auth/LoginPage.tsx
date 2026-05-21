import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { useAuthStore } from '@/stores/auth.store';

export function LoginPage() {
  const { signIn, signUp } = useAuthStore();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    const action = mode === 'signin' ? signIn : signUp;
    const { error } = await action(email, password);
    setBusy(false);
    if (error) setError(error);
    else if (mode === 'signup') setInfo('Cuenta creada. Revisa tu correo si requiere verificación.');
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-logo"><img src="/assets/logo.svg" alt="ABX Pyme" /></div>
        <div className="auth-title">{mode === 'signin' ? 'Iniciar sesión' : 'Crear cuenta'}</div>
        <div className="auth-subtitle">ERP fiscal — control de ingresos y egresos</div>

        <form className="auth-form" onSubmit={submit}>
          <Field label="Correo">
            <Input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="tu@empresa.com" />
          </Field>
          <Field label="Contraseña">
            <Input type="password" required minLength={6} value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
          </Field>
          {error && <div className="banner banner-danger">{error}</div>}
          {info && <div className="banner banner-success">{info}</div>}
          <Button type="submit" block disabled={busy}>
            {busy ? 'Procesando…' : mode === 'signin' ? 'Entrar' : 'Crear cuenta'}
          </Button>
        </form>

        <div className="auth-footer">
          {mode === 'signin' ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?'}{' '}
          <a onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? 'Crear una' : 'Iniciar sesión'}
          </a>
        </div>
      </div>
    </div>
  );
}
