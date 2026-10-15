import { sourceTextResponse } from '../../../../lib/source-text-handler';
import { searchDatabase } from '../../../../lib/search-db';

export async function GET(request: Request) {
  return sourceTextResponse(request, { database: searchDatabase });
}
