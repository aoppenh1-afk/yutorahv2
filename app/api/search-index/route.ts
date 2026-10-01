import { env } from 'cloudflare:workers';
import { searchDatabase } from '@/lib/search-db';
import {
  transferAuthorized,
  transferStatus,
  transferTitles,
} from '@/lib/title-transfer';

async function handle(request: Request) {
  const token = (env as unknown as { SEARCH_INDEX_TRANSFER_TOKEN?: string })
    .SEARCH_INDEX_TRANSFER_TOKEN;
  const headers = { 'Cache-Control': 'no-store' };
  if (!(await transferAuthorized(request, token)))
    return Response.json({ error: 'Not found.' }, { status: 404, headers });
  try {
    if (request.method === 'GET')
      return Response.json(await transferStatus(searchDatabase()), { headers });
    if (Number(request.headers.get('Content-Length')) > 1048576)
      throw new RangeError('Use a smaller transfer batch.');
    const raw = await request.text();
    if (raw.length > 1048576)
      throw new RangeError('Use a smaller transfer batch.');
    return Response.json(
      await transferTitles(searchDatabase(), JSON.parse(raw)),
      { headers },
    );
  } catch (error) {
    if (error instanceof RangeError || error instanceof SyntaxError)
      return Response.json({ error: error.message }, { status: 400, headers });
    console.error('Title transfer failed', error);
    return Response.json(
      { error: 'The title transfer failed; retry this batch.' },
      { status: 503, headers },
    );
  }
}
export const GET = handle;
export const POST = handle;
