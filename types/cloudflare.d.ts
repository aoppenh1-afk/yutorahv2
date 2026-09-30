// Import binding types without installing Workers' global Node/DOM declarations
// into the Linux worker and browser projects, which share this TypeScript check.
declare module 'cloudflare:workers' {
  export const env: {
    DB?: import('@cloudflare/workers-types').D1Database;
  };
}
