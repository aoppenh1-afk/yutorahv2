import Link from 'next/link';

export const metadata = {
  title: 'Privacy policy | YUTorah Library',
};

export default function PrivacyPage() {
  return (
    <main className="auth-callback privacy-page">
      <h1>YUTorah Library privacy policy</h1>
      <p>Updated October 11, 2026.</p>
      <p>
        YUTorah Library is an independent interface to YUTorah&apos;s public
        library. You can browse without creating an account.
      </p>
      <h2>Google sign-in and your library</h2>
      <p>
        Signing in shares your Google account ID, name, email address, and
        profile picture with our authentication provider, Supabase. We request
        only your basic identity information. We do not request access to Gmail,
        Google Drive, or your Google password. Supabase stores your account and
        your private library so it works across devices. This includes saved
        shiurim, playlists, listening history and progress, personal notes, the
        queue, followed teachers, topics and series, saved searches, learning
        goals and activity, and playback preferences.
      </p>
      <h2>Notifications</h2>
      <p>
        Enabling notifications stores this device&apos;s push endpoint,
        encryption keys, and device label in Supabase. We use them to notify you
        about new shiurim from teachers you follow and to send a test when you
        request one. Delivery uses your browser&apos;s push service, such as
        Apple, Google, or Mozilla. You can turn notifications off on each device
        or unfollow a teacher. Signing out unsubscribes the device.
      </p>
      <h2>Data on your device</h2>
      <p>
        Without signing in, your library stays in this browser&apos;s local
        storage. Signing in imports the existing device library into your
        account. A local copy and pending edits support offline use and retry
        when you reconnect. Your sign-in session also uses local storage.
        Clearing site data removes local records and edits that have not synced;
        it does not delete your cloud library. Switching accounts loads the
        other account&apos;s library without importing the previous
        account&apos;s data. Audio and video recordings remain hosted by
        YUTorah.
      </p>
      <h2>Hosting and library requests</h2>
      <p>
        Vercel hosts this website. Library information and recordings come from
        YUTorah and its media providers. These services process network requests
        needed to load pages, search, and play recordings. The website also
        records aggregate performance measurements. Your Google identity and
        private library are used for account sync and notifications, and are not
        sold or used for advertising.
      </p>
      <h2>Remove your account</h2>
      <p>
        To request deletion of your account, cloud library, and notification
        device records, contact{' '}
        <a href="mailto:yutorahv2@gmail.com">yutorahv2@gmail.com</a> from the
        email address associated with your account. Use the same address for
        privacy questions. You can revoke Google access in your Google account
        settings.
      </p>
      <Link href="/">Back to the library</Link>
    </main>
  );
}
