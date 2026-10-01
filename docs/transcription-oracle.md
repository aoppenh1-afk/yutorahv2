# Oracle Cloud Free Tier deployment

For the current teacher/series GUI, installation, and notes workflow, use [the transcription operator guide](transcription-operator.md). Automated discovery is now restricted to enabled selections and their recording budgets. The CLI `sync-now` and `backfill` commands use the same selections. For an explicitly enqueued commissioning recording, run `run --unscoped` with the regular worker stopped; the normal worker claims selected-source jobs only.


Use this page for Oracle-specific VM and networking setup, then follow
[the complete installation checklist](transcription-setup.md). The website stays
on its existing host; this VM runs PostgreSQL, the transcription worker, and the
authenticated search service behind Caddy.

## 1. Identify your current VM

In Oracle Console, open **Compute → Instances → your instance** and check its
shape, image, memory allocation, and public IP. Over SSH, run:

```sh
uname -m
cat /etc/os-release
free -h
df -h /
```

| Result | Meaning | Deployment path |
| --- | --- | --- |
| `aarch64` | ARM64, normally `VM.Standard.A1.Flex` | The Node and ACP installers select ARM64 automatically. Run `probe` before authentication. Real ARM execution still requires commissioning on your VM. |
| `x86_64` | AMD/Intel, including `VM.Standard.E2.1.Micro` | Installers select x86-64. The 1 GB Micro instance is below the proposed 4 GB starting allocation; use an A1 instance for this stack if available. |
| Ubuntu 24.04 | Target OS for these commands | Follow the installation checklist directly. |
| Oracle Linux (`ID=ol`) | Different package manager and PostgreSQL setup | The checklist uses Debian/Ubuntu packages. Prepare an Ubuntu 24.04 instance for this documented path; preserve an existing VM and its data before migrating. Do not run the `apt-get` commands on Oracle Linux. |

For a new instance, use **Canonical Ubuntu 24.04**, **Ampere A1 Flex**, **2 OCPUs**,
and **8–12 GB RAM**, with a 50 GB boot volume if your remaining allowance permits.
Start `ACP_CONCURRENCY=1`. This is an initial sizing recommendation, not an ARM
benchmark. Oracle's current documentation lists an A1 free allowance equivalent to
**2 OCPUs / 12 GB RAM**, and **200 GB total boot/block storage** across the tenancy;
check your console's remaining allowance before allocating resources. Older guides
quoting 4 OCPUs / 24 GB do not match the current documented allowance.
[Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## 2. Set Oracle network rules and DNS

Use a public subnet with a public IPv4 address and a route to the Internet Gateway.
On the attached Network Security Group or subnet Security List, add **stateful TCP
ingress** rules, with source ports left as **All**:

| Source | Destination port | Purpose |
| --- | --- | --- |
| Your administrative public IP `/32` | `22` | SSH |
| `0.0.0.0/0` | `80` | Caddy certificate issuance and HTTP redirect |
| `0.0.0.0/0` | `443` | Authenticated HTTPS search bridge |

Keep outbound DNS and HTTPS working so the VM can reach YU Torah, Google, and
package repositories. PostgreSQL 5432, search 8765, and OAuth callback ports need
no public ingress. The callback is forwarded through SSH.

Oracle's Ubuntu image also has a **host firewall**. Opening a Security List alone
does not open the host. Inspect the existing rules:

```sh
sudo iptables -S INPUT
sudo cat /etc/iptables/rules.v4
```

On the stock Ubuntu image, preserve the SSH and existing infrastructure rules.
Edit `/etc/iptables/rules.v4` and add these lines immediately after the existing
SSH ACCEPT rule and **before** the final INPUT REJECT rule:

```text
-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT
-A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT
```

Keep your SSH session open while applying the saved rules:

```sh
sudo iptables-restore --test < /etc/iptables/rules.v4
sudo iptables-restore < /etc/iptables/rules.v4
sudo iptables -L INPUT -n --line-numbers
```

If the VM has a customized firewall, use its existing manager instead of replacing
the rules. Oracle documents problems with enabling UFW on its Ubuntu images; follow
[Oracle's Ubuntu firewall instructions](https://blogs.oracle.com/developers/enabling-network-traffic-to-ubuntu-images-in-oracle-cloud-infrastructure)
and [the current compute known issues](https://docs.oracle.com/en-us/iaas/Content/Compute/known-issues.htm#ufw).

Point `transcripts.YOUR_DOMAIN` to the VM's public IPv4 using an A record. Add an
AAAA record only after configuring and checking IPv6 routing and both IPv6
firewalls. A DNS-only record is sufficient for Caddy; an Oracle load balancer is
not required for this single-VM deployment.

## 3. Install and commission the pipeline

Follow [steps 1–8 of the installation checklist](transcription-setup.md). In order:

1. Install packages and Node; clone the merged `main` branch into `/opt/yutorah`.
2. Build the worker and run the pinned runtime installer. It detects ARM64 or x86-64.
3. Create PostgreSQL roles/database, install the worker environment, and run `migrate`.
4. Run `probe`; require `runtime_verified`, especially on Ampere ARM64.
5. Run `auth` in an interactive SSH terminal. Run its printed SSH tunnel command on
   your laptop and open its Google URL there. Run `auth-check` and choose an
   advertised model before enqueueing jobs.
6. Keep `CATALOG_ENABLED=false` while validating a short and a long recording,
   including a service restart and timestamp/coverage checks.
7. Start the read-only search service and Caddy. Set `TRANSCRIPT_API_URL` and
   `TRANSCRIPT_API_TOKEN` on the existing website, then deploy its merged source
   and D1 migrations through that host's publishing flow.
8. Verify English/Hebrew spoken search and playback timestamps from the website,
   then set `CATALOG_ENABLED=true` and restart the worker.

The existing GitHub workflow validates source, builds, recovery, and the built
website-to-PostgreSQL search path; it does not log into your Google account, deploy
to Oracle, or publish the managed website. ARM execution, Google quota/token
renewal, and real transcription quality remain checks on your account and VM.

## 4. Check operation and keep a recoverable copy

```sh
sudo systemctl is-active postgresql yutorah-worker yutorah-search caddy
sudo journalctl -u yutorah-worker -n 50 --no-pager
sudo journalctl -u yutorah-search -n 50 --no-pager
curl -i https://transcripts.YOUR_DOMAIN/health
```

The unauthenticated health request should return **401**. A completed recording
must also be searchable through the website; 401 alone does not prove database
connectivity or transcription success. If local access works but HTTPS times out,
check DNS, the public subnet route, Oracle ingress, and the host firewall.

Follow the installation checklist's PostgreSQL backup and restore steps. Copy
backups off the VM and protect any saved Google profile. Oracle may reclaim idle
Always Free instances under its documented utilization policy, so keep data
recoverable independently of this instance.
[Oracle idle-instance policy](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
