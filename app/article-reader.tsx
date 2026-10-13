'use client';
import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2, Printer } from 'lucide-react';
import type { Shiur } from '@/lib/yutorah';
export function ArticleReader({ shiur }: { shiur: Shiur }) {
  const [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    [ready, setReady] = useState(false),
    [printHelp, setPrintHelp] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    let blob = '';
    setUrl('');
    setError('');
    setReady(false);
    setPrintHelp(false);
    fetch('/api/article?id=' + shiur.id, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json();
          throw new Error(d.error);
        }
        return r.blob();
      })
      .then((pdf) => {
        if (abort.signal.aborted) return;
        blob = URL.createObjectURL(pdf);
        setUrl(blob);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => {
      abort.abort();
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [shiur.id, retry]);
  return (
    <section className="detail-section article-reader">
      <h3>Read article</h3>
      <div className="article-toolbar">
        <button
          className="outline-button"
          disabled={!ready}
          onClick={() => {
            try {
              frame.current?.contentWindow?.focus();
              frame.current?.contentWindow?.print();
            } catch {
              setPrintHelp(true);
            }
          }}
        >
          <Printer size={16} /> Print article
        </button>
        <a
          className="text-button"
          href={url || shiur.audio}
          target="_blank"
          rel="noreferrer"
        >
          Open PDF <ExternalLink size={14} />
        </a>
        <a
          className="text-button"
          href={url || shiur.audio}
          download={`yutorah-${shiur.id}.pdf`}
        >
          <Download size={15} /> Download PDF
        </a>
      </div>
      {printHelp && (
        <p className="study-note-label">
          Use the PDF viewer’s print button, or open the PDF and choose Print in
          your browser.
        </p>
      )}
      {error ? (
        <div className="inline-error" role="alert">
          {error}
          <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </div>
      ) : url ? (
        <iframe
          ref={frame}
          className="article-pdf"
          src={url}
          title="Article PDF reader"
          onLoad={() => setReady(true)}
        />
      ) : (
        <output className="catalog-loading">
          <Loader2 size={17} className="spin" />
          Loading article…
        </output>
      )}
    </section>
  );
}
