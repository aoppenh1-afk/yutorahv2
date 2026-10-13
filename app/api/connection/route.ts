/** Small, uncached reachability check. It does not depend on any upstream API. */
export function GET() {
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  });
}
