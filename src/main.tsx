import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

function enforcePlatformFavicons() {
  if (typeof document === 'undefined' || !document.head) return;

  const definitions: Array<{
    rel: string;
    href: string;
    type?: string;
    sizes?: string;
    color?: string;
  }> = [
    { rel: 'icon', href: '/favicon.ico?v=3', sizes: 'any' },
    { rel: 'icon', href: '/favicon.svg?v=3', type: 'image/svg+xml' },
    { rel: 'icon', href: '/favicon-32x32.png?v=3', type: 'image/png', sizes: '32x32' },
    { rel: 'icon', href: '/favicon-16x16.png?v=3', type: 'image/png', sizes: '16x16' },
    { rel: 'shortcut icon', href: '/favicon.ico?v=3' },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png?v=3', sizes: '180x180' },
    { rel: 'mask-icon', href: '/safari-pinned-tab.svg?v=3', color: '#4f46e5' },
  ];

  for (const def of definitions) {
    const selector = `link[rel="${def.rel}"][href="${def.href}"]`;
    if (!document.head.querySelector(selector)) {
      const link = document.createElement('link');
      link.rel = def.rel;
      link.href = def.href;
      if (def.type) link.type = def.type;
      if (def.sizes) link.setAttribute('sizes', def.sizes);
      if (def.color) link.setAttribute('color', def.color);
      document.head.appendChild(link);
    }
  }
}

enforcePlatformFavicons();

createRoot(document.getElementById('root')!).render(<App />);
