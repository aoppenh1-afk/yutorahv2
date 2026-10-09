import type { Metadata, Viewport } from 'next';
import {
  Geist,
  Geist_Mono,
  Instrument_Serif,
  Frank_Ruhl_Libre,
} from 'next/font/google';
import './globals.css';
import './home.css';
import './screens.css';
import './study.css';
import { PerformanceMonitor } from './performance-monitor';
const sans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const display = Instrument_Serif({
  variable: '--font-display',
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  display: 'swap',
});
const hebrew = Frank_Ruhl_Libre({
  variable: '--font-hebrew',
  subsets: ['hebrew'],
  weight: ['400', '500', '700'],
  display: 'swap',
});
export const metadata: Metadata = {
  title: 'YUTorah | The Torah Library',
  description:
    'Listen and learn from the YUTorah library. Search shiurim by topic, teacher, series and more. Save your learning and pick up where you left off.',
  icons: { icon: '/images/yutorah-shield.png' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f6f3ec',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${display.variable} ${hebrew.variable}`}
    >
      <body>
        {children}
        <PerformanceMonitor />
      </body>
    </html>
  );
}
