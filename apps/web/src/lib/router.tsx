import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/** Minimal history router: the app has a handful of top-level pages, so a dependency is not worth it. */
const EVT = 'app:navigate';

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  window.dispatchEvent(new Event(EVT));
}

export function useLocation() {
  const read = () => ({ path: location.pathname, search: location.search });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    window.addEventListener(EVT, on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener(EVT, on); };
  }, []);
  return loc;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={go} {...rest} />;
}
