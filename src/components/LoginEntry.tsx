import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Lock, LogIn, Mail, Loader2 } from 'lucide-react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth, testConnection } from '../firebase';
import { RdxEmblem } from './RdxBackground';

const LEGACY_FIREBASE_API_KEY = 'AIzaSyAiDWFA9XejFdttVHrpxgUcmWnCfaFysuE';
export const SESSION_KEY = 'RDX_TEM_auth_session_v4';

export interface AuthSession {
  email: string;
  localId: string;
  idToken: string;
  expiresAt: number;
  cloudEnabled?: boolean;
}

const LOADING_STEPS = [
  { p: 18, t: 'Initializing system...' },
  { p: 44, t: 'Encrypting connection...' },
  { p: 72, t: 'Connecting to main server...' },
  { p: 92, t: 'Verifying security...' },
  { p: 100, t: 'Ready' },
];

interface LoginEntryProps {
  onAuthenticated: (session: AuthSession) => void;
  onSoundError: () => void;
  onSoundSuccess: () => void;
}

export function getSavedSession(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (parsed?.idToken && parsed?.expiresAt > Date.now()) {
      return parsed;
    }
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  } catch {
    return null;
  }
}

function mapFirebaseError(code: string): string {
  if (
    code.includes('INVALID_LOGIN_CREDENTIALS') ||
    code.includes('INVALID_PASSWORD') ||
    code.includes('EMAIL_NOT_FOUND') ||
    code.includes('invalid-credential')
  ) {
    return 'Invalid email or password.';
  }
  if (code.includes('INVALID_EMAIL') || code.includes('invalid-email')) {
    return 'Please enter a valid email address.';
  }
  if (code.includes('USER_DISABLED') || code.includes('user-disabled')) {
    return 'This account has been disabled.';
  }
  if (code.includes('TOO_MANY_ATTEMPTS_TRY_LATER') || code.includes('too-many-requests')) {
    return 'Too many failed attempts. Please try again later.';
  }
  return 'Authentication failed. Please check your credentials.';
}

