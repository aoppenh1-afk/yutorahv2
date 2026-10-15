# Notifications for new shiurim from followed teachers

Researched October 11, 2026. This is a feasibility assessment; no notification feature or production job was deployed. API findings below come from live, unauthenticated GET requests and the current official OpenAPI specification. Browser findings come from Apple, WebKit, Mozilla, and Google documentation.

## Conclusion

Yes: this website can send notifications when a followed teacher posts a shiur, including to an iPhone Home Screen web app while it is closed. A native App Store app is unnecessary for this feature. The server must detect uploads and send Web Push; the user's device should not be responsible for periodically checking YUTorah.

Follow-up testing found **working upload-ordered RSS feeds**, including a general feed, an audio podcast feed, teacher filters, and a series filter. These substantially improve the detection and free-server feasibility assessment. The feeds expose up to 50 entries in the tested requests. They are suitable for a lightweight central monitor, with teacher-specific reconciliation and explicit gap detection. No public webhook or WebSub subscription mechanism was identified. Search alone still has the date/order problems documented below.

## What works on each device

| User's setup | Background notifications | Requirements and qualifications |
| --- | --- | --- |
| iPhone/iPad, ordinary Safari or Chrome tab | No supported Web Push in that tab under the documented Apple model | Guide the user to a Home Screen web app, or offer email |
| iPhone/iPad, Home Screen web app | Yes, without keeping the app open | iOS/iPadOS 16.4+, explicit notification permission, an active push subscription |
| Android, supported browser such as Chrome | Yes, without keeping the website open | Notification permission; Home Screen installation is generally optional; device restrictions can delay delivery |
| Desktop supported browsers | Yes, without keeping the website tab open | Notification permission; delivery while the entire browser is quit varies with browser/OS/background settings |
| Safari on supported macOS | Yes, even while Safari is not running | Supported Safari/macOS and notification permission |

