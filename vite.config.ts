import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// Compress shared framework, UI and icon modules together across screens.
// Keep React DOM separate so consolidation respects the individual-chunk cap.
const environments = {
  client: {
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'react-dom',
                test: /[/\\]node_modules[/\\]react-dom[/\\]/,
              },
              {
                name: 'vinext-client',
                test: /[/\\]node_modules[/\\]vinext[/\\]/,
              },
              {
                name: 'ui-primitives',
                test: /[/\\]node_modules[/\\](?:@base-ui|@floating-ui)[/\\]/,
              },
              {
                name: 'icons',
                test: /[/\\]node_modules[/\\]lucide-react[/\\]/,
              },
            ],
          },
        },
      },
    },
  },
};

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  if (process.env.VERCEL || process.env.DEPLOY_TARGET === 'vercel') {
    const { nitro } = await import('nitro/vite');
    return {
      environments,
      optimizeDeps: { include: ['@react-pdf/renderer', 'docx'] },
      css: { postcss: { plugins: [tailwindcss()] } },
      resolve: {
        alias: {
          // Resolve stylesheet packages explicitly for the RSC build resolver.
          tailwindcss: fileURLToPath(
            import.meta.resolve('tailwindcss/index.css'),
          ),
          'tw-animate-css': fileURLToPath(
            new URL(
              './node_modules/tw-animate-css/dist/tw-animate.css',
              import.meta.url,
            ),
          ),
          'shadcn/tailwind.css': fileURLToPath(
            import.meta.resolve('shadcn/tailwind.css'),
          ),
          'cloudflare:workers': fileURLToPath(
            new URL('./lib/vercel-bindings.ts', import.meta.url),
          ),
        },
      },
      plugins: [
        vinext(),
        nitro({
          preset: process.env.NITRO_PRESET || 'vercel',
          // Vinext adds its default serverExternalPackages to Nitro's forced
          // dependency trace, including installed build/test tools that the
          // server never imports. Keep those tools out of every deployment.
          traceDeps: [
            '!playwright',
            '!playwright-core',
            '!postcss',
            '!ts-morph',
            '!typescript',
            '!webpack',
          ],
        }),
      ],
    };
  }
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    environments,
    optimizeDeps: { include: ['@react-pdf/renderer', 'docx'] },
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
  };
});
