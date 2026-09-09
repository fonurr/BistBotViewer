import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { createBistBridgePlugin } from './src/bistApi/server/bridge.ts';
import { createLogsBridgePlugin } from './src/bistApi/server/logs/logsMiddleware.ts';
import { createHistBridgePlugin } from './src/histApi/server/bridge.ts';
import { createPriceBridgePlugin } from './src/priceApi/server/bridge.ts';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'BIST_VIEWER_');
  const fixtureMode = environment.BIST_VIEWER_FIXTURES === 'true';

  return {
    plugins: [
      createLogsBridgePlugin({
        errors: environment.BIST_VIEWER_ORDER_DB ?? '../MatriksOrder/data/matriksorder.db',
        wire: environment.BIST_VIEWER_WIRE_LOG_DB ?? '../MatriksOrder/data/wire-log.db',
        api: environment.BIST_VIEWER_API_LOG_DB ?? '../MatriksOrder/data/api-log.db',
        fixtureMode,
      }),
      createBistBridgePlugin({
        upstreamUrl: environment.BIST_VIEWER_MATRIKS_URL ?? 'http://127.0.0.1:8788/api',
        fixtureMode,
      }),
      createPriceBridgePlugin({
        upstreamUrl: environment.BIST_VIEWER_PRICE_URL ?? 'http://127.0.0.1:8789/api',
        barsDatabasePath: environment.BIST_VIEWER_BARS_DB ?? '../DailyDataAggregator/data/bars.db',
        fixtureMode,
      }),
      createHistBridgePlugin({
        orderDatabasePath:
          environment.BIST_VIEWER_ORDER_DB ?? '../MatriksOrder/data/matriksorder.db',
        minuteDatabasePath:
          environment.BIST_VIEWER_BISTDATA_MINUTE_DB ?? '../BistData/data/minute.duckdb',
        scaleDatabasePath:
          environment.BIST_VIEWER_BISTDATA_SCALE_DB ?? '../BistData/data/scale.duckdb',
        cacheDatabasePath: environment.BIST_VIEWER_INTENT_CACHE_DB ?? 'data/intent-bars.db',
        fixtureMode,
      }),
      react(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), 'src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5175,
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 4175,
      strictPort: true,
    },
    build: {
      target: 'es2022',
      sourcemap: true,
    },
    test: {
      include: ['src/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      globals: true,
      pool: 'threads',
      maxWorkers: 2,
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
      clearMocks: true,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        thresholds: {
          statements: 65,
          branches: 55,
          functions: 65,
          lines: 67,
        },
      },
    },
  };
});
