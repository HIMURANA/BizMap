import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { FeedbackHost } from './components/feedback';
import { I18nProvider } from './lib/i18n';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <App />
        <FeedbackHost />
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