export function LoginEntry({ onAuthenticated, onSoundError, onSoundSuccess }: LoginEntryProps) {
  const [phase, setPhase] = useState<'loading' | 'login'>('loading');
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Loading system...');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [shaking, setShaking] = useState(false);

  useEffect(() => {
    void testConnection();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let idx = 0;

    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser || cancelled) return;
      try {
        const idToken = await fbUser.getIdToken();
        const session: AuthSession = {
          email: fbUser.email || 'operator@rdx.local',
          localId: fbUser.uid,
          idToken,
          expiresAt: Date.now() + 50 * 60 * 1000,
          cloudEnabled: Boolean(fbUser.emailVerified),
        };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        if (!cancelled) onAuthenticated(session);
      } catch {
        // Fallback to manual login
      }
    });

    const tick = () => {
      if (cancelled) return;
      if (idx >= LOADING_STEPS.length) {
        setTimeout(() => {
          if (cancelled) return;
          if (auth.currentUser) return;
          const existing = getSavedSession();
          if (existing) {
            onAuthenticated(existing);
          } else {
            setPhase('login');
          }
        }, 280);
        return;
      }
      const step = LOADING_STEPS[idx];
      setProgress(step.p);
      setStatusText(step.t);
      idx += 1;
      setTimeout(tick, 170 + Math.random() * 120);
    };

    tick();
    return () => {
      cancelled = true;
      unsub();
    };
  }, [onAuthenticated]);

  const triggerShake = () => {
    setShaking(false);
    requestAnimationFrame(() => setShaking(true));
    setTimeout(() => setShaking(false), 500);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedPass = password.trim();

    if (!trimmedEmail || !trimmedPass) {
      setErrorMsg('Please enter email and password.');
      triggerShake();
      onSoundError();
      return;
    }

    setSubmitting(true);
    setErrorMsg('');

    try {
      // Primary: Sign in against provisioned Firebase Auth project
      try {
        const cred = await signInWithEmailAndPassword(auth, trimmedEmail, trimmedPass);
        const fbUser = cred.user;
        const idToken = await fbUser.getIdToken();
        const session: AuthSession = {
          email: fbUser.email || trimmedEmail,
          localId: fbUser.uid,
          idToken,
          expiresAt: Date.now() + 50 * 60 * 1000,
          cloudEnabled: Boolean(fbUser.emailVerified),
        };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        onSoundSuccess();
        onAuthenticated(session);
        return;
      } catch {
        // Fallback to legacy operator REST auth for existing accounts
      }

      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${LEGACY_FIREBASE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: trimmedEmail,
            password: trimmedPass,
            returnSecureToken: true,
          }),
        },
      );

      const data = await res.json();
      if (!res.ok || data.error) {
        const msg = mapFirebaseError(data?.error?.message || '');
        setErrorMsg(msg);
        triggerShake();
        onSoundError();
        return;
      }

      const session: AuthSession = {
        email: data.email || trimmedEmail,
        localId: data.localId || '',
        idToken: data.idToken,
        expiresAt: Date.now() + (Number(data.expiresIn || 3600) - 60) * 1000,
        cloudEnabled: false,
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      onSoundSuccess();
      onAuthenticated(session);
    } catch {
      setErrorMsg('Network error. Unable to reach Firebase Auth.');
      triggerShake();
      onSoundError();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5 overflow-hidden">
      {phase === 'loading' ? (
        <section className="w-full max-w-[440px] text-center animate-[fadeIn_0.5s_ease]">
          <div className="relative w-[110px] h-[110px] mx-auto mb-6 flex items-center justify-center">
            <div
              className="absolute inset-0 rounded-[32px] animate-logo-pulse"
              style={{
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                boxShadow: '0 24px 70px rgba(239,68,68,0.45), 0 0 0 8px rgba(239,68,68,0.1)',
              }}
            />
            <div className="absolute inset-[7px] rounded-[26px] bg-[#080000]" />
            <RdxEmblem className="relative z-10 w-16 h-16" />
          </div>

          <h2 className="font-display text-[32px] font-bold tracking-[3px] mb-1.5 bg-gradient-to-br from-[#ef4444] to-[#dc2626] bg-clip-text text-transparent">
            RDX TEM
          </h2>
          <p className="text-[#a8a29e] text-xs font-bold tracking-[3px] mb-9 uppercase">
            RDX COMMAND CENTER
          </p>

          <div className="w-[280px] max-w-full h-1 mx-auto rounded-full bg-red-500/10 overflow-hidden relative">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${progress}%`,
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                boxShadow: '0 0 20px rgba(239,68,68,0.6)',
              }}
            />
          </div>
          <div className="mt-4 font-mono-num text-[11px] tracking-[1.5px] text-[#a8a29e] min-h-[20px]">
            {statusText}
          </div>
        </section>
      ) : (
        <section className="w-full max-w-[440px]">
          <div
            className={`relative w-full px-8 py-10 sm:px-10 rounded-[28px] border border-[rgba(239,68,68,0.35)] text-center overflow-hidden backdrop-blur-2xl ${
              shaking ? 'animate-shake' : ''
            }`}
            style={{
              background: 'linear-gradient(135deg, rgba(22,16,16,0.95), rgba(30,21,21,0.98))',
              boxShadow:
                '0 50px 120px rgba(0,0,0,0.85), 0 0 100px rgba(239,68,68,0.15), inset 0 1px 0 rgba(255,255,255,0.08)',
            }}
          >
            <div className="absolute top-0 left-0 right-0 h-[3px] animate-line-slide" />

            <span className="absolute top-5 left-5 text-[9px] font-extrabold tracking-[1.5px] px-3 py-1.5 rounded-lg text-emerald-400 bg-emerald-500/10 border border-emerald-500/40 font-mono-num shadow-[0_0_15px_rgba(16,185,129,0.2)]">
              v4.0 · SECURE
            </span>

            <div className="relative w-[92px] h-[92px] mx-auto mb-5 flex items-center justify-center">
              <div
                className="absolute inset-0 rounded-[28px] animate-logo-pulse"
                style={{
                  background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                  boxShadow: '0 24px 70px rgba(239,68,68,0.5), 0 0 0 8px rgba(239,68,68,0.1)',
                }}
              />
              <div className="absolute inset-[6px] rounded-[22px] bg-[#161010]" />
              <RdxEmblem className="relative z-10 w-12 h-12" />
            </div>

            <h1 className="font-display text-[30px] font-bold tracking-[2px] mb-1 bg-gradient-to-br from-[#ef4444] to-[#dc2626] bg-clip-text text-transparent">
              RDX TEM
            </h1>
            <p className="text-[#a8a29e] text-[13px] font-semibold mb-6 tracking-[1px]">
              Secure Command Center · Cloud Sync
            </p>

            <form onSubmit={handleSubmit} noValidate>
              <div className="relative mb-3.5 group">
                <Mail
                  size={16}
                  className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2 text-[#a8a29e] group-focus-within:text-[#ef4444] transition-colors z-10"
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email Address"
                  autoComplete="email"
                  required
                  className="rdx-input-dark w-full h-[54px] pl-12 pr-5 rounded-2xl border border-[rgba(239,68,68,0.16)] bg-[rgba(8,0,0,0.72)] text-[#f7f5f0] placeholder:text-[#a8a29e]/55 placeholder:font-medium font-mono-num text-[14px] font-bold tracking-[0.4px] outline-none transition-all focus:border-[#ef4444] focus:bg-[rgba(10,0,0,0.92)] focus:shadow-[0_0_0_4px_rgba(239,68,68,0.2),0_0_40px_rgba(239,68,68,0.28)]"
                />
              </div>

              <div className="relative mb-3.5 group">
                <Lock
                  size={16}
                  className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2 text-[#a8a29e] group-focus-within:text-[#ef4444] transition-colors z-10"
                />
                <input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete="current-password"
                  required
                  className="rdx-input-dark w-full h-[54px] pl-12 pr-12 rounded-2xl border border-[rgba(239,68,68,0.16)] bg-[rgba(8,0,0,0.72)] text-[#f7f5f0] placeholder:text-[#a8a29e]/55 placeholder:font-medium font-mono-num text-[14px] font-bold tracking-[0.4px] outline-none transition-all focus:border-[#ef4444] focus:bg-[rgba(10,0,0,0.92)] focus:shadow-[0_0_0_4px_rgba(239,68,68,0.2),0_0_40px_rgba(239,68,68,0.28)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  aria-label={showPass ? 'Hide password' : 'Show password'}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-xl flex items-center justify-center text-[#a8a29e] hover:text-[#ef4444] hover:bg-red-500/10 transition-colors z-10 cursor-pointer"
                >
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              <div
                role="alert"
                className="min-h-[20px] my-2 mb-3 text-[#ef4444] text-[12.5px] font-bold drop-shadow-[0_0_10px_rgba(239,68,68,0.45)]"
              >
                {errorMsg}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="relative w-full h-[54px] rounded-2xl font-bold text-[15px] tracking-[1.5px] text-[#f7f5f0] flex items-center justify-center gap-3 overflow-hidden transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-65 cursor-pointer"
                style={{
                  background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                  boxShadow:
                    '0 15px 40px rgba(239,68,68,0.45), inset 0 2px 0 rgba(255,255,255,0.2)',
                }}
              >
                {submitting ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    <span>Authenticating...</span>
                  </>
                ) : (
                  <>
                    <LogIn size={18} />
                    <span>Secure Login</span>
                  </>
                )}
              </button>
            </form>

            <div className="mt-6 text-[#a8a29e] text-[11.5px] font-bold tracking-[1.5px] font-mono-num">
              <span className="text-[#ef4444] drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]">
                RDX TEM
              </span>{' '}
              · Protected by Firebase
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
