'use client';
import {
  Bell,
  BellOff,
  UserRound,
  Loader2,
  Gauge,
  Users,
  Check,
  ChevronDown,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { useAccount } from '@/lib/use-account';
import type { Follow } from '@/lib/learning';
import { PLAYBACK_SPEEDS } from '@/lib/playback-speed';
import Link from 'next/link';
import { Avatar } from './ui';

function NotificationSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="notification-switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function AccountPanel({
  account,
  open,
  onOpenChange,
  teachers,
  defaultSpeed,
  onSpeedChange,
  onTeacherNotificationsChange,
  onBrowseTeachers,
}: {
  account: ReturnType<typeof useAccount>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teachers: Follow[];
  defaultSpeed: number;
  onSpeedChange: (speed: number) => void;
  onTeacherNotificationsChange: (teacher: Follow, enabled: boolean) => void;
  onBrowseTeachers: () => void;
}) {
  const enabled = !!account.subscriptionId;
  const selected = teachers.filter(
    (teacher) => teacher.notificationsEnabled !== false,
  ).length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="account-dialog">
        <DialogHeader className="settings-heading">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="settings-body">
          <section
            className="account-section account-profile-section"
            aria-label="Account"
          >
            <div className="account-identity">
              <span className="profile-avatar">
                <UserRound size={23} />
              </span>
              <div>
                <strong>
                  {account.user?.user_metadata?.full_name ||
                    (account.user ? 'Your account' : 'Your Torah library')}
                </strong>
                <p>
                  {account.user?.email ||
                    'Sign in to sync your library across devices.'}
                </p>
              </div>
              {account.user ? (
                <button
                  className="account-text-button"
                  disabled={account.loading || account.syncing}
                  onClick={() => void account.signOut()}
                >
                  Sign out
                </button>
              ) : null}
            </div>
            {!account.user && (
              <button
                className="account-primary account-google"
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
            )}
            {account.user && (
              <output className="account-sync-status">
                {account.error ? (
                  'Library could not sync'
                ) : account.syncing ? (
                  <>
                    <Loader2 size={13} className="animate-spin" /> Syncing…
                  </>
                ) : account.pendingCount ? (
                  `${account.pendingCount} changes waiting to sync`
                ) : (
                  <>
                    <Check size={13} /> Library synced
                  </>
                )}
              </output>
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
          </section>

          <section
            className="account-section"
            aria-labelledby="settings-playback"
          >
            <h3 id="settings-playback">
              <Gauge size={18} /> Playback
            </h3>
            <div className="settings-row">
              <div>
                <span id="default-playback-speed-label">Default speed</span>
              </div>
              <Select
                value={String(defaultSpeed)}
                onValueChange={(value) => {
                  if (value) onSpeedChange(Number(value));
                }}
              >
                <SelectTrigger
                  className="settings-speed-trigger"
                  aria-labelledby="default-playback-speed-label"
                >
                  <SelectValue>{defaultSpeed}×</SelectValue>
                </SelectTrigger>
                <SelectContent
                  className="settings-speed-menu"
                  align="end"
                  sideOffset={8}
                  alignItemWithTrigger={false}
                >
                  {PLAYBACK_SPEEDS.map((speed) => (
                    <SelectItem key={speed} value={String(speed)}>
                      <span>{speed}×</span>
                      {speed === 1 && <small>Normal</small>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <section
            className="account-section"
            aria-labelledby="settings-notifications"
          >
            <h3 id="settings-notifications">
              <Bell size={18} /> Notifications
            </h3>
            <div className="settings-row">
              <div>
                <strong>New shiur alerts</strong>
                <p className="account-hint">
                  {enabled ? 'On for this device' : 'Off for this device'}
                </p>
              </div>
              {account.notificationBusy ? (
                <Loader2
                  size={19}
                  className="animate-spin"
                  aria-label="Updating notifications"
                />
              ) : (
                <NotificationSwitch
                  checked={enabled}
                  disabled={
                    !account.user ||
                    account.loading ||
                    account.syncing ||
                    (!enabled && account.support !== 'supported')
                  }
                  label="New shiur alerts on this device"
                  onChange={() =>
                    void (enabled
                      ? account.turnOff()
                      : account.enableNotifications())
                  }
                />
              )}
            </div>
            {!account.user && (
              <p className="notification-note">Sign in to enable alerts.</p>
            )}
            {account.support === 'iphone-install' ? (
              <details className="notification-help">
                <summary>
                  Enable alerts on iPhone or iPad <ChevronDown size={14} />
                </summary>
                <ol>
                  <li>Open YUTorah in Safari.</li>
                  <li>Tap Share, then Add to Home Screen.</li>
                  <li>Open the app, sign in, and turn on alerts.</li>
                </ol>
                <p className="account-hint">
                  Requires iOS or iPadOS 16.4 or later.
                </p>
              </details>
            ) : account.user && account.support === 'unsupported' ? (
              <p className="notification-note">
                Notifications aren’t supported in this browser.
              </p>
            ) : account.user && account.support === 'blocked' ? (
              <p className="notification-note">
                Allow notifications in your browser settings to turn on alerts.
              </p>
            ) : null}
            {enabled && (
              <button
                className="account-text-button notification-test"
                disabled={account.notificationBusy}
                onClick={() => void account.testNotification()}
              >
                Send a test notification
              </button>
            )}
            {account.notificationError && (
              <p className="account-error" role="alert">
                {account.notificationError}
              </p>
            )}
          </section>

          <section
            className="account-section teacher-settings-section"
            aria-labelledby="settings-teachers"
          >
            <div className="teacher-settings-heading">
              <h3 id="settings-teachers">
                <Users size={18} /> Your Rebbeim{' '}
                <span className="settings-count">{teachers.length}</span>
              </h3>
              <span className="account-hint">
                {teachers.length ? `${selected} enabled` : ''}
              </span>
            </div>
            {teachers.length ? (
              <>
                <div className="teacher-notification-list">
                  {teachers.map((teacher) => (
                    <div className="teacher-notification-row" key={teacher.id}>
                      <Avatar src={teacher.image || ''} name={teacher.name} />
                      <div className="teacher-notification-name">
                        <strong dir="auto">{teacher.name}</strong>
                        <span>
                          {teacher.notificationsEnabled === false ? (
                            <>
                              <BellOff size={12} /> Alerts off
                            </>
                          ) : (
                            <>
                              <Bell size={12} /> Alerts on
                            </>
                          )}
                        </span>
                      </div>
                      <NotificationSwitch
                        checked={teacher.notificationsEnabled !== false}
                        label={`New shiur alerts from ${teacher.name}`}
                        disabled={account.loading}
                        onChange={(checked) =>
                          onTeacherNotificationsChange(teacher, checked)
                        }
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="teacher-settings-empty">
                <Users size={26} />
                <strong>No teachers followed yet</strong>
                <p>Follow a teacher to choose their alerts.</p>
                <button
                  className="account-secondary"
                  onClick={onBrowseTeachers}
                >
                  Find teachers
                </button>
              </div>
            )}
          </section>
        </div>
        <footer className="settings-footer">
          <span>{account.user ? 'Your library syncs across devices.' : 'Sign in to sync your library across devices.'}</span>
          <Link href="/privacy">Privacy</Link>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
