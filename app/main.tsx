/**
 * main.tsx: mounts the board and keeps it fresh.
 *
 * Every 5 seconds, while the tab is visible, both JSON routes are fetched and the page updates in
 * place: no animation, no reload, and focus is never moved. Three failed checks in a row show
 * "server not reachable" and keep the last numbers. A one-second tick only advances the
 * "updated N s ago" and "waiting 4 min" texts.
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { InboxPayload, JudgmentPayload } from '../server';
import { Board } from './board';
import { POLL_MS, initialLink, onFailure, onSuccess, type Link } from './poll';

const NARROW = '(max-width: 639px)';

function App() {
  const [inbox, setInbox] = useState<InboxPayload | null>(null);
  const [judgment, setJudgment] = useState<JudgmentPayload | null>(null);
  const [link, setLink] = useState<Link>(() => initialLink(Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const check = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const [a, b] = await Promise.all([fetch('/api/inbox', { cache: 'no-store' }), fetch('/api/judgment', { cache: 'no-store' })]);
        if (!a.ok || !b.ok) throw new Error('bad status');
        const [nextInbox, nextJudgment] = [(await a.json()) as InboxPayload, (await b.json()) as JudgmentPayload];
        if (stopped) return;
        setInbox(nextInbox);
        setJudgment(nextJudgment);
        setLink((l) => onSuccess(l, Date.now()));
      } catch {
        if (!stopped) setLink((l) => onFailure(l, Date.now()));
      } finally {
        busy = false;
      }
    };
    void check();
    const poll = setInterval(check, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    const media = window.matchMedia(NARROW);
    const onMedia = () => setNarrow(media.matches);
    media.addEventListener('change', onMedia);
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      media.removeEventListener('change', onMedia);
    };
  }, []);

  // The page knows its own address; the port is whatever this server was started on.
  return <Board inbox={inbox} judgment={judgment} link={link} now={now} weeks={narrow ? 8 : 12} address={`${window.location.origin}/`} />;
}

render(<App />, document.getElementById('app')!);
