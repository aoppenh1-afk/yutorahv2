import { sourceTextResponse } from '../../../../lib/source-text-handler';

export async function GET(request: Request) {
  return sourceTextResponse(request, {});
}
