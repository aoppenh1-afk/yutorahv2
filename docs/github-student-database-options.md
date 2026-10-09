# GitHub student database options

Checked October 9, 2026 against current official offer and provider pages. The
user confirmed an approved GitHub Student Developer Pack. Heroku separately
requires applicants to be at least 18; the user's age and redemption status were
not checked. No account, database, or paid resource was created.

## GitHub Pro

[GitHub Pro's listed benefits](https://docs.github.com/en/get-started/learning-about-github/githubs-plans#github-pro)
include repository features, Actions minutes, Packages storage, and Codespaces
usage. It does not include a hosted application database. Student partner offers
come through the Student Developer Pack, rather than Pro alone. Codespaces is a
development environment, not the recommended live database for this website.

## Heroku student credits and PostgreSQL

The [Heroku student offer](https://www.heroku.com/github-students/) provides
$13 platform credit each month for 24 months. Credits apply to Heroku Postgres
and other first-party Heroku products, but not third-party add-ons. Unused credit
does not roll over. Redemption requires a credit/debit card and age 18 or older;
usage beyond the monthly credit is charged to the card.

[Current PostgreSQL pricing](https://www.heroku.com/pricing/) lists Essential-1
at $9/month with 10 GB storage and 20 concurrent connections. The $13 student
credit can therefore cover this database alone while the offer remains active.
This is a fixed monthly database plan, not a Request Unit allowance like TiDB.
Compute, connection, and storage limits still bound the work it can handle.
Other Heroku resources share the same $13 credit; adding a $5 Eco dyno would put
$9 database plus $5 dyno at $14/month. The website and generation VM need not
move to Heroku to use its PostgreSQL database.

[External SSL connections are supported](https://devcenter.heroku.com/articles/connecting-heroku-postgres).
The VM can write outward to the database without a public IP. The website can
read through its hosted server, independent of VM uptime. External clients need
appropriate TLS certificate configuration for the Essential tier's AWS RDS CA.
Cloudflare [documents PostgreSQL access through Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/);
its [Free allowance](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
and Workers request/CPU limits are separate from the Heroku credit. The complete
Cloudflare-to-Heroku path was not tested against a live database in this research.

The current notes-only estimate is 1.72 GB compressed notes for 430,000 shiurim,
before metadata, indexes, revisions, and backups. That fits within 10 GB with
substantial projected headroom. It remains an extrapolation from eight short
lectures. Store one compressed active note per shiur as PostgreSQL `bytea`; retain
source and generator hashes. Full-library search requires a separate sizing test.

PostgreSQL preserves the engine used by the existing worker and website database
adapter, reducing engine migration work compared with TiDB. Heroku documents
[pg_trgm, pgcrypto, and unaccent support](https://devcenter.heroku.com/articles/heroku-postgres-extensions-postgis-full-text-search).
This does not make the current transcript-linked notes worker into a notes-only
worker. Its source storage, queue, publication, and official reader still need
adaptation as described in the [notes-only verification](tidb-notes-only-verification.md).

[Essential tier limitations](https://devcenter.heroku.com/articles/heroku-postgres-plans)
include 99.5% expected monthly uptime, unannounced maintenance, no additional
credentials, and no high-availability follower. Its 20-connection cap needs a
budget across the worker and concurrent website readers; per-process pools alone
do not enforce an account-wide connection cap. Review the existing database-role
configuration before cutover, rather than assuming multiple credentials work.

Assessment: Heroku is the strongest verified Student Pack offer to evaluate for
retaining PostgreSQL and hosting notes with no out-of-pocket database cost during
its 24-month credit period. It is not a permanently free or hard-capped service.
Confirm offer activation and perform a real compressed-note upload/read/recovery
pilot before replacing any existing database.

## Other current student offers

- [Appwrite Education](https://appwrite.io/education) provides Pro resources for
  six months. The current [GitHub listing](https://education.github.com/pack#appwrite)
  specifies two projects with Pro-equivalent limits. Older indexed search excerpts
  saying "throughout your student career" conflict with both current live pages;
  use the current six-month term. This needs an Appwrite API/storage integration
  and is a temporary option, not a durable free replacement. Its exact account
  resource limits and overage handling were not tested.
- [Azure for Students](https://learn.microsoft.com/en-us/azure/education-hub/azure-dev-tools-teaching/azure-students-program)
  provides $100 credit for 12 months and can be renewed while eligible. Service
  charges draw from that credit; it does not establish that an arbitrary managed
  database is free all year. General Azure PostgreSQL free-account offers should
  not be assumed to apply to every Student subscription. Azure's Education
  [FAQ](https://learn.microsoft.com/en-us/azure/education-hub/faq) describes the
  permitted educational/development uses and subscription cancellation when
  credit is exhausted without upgrading. No live subscription entitlement,
  regional quota, or database SKU was checked.
- [MongoDB's Student Pack offer](https://education.github.com/pack#mongodb)
  provides $50 Atlas credit. This is a finite credit, not an unlimited ongoing
  database allowance, and would require a different storage adapter. No MongoDB
  database or workload was tested.

Student Pack eligibility does not mean every offer was already redeemed or is
still unused. [Partner terms](https://docs.github.com/en/education/about-github-education/github-education-for-students/github-terms-and-conditions-for-the-student-developer-pack)
can limit repeat redemption and change independently of GitHub verification.
TiDB Starter remains the previously verified option without a fixed student-credit
expiry, subject to its free storage/RU quotas and the outstanding live pilot.
