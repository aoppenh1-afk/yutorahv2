import type { Metadata } from 'next';
import Script from 'next/script';
import { Fraunces, Geist_Mono, Source_Sans_3 } from 'next/font/google';
import './globals.css';
import './redesign.css';
import './mobile.css';
import './reading-room.css';
import { PerformanceMonitor } from './performance-monitor';
const sans = Source_Sans_3({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const editorial = Fraunces({
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
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${sans.variable} ${mono.variable} ${editorial.variable}`}
      >
        <Script id="yutorah-theme" strategy="beforeInteractive">
          {`(function(){try{var t=localStorage.getItem('yutorah-theme');var dark=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);if(dark){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark'}}catch(e){}})();`}
        </Script>
        {children}
        <PerformanceMonitor />
      </body>
    </html>
  );
}