Sources: [Apple Web Push documentation](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers), [WebKit's iOS/iPadOS support](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [Google's platform behavior FAQ](https://web.dev/articles/push-notifications-faq), and [WebKit's macOS delivery explanation](https://webkit.org/blog/12945/meet-web-push/). Google's FAQ is older; use it for the desktop-versus-Android distinction, not as a current per-browser compatibility matrix. Real-device validation remains necessary.

For an iPhone user, the intended flow is:

1. Add our website to the Home Screen and open it from that icon.
2. Follow teachers in the installed web app, or import/sync existing follows.
3. Tap an explicit “Notify me about new shiurim” control and allow the system prompt.
4. Close the app. Later, a notification can appear and its tap can open the shiur.

Notification permission must follow a user gesture. A Home Screen icon alone does not grant permission. Alerts integrate with the Lock Screen, Notification Center and Focus. Focus, permissions, connectivity and device behavior affect delivery timing; this is not a guaranteed instantaneous channel. [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

On iOS 26, websites added to the Home Screen open as web apps by default; users can turn off “Open as Web App” to save a browser bookmark instead. Earlier supported iOS versions need the site configured for standalone web-app behavior. Provide a manifest, app icons and a stable app identity for a consistent experience across versions. [Safari 26 release explanation](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [Apple's current installation instructions](https://support.apple.com/en-hk/guide/iphone/iphea86e5236/ios).

## YUTorah API evidence

The [official Swagger UI](https://api.yutorah.org/swagger/index.html) links to the [OpenAPI specification](https://api.yutorah.org/swagger/v1/swagger.json). Requests below succeeded without a login, cookie or API key. This verifies present access, not a contractual rate limit or service guarantee.

| Request | Live result | Implication |
| --- | --- | --- |
| `https://api.yutorah.org/search/get?searchTerm=&teacherID=81959&start=1` | HTTP 200; 30 records; 1,648 total | Teacher-specific discovery works |
| Same request with `start=2` | HTTP 200; next 30 records; no overlap in the sampled pair | `start` is a page number, not a record offset |
| Equivalent `https://www.yutorah.org/api/search/get?...` | Same sampled teacher results | Existing project API host also works |
| `https://api.yutorah.org/homepage/details` and website equivalent | HTTP 200; homepage response includes 10 recent uploads in the sample | Useful fast signal, too small to guarantee coverage |
| Search with added `sort_by=shiurdatesubmitted desc`, `sort=shiurdatesubmitted desc`, `getFacets=false` | Byte-identical response to the baseline teacher search | These added parameters did not change this response; do not assume upload sorting |
| `https://api.yutorah.org/shiur/details?shiurID=1191312` | HTTP 200; `shiurDateSubmitted: null` | Details did not recover the upload timestamp for this sample |
| Website `/Search/GetSearchResults` with an upload sort | HTTP 403 Cloudflare challenge | Existing website-search integration is unsuitable as the sole unattended monitor from this environment |

Every sampled teacher result belonged to teacher 81959. Match IDs, not display names. Keep all teacher IDs when a shiur has multiple teachers; the website's general `normalize()` currently keeps only the first teacher for its display model.

### The concrete date problem

Shiur **1191312, “Bechorot 10,” Rabbi Eric Goldstein**:

- Homepage: recording date `2026-09-28T00:00:00`, submitted date `2026-10-11T13:35:08.457`.
- Search: recording date **and** submitted date `2026-09-28T04:00:00Z`.
- Details: recording date September 28; submitted date `null`.

This was newly uploaded on October 11 according to the homepage, but an October 11 submitted-date cutoff on search would exclude it. The homepage timestamp has no explicit timezone; retain its raw value and confirm the convention before relying on exact timestamp cutoffs.

Search pages followed descending recording dates in the sample, with submission dates moving both forward and backward. One page-two item recorded August 10 had a September 28 submission timestamp, following an August 10 item submitted August 23. Search order is therefore unsuitable for stopping at an upload-time boundary. Added sort parameters were ignored in the sampled response. This is observed behavior, not a documented guarantee of the default ordering.

The specification's search parameters include `searchTerm`, `start`, `teacherID`, `subcategoryID`, `seriesID`, `locationID` and `collectionID`. It does not document upload sorting, a “since last upload” cursor, webhooks, or notification subscriptions. No rate limit is specified there. An undocumented/private facility could still exist; do not claim YUTorah has no such facility anywhere.

The first teacher-podcast requests failed because the old `/rss/RssAudioOnly/teacher/...` route redirects to an **HTTP** `/rss/RecentAudioShiurim?...` URL. The HTTP destination timed out from this environment. Follow-up tests requested the destination directly over **HTTPS**, which returned valid XML with HTTP 200. The classic-site equivalent remained 404. The original failure therefore did not establish that current feeds were unavailable.

Evidence is saved locally under `work/notifications-research/`: `swagger.json`, `home-summary.json`, `additional-probes.json`, `date-order-probes.json`, `rss-probes.json` and the initial responses. These are research artifacts excluded from Git. This was a small live sample, not a sustained polling or upload-to-alert latency test.

## Follow-up: verified upload feeds and webhooks

Live checks on October 11, 2026 returned HTTP 200 without authentication for:

| Feed | HTTPS path/query on `www.yutorah.org` | Result |
| --- | --- | --- |
| General recent shiurim | `/rss/RecentShiurim?organizationId=301&numberOfRssResults=50` | 50 entries, 46,007 decoded bytes |
| General teacher feed | Same path plus `teacherID=81959` | 50 entries, 39,096 decoded bytes |
| Recent audio podcast | `/rss/RecentAudioShiurim?organizationId=301&numberOfRssResults=50` | 50 entries, 38,647 decoded bytes |
| Audio teacher feed | Same audio path plus `teacherID=81959` | 50 entries, 31,694 decoded bytes |
| Audio series feed | Same audio path plus `seriesID=4009&numberOfRssResults=20` | 20 entries |

Direct examples: [general feed](https://www.yutorah.org/rss/RecentShiurim?organizationId=301&numberOfRssResults=50), [teacher feed](https://www.yutorah.org/rss/RecentShiurim?organizationId=301&teacherID=81959&numberOfRssResults=50), [audio feed](https://www.yutorah.org/rss/RecentAudioShiurim?organizationId=301&numberOfRssResults=50).

`numberOfRssResults=1` returned one audio entry; 20 returned 20; 50 returned 50. Requests for 100 returned **50**, both for a teacher audio feed and the global general/audio feeds. Fifty is an observed cap, not a published service contract. Default feeds returned 10 entries.

RSS `pubDate` solves the sampled old-recording problem: shiur 1191312 appears with `Sun, 11 Oct 2026 13:35:08 GMT`, matching the homepage's October 11 submitted wall-clock time to the second, rather than search's September 28 date. The 50-entry audio samples were ordered by descending publication timestamp, with unique shiur IDs. The general feed's teacher IDs matched the audio teacher sample. New general-feed entries 1191328 and then 1191329 appeared during the investigation, demonstrating updates between reads, not a controlled upload-latency SLA. The upstream timezone convention has not been independently validated; use observed IDs for identity instead of relying solely on date cutoffs.

The general feed contains title, link, author, description, GUID and publication date, without podcast enclosures. Its text fields contain escaped literal `<![CDATA[...]]>` wrappers. An XML parser first decodes entities; strip that exact outer wrapper before using the value. Validate the resulting link and extract the numeric shiur ID. Treat descriptions as untrusted HTML. Teacher names are present, but numerical teacher IDs are not; fetch metadata once for each genuinely new ID and match all `shiurTeachers[].teacherID` values. Two verified details responses were 1,758 and 1,918 decoded bytes. The general route is preferable for discovery, but coverage of every video/article/file type has not been independently established by this sample.

No usable RSS pagination was found. `page=2` and `start=2` returned the same audio head, not subsequent entries. A general `page=2` returned 49 of the previous head's 50 IDs plus a newly uploaded head entry; it did not act as page two. Do not treat these parameters as archive pagination.

For webhook discovery, a fresh official OpenAPI download contained 50 paths, no `webhooks` section, no callback definitions, and no subscription/notification/feed routes. The only upload path is POST `/shiur/upload`, which accepts uploads; it is not a mechanism for subscribing to publication events. No POST requests or registrations were made. Tested feeds advertised no WebSub hub in XML or HTTP `Link` headers. Public searches identified no official webhook instructions. This supports **“no publicly discoverable webhook verified”**, not “YUTorah cannot offer a private webhook.”

## Recommended detection approach

1. Poll the **single general 50-entry feed every five minutes**, regardless of how many users follow teachers. Persist seen IDs. Initialize the first successful read as a baseline without sending archive alerts. A user's initial teacher-feed baseline must likewise avoid historical notifications.
2. Fetch numeric teacher metadata once per new shiur, cache it, and fan out to subscriptions indexed by teacher ID. Never fetch the feed separately for every subscriber, and never download lecture audio or generate notes as part of notification detection.
3. Reconcile feeds for distinct followed teachers every few hours, staggered across runs. For 100 distinct teachers, one pass every six hours adds only 400 RSS fetches per day. Raise the cadence for unusually active teachers if measured bursts justify it.
4. Detect a possible gap when a previously initialized feed has no overlapping known IDs. More than 50 posts between successful global checks, an outage, delayed visibility or removals can exhaust the feed window. Teacher feeds provide a wider time horizon, but an outage containing more than 50 uploads for one teacher can exhaust those too. Use bounded, resumable catalog reconciliation when necessary; an initial gap cannot be repaired by requesting RSS page two. Do not silently certify complete coverage.
5. Store durable events and delivery jobs with uniqueness on subscription + shiur ID. Recheck current follows before sending, retry transient failures, remove expired endpoints, bundle bursts, and retain a short delivery ledger rather than unbounded notification history. Persist detection and jobs together.
6. Set queue/concurrency limits and backoff for upstream errors. Alert on stale detector progress and preserve work through restarts. Confirm acceptable polling rates with YUTorah before materially scaling the monitor.

This design can provide ordinary prompt notifications with modest work. It still cannot prove that every upload arrives within five minutes under bursts, downtime or upstream indexing delays. Numeric high-water IDs alone do not establish complete coverage. The initial API-only full-scan proposal is superseded by this RSS-first approach; full catalog scans are for exceptional reconciliation.

## Follow-up: free-server load measurements

The current local host reports eight logical CPUs and about 15.6 GiB total memory. The notes-worker runtime exists here. One snapshot showed load averages around 7.2 and 2.13 GiB available memory later in the measurement; it is already busy, so avoid adding large concurrent crawls. These are instantaneous host observations, not reserved capacity or a managed-host uptime guarantee.

On this host, Python's standard XML parser plus link/date extraction took a median **0.397 ms CPU** for the 50-entry general feed, measured over 200 iterations. A separate 500-message synthetic Node crypto benchmark exercised P-256 ECDH, HKDF, AES-GCM and an ES256 VAPID signature per message: mean **0.292 ms CPU/message**, median 0.203 ms, p95 0.514 ms. The benchmark process used about **63.5 MiB RSS**. It did not contact push services, use a real subscription, run database queries or measure a complete application's memory; it is a component-cost check, not an end-to-end capacity test. VAPID tokens can normally be reused for a bounded period, so signing per message is conservative for that component.

Raw HTTP body measurements with gzip explicitly requested:

| Sample | Compressed body | Decoded XML | Result count |
| --- | ---: | ---: | ---: |
| General global RSS | 7,882 bytes | 46,007 bytes | 50 |
| General teacher RSS, teacher 81959 | 4,172 bytes | 39,096 bytes | 50 |
| Audio global RSS | 9,199 bytes | 38,647 bytes | 50 |
| Audio teacher RSS, teacher 81959 | 4,806 bytes | 31,694 bytes | 50 |

No ETag, Last-Modified or cache-control header was present in these samples. Budget for downloading the whole feed; do not assume unchanged feeds cost zero bandwidth. No media enclosures were downloaded.

| Monitoring scenario | RSS requests/day | Requests/30 days | Compressed RSS bodies/30 days |
| --- | ---: | ---: | ---: |
| One global feed every 5 minutes | 288 | 8,640 | 68.1 MB |
| One global feed every 15 minutes | 96 | 2,880 | 22.7 MB |
| 100 distinct teacher feeds, each every 15 minutes | 9,600 | 288,000 | 1.20 GB |
| 100 distinct teacher feeds, each every 5 minutes | 28,800 | 864,000 | 3.60 GB |

These are arithmetic scenarios using this teacher's measured body size as the teacher average, a 30-day month, and unchanged sample sizes. Headers/TLS, retries, metadata lookups, database traffic and push delivery are additional. Responses vary by teacher and content. The recommended global five-minute poll plus 100 teachers reconciled every six hours totals **688 RSS requests/day and about 118 MB of compressed RSS bodies/month** under those assumptions.

Sending to subscribers is a separate scaling factor. For example, 1,000 users receiving two eligible posts each per day on one installation produce 2,000 pushes/day. At an assumed 1 KB body, that is 60 MB/month before transport overhead, plus about 0.6 seconds/day of crypto CPU using the local benchmark's mean. Multiple installations, popular teachers, retries and large bursts increase deliveries. Database fan-out and network concurrency, rather than cryptography, are likely to dominate at larger scale; that is an inference, not a full load-test result.

## Free hosting constraints and deployment choice

Repository records identify the public site as Vercel Hobby, an existing Cloudflare Workers Free/D1 content service, and the local managed notes VM. The title search database is recorded as Neon Free; notes use TiDB Starter with a zero spending limit. This follow-up checked current published platform limits, not live account dashboards or remaining allowances. Do not put notification state into the title index simply because that database exists; its recorded 406 MiB size is already substantial against its enforced 512 MiB limit, and another transcript Neon project previously exhausted transfer.

- **Vercel Hobby:** built-in cron expressions are limited to once a day, so a native five-minute cron is unavailable. Current included monthly function usage is 1 million invocations, 4 CPU-hours and 360 GB-hours of provisioned memory. A central 8,640-run monthly job is small against the invocation allowance; actual CPU/memory use and existing website traffic still count. [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Hobby allowance](https://vercel.com/docs/plans/hobby).
- **Existing VM:** a separate low-concurrency polling/sending process can use local cron without Vercel's scheduling restriction. Its outbound networking successfully fetched the feeds, and incoming ports are not required if it reads subscriber preferences/jobs from hosted storage. This is the simplest option using present infrastructure. The documented full-host replacement/startup recovery gap remains relevant: if this VM stops, alerts stop until recovery.
- **Cloudflare Workers Free:** supports Cron Triggers, with five triggers/account, 100,000 daily Worker requests, 10 ms CPU per invocation including scheduled work, 50 external subrequests/invocation and 128 MB memory. These are account/shared execution limits, not one unlimited cron budget. Use it as a small scheduler invoking a protected Vercel job, or validate carefully bounded native work; do not put an unbounded scan or thousands of encrypted push sends into one invocation. A VM Node benchmark does not certify Workers/WebCrypto performance. [Cron configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
- **D1 Free:** 5 million rows read/day and 100,000 rows written/day, shared across the account, with 5 GB aggregate storage; individual Free databases are limited to 500 MB. Store small indexed preferences, subscription endpoints, event IDs and a bounded outbox in a separate schema/database as appropriate. Query subscribers only for new matching posts, avoid rewriting all seen records every poll, and include index/queue writes in the budget. At 2,000 deliveries/day, a simple insert + completion update is 4,000 logical row mutations before indexes/retries, rather than 2,000 total billed writes. Inspect actual D1 row metrics in a pilot. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- **TiDB Starter:** the documented free allowance is 5 GiB row storage and 50 million Request Units/month per qualifying instance. RUs are not request counts. Notes already consume some of that instance's allowance; notification roles/tables and queue mutations would need their own design and measured budget. [TiDB quotas](https://docs.pingcap.com/tidbcloud/serverless-limitations/).

**Recommendation:** the measured RSS-first workload should be a small addition to the existing free VM at modest subscriber volume. Keep the website's subscription controls on Vercel and preferences in small durable hosted tables, run the poller/sender separately with one or two outbound lanes, and cap retries/fan-out. If independence from VM uptime is more important, use a tiny Cloudflare cron trigger with bounded Vercel jobs and a durable queue. No paid plan is inherently required by these measured workloads; current account headroom and real push delivery remain launch checks. Heavy repeated full-library scans or per-user polling would change that conclusion.

Follow-up evidence is under `work/notifications-research/`, including `feed-redirect-probes.json`, `resolved-feed-probes.json`, `expanded-feed-probes.json`, `feed-cap-probes.json`, `general-feed-probes.json`, saved XML, `feed-load-measurements.json`, `push-crypto-measurements.json`, and `general-load-scenarios.json`. No scheduler, database schema, account plan, subscriber record or production notification was changed.

## What this project would need

The current app already has teacher follows and a teacher-filtered feed, but not the background notification system:

- `lib/library.ts` and `lib/learning.ts` store follows in `localStorage`; the server does not maintain subscriber preferences.
- `app/api/feed/route.ts` fetches bounded discovery pages for up to eight sources on request. It is a foreground feed, not a persistent upload monitor.
- `app/layout.tsx` has a site icon but no configured web-app manifest. No service-worker registration, push subscription UI or push-sending dependency was found in the website source.
- The transcription worker has polling for operator-selected catalogs in `apps/worker/src/selections.ts`. Those selections and processing limits are separate from public users' follows; it is not a ready notification backend.

Add an HTTPS web-app setup, manifest/icons, a cross-browser service worker, an explicit permission control, subscription registration and removal endpoints, durable teacher preferences, a scheduled detector, and a delivery queue/sender. Use standard Web Push with VAPID identification and encrypted messages. No Apple Developer Program membership is required. Every Safari push must produce a visible notification; do not use silent pushes as a background polling mechanism. [Apple implementation requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).

Accounts are optional for an initial version: store teacher preferences against an anonymous installation/subscription with an authenticated installation credential. Accounts are useful for restoring preferences and synchronizing devices. A push endpoint is device/browser-installation specific, so register each installation and protect subscription management. Do not assume existing Safari-tab local storage automatically becomes the Home Screen app's storage; provide an explicit migration/sync path or let users follow teachers inside the installed app.

For newer Apple platforms, use **Declarative Web Push** where supported, with service-worker handling as a compatible fallback. It lets the platform display the notification even if service-worker processing fails or the registration is removed. Apple documents support in iOS/iPadOS 18.4+ Home Screen apps and Safari 18.5+ on macOS. This improves the delivery implementation; it does not solve YUTorah upload discovery. [WebKit explanation](https://webkit.org/blog/16535/meet-declarative-web-push/), [Apple WWDC25](https://developer.apple.com/videos/play/wwdc2025/235/).

An always-available scheduled backend is required. A suspended/offline processing VM cannot detect new uploads while it is unavailable. An existing hosted scheduler/worker could run this independently; hosting selection and account quotas were not assessed here.

## Validation before launch

Use a real iPhone and Android device to test permission granted and denied, app/tab closed, device locked, notification tap navigation, Focus, unsubscribe, expired subscriptions and multiple installations. Verify detection against an upload of an old recording, more than one page of uploads, a detector outage, and an upstream index delay. These are proposed acceptance checks; they were not executed because no push feature was built in this research.
