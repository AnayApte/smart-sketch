'use client';

import { useRef, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

type AuthFormProps = {
  scrollRootRef?: React.RefObject<HTMLElement>;
};

export default function AuthForm({ scrollRootRef }: AuthFormProps) {
  const router = useRouter();
  const { signUp, signIn, user, loading } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleElements, setVisibleElements] = useState<Set<number>>(new Set());
  const [isLogin, setIsLogin] = useState(true);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirm, setRegisterConfirm] = useState('');
  const [registerFirstName, setRegisterFirstName] = useState('');
  const [registerLastName, setRegisterLastName] = useState('');
  const [error, setError] = useState('');
  const [registerSuccessMessage, setRegisterSuccessMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingOverride, setLoadingOverride] = useState(false);

  useEffect(() => {
    if (!loading) {
      setLoadingOverride(false);
      return;
    }
    const t = setTimeout(() => setLoadingOverride(true), 2000);
    return () => clearTimeout(t);
  }, [loading]);

  useEffect(() => {
    console.log('[AuthForm] Mount check - user:', user?.email ?? 'null', 'loading:', loading, 'embedded:', !!scrollRootRef);
  }, [user, loading, scrollRootRef]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const index = parseInt(entry.target.getAttribute('data-index') || '0');
          setVisibleElements((prev) => {
            const newSet = new Set(prev);
            if (entry.isIntersecting) {
              newSet.add(index);
            } else {
              newSet.delete(index);
            }
            return newSet;
          });
        });
      },
      {
        threshold: 0.1,
        rootMargin: '0px 0px 0px 0px',
        root: scrollRootRef?.current ?? null,
      }
    );

    const elements = containerRef.current?.querySelectorAll('[data-index]');
    elements?.forEach((el) => observer.observe(el));

    const elementArray = Array.from(elements || []);
    setVisibleElements(new Set(
      elementArray.map((el) => parseInt(el.getAttribute('data-index') || '0'))
    ));

    return () => observer.disconnect();
  }, [isLogin, scrollRootRef]);

  const isVisible = (index: number) => visibleElements.has(index);

  const handleToggle = () => {
    setError('');
    setRegisterSuccessMessage('');
    const fieldCount = isLogin ? 5 : 7;
    const staggerTime = fieldCount * 100;
    const animationDuration = 1000;
    const totalAnimationTime = staggerTime + animationDuration;

    setIsAnimatingOut(true);
    for (let i = 0; i <= fieldCount; i++) {
      setTimeout(() => {
        setVisibleElements((prev) => {
          const newSet = new Set(prev);
          newSet.delete(i);
          return newSet;
        });
      }, i * 100);
    }

    setTimeout(() => {
      setIsLogin(!isLogin);
      setIsAnimatingOut(false);
      setVisibleElements(new Set());

      setTimeout(() => {
        const elements = containerRef.current?.querySelectorAll('[data-index]');
        const elementArray = Array.from(elements || []);

        elementArray.sort((a, b) => {
          const idxA = parseInt(a.getAttribute('data-index') || '0');
          const idxB = parseInt(b.getAttribute('data-index') || '0');
          return idxA - idxB;
        });

        setVisibleElements(new Set([0]));

        elementArray.forEach((el) => {
          const index = parseInt(el.getAttribute('data-index') || '0');
          if (index !== 0) {
            setTimeout(() => {
              setVisibleElements((prev) => new Set(prev).add(index));
            }, (index) * 150);
          }
        });
      }, 50);
    }, totalAnimationTime);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    console.log('[AuthForm] Login attempt started');

    if (!loginEmail || !loginPassword) {
      setError('Please fill in all fields');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail)) {
      setError('Please enter a valid email');
      return;
    }

    setIsSubmitting(true);
    console.log('[AuthForm] Calling signIn...');
    const { error: signInError } = await signIn(loginEmail, loginPassword);

    if (signInError) {
      console.error('[AuthForm] Login failed:', signInError.message);
      setError(signInError.message || 'Failed to login. Please check your credentials.');
      setIsSubmitting(false);
    } else {
      console.log('[AuthForm] Login successful, redirecting to home...');
      router.push('/home');
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setRegisterSuccessMessage('');

    if (!registerFirstName || !registerLastName || !registerEmail || !registerPassword || !registerConfirm) {
      setError('Please fill in all fields');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registerEmail)) {
      setError('Please enter a valid email');
      return;
    }

    if (registerPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    if (registerPassword !== registerConfirm) {
      setError('Passwords do not match');
      return;
    }

    setIsSubmitting(true);
    const { error: signUpError, signedIn } = await signUp(registerEmail, registerPassword, {
      firstName: registerFirstName,
      lastName: registerLastName
    });

    if (signUpError) {
      setError(signUpError.message || 'Failed to register. Please try again.');
      setIsSubmitting(false);
      return;
    }

    if (signedIn) {
      setIsSubmitting(false);
      router.push('/home');
      return;
    }

    setRegisterSuccessMessage(
      `Check your email — we sent a confirmation link to ${registerEmail}. Open that link to verify your account, then sign in here with the same email and password.`
    );
    setIsSubmitting(false);
  };

  if (loading && !loadingOverride && !scrollRootRef) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-transparent relative">
        <div className="text-center relative z-10">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <h1 className="text-xl font-display font-semibold text-foreground">Loading...</h1>
          <p className="text-foreground-muted mt-2">Please wait</p>
        </div>
      </div>
    );
  }

  const inputClasses = `w-full px-4 py-3 rounded-xl input-field transition-all duration-500 transform disabled:opacity-50`;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-transparent relative">
      <div ref={containerRef} className="relative z-10 w-full max-w-md p-8">
        {/* Card container with glass effect */}
        <div className="card-glass p-8 space-y-6">
          {/* Header */}
          <div className="text-center">
            <h1
              data-index="0"
              className={`text-3xl font-display font-bold text-foreground transition-all duration-300 ${
                isAnimatingOut ? 'opacity-0' : 'opacity-100'
              }`}
            >
              {isLogin ? 'Welcome back' : 'Create account'}
            </h1>
            <p className="text-foreground-muted mt-2 text-sm">
              {isLogin ? 'Sign in to continue your learning journey' : 'Start visualizing your learning'}
            </p>
          </div>

          {/* Login Form */}
          {isLogin && (
            <form onSubmit={handleLogin} className="flex flex-col space-y-4">
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm">
                  {error}
                </div>
              )}
              <div data-index="1">
                <label className="block text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wider">
                  Email
                </label>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  disabled={isSubmitting}
                  className={`${inputClasses} ${
                    isVisible(1)
                      ? 'opacity-100 translate-x-0'
                      : 'opacity-0 translate-x-8'
                  }`}
                />
              </div>
              <div data-index="2">
                <label className="block text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wider">
                  Password
                </label>
                <input
                  type="password"
                  placeholder="Enter your password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  disabled={isSubmitting}
                  className={`${inputClasses} ${
                    isVisible(2)
                      ? 'opacity-100 translate-x-0'
                      : 'opacity-0 translate-x-8'
                  }`}
                />
              </div>
              <button
                type="submit"
                data-index="3"
                disabled={isSubmitting}
                className={`w-full px-4 py-3 font-semibold rounded-xl btn-primary disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-500 transform ${
                  isVisible(3)
                    ? 'opacity-100 translate-x-0'
                    : 'opacity-0 translate-x-8'
                }`}
              >
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                    Signing in...
                  </span>
                ) : (
                  'Sign In'
                )}
              </button>
              <p
                data-index="4"
                className={`text-center text-foreground-muted text-sm transition-all duration-500 transform ${
                  isVisible(4)
                    ? 'opacity-100 translate-x-0'
                    : 'opacity-0 translate-x-8'
                }`}
              >
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  onClick={handleToggle}
                  disabled={isSubmitting}
                  className="text-primary hover:text-primary-light font-semibold transition-colors disabled:text-foreground-muted"
                >
                  Register
                </button>
              </p>
            </form>
          )}

          {/* Register Form */}
          {!isLogin && (
            <form onSubmit={handleRegister} className="flex flex-col space-y-4">
              {(error || registerSuccessMessage) && (
                <div
                  className={`p-3 border rounded-xl text-sm ${
                    registerSuccessMessage
                      ? 'bg-green-500/10 border-green-500/20 text-green-400'
                      : 'bg-red-500/10 border-red-500/20 text-red-400'
                  }`}
                >
                  {registerSuccessMessage || error}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div data-index="1">
                  <label className="block text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wider">
                    First Name
                  </label>
                  <input
                    type="text"
                    placeholder="John"
                    value={registerFirstName}
                    onChange={(e) => setRegisterFirstName(e.target.value)}
                    disabled={isSubmitting}
                    className={`${inputClasses} ${
                      isVisible(1)
                        ? 'opacity-100 translate-x-0'
                        : 'opacity-0 -translate-x-8'
                    }`}
                  />
                </div>
                <div data-index="2">
                  <label className="block text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wider">
                    Last Name
                  </label>
                  <input
                    type="text"
                    placeholder="Doe"
                    value={registerLastName}
                    onChange={(e) => setRegisterLastName(e.target.value)}
                    disabled={isSubmitting}
                    className={`${inputClasses} ${
                      isVisible(2)
                        ? 'opacity-100 translate-x-0'
                        : 'opacity-0 -translate-x-8'
                    }`}
                  />
                </div>
              </div>
              <div data-index="3">
                <label className="block text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wider">
                  Email
                </label>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={registerEmail}
                  onChange={(e) => setRegisterEmail(e.target.value)}
                  disabled={isSubmitting}
                  className={`${inputClasses} ${
                    isVisible(3)
                      ? 'opacity-100 translate-x-0'
                      : 'opacity-0 -translate-x-8'
                  }`}
                />
              </div>
              <div data-index="4">
                <label className="block text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wider">
                  Password
                </label>
                <input
                  type="password"
                  placeholder="Min. 6 characters"
                  value={registerPassword}
                  onChange={(e) => setRegisterPassword(e.target.value)}
                  disabled={isSubmitting}
                  className={`${inputClasses} ${
                    isVisible(4)
                      ? 'opacity-100 translate-x-0'
                      : 'opacity-0 -translate-x-8'
                  }`}
                />
              </div>
              <div data-index="5">
                <label className="block text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wider">
                  Confirm Password
                </label>
                <input
                  type="password"
                  placeholder="Confirm your password"
                  value={registerConfirm}
                  onChange={(e) => setRegisterConfirm(e.target.value)}
                  disabled={isSubmitting}
                  className={`${inputClasses} ${
                    isVisible(5)
                      ? 'opacity-100 translate-x-0'
                      : 'opacity-0 -translate-x-8'
                  }`}
                />
              </div>
              <button
                type="submit"
                data-index="6"
                disabled={isSubmitting}
                className={`w-full px-4 py-3 font-semibold rounded-xl btn-primary disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-500 transform ${
                  isVisible(6)
                    ? 'opacity-100 translate-x-0'
                    : 'opacity-0 -translate-x-8'
                }`}
              >
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                    Creating account...
                  </span>
                ) : (
                  'Create Account'
                )}
              </button>
              <p
                data-index="7"
                className={`text-center text-foreground-muted text-sm transition-all duration-500 transform ${
                  isVisible(7)
                    ? 'opacity-100 translate-x-0'
                    : 'opacity-0 -translate-x-8'
                }`}
              >
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={handleToggle}
                  disabled={isSubmitting}
                  className="text-primary hover:text-primary-light font-semibold transition-colors disabled:text-foreground-muted"
                >
                  Sign In
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
