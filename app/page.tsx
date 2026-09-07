import { getHome } from '@/lib/yutorah';
import TorahApp from './torah-app';
export default async function Home() {
  let home = null;
  try {
    home = await getHome();
  } catch {}
  return <TorahApp initialHome={home} />;
}
