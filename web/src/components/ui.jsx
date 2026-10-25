import { useEffect, useRef } from 'react';
import { initials } from '../lib/util.js';

export function Avatar({ user, size = 28, ring = false, title }) {
  if (!user) return <span className="avatar avatar-empty" style={{ width: size, height: size }} title="Unassigned" />;
  return (
    <span
      className={`avatar${ring ? ' avatar-ring' : ''}`}
      style={{ width: size, height: size, background: user.color, fontSize: Math.max(10, size * 0.4) }}
      title={title || user.name}
      aria-label={user.name}
    >
      {initials(user.name)}
    </span>
  );
}

export function Modal({ title, onClose, children, wide = false, testId }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // always call the latest handler without re-running the effect

  // Runs once on open: Escape-to-close + move focus into the dialog (unless a child
  // already took it with autoFocus). Re-running on every render would steal focus.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} data-testid={testId}>
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close" type="button">✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Field({ label, error, children, htmlFor }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export const PriorityIcon = ({ priority }) => {
  const bars = { low: 1, medium: 2, high: 3, urgent: 4 }[priority] || 2;
  return (
    <span className={`prio prio-${priority}`} title={`${priority} priority`} aria-label={`${priority} priority`}>
      <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={i * 3.6} y={9 - i * 3} width="2.6" height={3 + i * 3} rx="1" opacity={i < bars ? 1 : 0.22} />
        ))}
      </svg>
    </span>
  );
};

export function Spinner() {
  return <div className="spinner" role="progressbar" aria-label="Loading" />;
}

export function ErrorState({ error, children }) {
  return (
    <div className="empty-state page-pad" data-testid="error-state">
      <h1 id="page-title">{error?.status === 404 ? 'Not found' : 'Something went wrong'}</h1>
      <p>{error?.message}</p>
      {children}
    </div>
  );
}
