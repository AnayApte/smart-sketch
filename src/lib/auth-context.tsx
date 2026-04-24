'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signUp: (
    email: string,
    password: string,
    metadata?: { firstName: string; lastName: string }
  ) => Promise<{ error: any | null; signedIn?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: any | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check current session
    const checkSession = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        setUser(data.session?.user ?? null);
      } catch (error) {
        console.error('Error checking session:', error);
      } finally {
        setLoading(false);
      }
    };

    checkSession();

    // Subscribe to auth state changes
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        console.log('[Auth] State change:', _event, 'User:', session?.user?.email ?? 'null');
        setUser(session?.user ?? null);
        setLoading(false);
      }
    );

    return () => {
      authListener?.subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string, metadata?: { firstName: string; lastName: string }) => {
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          firstName: metadata?.firstName ?? '',
          lastName: metadata?.lastName ?? '',
        }),
      });

      type SignupApiPayload = {
        ok?: boolean;
        message?: string;
        name?: string;
        session?: { access_token: string; refresh_token: string };
      };
      let payload: SignupApiPayload | null = null;
      try {
        payload = (await res.json()) as SignupApiPayload;
      } catch {
        payload = null;
      }

      const proxyError =
        !res.ok || !payload || payload.ok === false
          ? {
              message: payload?.message ?? `Sign up request failed (${res.status}).`,
              name: payload?.name ?? 'AuthError',
              status: res.status,
            }
          : null;

      if (proxyError) {
        return { error: proxyError };
      }

      if (payload?.session) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: payload.session.access_token,
          refresh_token: payload.session.refresh_token,
        });
        if (sessionError) {
          return { error: sessionError, signedIn: false };
        }
        return { error: null, signedIn: true };
      }

      return { error: null, signedIn: false };
    } catch (error) {
      return { error, signedIn: false };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      console.log('[Auth] Attempting sign in for:', email);
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        console.error('[Auth] Sign in error:', error.message);
      } else {
        console.log('[Auth] Sign in successful!');
      }
      return { error };
    } catch (error) {
      console.error('[Auth] Sign in exception:', error);
      return { error };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
