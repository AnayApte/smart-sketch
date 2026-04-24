"use client";

import Link from "next/link";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import NeuralNetworkBackground from "@/components/NeuralNetworkBackground";

export default function HomePage() {
  const { signOut, user } = useAuth();
  const router = useRouter();

  const firstName = user?.user_metadata?.first_name || 'there';

  const handleLogout = async () => {
    await signOut();
    router.push('/');
  };

  return (
    <ProtectedRoute>
      <NeuralNetworkBackground />
      <div className="relative z-10 w-full min-h-screen bg-transparent overflow-hidden">
        {/* Header */}
        <header className="absolute top-0 left-0 right-0 z-20 p-6 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary-dark flex items-center justify-center">
              <span className="text-background font-display font-bold text-lg">S</span>
            </div>
            <span className="font-display font-semibold text-foreground text-lg hidden sm:block">SmartSketch</span>
          </div>
          <button
            onClick={handleLogout}
            className="px-4 py-2 rounded-xl glass text-foreground-muted hover:text-foreground hover:border-surface-border-light transition-all duration-300 text-sm font-medium"
          >
            Sign Out
          </button>
        </header>

        {/* Main Content */}
        <div className="flex flex-col items-center justify-center min-h-screen px-4 pt-20 pb-10">
          {/* Welcome Section */}
          <div className="text-center mb-12 animate-fade-in-down">
            <p className="text-primary font-medium mb-2 tracking-wide">Welcome back</p>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-display font-bold text-foreground">
              {firstName}
            </h1>
            <p className="text-foreground-muted mt-4 text-lg max-w-md mx-auto">
              Ready to transform your next lecture into visual knowledge?
            </p>
          </div>

          {/* Action Cards */}
          <div className="w-full max-w-4xl">
            <div className="grid md:grid-cols-2 gap-6">
              {/* New Sketch Card */}
              <div className="group relative animate-fade-in-up opacity-0 [animation-delay:0.2s] [animation-fill-mode:forwards]">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                <div className="relative card p-8 hover:border-primary/30 transition-all duration-300 group-hover:shadow-glow-primary">
                  {/* Icon */}
                  <div className="w-14 h-14 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-6 group-hover:bg-primary/20 transition-colors duration-300">
                    <svg className="w-7 h-7 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                    </svg>
                  </div>

                  <h3 className="text-xl font-display font-bold text-foreground mb-2">
                    Start New Sketch
                  </h3>
                  <p className="text-foreground-muted text-sm mb-6 leading-relaxed">
                    Begin a live recording session. Your lecture will be transcribed and visualized in real-time.
                  </p>

                  <Link
                    href="/record"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl btn-primary text-sm"
                  >
                    Begin Session
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                  </Link>
                </div>
              </div>

              {/* Past Sketches Card */}
              <div className="group relative animate-fade-in-up opacity-0 [animation-delay:0.4s] [animation-fill-mode:forwards]">
                <div className="absolute inset-0 bg-gradient-to-br from-accent/20 to-transparent rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                <div className="relative card p-8 hover:border-accent/30 transition-all duration-300 group-hover:shadow-glow-accent">
                  {/* Icon */}
                  <div className="w-14 h-14 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center mb-6 group-hover:bg-accent/20 transition-colors duration-300">
                    <svg className="w-7 h-7 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                  </div>

                  <h3 className="text-xl font-display font-bold text-foreground mb-2">
                    View Past Sketches
                  </h3>
                  <p className="text-foreground-muted text-sm mb-6 leading-relaxed">
                    Explore and interact with your previous mind maps. Refresh your memory anytime.
                  </p>

                  <Link
                    href="/library"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl btn-accent text-sm"
                  >
                    Browse Library
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Stats or Tips */}
          <div className="mt-12 text-center animate-fade-in-up opacity-0 [animation-delay:0.6s] [animation-fill-mode:forwards]">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass text-sm text-foreground-muted">
              <svg className="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Tip: Speak clearly for better transcription accuracy</span>
            </div>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
