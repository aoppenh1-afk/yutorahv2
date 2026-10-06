import type { Metadata } from 'next';
import { Geist, Geist_Mono, Lora } from 'next/font/google';
import './globals.css';
import './redesign.css';
import './mobile.css';
import { PerformanceMonitor } from './performance-monitor';
const sans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const editorial = Lora({
  variable: '--font-editorial',
  subsets: ['latin'],
  display: 'swap',
});
export const metadata: Metadata = {
  title: 'YUTorah | The Torah Library',
  description:
    'Listen and learn from the YUTorah library. Search shiurim by topic, teacher, series and more. Save your learning and pick up where you left off.',
  icons: { icon: '/images/yutorah-shield.png' },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${sans.variable} ${mono.variable} ${editorial.variable}`}
      >
        {children}
        <PerformanceMonitor />
      </body>
    </html>
  );
}
