import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // In development the API runs separately on :3000.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
