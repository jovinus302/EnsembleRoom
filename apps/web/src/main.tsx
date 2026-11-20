import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@fontsource-variable/dm-sans';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './index.css';
import { App } from './App';

// 개발용 3D 월드 랩: 로그인·서버 없이 열린다(three 번들은 이 경로에서만 로드). S15/S16
const WorldLab = lazy(() => import('./world/lab/WorldLab').then((m) => ({ default: m.WorldLab })));
const isWorldLab = location.pathname.startsWith('/lab/world');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isWorldLab ? (
      <Suspense fallback={null}>
        <WorldLab />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
