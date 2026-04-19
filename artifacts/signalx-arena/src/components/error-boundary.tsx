import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children:    ReactNode;
  label?:      string;
  fallback?:   (err: Error, info: ErrorInfo | null, reset: () => void) => ReactNode;
  onError?:    (err: Error, info: ErrorInfo) => void;
}

interface State {
  err:  Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { err: null, info: null };

  static getDerivedStateFromError(err: Error): State {
    return { err, info: null };
  }

  override componentDidCatch(err: Error, info: ErrorInfo) {
    this.setState({ err, info });
    try {
      console.error(`[ErrorBoundary:${this.props.label ?? 'root'}]`, err, info?.componentStack);
      this.props.onError?.(err, info);
    } catch { /* never let logging itself crash */ }
  }

  reset = () => this.setState({ err: null, info: null });

  copyDiag = async () => {
    const { err, info } = this.state;
    const text = [
      `SignalX Renderer Error (${this.props.label ?? 'root'})`,
      `time:    ${new Date().toISOString()}`,
      `href:    ${typeof window !== 'undefined' ? window.location.href : 'n/a'}`,
      `ua:      ${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}`,
      ``,
      `name:    ${err?.name ?? ''}`,
      `message: ${err?.message ?? ''}`,
      ``,
      `stack:`,
      err?.stack ?? '',
      ``,
      `componentStack:`,
      info?.componentStack ?? '',
    ].join('\n');
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be denied */ }
  };

  override render() {
    const { err, info } = this.state;
    if (!err) return this.props.children;

    if (this.props.fallback) return this.props.fallback(err, info, this.reset);

    return (
      <div
        role="alert"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          background:  '#09090b',
          color:       '#fca5a5',
          padding:     24,
          minHeight:   '100vh',
          boxSizing:   'border-box',
          overflow:    'auto',
        }}
      >
        <h1 style={{ color: '#ef4444', fontSize: 18, margin: '0 0 12px' }}>
          SignalX — {this.props.label ?? 'Renderer'} crashed
        </h1>
        <p style={{ color: '#a1a1aa', fontSize: 13, margin: '0 0 12px' }}>
          The view stopped rendering. Your connection and settings are unchanged.
        </p>
        <pre
          style={{
            background:   '#18181b',
            border:       '1px solid #27272a',
            borderRadius: 6,
            padding:      14,
            fontSize:     12,
            color:        '#fecaca',
            whiteSpace:   'pre-wrap',
            wordBreak:    'break-word',
            maxHeight:    '40vh',
            overflow:     'auto',
          }}
        >
          {err.name}: {err.message}
          {err.stack ? '\n\n' + err.stack : ''}
        </pre>
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button
            onClick={this.reset}
            style={{
              background: '#dc2626', color: '#fff', border: 'none',
              padding: '8px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <button
            onClick={this.copyDiag}
            style={{
              background: '#27272a', color: '#fafafa', border: '1px solid #3f3f46',
              padding: '8px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
            }}
          >
            Copy diagnostics
          </button>
        </div>
      </div>
    );
  }
}
