# Teacher notifications

Google sign-in syncs teacher follows across devices. Notifications are opt-in
on each device. The account library also syncs saved shiurim, playlists, listening
progress, and topic, series, venue and collection follows. Browsing and local
follows work without signing in. See [Account library sync](account-library-sync.md).

The dedicated Supabase Free project is `spdyqnkbuvszhnethmke`, named
`yutorah-notifications`. Its dashboard is
https://supabase.com/dashboard/project/spdyqnkbuvszhnethmke.
Google OAuth uses the separate `yutorah-notifications` Google Cloud project,
owned by `yutorahv2@gmail.com`. The website remains on Vercel.
This notification service uses no Cloudflare Worker, paid plan, or billing account.

## Turn on notifications

Open Settings from the bottom of the desktop sidebar or the profile button on
mobile. Continue with Google and turn on New shiur alerts. Each device has its
own switch and test button. Under Your Rebbeim, choose which followed teachers
can send alerts. Turning off a teacher's alerts keeps the follow and clears
pending notifications. Turning them back on does not replay muted uploads.
Signing out unsubscribes that device.

Default speed in Settings starts each new shiur at the selected pace and syncs
with the account library. Changing speed in the player applies to that recording without
replacing the default.

On iPhone or iPad, use iOS/iPadOS 16.4 or later. Open the website in Safari,
choose Share, then Add to Home Screen. Open that installed app, sign in, and
turn on New shiur alerts. Accept the system permission prompt. The website
does not need to stay open for push notifications to arrive. Notifications
still depend on the device's connection, permission, and Focus settings.

## Detecting new shiurim

Supabase Cron runs `dispatch_notification_worker` at `0 * * * *`, at the
start of every hour in UTC. It calls the `notify-shiurim` Edge Function
with a private scheduler secret from Supabase Vault. No open browser is needed.

The worker scans each followed teacher once per cycle, shared by all followers.
It reads the teacher's recent audio RSS feed, then paginates the complete search
catalog. Shiur IDs determine whether an upload is new. Recording dates do not:
an old recording uploaded today still qualifies. The catalog scan also catches
videos and audio omitted from the RSS feed.

A teacher's first complete scan records a silent baseline. It does not notify
about their existing library. New follows and new devices also complete one
scan quietly before receiving alerts, including when a teacher's last scan
was long ago. Allow a first scheduled scan to
complete before expecting new-upload alerts. Large catalogs resume from a saved
page through bounded continuation requests.

Deliveries are stored once per device, teacher, and shiur. The worker checks that
the account still follows the teacher and has enabled their alerts before
sending. Expired push endpoints
are removed. Temporary failures retry, with at most five attempts; the next
hourly run picks up retries that are due. Notification tags collapse repeated
delivery of the same shiur on a device. Pending deliveries expire after 30 days.

Cloud follow changes use a local per-account outbox. Network failures leave
the change pending, with a visible retry action. Refreshing, reconnecting, and
returning to the app retry sync. Switching accounts replaces teacher follows
with the new account's cloud state.

## Credentials and deployment

`lib/account-config.ts` contains only the public Supabase URL, anon key, and
VAPID public key. Row-level security protects each account's follows and device
records. Only authenticated RPCs can change them. Scheduler, observation, and
delivery functions are restricted to the service role.

The service-role key, database password, VAPID private key, scheduler secret,
and OAuth client secret belong outside the repository. On the setup computer,
private files are under `~/.config/yutorah/`, readable only by the owner.
Never rotate VAPID keys during a routine redeploy: existing device subscriptions
depend on them.

Google's Web application client uses origin `https://yutorah.vercel.app` and
redirect URI `https://spdyqnkbuvszhnethmke.supabase.co/auth/v1/callback`.
Supabase redirects back to `https://yutorah.vercel.app/auth/callback`.
The login requests only `openid email profile`. Auth uses PKCE and the official
Supabase Auth SDK. The callback handles the SDK's `sb_flow_id` parameter.

Deploy migration `202610110007_teacher_notification_preferences.sql` and the
updated Edge Function before releasing the new settings UI. The migration keeps
existing teacher alerts enabled and supports older clients' follow RPC calls.

The deployment script applies each SQL migration once and rejects edited
migrations. It deploys the tracked Edge Function, installs push secrets, sets
the Vault scheduler credentials, and verifies the hourly cron job.

```sh
export NOTIFICATION_CREDENTIALS_FILE="$HOME/.config/yutorah/supabase-notifications-credentials.json"
export SUPABASE_SESSION_FILE="$HOME/.config/yutorah/supabase-deploy-session.json"
export GOOGLE_OAUTH_CREDENTIALS_FILE="$HOME/.config/yutorah/google-notifications-oauth.json"
npm run notifications:deploy
npm run notifications:verify
```

For unattended deployment, use a private `SUPABASE_ACCESS_TOKEN` instead of a
short-lived dashboard session. Deployment does not change the billing plan.
The optional Google credentials file configures the provider; omitting it keeps
the existing Google client ID and private secret unchanged.

## Checks and limits

`npm run test:notifications` checks follow merging, account switching, API and
RSS parsing, delivery retry rules, endpoint validation, and service-worker
behavior. Set `NOTIFICATION_TEST_DATABASE_URL` to an empty, disposable PostgreSQL
database to also run the alert preference integration test. That test rolls
back its schema, roles, and fixtures when finished.

`notifications:verify` uses disposable users to verify live database
permissions, silent baselines, deduplication, unfollowing, and device cleanup.
It deletes its fixtures when finished. Deno checks the Edge Function separately:

```sh
deno check --no-config --node-modules-dir=manual supabase/functions/notify-shiurim/index.ts
```

The app allows 100 teacher follows and another 100 topic/series follows.
The database allows up to ten notification devices per account. Web-push
endpoints are limited to Google's, Mozilla's, and Apple's push services.

Supabase's Free plan has usage limits and may pause inactive projects. Free
operation is not a guarantee of uninterrupted service at arbitrary scale.
Monitor the project's Database and Edge Functions usage in the dashboard.
No paid upgrade is enabled automatically. Catalog scans use one request per
30 shiurim per followed teacher; popular teachers can require hundreds of
pages. One hour is the polling interval, not an instant-delivery guarantee.

Operational state is in `notification_worker` and `teacher_poll_state`.
Inspect `last_result`, `last_finished_at`, `next_page`, and `last_error` to check
progress. The initial live catalog check recorded 1,648 shiur IDs, completed
its continuation requests, and queued zero old-upload notifications.
Physical iPhone permission and delivery checks require an actual device.
