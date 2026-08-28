import { useEffect } from 'react';
import { DocsPage } from './pages/DocsPage';
import { LandingPage } from './pages/LandingPage';
import { StudioPage } from './pages/StudioPage';

type Route = 'home' | 'studio' | 'view' | 'docs' | 'not-found';

function currentRoute(pathname: string): Route {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/') return 'home';
  if (normalized === '/studio') return 'studio';
  if (normalized === '/view') return 'view';
  if (normalized === '/docs') return 'docs';
  return 'not-found';
}

export function App() {
  const route = currentRoute(window.location.pathname);
  usePageMetadata(route);

  if (route === 'home') return <LandingPage />;
  if (route === 'studio' || route === 'view') return <StudioPage reviewOnly={route === 'view'} />;
  if (route === 'docs') return <DocsPage />;

  return (
    <main className="not-found">
      <a className="brand" href="/" aria-label="FrameScript home">
        FRAMESCRIPT
      </a>
      <p className="kicker">404</p>
      <h1>This scene isn’t in the script.</h1>
      <p>The address does not match a FrameScript page.</p>
      <a className="button button--primary" href="/">
        Return home
      </a>
    </main>
  );
}

function usePageMetadata(route: Route) {
  useEffect(() => {
    document.title =
      route === 'home'
        ? 'FrameScript — Turn video into a structured screenplay'
        : route === 'docs'
          ? 'Documentation — FrameScript'
          : route === 'view'
            ? 'Project Viewer — FrameScript'
            : route === 'studio'
              ? 'Studio — FrameScript'
              : 'Page not found — FrameScript';

    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (robots)
      robots.content = route === 'home' || route === 'docs' ? 'index,follow' : 'noindex,nofollow';

    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = `${window.location.origin}${route === 'not-found' ? '/' : window.location.pathname}`;
  }, [route]);
}
