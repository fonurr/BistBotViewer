import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-ext-500.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './app/App';
import { queryClient } from './app/queryClient';
import { ViewerRuntimeProvider } from './app/ViewerRuntime';
import './styles/nocturne.css';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('The application root element is missing.');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ViewerRuntimeProvider>
          <App />
        </ViewerRuntimeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
