'use client';
import { Component, Suspense } from 'react';
class ScreenError extends Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="loading-panel">
        This screen could not load.{' '}
        <button
          className="outline-button"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export function ScreenBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ScreenError>
      <Suspense
        fallback={
          <output className="loading-panel">Loading study tools…</output>
        }
      >
        {children}
      </Suspense>
    </ScreenError>
  );
}
