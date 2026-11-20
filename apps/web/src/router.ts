import { useEffect, useState } from 'react';

/** 라우트가 몇 개 안 되므로 history API로 직접 처리한다 (/login, /, /room/:id, /lab, /metrics). */
export function navigate(path: string, replace = false): void {
  if (location.pathname === path) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}
