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
      <h2>Google sign-in and teacher follows</h2>
      <p>
        Signing in shares your Google account ID, name, email address, and
        profile picture with our authentication provider, Supabase. We request
        only your basic identity information. We do not request access to Gmail,
        Google Drive, or your Google password. Supabase stores your account and
        the teachers you follow so those follows work across devices.
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
        Saved shiurim, playlists, listening progress, topics, series, searches,
        and learning goals stay in this browser&apos;s local storage. Pending
        changes to teacher follows and your sign-in session also use local
        storage. Clearing site data removes those local records. It does not
        delete an existing cloud account or its teacher follows.
      </p>
      <h2>Hosting and library requests</h2>
      <p>
        Vercel hosts this website. Library information and recordings come from
        YUTorah and its media providers. These services process network requests
        needed to load pages, search, and play recordings. The website also
        records aggregate performance measurements. Your Google identity and
        teacher follows are used for account sync and notifications, and are not
        sold or used for advertising.
      </p>
      <h2>Remove your account</h2>
      <p>
        To request deletion of your account, cloud teacher follows, and
        notification device records, contact{' '}
        <a href="mailto:yutorahv2@gmail.com">yutorahv2@gmail.com</a> from the
        email address associated with your account. Use the same address for
        privacy questions. You can revoke Google access in your Google account
        settings.
      </p>
      <Link href="/">Back to the library</Link>
    </main>
  );
}
