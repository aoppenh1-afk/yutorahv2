'use client';
import { Bell, BellOff, UserRound, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { useAccount } from '@/lib/use-account';
import Link from 'next/link';

export function AccountPanel({
  account,
  open,
  onOpenChange,
  teacherCount,
}: {
  account: ReturnType<typeof useAccount>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teacherCount: number;
}) {
  const enabled = !!account.subscriptionId;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="account-dialog">
        <DialogHeader>
          <DialogTitle>Account and notifications</DialogTitle>
          <DialogDescription>
            Keep your teacher follows across devices and hear when a new shiur
            is posted.
          </DialogDescription>
        </DialogHeader>
        <div className="account-section">
          {account.user ? (
            <>
              <div className="account-identity">
                <UserRound size={22} />
                <div>
                  <strong>
                    {account.user.user_metadata?.full_name || 'Your account'}
                  </strong>
                  <p>{account.user.email}</p>
                </div>
              </div>
              <p>
                {account.syncing
                  ? 'Syncing teacher follows…'
                  : account.pendingCount
                    ? `${account.pendingCount} follow changes waiting to sync.`
                    : `${teacherCount} teachers followed. Teacher follows sync across your devices.`}
              </p>
              <p className="account-hint">
                Saved shiurim, playlists, topics, and series stay on this
                device.
              </p>
              <button
                className="account-secondary"
                disabled={account.loading || account.syncing}
                onClick={() => void account.signOut()}
              >
                Sign out on this device
              </button>
            </>
          ) : (
            <>
              <p>
                Sign in to sync teacher follows and enable notifications. You
                can keep browsing without an account.
              </p>
              <button
                className="account-primary"
                disabled={account.loading}
                onClick={() => void account.signIn()}
              >
                {account.loading ? (
                  <Loader2 size={17} className="animate-spin" />
                ) : (
                  <UserRound size={17} />
                )}{' '}
                Continue with Google
              </button>
            </>
          )}
          {account.error && (
            <div className="account-error" role="alert">
              <p>{account.error}</p>
              {account.user && (
                <button onClick={() => void account.refresh()}>
                  Retry sync
                </button>
              )}
            </div>
          )}
        </div>
        <div className="account-section">
          <h3>
            <Bell size={18} /> New shiur notifications
          </h3>
          <p>
            We check for new shiurim every six hours. Notifications work when
            this website is closed.
          </p>
          {account.support === 'iphone-install' ? (
            <div className="account-install">
              <strong>On iPhone or iPad</strong>
              <ol>
                <li>Open this website in Safari.</li>
                <li>
                  Tap Share, then Add to Home Screen. Keep Open as Web App
                  enabled if shown.
                </li>
                <li>
                  Open YUTorah from your Home Screen, sign in, and enable
                  notifications here.
                </li>
              </ol>
              <p>Requires iOS or iPadOS 16.4 or later.</p>
            </div>
          ) : account.support === 'unsupported' ? (
            <p>
              This browser does not support push notifications. Try a current
              version of Safari, Chrome, Edge, or Firefox.
            </p>
          ) : account.support === 'blocked' ? (
            <p>
              Notifications are blocked. Allow YUTorah notifications in your
              browser or device settings, then reopen this page.
            </p>
          ) : (
            <>
              <p className="account-hint">
                Permission applies to this device. Follow teachers to receive
                their new shiurim.
              </p>
              {account.user ? (
                <div className="account-actions">
                  <button
                    className={
                      enabled ? 'account-secondary' : 'account-primary'
                    }
                    disabled={account.notificationBusy || account.syncing}
                    onClick={() =>
                      void (enabled
                        ? account.turnOff()
                        : account.enableNotifications())
                    }
                  >
                    {account.notificationBusy ? (
                      <Loader2 className="animate-spin" size={17} />
                    ) : enabled ? (
                      <BellOff size={17} />
                    ) : (
                      <Bell size={17} />
                    )}{' '}
                    {enabled
                      ? 'Turn off on this device'
                      : 'Enable on this device'}
                  </button>
                  {enabled && (
                    <button
                      className="account-secondary"
                      disabled={account.notificationBusy}
                      onClick={() => void account.testNotification()}
                    >
                      Send a test
                    </button>
                  )}
                </div>
              ) : (
                <p>Sign in above to enable notifications.</p>
              )}
            </>
          )}
          {enabled && (
            <output className="account-hint">
              Notifications are on for this device.
            </output>
          )}
          {account.notificationError && (
            <p className="account-error" role="alert">
              {account.notificationError}
            </p>
          )}
        </div>
        <p className="account-hint">
          You can unfollow a teacher or turn off notifications at any time.
        </p>
        <p className="account-hint">
          <Link href="/privacy">Privacy and account data</Link>
        </p>
      </DialogContent>
    </Dialog>
  );
}
