import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/app/App';
import { AuthGate } from '@/auth/AuthGate';
import { BrandingProvider } from '@/branding/BrandingProvider';
import '@/styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandingProvider>
        <BrowserRouter>
          <AuthGate>
            <App />
          </AuthGate>
        </BrowserRouter>
      </BrandingProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
