import { sourceFeatures } from '../../../../lib/source-features';
export async function GET() {
  return Response.json(sourceFeatures(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
