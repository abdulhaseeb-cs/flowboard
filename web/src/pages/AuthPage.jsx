import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession, useToast } from '../lib/session.jsx';

export default function AuthPage({ mode }) {
  const isLogin = mode === 'login';
  const { startSession } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = isLogin ? { email: form.email, password: form.password } : form;
      const { token, user } = await api.post(isLogin ? '/auth/login' : '/auth/register', body);
      await startSession(token, user);
      toast(isLogin ? `Welcome back, ${user.name.split(' ')[0]}` : 'Account created — welcome to FlowBoard!');
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const fieldErr = (k) => error?.details?.[k];

  return (
    <div className="auth">
      <section className="auth-hero" aria-hidden="true">
        <div className="logo logo-light"><span className="logo-mark"><i /><i /><i /></span><span>FlowBoard</span></div>
        <div>
          <h1>Plan, track and ship<br /><em>together, in real time.</em></h1>
          <p>Kanban boards that update live for your whole team — with WIP limits, checklists, @mentions and burndown analytics.</p>
        </div>
        <div className="hero-board">
          {[['To Do', 3], ['In Progress', 2], ['Done', 4]].map(([name, n]) => (
            <div key={name} className="hero-col">
              <span>{name}</span>
              {Array.from({ length: n }).map((_, i) => <i key={i} style={{ width: `${60 + ((i * 17) % 35)}%` }} />)}
            </div>
          ))}
        </div>
      </section>

      <section className="auth-panel">
        <form className="auth-form" onSubmit={submit} noValidate>
          <h2 id="page-title">{isLogin ? 'Welcome back' : 'Create your account'}</h2>
          <p className="muted">{isLogin ? 'Log in to your workspaces.' : 'Free for your whole team. No credit card.'}</p>

          {error && <div className="alert alert-error" data-testid="form-error">{error.message}</div>}

          {!isLogin && (
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input id="name" className={`input${fieldErr('name') ? ' invalid' : ''}`} value={form.name} onChange={set('name')} autoComplete="name" autoFocus />
              {fieldErr('name') && <span className="field-error">{fieldErr('name')}</span>}
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Work email</label>
            <input id="email" type="email" className={`input${fieldErr('email') ? ' invalid' : ''}`} value={form.email} onChange={set('email')} autoComplete="email" autoFocus={isLogin} />
            {fieldErr('email') && <span className="field-error">{fieldErr('email')}</span>}
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" className={`input${fieldErr('password') ? ' invalid' : ''}`} value={form.password} onChange={set('password')} autoComplete={isLogin ? 'current-password' : 'new-password'} />
            {fieldErr('password') && <span className="field-error">{fieldErr('password')}</span>}
          </div>

          <button className="btn btn-primary btn-block" type="submit" disabled={busy} id={isLogin ? 'login-btn' : 'register-btn'}>
            {busy ? 'Please wait…' : isLogin ? 'Log in' : 'Create account'}
          </button>

          <p className="auth-switch">
            {isLogin ? <>New to FlowBoard? <Link to="/register" state={location.state} id="go-register">Create an account</Link></>
              : <>Already have an account? <Link to="/login" state={location.state} id="go-login">Log in</Link></>}
          </p>
        </form>
      </section>
    </div>
  );
}
