import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Frank_Ruhl_Libre } from 'next/font/google';
import './globals.css';
import './home.css';
import './screens.css';
import './study.css';
import './account.css';
import { PerformanceMonitor } from './performance-monitor';
const sans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const hebrew = Frank_Ruhl_Libre({
  variable: '--font-hebrew',
  subsets: ['hebrew'],
  weight: ['400', '500', '700'],
  display: 'swap',
});
export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
  title: 'YUTorah | The Torah Library',
  description:
    'Listen and learn from the YUTorah library. Search shiurim by topic, teacher, series and more. Save your learning and pick up where you left off.',
  icons: {
    icon: '/images/yutorah-shield.png',
    apple: {
      url: '/apple-touch-icon.png?v=2',
      sizes: '180x180',
      type: 'image/png',
    },
  },
  appleWebApp: { title: 'YUTorah', capable: true, statusBarStyle: 'default' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${hebrew.variable}`}
    >
      <body>
        {children}
        <PerformanceMonitor />
      </body>
    </html>
  );
}
